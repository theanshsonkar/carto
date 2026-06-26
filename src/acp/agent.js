'use strict';

const { Readable, Writable } = require('stream');
const acp = require('@agentclientprotocol/sdk');
const { SessionManager } = require('./session');
const { buildSystemPrompt, buildContextBlock } = require('./prompt');
const { CARTO_TOOLS, executeTool } = require('./tools');
const { ProviderRegistry } = require('./providers');
const { loadAgentConfig, saveAgentConfig } = require('./config');

const MAX_ITERATIONS = 25;

class CartoAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new SessionManager();
    this.providers = new ProviderRegistry();
    // Rehydrate last-used provider config (no API key — that still comes
    // from the environment or IDE settings). Done lazily so a fresh repo
    // without `.carto/agent-config.json` doesn't pay any cost.
    this._lastProviderConfig = null;
  }

  async initialize(_params) {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
      agentInfo: {
        name: 'carto',
        title: 'Carto',
        version: require('../../package.json').version,
      },
      authMethods: [],
    };
  }

  async authenticate(_params) {
    return {};
  }

  async newSession(params) {
    const cwd = params.cwd || process.cwd();
    const session = this.sessions.create(cwd);
    // Lazy-load any persisted provider config for this project.
    if (!this._lastProviderConfig) {
      this._lastProviderConfig = loadAgentConfig(cwd);
    }
    return { sessionId: session.id };
  }

  async setSessionMode(_params) {
    return {};
  }

  async prompt(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);

    session.abortController?.abort();
    session.abortController = new AbortController();
    const signal = session.abortController.signal;

    try {
      await this._runAgentLoop(params, session, signal);
    } catch (err) {
      if (signal.aborted) return { stopReason: 'cancelled' };
      throw err;
    }

    session.abortController = null;
    // Persist after every successful prompt so an editor crash never
    // loses session history. Best-effort; failures don't surface to the
    // client (we'd rather complete the turn than block on disk).
    try { this.sessions.persist(session); } catch {}
    return { stopReason: 'end_turn' };
  }

  async cancel(params) {
    const session = this.sessions.get(params.sessionId);
    if (session) session.abortController?.abort();
  }

  // Provider methods
  // The custom `unstable_*` provider-management methods (list / set / disable)
  // were removed. The ACP SDK only dispatches the methods declared in
  // its AGENT_METHODS constant, so those custom routes returned -32601
  // "Method not found" anyway. Provider config flows through env vars /
  // editor settings; ProviderRegistry remains as the internal
  // configuration carrier.

  // Session list/load — persisted ACP sessions.
  // Sessions are persisted to `.carto/acp-sessions.db` after every
  // prompt completion. `listSessions` returns persisted sessions for the
  // working directory; `loadSession` rehydrates one into memory.
  async listSessions(params) {
    const cwd = (params && params.cwd) || process.cwd();
    const rows = this.sessions.list(cwd);
    return {
      sessions: rows.map(r => ({
        sessionId: r.id,
        cwd: r.working_dir,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        messageCount: r.msg_count || 0,
      })),
    };
  }
  async loadSession(params) {
    if (!params || !params.sessionId || !params.cwd) return { sessionId: null };
    const session = this.sessions.resume(params.sessionId, params.cwd);
    return { sessionId: session ? session.id : null };
  }
  async closeSession(params) {
    if (params && params.sessionId) {
      const session = this.sessions.get(params.sessionId);
      if (session) {
        try { this.sessions.persist(session); } catch {}
      }
      this.sessions.delete(params.sessionId);
    }
    return {};
  }

  // ─── Agent Loop ──────────────────────────────────────────────────────────

  async _runAgentLoop(params, session, signal) {
    // 1. Ensure project is indexed
    const indexMsg = await session.ensureIndexed();
    if (indexMsg) {
      await this.connection.sessionUpdate({
        sessionId: session.id,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: indexMsg } },
      });
    }

    // 2. Extract user message text
    const userText = (params.prompt || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    // 3. Build context from Carto intelligence
    const contextBlock = buildContextBlock(session.carto, session.workingDir);

    // 4. Build messages array
    const systemPrompt = buildSystemPrompt(contextBlock);
    const messages = [
      { role: 'system', content: systemPrompt },
      ...session.history,
      { role: 'user', content: userText },
    ];
    session.history.push({ role: 'user', content: userText });

    // 5. Get the active provider
    const provider = this.providers.getActive();
    if (!provider) {
      const msg = 'No LLM provider configured. Please set a provider in your editor settings (API key + model).';
      await this.connection.sessionUpdate({
        sessionId: session.id,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: msg } },
      });
      session.history.push({ role: 'assistant', content: msg });
      return;
    }

    // 6. Agent loop — iterate until no more tool calls or max iterations
    let iterations = 0;
    while (iterations++ < MAX_ITERATIONS) {
      if (signal.aborted) throw new Error('cancelled');

      // True LLM token streaming.
      //
      // The provider streams text deltas via `onTextChunk`. We forward
      // each chunk to the editor as it arrives so the UI feels alive
      // instead of stalling for the duration of the request. The
      // *aggregated* assistant text is captured here so we can store
      // it on `session.history` once the turn ends — the provider
      // still returns the full `{ content: [...] }` object so tool_use
      // blocks survive.
      let streamedText = '';
      const onTextChunk = (delta) => {
        if (!delta) return;
        streamedText += delta;
        // Fire-and-forget — sessionUpdate returns a Promise but the SDK
        // tolerates concurrent calls and we don't want each delta to
        // block the next one.
        this.connection.sessionUpdate({
          sessionId: session.id,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta } },
        }).catch(() => { /* connection errors surface elsewhere */ });
      };

      const response = await provider.chat(messages, CARTO_TOOLS, signal, onTextChunk);

      // After the stream completes, classify content blocks. Text was
      // already forwarded chunk-by-chunk; here we only need to collect
      // tool_use blocks and reconcile assistantText for history.
      let assistantText = '';
      let toolCalls = [];

      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          assistantText += block.text;
          // If the provider didn't actually stream (e.g. test stub or
          // a non-streaming compatible API), forward the text once here
          // so the editor still sees it.
          if (!streamedText) {
            await this.connection.sessionUpdate({
              sessionId: session.id,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: block.text } },
            });
          }
        } else if (block.type === 'tool_use') {
          toolCalls.push(block);
        }
      }

      // Add assistant message to history
      messages.push({ role: 'assistant', content: response.content });

      if (toolCalls.length === 0) {
        session.history.push({ role: 'assistant', content: assistantText });
        break;
      }

      // Execute tool calls
      const toolResults = [];
      for (const tc of toolCalls) {
        // Report tool call to editor
        await this.connection.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: tc.id,
            title: tc.name,
            kind: 'other',
            status: 'pending',
            rawInput: tc.input,
          },
        });

        // Execute
        const result = await executeTool(tc.name, tc.input, session);

        // Report completion
        await this.connection.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: tc.id,
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) } }],
            rawOutput: result,
          },
        });

        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
      }

      // Add tool results to messages
      messages.push({ role: 'user', content: toolResults });
    }

    if (iterations > MAX_ITERATIONS) {
      await this.connection.sessionUpdate({
        sessionId: session.id,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\n⚠️ Reached maximum iterations (25). Stopping.' } },
      });
    }
  }
}

/**
 * startAgent() — Entry point. Connects ACP over stdin/stdout.
 */
function startAgent() {
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin);
  const stream = acp.ndJsonStream(input, output);
  new acp.AgentSideConnection((conn) => new CartoAgent(conn), stream);
}

module.exports = { startAgent, CartoAgent };
