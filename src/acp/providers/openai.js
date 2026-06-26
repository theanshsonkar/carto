'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { parseSseStream } = require('./sse');

/**
 * OpenAIProvider — handles OpenAI and every OpenAI-compatible API.
 * Works with: OpenAI, Gemini, Ollama, OpenRouter, Together, Groq, Azure,
 * LM Studio, vLLM.
 *
 * Token streaming via SSE.
 *   The older path sent `stream: false` and parsed the full JSON
 *   response. We now request streaming by default; text deltas are
 *   forwarded to the optional `onTextChunk` callback, and the assembled
 *   `{ content: [...] }` is returned only once the stream completes so
 *   downstream tool_use handling is unchanged.
 *
 * OpenAI SSE event shape (per chunk):
 *
 *   data: {
 *     "id": "...",
 *     "object": "chat.completion.chunk",
 *     "choices": [{
 *       "index": 0,
 *       "delta": {
 *         "role": "assistant"?,
 *         "content": "..."?,
 *         "tool_calls": [
 *           { "index": 0, "id": "..."?, "function": { "name": "..."?, "arguments": "..." } }
 *         ]?
 *       },
 *       "finish_reason": "stop" | "tool_calls" | null
 *     }]
 *   }
 *
 * Stream terminates with `data: [DONE]`. Function arguments are
 * delivered as JSON-fragment strings keyed by `tool_calls[i].index`;
 * we concatenate per-index and JSON.parse once at the end.
 */
class OpenAIProvider {
  constructor(apiKey, baseUrl, model) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
  }

  /**
   * chat(messages, tools, signal, onTextChunk?)
   *
   * Same contract as AnthropicProvider — onTextChunk is an optional
   * callback that gets each text delta as it streams. Returns the full
   * assembled `{ content: [...] }` once the stream ends.
   */
  async chat(messages, tools, signal, onTextChunk) {
    const body = {
      model: this.model,
      messages: this._formatMessages(messages),
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
    }

    return this._streamRequest('/chat/completions', body, signal, onTextChunk);
  }

  _formatMessages(messages) {
    const formatted = [];
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        formatted.push({ role: msg.role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Handle tool_use blocks (assistant) and tool_result blocks (user).
        if (msg.role === 'assistant') {
          const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
          const toolCalls = msg.content.filter((b) => b.type === 'tool_use').map((b) => ({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          }));
          const entry = { role: 'assistant' };
          if (text) entry.content = text;
          if (toolCalls.length > 0) entry.tool_calls = toolCalls;
          formatted.push(entry);
        } else if (msg.role === 'user') {
          // Tool results.
          for (const block of msg.content) {
            if (block.type === 'tool_result') {
              formatted.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content });
            } else if (block.type === 'text') {
              formatted.push({ role: 'user', content: block.text });
            }
          }
        }
      }
    }
    return formatted;
  }

  /**
   * Reduces a list of OpenAI SSE chunks into the unified content-block
   * format. Exposed on the prototype for testing.
   *
   * Chunks → state:
   *   - Per choice (we only care about choices[0]):
   *     - text accumulator (string)
   *     - tool_calls accumulator, keyed by the `index` field on each
   *       streamed tool_call delta:
   *         { id, name, argsAcc }
   *
   * Output:
   *   - one `{ type: 'text', text }` block (if any text accumulated)
   *   - one `{ type: 'tool_use', id, name, input }` block per tool_call,
   *     in `index` order. `input` is JSON.parse(argsAcc), defaulting to
   *     `{}` if argsAcc is empty or invalid.
   */
  _foldChunks(chunks) {
    let text = '';
    /** @type {Map<number, { id: string|null, name: string|null, argsAcc: string }>} */
    const tools = new Map();

    for (const chunk of chunks) {
      const choice = chunk && chunk.choices && chunk.choices[0];
      if (!choice || !choice.delta) continue;
      const delta = choice.delta;
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          if (!tools.has(idx)) tools.set(idx, { id: null, name: null, argsAcc: '' });
          const t = tools.get(idx);
          if (tc.id) t.id = tc.id;
          if (tc.function) {
            if (tc.function.name) t.name = tc.function.name;
            if (typeof tc.function.arguments === 'string') t.argsAcc += tc.function.arguments;
          }
        }
      }
    }

    const content = [];
    if (text) content.push({ type: 'text', text });
    const indices = [...tools.keys()].sort((a, b) => a - b);
    for (const i of indices) {
      const t = tools.get(i);
      let input = {};
      if (t.argsAcc) {
        try { input = JSON.parse(t.argsAcc); } catch { /* tolerate */ }
      }
      content.push({ type: 'tool_use', id: t.id, name: t.name, input });
    }
    if (content.length === 0) {
      content.push({ type: 'text', text: 'No response from model.' });
    }
    return { content };
  }

  /**
   * Open the SSE stream, push each parsed chunk into a buffer, and
   * resolve with the folded `{ content: [...] }` once `[DONE]` arrives
   * or the response ends.
   */
  _streamRequest(endpoint, body, signal, onTextChunk) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + endpoint);
      const isHttps = url.protocol === 'https:';
      const mod = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'Authorization': `Bearer ${this.apiKey}`,
        },
      };

      const chunks = [];
      let sseBuf = '';
      let aborted = false;
      let done = false;

      const req = mod.request(options, (res) => {
        if (res.statusCode && res.statusCode !== 200) {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => {
            let parsed;
            try { parsed = JSON.parse(buf); } catch { parsed = null; }
            const msg = (parsed && parsed.error && (parsed.error.message || parsed.error)) ||
                        buf.slice(0, 200) ||
                        `HTTP ${res.statusCode}`;
            reject(new Error(`OpenAI API error (${res.statusCode}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`));
          });
          return;
        }

        res.on('data', (data) => {
          sseBuf = parseSseStream(data, sseBuf, (event, payload) => {
            if (payload === null && event === 'done') {
              done = true;
              return;
            }
            if (!payload) return;
            chunks.push(payload);
            // Forward text deltas immediately.
            const choice = payload.choices && payload.choices[0];
            if (
              choice && choice.delta &&
              typeof choice.delta.content === 'string' &&
              choice.delta.content &&
              onTextChunk
            ) {
              try { onTextChunk(choice.delta.content); } catch { /* user callback */ }
            }
          });
        });

        res.on('end', () => {
          if (aborted) return;
          // Some compatible APIs (Ollama, vLLM) don't emit `[DONE]`;
          // an ordinary close is fine — fold what we have.
          resolve(this._foldChunks(chunks));
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
      // `done` is intentionally observed but unused — resolve happens on
      // socket close. The variable exists to make the [DONE] sentinel
      // visible in the event-handler closure for future debug-logging.
      void done;
    });
  }
}

module.exports = { OpenAIProvider };
