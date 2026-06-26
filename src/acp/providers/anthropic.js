'use strict';

const https = require('https');
const { URL } = require('url');
const { parseSseStream } = require('./sse');

/**
 * AnthropicProvider — handles the Anthropic Claude Messages API.
 *
 * Token streaming via SSE.
 *   The older `chat()` path used `stream: false` and parsed the batched
 *   JSON response. That made the ACP agent feel stuck while the model
 *   thought. We now request `stream: true` by default and surface
 *   incremental text deltas via an optional `onTextChunk`
 *   callback. The function still returns the *full assembled*
 *   `{ content: [...] }` once the stream completes, so the agent loop
 *   continues to receive tool_use blocks intact.
 *
 * If `onTextChunk` is omitted, the streaming path is still used (no
 * regressions for tools that don't care about deltas) and only the
 * final aggregated object is returned. Cancellation via AbortSignal
 * destroys the in-flight request the same way the non-streaming path did.
 *
 * SSE event types we handle (subset of the public Messages API):
 *   - content_block_start { index, content_block: { type: 'text'|'tool_use', ... } }
 *   - content_block_delta { index, delta: { type: 'text_delta', text }
 *                                       | { type: 'input_json_delta', partial_json } }
 *   - content_block_stop  { index }
 *   - message_stop        {}                                — end of stream
 *   - error               { error: { type, message } }      — surfaced as Error
 *
 * Everything else (message_start, message_delta, ping) is ignored.
 */
class AnthropicProvider {
  constructor(apiKey, baseUrl, model) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    this.model = model;
  }

  /**
   * chat(messages, tools, signal, onTextChunk?)
   *   - messages     : conversation history in the unified content-block format
   *   - tools        : [{ name, description, input_schema }, ...] | null
   *   - signal       : AbortSignal | null
   *   - onTextChunk  : (text: string) => void  — optional; called with each
   *                    text delta as it streams. Use this to forward tokens
   *                    to the ACP `sessionUpdate` channel.
   *
   * Returns `{ content: [...] }` once the stream completes.
   */
  async chat(messages, tools, signal, onTextChunk) {
    // Separate system message from conversation.
    let system = '';
    const conversationMessages = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system += (typeof msg.content === 'string' ? msg.content : '') + '\n';
      } else {
        conversationMessages.push(this._formatMessage(msg));
      }
    }

    const body = {
      model: this.model,
      max_tokens: 8192,
      system: system.trim(),
      messages: conversationMessages,
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
    }

    return this._streamRequest('/v1/messages', body, signal, onTextChunk);
  }

  _formatMessage(msg) {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content };
    }

    if (Array.isArray(msg.content)) {
      if (msg.role === 'assistant') {
        // Pass through content blocks (text + tool_use).
        return { role: 'assistant', content: msg.content };
      }
      if (msg.role === 'user') {
        // Convert tool_result blocks to Anthropic format.
        const blocks = msg.content.map((b) => {
          if (b.type === 'tool_result') {
            return { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content };
          }
          return b;
        });
        return { role: 'user', content: blocks };
      }
    }

    return { role: msg.role, content: msg.content };
  }

  /**
   * Reduces a stream of content_block_* events into a final
   * `{ content: [...] }` payload that matches the non-streaming shape.
   *
   * For text blocks: concatenate `delta.text` shards.
   * For tool_use blocks: concatenate `delta.partial_json` shards then
   * JSON.parse the assembled string into the block's `input`.
   *
   * Streaming gotcha: tool_use input is delivered as raw JSON *fragments*
   * (`input_json_delta`), not as object deltas. Empty input objects come
   * across as `partial_json: ""` — we must guard against JSON.parse('').
   */
  // Pure helper exported on the prototype primarily for testing —
  // operates on a list of already-parsed SSE events.
  _foldEvents(events) {
    /** @type {Map<number, { type: 'text'|'tool_use', text?: string, id?: string, name?: string, jsonAcc?: string }>} */
    const blocks = new Map();

    for (const ev of events) {
      const { event, data } = ev;
      if (!data) continue;
      switch (event || data.type) {
        case 'content_block_start': {
          const cb = data.content_block || {};
          if (cb.type === 'text') {
            blocks.set(data.index, { type: 'text', text: cb.text || '' });
          } else if (cb.type === 'tool_use') {
            blocks.set(data.index, {
              type: 'tool_use',
              id: cb.id,
              name: cb.name,
              jsonAcc: '',
            });
          }
          break;
        }
        case 'content_block_delta': {
          const block = blocks.get(data.index);
          if (!block) break;
          const delta = data.delta || {};
          if (delta.type === 'text_delta' && block.type === 'text') {
            block.text += delta.text || '';
          } else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
            block.jsonAcc += delta.partial_json || '';
          }
          break;
        }
        // content_block_stop, message_*, ping — nothing to assemble.
        default:
          break;
      }
    }

    // Materialize in index order.
    const indices = [...blocks.keys()].sort((a, b) => a - b);
    const content = [];
    for (const i of indices) {
      const b = blocks.get(i);
      if (b.type === 'text') {
        content.push({ type: 'text', text: b.text });
      } else if (b.type === 'tool_use') {
        let input = {};
        if (b.jsonAcc) {
          try { input = JSON.parse(b.jsonAcc); } catch { /* tolerate */ }
        }
        content.push({ type: 'tool_use', id: b.id, name: b.name, input });
      }
    }
    return { content };
  }

  /**
   * Open the SSE stream, accumulate state, fire onTextChunk for each
   * `text_delta`, and resolve once the connection closes cleanly.
   *
   * Errors:
   *   - HTTP non-200 → reject with parsed error body if possible.
   *   - SSE `event: error` frames → reject with the Anthropic error message.
   *   - Connection abort via AbortSignal → reject('cancelled').
   */
  _streamRequest(endpoint, body, signal, onTextChunk) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + endpoint);

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
      };

      const events = [];
      let sseBuf = '';
      let streamError = null;
      let aborted = false;

      const req = https.request(options, (res) => {
        if (res.statusCode && res.statusCode !== 200) {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            let parsed;
            try { parsed = JSON.parse(body); } catch { parsed = null; }
            const msg = (parsed && parsed.error && parsed.error.message) ||
                        body.slice(0, 200) ||
                        `HTTP ${res.statusCode}`;
            reject(new Error(`Anthropic API error (${res.statusCode}): ${msg}`));
          });
          return;
        }

        res.on('data', (chunk) => {
          sseBuf = parseSseStream(chunk, sseBuf, (event, data) => {
            if (event === 'error' && data && data.error) {
              streamError = new Error(
                `Anthropic stream error: ${data.error.message || JSON.stringify(data.error)}`
              );
              return;
            }
            // Record the event for the final reducer.
            events.push({ event, data });
            // Forward text deltas to the caller immediately so the ACP
            // agent can stream tokens to the editor.
            if (
              event === 'content_block_delta' &&
              data && data.delta && data.delta.type === 'text_delta' &&
              typeof data.delta.text === 'string' &&
              onTextChunk
            ) {
              try { onTextChunk(data.delta.text); } catch { /* user callback */ }
            }
          });
        });

        res.on('end', () => {
          if (aborted) return; // already rejected
          if (streamError) return reject(streamError);
          resolve(this._foldEvents(events));
        });

        res.on('error', reject);
      });

      req.on('error', (err) => {
        if (aborted) return;
        reject(err);
      });

      if (signal) {
        signal.addEventListener('abort', () => {
          aborted = true;
          req.destroy();
          reject(new Error('cancelled'));
        }, { once: true });
      }

      req.write(JSON.stringify(body));
      req.end();
    });
  }
}

module.exports = { AnthropicProvider };
