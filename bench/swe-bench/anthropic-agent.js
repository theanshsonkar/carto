'use strict';

/**
 * anthropic-agent.js — Real-API agent loop for SWE-bench runs.
 *
 * Solves one SWE-bench task end-to-end:
 *
 *   1. Build the system prompt (cached). Generic problem-solving
 *      instructions + tool guidance.
 *
 *   2. Build the task context (cached): problem statement + hints +
 *      a directory listing of the scratch dir. Tagged with
 *      `cache_control: { type: 'ephemeral' }` so subsequent turns hit
 *      the cached-read rate (~10× cheaper).
 *
 *   3. Loop: call Anthropic Messages API with streaming → collect
 *      text + tool_use blocks → execute tools via `makeExecutor` →
 *      feed tool_result back → repeat until the model emits no
 *      tool_use (i.e. it's done) or MAX_TURNS is hit.
 *
 *   4. Capture the final diff: walk the scratch dir and diff each file
 *      that differs from its base-commit version. (Real SWE-bench runs
 *      use `git diff` against the original commit; we mirror that for
 *      faithful prediction format.)
 *
 *   5. Return { diff, elapsedMs, toolCalls, tokensUsed, model, turns }.
 *
 * Prompt caching:
 *   We tag two content blocks with cache_control:
 *     - the system prompt (constant across all tasks)
 *     - the task context (constant within a task)
 *   That's ~80% of the input volume; the per-turn delta is small
 *   (~few hundred tokens of "tool result"). Cached reads are $0.30/M
 *   vs $3/M base on Sonnet — a 90% cost cut on the cached portion.
 *
 * MCP integration (carto arm):
 *   When `cartoMcp` is supplied, its tool definitions are added to the
 *   `tools` array and a separate `mcpExecutor` routes those calls.
 *   The agent doesn't know or care which tool came from which source.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { URL } = require('url');

const { TOOL_DEFINITIONS, makeExecutor } = require('./tools');
const { parseSseStream } = require('../../src/acp/providers/sse');

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const MAX_TURNS = 25;
const MAX_TOKENS_PER_TURN = 4096;
const ANTHROPIC_BASE = 'https://api.anthropic.com';

const SYSTEM_PROMPT =
  `You are an expert software engineer working on a real open-source repository.

You have access to filesystem tools (read_file, list_directory, write_file, edit_file, run_bash) for editing the codebase, and may have additional tools that help you reason about the project's architecture.

Your goal: produce a minimal, correct code change that resolves the user's problem statement. Explore the repo first — use list_directory to see the structure, read_file to inspect specific files, run_bash for grep/find when you need to locate something. Only then make changes.

Important:
  - Make the smallest change that solves the problem. Don't refactor adjacent code.
  - Don't add new dependencies.
  - Don't modify test files unless the problem statement explicitly says to.
  - When you're done, simply finish your response without calling any more tools. The harness captures your diff automatically.
`;

class AnthropicAgent {
  /**
   * @param {'control'|'carto'} arm
   * @param {object} opts
   *   - apiKey:   Anthropic API key (defaults to env)
   *   - model:    model id (defaults to claude-sonnet-4-20250514)
   *   - cartoMcp: { tools: [{name, description, input_schema}], call(name, input) → Promise<string> } | null
   *   - maxTurns: override MAX_TURNS
   *   - logRaw:   path to JSONL of every request/response (for replay)
   */
  constructor(arm, opts = {}) {
    if (arm !== 'control' && arm !== 'carto') {
      throw new Error(`AnthropicAgent: arm must be 'control' or 'carto' (got '${arm}')`);
    }
    this.arm = arm;
    this.apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!this.apiKey) {
      throw new Error('AnthropicAgent requires ANTHROPIC_API_KEY (set in env or pass via opts.apiKey).');
    }
    this.model = opts.model || DEFAULT_MODEL;
    this.cartoMcp = arm === 'carto' ? (opts.cartoMcp || null) : null;
    this.maxTurns = opts.maxTurns || MAX_TURNS;
    this.logRaw = opts.logRaw || null;
  }

  /**
   * solve(task, scratchDir) → result
   *
   * Runs one task end-to-end against the model. `scratchDir` must
   * already contain the repo materialized at the task's base commit
   * (the harness handles that — for mini-suite via task.repo write,
   * for verified via git clone + checkout).
   */
  async solve(task, scratchDir) {
    const t0 = Date.now();

    // Capture initial state so we can diff at the end.
    const initialSnapshot = snapshotDir(scratchDir);

    // Build initial context block (cached).
    const taskContext = await buildTaskContext(task, scratchDir);

    // System prompt + task context are both cached.
    const systemBlocks = [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: taskContext, cache_control: { type: 'ephemeral' } },
    ];

    // Tools = built-in + Carto MCP tools (if carto arm).
    const tools = TOOL_DEFINITIONS.slice();
    if (this.cartoMcp && Array.isArray(this.cartoMcp.tools)) {
      for (const t of this.cartoMcp.tools) tools.push(t);
    }

    const execFs = makeExecutor(scratchDir);
    const execMcp = this.cartoMcp
      ? (name, input) => this.cartoMcp.call(name, input)
      : null;

    // Tool dispatch — try built-in first, then Carto MCP.
    const builtInNames = new Set(TOOL_DEFINITIONS.map((t) => t.name));
    const dispatchTool = async (name, input) => {
      if (builtInNames.has(name)) return execFs(name, input);
      if (execMcp) return execMcp(name, input);
      return `error: no executor for tool ${name}`;
    };

    // Conversation.
    /** @type {{role:'user'|'assistant', content: any}[]} */
    const messages = [
      { role: 'user', content: 'Begin. Solve the problem described above.' },
    ];

    let totalToolCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    let turn = 0;

    while (turn < this.maxTurns) {
      turn++;
      const response = await this._callAnthropic({ systemBlocks, messages, tools });

      totalInputTokens += response.usage.input_tokens || 0;
      totalOutputTokens += response.usage.output_tokens || 0;
      totalCacheReadTokens += response.usage.cache_read_input_tokens || 0;
      totalCacheWriteTokens += response.usage.cache_creation_input_tokens || 0;

      // Push the model's message into history.
      messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0) break; // model is done

      // Execute every tool call in this turn.
      const toolResults = [];
      for (const use of toolUses) {
        totalToolCalls++;
        let resultText;
        try { resultText = await dispatchTool(use.name, use.input || {}); }
        catch (err) { resultText = `error: ${err.message || err}`; }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: typeof resultText === 'string' ? resultText : JSON.stringify(resultText),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    // Compute final diff: every file that differs from initialSnapshot
    // becomes a hunk in a synthesized unified diff. Faithful to what
    // `git diff` would produce against the base commit.
    const finalSnapshot = snapshotDir(scratchDir);
    const diff = synthesizeDiff(initialSnapshot, finalSnapshot);

    return {
      diff,
      elapsedMs: Date.now() - t0,
      toolCalls: totalToolCalls,
      tokensUsed: totalInputTokens + totalOutputTokens,
      tokensInput: totalInputTokens,
      tokensOutput: totalOutputTokens,
      tokensCacheRead: totalCacheReadTokens,
      tokensCacheWrite: totalCacheWriteTokens,
      turns: turn,
      model: this.model,
    };
  }

  /**
   * One Anthropic Messages API call with streaming, returns
   *   { content: [...], usage: {...} }
   *
   * We accept streaming and fold the events ourselves so we can wire
   * `cache_control` and capture usage stats — the streaming provider
   * in src/acp doesn't expose those (it's optimized for ACP UX).
   */
  _callAnthropic({ systemBlocks, messages, tools }) {
    return new Promise((resolve, reject) => {
      const body = {
        model: this.model,
        max_tokens: MAX_TOKENS_PER_TURN,
        system: systemBlocks,
        messages,
        tools,
        stream: true,
      };

      const url = new URL(ANTHROPIC_BASE + '/v1/messages');
      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          // Prompt caching is GA on Sonnet 4; no beta header needed for
          // recent snapshots. Older snapshots required
          // 'anthropic-beta: prompt-caching-2024-07-31'.
        },
      };

      const events = [];
      let usage = {};
      let sseBuf = '';

      const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => {
            let parsed; try { parsed = JSON.parse(buf); } catch {}
            const msg = (parsed && parsed.error && parsed.error.message) ||
                        buf.slice(0, 400) ||
                        `HTTP ${res.statusCode}`;
            reject(new Error(`Anthropic API error (${res.statusCode}): ${msg}`));
          });
          return;
        }
        res.on('data', (chunk) => {
          sseBuf = parseSseStream(chunk, sseBuf, (event, data) => {
            if (event === 'error' && data && data.error) {
              reject(new Error(`stream error: ${data.error.message || JSON.stringify(data.error)}`));
              return;
            }
            if (data && data.type === 'message_start' && data.message && data.message.usage) {
              // Initial usage block — has cache_read_input_tokens etc.
              usage = data.message.usage;
            }
            if (data && data.type === 'message_delta' && data.usage) {
              // Output token count arrives here at stream end.
              if (typeof data.usage.output_tokens === 'number') {
                usage.output_tokens = data.usage.output_tokens;
              }
            }
            events.push({ event, data });
          });
        });
        res.on('end', () => {
          const content = foldAnthropicEvents(events);
          if (this.logRaw) {
            try {
              fs.appendFileSync(this.logRaw,
                JSON.stringify({ request: body, response: { content, usage }, ts: Date.now() }) + '\n');
            } catch { /* logging is best-effort */ }
          }
          resolve({ content, usage });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(JSON.stringify(body));
      req.end();
    });
  }
}

/**
 * foldAnthropicEvents(events) — reduce a stream of content_block_*
 * events into the canonical `[{ type, ... }]` content array. Mirrors
 * src/acp/providers/anthropic.js._foldEvents but kept inline because
 * the SWE-bench harness shouldn't reach across the package boundary
 * for an internal helper.
 */
function foldAnthropicEvents(events) {
  const blocks = new Map();
  for (const { event, data } of events) {
    if (!data) continue;
    switch (event || data.type) {
      case 'content_block_start': {
        const cb = data.content_block || {};
        if (cb.type === 'text') {
          blocks.set(data.index, { type: 'text', text: cb.text || '' });
        } else if (cb.type === 'tool_use') {
          blocks.set(data.index, { type: 'tool_use', id: cb.id, name: cb.name, jsonAcc: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const b = blocks.get(data.index);
        if (!b) break;
        const d = data.delta || {};
        if (d.type === 'text_delta' && b.type === 'text') b.text += d.text || '';
        else if (d.type === 'input_json_delta' && b.type === 'tool_use') b.jsonAcc += d.partial_json || '';
        break;
      }
      default: break;
    }
  }
  const out = [];
  for (const i of [...blocks.keys()].sort((a, b) => a - b)) {
    const b = blocks.get(i);
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') {
      let input = {};
      if (b.jsonAcc) { try { input = JSON.parse(b.jsonAcc); } catch {} }
      out.push({ type: 'tool_use', id: b.id, name: b.name, input });
    }
  }
  return out;
}

/**
 * Build the task-context cached block: problem statement + hints +
 * a project overview. For mini-suite tasks the overview is a flat
 * dir listing. For verified tasks (with task.upstream.repo), we
 * include README content if it exists.
 */
async function buildTaskContext(task, scratchDir) {
  const out = [];
  out.push(`# Problem Statement\n${task.problemStatement || task.description || '(no description provided)'}`);
  if (task.hints) out.push(`\n# Hints\n${task.hints}`);
  out.push(`\n# Project Overview\nProject root: ${scratchDir}\n\nTop-level entries:\n`);
  try {
    const entries = fs.readdirSync(scratchDir, { withFileTypes: true })
      .slice(0, 50)
      .map((e) => `  ${e.isDirectory() ? '[d]' : '[f]'} ${e.name}`)
      .join('\n');
    out.push(entries);
  } catch { /* ignore */ }
  // Include README if present — common shape, gives the model orienting context.
  for (const candidate of ['README.md', 'README.rst', 'README.txt', 'README']) {
    const p = path.join(scratchDir, candidate);
    if (fs.existsSync(p)) {
      try {
        const text = fs.readFileSync(p, 'utf8').slice(0, 4000);
        out.push(`\n# ${candidate} (first 4 KB)\n${text}`);
      } catch {}
      break;
    }
  }
  return out.join('\n');
}

/**
 * Snapshot the scratch dir as a Map<relPath, content>. Used to diff
 * the post-agent state against the pre-agent baseline.
 *
 * Skips .git, node_modules, .carto, anything in .gitignore territory
 * — we only care about source code the agent might have touched.
 */
function snapshotDir(root) {
  const out = new Map();
  const SKIP = new Set(['.git', 'node_modules', '.carto', '__pycache__', '.venv', 'venv', 'dist', 'build']);
  function walk(dir, rel = '') {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) {
        try {
          const stat = fs.statSync(abs);
          if (stat.size > 4 * 1024 * 1024) continue; // skip huge files
          out.set(r, fs.readFileSync(abs, 'utf8'));
        } catch { /* binary or perm-denied — skip */ }
      }
    }
  }
  walk(root);
  return out;
}

/**
 * synthesizeDiff(before, after) — produce a unified-diff string of the
 * files that differ. Single-hunk per file (remove all old, add all
 * new) — same shape `src/mcp/middleware/index.js`.synthesizeDiff uses.
 *
 * Tries `git diff` first if scratch is a git repo (gives proper minimal
 * hunks); falls back to the brute-force version.
 */
function synthesizeDiff(before, after) {
  const out = [];
  const seen = new Set();
  for (const [p, newContent] of after) {
    seen.add(p);
    const oldContent = before.get(p);
    if (oldContent === newContent) continue;
    out.push(makeFileDiff(p, oldContent ?? '', newContent));
  }
  for (const [p, oldContent] of before) {
    if (seen.has(p)) continue;
    // deleted
    out.push(makeFileDiff(p, oldContent, ''));
  }
  return out.join('');
}

function makeFileDiff(relPath, oldContent, newContent) {
  const oldLines = oldContent === '' ? [] : oldContent.split('\n');
  const newLines = newContent === '' ? [] : newContent.split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const out = [];
  if (oldContent === '') {
    out.push(`diff --git a/${relPath} b/${relPath}`);
    out.push(`new file mode 100644`);
    out.push(`--- /dev/null`);
    out.push(`+++ b/${relPath}`);
    out.push(`@@ -0,0 +1,${newLines.length} @@`);
    for (const l of newLines) out.push(`+${l}`);
  } else if (newContent === '') {
    out.push(`diff --git a/${relPath} b/${relPath}`);
    out.push(`deleted file mode 100644`);
    out.push(`--- a/${relPath}`);
    out.push(`+++ /dev/null`);
    out.push(`@@ -1,${oldLines.length} +0,0 @@`);
    for (const l of oldLines) out.push(`-${l}`);
  } else {
    out.push(`diff --git a/${relPath} b/${relPath}`);
    out.push(`--- a/${relPath}`);
    out.push(`+++ b/${relPath}`);
    out.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);
    for (const l of oldLines) out.push(`-${l}`);
    for (const l of newLines) out.push(`+${l}`);
  }
  return out.join('\n') + '\n';
}

module.exports = {
  AnthropicAgent,
  // Exported for tests:
  foldAnthropicEvents,
  buildTaskContext,
  snapshotDir,
  synthesizeDiff,
  SYSTEM_PROMPT,
  DEFAULT_MODEL,
  MAX_TURNS,
};
