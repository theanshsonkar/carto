'use strict';

const { Readable, Writable } = require('stream');
const acp = require('@agentclientprotocol/sdk');
const { SessionManager } = require('./session');
const { buildSystemPrompt, buildContextBlock } = require('./prompt');
const { CARTO_TOOLS, executeTool } = require('./tools');
const { ProviderRegistry } = require('./providers');

const MAX_ITERATIONS = 25;

class CartoAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new SessionManager();
    this.providers = new ProviderRegistry();
  }

  async initialize(_params) {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
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
    const session = this.sessions.create(params.cwd || process.cwd());
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

  // Session list/load stubs
  async listSessions(_params) { return { sessions: [] }; }
  async closeSession(_params) { return {}; }

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

      const response = await provider.chat(messages, CARTO_TOOLS, signal);

      // Stream text content
      let assistantText = '';
      let toolCalls = [];

      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          assistantText += block.text;
          await this.connection.sessionUpdate({
            sessionId: session.id,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: block.text } },
          });
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
