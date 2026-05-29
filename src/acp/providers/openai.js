'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * OpenAIProvider — Handles OpenAI and all OpenAI-compatible APIs.
 * Works with: OpenAI, Gemini, Ollama, OpenRouter, Together, Groq, Azure, LM Studio, vLLM.
 */
class OpenAIProvider {
  constructor(apiKey, baseUrl, model) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
  }

  /**
   * chat(messages, tools, signal)
   * Calls the OpenAI-compatible /chat/completions endpoint.
   * Returns { content: [{ type: 'text', text } | { type: 'tool_use', id, name, input }] }
   */
  async chat(messages, tools, signal) {
    const body = {
      model: this.model,
      messages: this._formatMessages(messages),
      stream: false,
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
    }

    const data = await this._request('/chat/completions', body, signal);
    return this._parseResponse(data);
  }

  _formatMessages(messages) {
    const formatted = [];
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        formatted.push({ role: msg.role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Handle tool_use blocks (assistant) and tool_result blocks (user)
        if (msg.role === 'assistant') {
          const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
          const toolCalls = msg.content.filter(b => b.type === 'tool_use').map(b => ({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          }));
          const entry = { role: 'assistant' };
          if (text) entry.content = text;
          if (toolCalls.length > 0) entry.tool_calls = toolCalls;
          formatted.push(entry);
        } else if (msg.role === 'user') {
          // Tool results
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

  _parseResponse(data) {
    const choice = data.choices && data.choices[0];
    if (!choice) return { content: [{ type: 'text', text: 'No response from model.' }] };

    const msg = choice.message;
    const content = [];

    if (msg.content) {
      content.push({ type: 'text', text: msg.content });
    }

    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function.arguments); } catch {}
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
    }

    return { content };
  }

  _request(endpoint, body, signal) {
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
          'Authorization': `Bearer ${this.apiKey}`,
        },
      };

      const req = mod.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            else resolve(parsed);
          } catch { reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`)); }
        });
      });

      req.on('error', reject);

      if (signal) {
        signal.addEventListener('abort', () => { req.destroy(); reject(new Error('cancelled')); }, { once: true });
      }

      req.write(JSON.stringify(body));
      req.end();
    });
  }
}

module.exports = { OpenAIProvider };
