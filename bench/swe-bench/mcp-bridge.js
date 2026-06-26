'use strict';

/**
 * mcp-bridge.js — Spawn `carto serve` and expose a minimal
 * `{ tools, call(name, input) }` shape the SWE-bench agent can plug
 * into its `dispatchTool` router.
 *
 * Speaks raw JSON-RPC over the child's stdio (no SDK dependency) so
 * we can keep the bench harness lean. Same wire format the production
 * middleware proxy uses.
 *
 * Lifecycle:
 *   const bridge = new MCPBridge({ cwd: scratchDir });
 *   await bridge.start();
 *   await bridge.listTools();           // populates bridge.tools
 *   const result = await bridge.call('get_blast_radius', { file: 'x.ts' });
 *   await bridge.close();
 *
 * Each task gets its own bridge instance because each task points at
 * a different scratch dir. The cost of starting a fresh `carto serve`
 * is acceptable (<100 ms after the first index is built).
 */

const { spawn } = require('child_process');
const path = require('path');
const { LineSplitter } = require('../../src/mcp/middleware');

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 30_000;

class MCPBridge {
  /**
   * @param {object} opts
   *   - cwd:        the scratch dir the agent is operating in (carto
   *                 will index this directory)
   *   - cartoBin:   path to the carto CLI (defaults to the in-repo one)
   *   - stderr:     where to forward child stderr (defaults to inherit)
   */
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd();
    this.cartoBin = opts.cartoBin || path.join(__dirname, '..', '..', 'src', 'cli', 'index.js');
    this.stderr = opts.stderr || 'inherit';

    /** @type {Array<{name, description, input_schema}>} */
    this.tools = [];
    this._child = null;
    this._splitter = null;
    this._pending = new Map();
    this._nextId = 1;
    this._closed = false;
  }

  async start() {
    this._child = spawn(
      process.execPath, // node
      [this.cartoBin, 'serve'],
      {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', this.stderr],
      },
    );
    this._child.on('exit', () => { this._closed = true; });

    this._splitter = new LineSplitter((msg) => this._onMessage(msg), 'mcp-bridge');
    this._child.stdout.on('data', (chunk) => this._splitter.feed(chunk));

    // MCP handshake.
    await this._rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'carto-swe-bench-bridge', version: '0.1.0' },
    });
    // Many MCP servers expect a `notifications/initialized` notification
    // (no id) after initialize. carto serve tolerates either, but we
    // send it for correctness.
    this._sendNotification('notifications/initialized', {});
  }

  async listTools() {
    const result = await this._rpc('tools/list', {});
    // MCP tools/list returns `{tools: [{name, description, inputSchema}]}`
    // — note inputSchema vs input_schema. Anthropic's API expects
    // input_schema, so we normalize here.
    const raw = (result && result.tools) || [];
    this.tools = raw.map((t) => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
    }));
    return this.tools;
  }

  /**
   * Call an MCP tool by name. Returns the text content of the response,
   * or a stringified JSON blob if the tool returned structured content.
   */
  async call(name, input) {
    const result = await this._rpc('tools/call', { name, arguments: input || {} });
    if (!result) return '(no result)';
    if (Array.isArray(result.content)) {
      const text = result.content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
      return text || JSON.stringify(result, null, 2);
    }
    return JSON.stringify(result);
  }

  async close() {
    if (!this._child || this._closed) return;
    try { this._child.stdin.end(); } catch {}
    try { this._child.kill('SIGTERM'); } catch {}
    this._closed = true;
  }

  // ─── internals ───────────────────────────────────────────────────

  _rpc(method, params) {
    return new Promise((resolve, reject) => {
      if (this._closed) return reject(new Error(`mcp-bridge closed before ${method}`));
      const id = this._nextId++;
      const msg = { jsonrpc: '2.0', id, method, params: params || {} };
      const t = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`mcp-bridge: ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this._pending.set(id, { resolve, reject, timeout: t });
      try {
        this._child.stdin.write(JSON.stringify(msg) + '\n');
      } catch (err) {
        clearTimeout(t);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  _sendNotification(method, params) {
    if (this._closed) return;
    const msg = { jsonrpc: '2.0', method, params: params || {} };
    try { this._child.stdin.write(JSON.stringify(msg) + '\n'); } catch {}
  }

  _onMessage(msg) {
    if (msg && typeof msg.id !== 'undefined' && this._pending.has(msg.id)) {
      const entry = this._pending.get(msg.id);
      clearTimeout(entry.timeout);
      this._pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`MCP error: ${msg.error.message || JSON.stringify(msg.error)}`));
      else entry.resolve(msg.result);
    }
    // Server-initiated notifications are ignored — the bridge is one-way.
  }
}

module.exports = { MCPBridge };
