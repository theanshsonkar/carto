'use strict';

/**
 * MCP middleware proxy.
 *
 * Wraps an inner stdio MCP server. Forwards JSON-RPC traffic in both
 * directions; intercepts `tools/call` requests whose `name` matches a
 * configured set of filesystem-write tools. For intercepted calls,
 * builds a synthetic unified diff from `(old file contents on disk,
 * new contents from the tool args)` and runs Carto's validation API.
 *
 * If the resulting risk meets/exceeds a configured threshold, the
 * middleware returns a JSON-RPC `result` containing a structured error
 * payload — the write is *not* forwarded to the inner server. The AI
 * client sees a blocked tool call with the violation reasons and can
 * adjust its plan.
 *
 * Wire format: MCP uses line-delimited JSON-RPC 2.0 over stdio. Each
 * message is one JSON object followed by `\n`. This module speaks raw
 * JSON-RPC rather than using the SDK so it can wrap *any* MCP server.
 *
 * Architecture (transport layer is built on top of the policy layer):
 *
 *     stdin ─► LineSplitter ─► onIncoming(parsed) ─► policy.handleClient ─► forward/block
 *                                                                            │
 *                                                                            ▼
 *                                                                   child.stdin
 *                                                                            │
 *                                                                   child.stdout
 *                                                                            │
 *     stdout ◄─ LineSplitter ◄─ onOutgoing(parsed) ◄─ policy.handleServer ◄──┘
 *
 * `policy.handleClient` is the only thing that needs business logic.
 * Everything else is line splitting + dispatch + JSON.parse/stringify.
 * Tests exercise policy.handleClient directly; the integration smoke
 * test only validates that the dispatcher wiring is sane.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_BLOCK_THRESHOLD = 'HIGH'; // SAFE | LOW | MEDIUM | HIGH
const RISK_RANK = { SAFE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

/**
 * Default set of intercepted tool names. We match on the suffix after
 * the last `/` and `_`, case-insensitive — accommodates `fs/write_file`,
 * `filesystem.write_file`, `textEditor/edit`, etc., across whatever
 * naming convention the inner MCP server uses.
 *
 * The match is suffix-based, not exact, because every MCP server names
 * its tools slightly differently. Better to over-intercept and skip
 * non-write operations than to miss a high-risk write because of a
 * naming mismatch.
 */
const DEFAULT_WRITE_TOOL_PATTERNS = [
  /(^|[/_.])write_?file$/i,
  /(^|[/_.])write_text_file$/i,
  /(^|[/_.])edit_?file$/i,
  /(^|[/_.])edit$/i,                  // text_editor/edit
  /(^|[/_.])create_file$/i,
  /(^|[/_.])replace$/i,               // some servers use generic "replace"
  /(^|[/_.])apply_patch$/i,
];

/**
 * MiddlewareProxy — the policy core. Pure JS, no I/O — every external
 * resource is injected (validate, readFile). Makes the unit tests
 * trivial and the transport layer's job a thin wire.
 *
 * Constructor options:
 *   - projectRoot:   absolute path used to resolve relative tool args
 *   - validate(diff): function returning the validateDiff() result
 *                    synchronously. Injected so tests can mock it.
 *   - blockThreshold: 'HIGH' | 'MEDIUM' | 'LOW' (defaults to HIGH)
 *   - readFile(path): function returning the current on-disk contents
 *                     (or '' if missing). Injected for tests.
 *   - toolPatterns:  Array<RegExp> overriding DEFAULT_WRITE_TOOL_PATTERNS.
 */
class MiddlewareProxy {
  constructor(opts = {}) {
    if (!opts.validate || typeof opts.validate !== 'function') {
      throw new Error('MiddlewareProxy: opts.validate (function) is required');
    }
    this.projectRoot = opts.projectRoot || process.cwd();
    this.validate = opts.validate;
    this.blockThreshold = (opts.blockThreshold || DEFAULT_BLOCK_THRESHOLD).toUpperCase();
    if (!(this.blockThreshold in RISK_RANK)) {
      throw new Error(`blockThreshold must be SAFE|LOW|MEDIUM|HIGH (got ${this.blockThreshold})`);
    }
    this.readFile = opts.readFile || ((p) => {
      try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
    });
    this.toolPatterns = opts.toolPatterns || DEFAULT_WRITE_TOOL_PATTERNS;
  }

  /**
   * isWriteTool(name) → boolean
   *
   * True when the tool name matches any configured write pattern.
   * Matching is case-insensitive and suffix-based — see comment on
   * DEFAULT_WRITE_TOOL_PATTERNS for why.
   */
  isWriteTool(name) {
    if (typeof name !== 'string') return false;
    return this.toolPatterns.some((re) => re.test(name));
  }

  /**
   * extractWriteIntent(toolName, args) → { path, newContent } | null
   *
   * Normalize the diverse argument shapes used by different MCP write
   * tools into one canonical shape. Returns null when we can't make
   * sense of the args — the call passes through unchanged in that case.
   *
   * Recognized shapes:
   *   write_file:        { path, content | contents | text }
   *   text_editor/edit:  { path | file, old_string, new_string }
   *                      → synthesize newContent by replacing old→new
   *                        in the on-disk content. If old_string isn't
   *                        present in the file, we conservatively skip
   *                        validation rather than guessing.
   *   apply_patch:       { path, patch } — already a diff. Pass it
   *                      through to validate() directly (no synthesis).
   */
  extractWriteIntent(toolName, args) {
    if (!args || typeof args !== 'object') return null;

    const filePath = args.path || args.file || args.file_path || args.filename || args.target;
    if (!filePath || typeof filePath !== 'string') return null;

    // apply_patch: args.patch is already a unified diff.
    if (/(apply_)?patch/i.test(toolName) && typeof args.patch === 'string') {
      return { path: filePath, prebuiltDiff: args.patch };
    }

    // write_file family.
    const direct =
      typeof args.content === 'string' ? args.content :
      typeof args.contents === 'string' ? args.contents :
      typeof args.text === 'string' ? args.text :
      typeof args.new_content === 'string' ? args.new_content :
      null;
    if (direct !== null) return { path: filePath, newContent: direct };

    // text_editor/edit family.
    if (typeof args.old_string === 'string' && typeof args.new_string === 'string') {
      const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.projectRoot, filePath);
      const oldDisk = this.readFile(absPath);
      if (!oldDisk.includes(args.old_string)) return null; // we don't know
      const newContent = oldDisk.replace(args.old_string, args.new_string);
      return { path: filePath, newContent, oldContent: oldDisk };
    }

    return null;
  }

  /**
   * synthesizeDiff(relPath, oldContent, newContent) → string
   *
   * Build a minimal unified-diff string the validateDiff parser can
   * consume. We don't try to compute hunks — just emit one big hunk
   * that removes all old lines and adds all new lines. That's
   * suboptimal as a diff representation but correct for validation:
   * the validator cares about added imports + which file changed.
   *
   * For brand-new files, oldContent is '' and the header signals an add.
   */
  synthesizeDiff(relPath, oldContent, newContent) {
    const oldLines = oldContent === '' ? [] : oldContent.split('\n');
    const newLines = newContent === '' ? [] : newContent.split('\n');
    // Drop a trailing empty line caused by a final \n — the diff parser
    // is happier with it gone.
    if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
    if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();

    const out = [];
    const isAdd = oldContent === '';
    if (isAdd) {
      out.push(`diff --git a/${relPath} b/${relPath}`);
      out.push(`new file mode 100644`);
      out.push(`--- /dev/null`);
      out.push(`+++ b/${relPath}`);
      out.push(`@@ -0,0 +1,${newLines.length} @@`);
      for (const l of newLines) out.push(`+${l}`);
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

  /**
   * shouldBlock(result) → boolean
   *
   * True when the validateDiff result's risk meets/exceeds the
   * configured block threshold.
   */
  shouldBlock(result) {
    if (!result || !result.risk) return false;
    return RISK_RANK[result.risk] >= RISK_RANK[this.blockThreshold];
  }

  /**
   * buildBlockResponse(id, validation, toolName, intent) → JSON-RPC msg
   *
   * MCP convention for tool errors is to return a *success* JSON-RPC
   * response whose content includes `isError: true`. This lets the
   * model see the violation reasons and adjust, rather than crashing
   * the tool dispatch loop.
   */
  buildBlockResponse(id, validation, toolName, intent) {
    const lines = [];
    lines.push(`🚫 Carto blocked this write — risk: ${validation.risk}.`);
    lines.push('');
    lines.push(`Tool:  ${toolName}`);
    lines.push(`File:  ${intent.path}`);
    lines.push('');
    if (validation.blast_radius && validation.blast_radius.union) {
      lines.push(`Blast radius (union): ${validation.blast_radius.union} files`);
    }
    if (validation.violations && validation.violations.length > 0) {
      lines.push('');
      lines.push(`Violations (${validation.violations.length}):`);
      for (const v of validation.violations) {
        lines.push(`  • [${v.severity}] ${v.message}`);
      }
    }
    if (validation.suggestions && validation.suggestions.length > 0) {
      lines.push('');
      lines.push('Suggestions:');
      for (const s of validation.suggestions) {
        lines.push(`  • ${s.message}`);
      }
    }
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: true,
      },
    };
  }

  /**
   * handleClient(msg) → { intercept: false } | { intercept: true, response }
   *
   * Examines an incoming client→server message. If the message is a
   * `tools/call` against a write tool AND validation triggers a block,
   * returns the synthesized block response. Otherwise signals
   * "forward as-is" (intercept: false).
   *
   * Pure function — relies only on injected deps. Tests call this
   * directly.
   */
  handleClient(msg) {
    if (!msg || msg.method !== 'tools/call') return { intercept: false };
    const params = msg.params || {};
    const name = params.name;
    if (!this.isWriteTool(name)) return { intercept: false };

    const intent = this.extractWriteIntent(name, params.arguments || {});
    if (!intent) return { intercept: false };

    let diffText;
    if (intent.prebuiltDiff) {
      diffText = intent.prebuiltDiff;
    } else {
      const relPath = path.isAbsolute(intent.path)
        ? path.relative(this.projectRoot, intent.path)
        : intent.path;
      const oldContent =
        typeof intent.oldContent === 'string'
          ? intent.oldContent
          : this.readFile(
              path.isAbsolute(intent.path) ? intent.path : path.join(this.projectRoot, intent.path),
            );
      diffText = this.synthesizeDiff(relPath, oldContent, intent.newContent || '');
    }

    let validation;
    try {
      validation = this.validate(diffText);
    } catch {
      // Validator failed — fail open. Better to permit a write than to
      // block AI tooling because the index isn't ready.
      return { intercept: false };
    }

    if (this.shouldBlock(validation)) {
      return {
        intercept: true,
        response: this.buildBlockResponse(msg.id, validation, name, intent),
      };
    }
    return { intercept: false };
  }
}

/**
 * LineSplitter — splits a stream of stdin chunks into JSON-RPC frames
 * separated by `\n`. Each complete line is parsed with JSON.parse and
 * dispatched via `onMessage`. Malformed lines are logged to stderr but
 * don't crash the proxy — robustness is more important than strictness
 * for a process whose job is to stay alive between two other processes.
 *
 * MCP uses LSP-style framing in some implementations (Content-Length
 * headers + body), but the stdio transport in the SDK is line-delimited
 * — the SDK's stdio transport explicitly writes JSON.stringify(msg)+'\n'.
 * We match that.
 */
class LineSplitter {
  constructor(onMessage, label) {
    this.onMessage = onMessage;
    this.label = label || 'stream';
    this.buf = '';
  }

  feed(chunk) {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); }
      catch (err) {
        process.stderr.write(`[carto-middleware] malformed JSON on ${this.label}: ${err.message}\n`);
        continue;
      }
      this.onMessage(parsed);
    }
  }
}

/**
 * runProxy({ projectRoot, innerCmd, innerArgs, blockThreshold, ... })
 *
 * Spawns the inner MCP server and wires stdin/stdout in both
 * directions through MiddlewareProxy.handleClient. Returns the child
 * process so the caller (CLI) can install signal handlers if needed.
 *
 * Test injection points:
 *   - `spawn`     : override child_process.spawn (mock the inner)
 *   - `clientIn`  : Readable stream to read client messages from
 *   - `clientOut` : Writable stream to send proxy→client messages
 */
function runProxy(opts) {
  const {
    projectRoot,
    innerCmd,
    innerArgs = [],
    blockThreshold,
    toolPatterns,
    spawn = require('child_process').spawn,
    clientIn = process.stdin,
    clientOut = process.stdout,
    stderr = process.stderr,
    validate,    // injected for tests; production builds its own (see below)
    readFile,
  } = opts;

  // Production validate function lazily constructs the SQLite store +
  // bitmap sidecar on first use and reuses them. We do this here so
  // tests can replace the whole thing with a mock.
  let realValidate = validate;
  if (!realValidate) {
    const { SQLiteStore } = require('../../store/sqlite-store');
    const { ensureBitmapFresh } = require('../../bitmap/index');
    const { validateDiff } = require('../validate');
    let store = null;
    let sidecar = null;
    realValidate = (diffText) => {
      const cartoDir = path.join(projectRoot, '.carto');
      if (!fs.existsSync(path.join(cartoDir, 'carto.db'))) {
        // No index — fail open by returning a SAFE result.
        return { diff: [], blast_radius: { perFile: {}, union: 0 }, violations: [], suggestions: [], risk: 'SAFE' };
      }
      if (!store) {
        store = new SQLiteStore(projectRoot);
        store.open({ readonly: true });
        try { sidecar = ensureBitmapFresh(cartoDir, store); }
        catch { sidecar = null; }
      }
      return validateDiff(store, sidecar, diffText);
    };
  }

  const policy = new MiddlewareProxy({
    projectRoot,
    validate: realValidate,
    blockThreshold,
    toolPatterns,
    readFile,
  });

  if (!innerCmd) {
    throw new Error('runProxy: innerCmd is required (the inner MCP server executable)');
  }

  const child = spawn(innerCmd, innerArgs, {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  // server → client passthrough
  const fromServer = new LineSplitter((msg) => {
    clientOut.write(JSON.stringify(msg) + '\n');
  }, 'server.stdout');
  child.stdout.on('data', (chunk) => fromServer.feed(chunk));

  // client → server with interception
  const fromClient = new LineSplitter((msg) => {
    const decision = policy.handleClient(msg);
    if (decision.intercept) {
      // Block: respond directly to the client, don't forward to server.
      clientOut.write(JSON.stringify(decision.response) + '\n');
      // Log the block to stderr so operators can see what's happening.
      stderr.write(
        `[carto-middleware] blocked tools/call name=${(msg.params && msg.params.name) || '?'} ` +
        `risk=${decision.response.result.content[0].text.match(/risk: (\w+)/) ? decision.response.result.content[0].text.match(/risk: (\w+)/)[1] : 'unknown'}\n`,
      );
      return;
    }
    if (child.stdin.writable) child.stdin.write(JSON.stringify(msg) + '\n');
  }, 'client.stdin');
  clientIn.on('data', (chunk) => fromClient.feed(chunk));

  // Tear-down: if either end goes away, propagate.
  clientIn.on('end', () => { try { child.stdin.end(); } catch {} });
  child.on('exit', (code) => {
    // Mirror the inner server's exit code so the AI client sees the
    // same lifecycle as without the middleware.
    process.exit(code || 0);
  });

  return child;
}

module.exports = {
  MiddlewareProxy,
  LineSplitter,
  runProxy,
  DEFAULT_WRITE_TOOL_PATTERNS,
  RISK_RANK,
};
