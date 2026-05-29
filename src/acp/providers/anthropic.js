'use strict';

const https = require('https');
const { URL } = require('url');

/**
 * AnthropicProvider — Handles Anthropic Claude API (Messages API).
 * Supports tool use and streaming-ready structure.
 */
class AnthropicProvider {
  constructor(apiKey, baseUrl, model) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    this.model = model;
  }

  /**
   * chat(messages, tools, signal)
   * Calls the Anthropic Messages API.
   * Returns { content: [{ type: 'text', text } | { type: 'tool_use', id, name, input }] }
   */
  async chat(messages, tools, signal) {
    // Separate system message from conversation
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
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
    }

    const data = await this._request('/v1/messages', body, signal);
    return this._parseResponse(data);
  }

  _formatMessage(msg) {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content };
    }

    if (Array.isArray(msg.content)) {
      if (msg.role === 'assistant') {
        // Pass through content blocks (text + tool_use)
        return { role: 'assistant', content: msg.content };
      }
      if (msg.role === 'user') {
        // Convert tool_result blocks to Anthropic format
        const blocks = msg.content.map(b => {
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

  _parseResponse(data) {
    if (!data.content) return { content: [{ type: 'text', text: 'No response from model.' }] };
    // Anthropic already returns content in the format we need
    return { content: data.content };
  }

  _request(endpoint, body, signal) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + endpoint);

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
      };

      const req = https.request(options, (res) => {
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

module.exports = { AnthropicProvider };
