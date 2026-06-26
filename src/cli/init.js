const fs = require('fs');
const path = require('path');
const { detectFramework } = require('../detector/framework');
const { parseCartoIgnore } = require('../security/ignore');
const { runSync, discoverFiles: discoverFilesV2 } = require('../store/sync');
const { checkForUpdate } = require('./update-check');

const REQUIRED_NODE_MAJOR = 18;
const LARGE_REPO_THRESHOLD = 100_000;

/**
 * Pre-flight checks that block or warn before we touch the filesystem.
 * Returns true if init should proceed, false if it should bail.
 */
function preflightChecks(projectRoot) {
  // Node version — postinstall blocks too, but a defensive double-check
  // costs nothing and gives the user a clearer message than a crash 30
  // lines later.
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < REQUIRED_NODE_MAJOR) {
    console.error(
      `[CARTO] Node ${process.versions.node} is too old. ` +
      `carto-md requires Node ≥ v${REQUIRED_NODE_MAJOR}. ` +
      `Upgrade at https://nodejs.org/ and re-run.`,
    );
    return false;
  }

  // Already-initialized notice — we don't refuse to re-init, just call
  // it out so the user knows what's happening.
  const cartoDir = path.join(projectRoot, '.carto');
  const dbPath = path.join(cartoDir, 'carto.db');
  if (fs.existsSync(dbPath)) {
    console.log('[CARTO] Re-indexing existing project (run `carto remove` first to start fresh).');
  }

  // Submodules warning — `discoverFiles` may or may not descend into
  // them depending on .cartoignore. We surface so the user can choose.
  const gitmodules = path.join(projectRoot, '.gitmodules');
  if (fs.existsSync(gitmodules)) {
    try {
      const text = fs.readFileSync(gitmodules, 'utf8');
      const count = (text.match(/\[submodule /g) || []).length;
      if (count > 0) {
        console.log(`[CARTO] Detected ${count} git submodule${count === 1 ? '' : 's'}. ` +
          `Add their paths to .cartoignore if you don't want them indexed.`);
      }
    } catch { /* ignore */ }
  }

  // No .git? Hooks won't fire — git-based freshness mechanism is gone.
  // Lazy MCP re-parse still handles staleness, but operators should know.
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    console.log('[CARTO] No .git directory — skipping git-hooks install. The index will refresh on `carto sync` and on MCP queries.');
  }

  return true;
}

/**
 * Render a small box with the headline numbers + one surprising fact
 * after the first sync completes. The "mirror moment" — Carto reflects
 * something the developer didn't already know.
 */
function printSummaryBox(projectRoot) {
  try {
    const { SQLiteStore } = require('../store/sqlite-store');
    const store = new SQLiteStore(projectRoot);
    store.open({ readonly: true });
    const structure = store.getStructure();
    const domains = store.getDomainsList() || [];
    const highImpact = store.getHighImpactFiles(1) || [];
    const crossDomain = store.getCrossDomainDeps() || [];
    store.close();

    const totalFiles = (structure.meta && structure.meta.totalFiles) || 0;
    const totalRoutes = (structure.meta && structure.meta.totalRoutes) || 0;
    const totalImports = (structure.meta && structure.meta.totalImportEdges) || 0;
    if (totalFiles === 0) return; // empty repo — skip the box

    const topDomains = domains.slice().sort((a, b) => b.fileCount - a.fileCount).slice(0, 4);
    const lines = [];
    lines.push('');
    lines.push('┌─ Carto · indexed ─────────────────────────────────────────');
    lines.push(`│  ${totalFiles} file${totalFiles === 1 ? '' : 's'} · ${domains.length} domain${domains.length === 1 ? '' : 's'} · ${totalRoutes} route${totalRoutes === 1 ? '' : 's'} · ${totalImports} import edge${totalImports === 1 ? '' : 's'}`);
    if (topDomains.length > 0) {
      lines.push('│');
      lines.push('│  Top domains:');
      for (const d of topDomains) {
        lines.push(`│    ${d.name.padEnd(12)} (${d.fileCount} file${d.fileCount === 1 ? '' : 's'})`);
      }
    }
    // The "mirror moment" — facts the user couldn't have known.
    if (highImpact.length > 0) {
      const top = highImpact[0];
      const filePath = top.path || top.file || top;
      const deps = top.centrality || top.dependents || top.dependentCount;
      if (deps && deps > 0) {
        lines.push('│');
        lines.push(`│  💡 Highest-risk file: ${filePath}`);
        const verb = deps === 1 ? 'file depends' : 'files depend';
        lines.push(`│     (${deps} ${verb} on it — try \`carto why ${filePath}\`)`);
      }
    }
    if (crossDomain.length > 0) {
      lines.push('│');
      lines.push(`│  ⚠️  ${crossDomain.length} cross-domain edge${crossDomain.length === 1 ? '' : 's'} — run \`carto check\` for details.`);
    }
    lines.push('└───────────────────────────────────────────────────────────');
    lines.push('');
    console.log(lines.join('\n'));
  } catch (err) {
    // Box is decorative — never let it fail the init flow.
    if (process.env.CARTO_DEBUG) console.error(`[CARTO] (debug) summary box failed: ${err.message}`);
  }
}

async function run(projectRoot) {
  checkForUpdate(); // fire and forget
  if (!preflightChecks(projectRoot)) return;
  console.log('[CARTO] Detecting project...');

  const detection = detectFramework(projectRoot);
  console.log(`[CARTO] Detected: ${detection.framework} (${detection.language})`);

  // Discover every file with no cap. The single-line counter refreshes
  // every 500 files so users on big repos don't stare at a frozen
  // "Detecting..." prompt for seconds.
  const isTty = !!(process.stdout.isTTY && process.stdout.clearLine);
  let lastTickAt = 0;
  const onProgress = (count) => {
    if (!isTty) return;
    const now = Date.now();
    if (now - lastTickAt < 50) return;  // throttle to ~20 Hz
    lastTickAt = now;
    process.stdout.write(`\r[CARTO] Discovering files: ${count.toLocaleString()}`);
  };
  const relFiles = discoverFilesV2(projectRoot, { onProgress });
  if (isTty) process.stdout.write(`\r[CARTO] Discovered ${relFiles.length.toLocaleString()} source files.\n`);

  // Large-repo ETA — at >100K files, indexing takes minutes, not
  // seconds. Surface that so the user doesn't ctrl-C thinking we hung.
  if (relFiles.length > LARGE_REPO_THRESHOLD) {
    // Empirical: ~1ms / file for first-run on a recent laptop. Round
    // up generously — better to over-estimate than have the user wait
    // longer than promised.
    const etaSec = Math.ceil(relFiles.length / 1000);
    console.log(`[CARTO] Large repo (${relFiles.length.toLocaleString()} files). Estimated index time: ~${etaSec}s. Sit tight.`);
  }

  const pyCount = relFiles.filter(f => f.endsWith('.py')).length;
  const jsCount = relFiles.filter(f => /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(f)).length;
  const rCount = relFiles.filter(f => /\.[rR]$/.test(f)).length;
  const rsCount = relFiles.filter(f => f.endsWith('.rs')).length;
  const goCount = relFiles.filter(f => f.endsWith('.go')).length;

  const parts = [];
  if (jsCount > 0) parts.push(`${jsCount} JS/TS files`);
  if (pyCount > 0) parts.push(`${pyCount} Python files`);
  if (goCount > 0) parts.push(`${goCount} Go files`);
  if (rsCount > 0) parts.push(`${rsCount} Rust files`);
  if (rCount > 0) parts.push(`${rCount} R files`);
  console.log(`[CARTO] Found ${parts.join(', ') || '0 files'} (${relFiles.length} total)`);

  // Write .carto/config.json
  const cartoDir = path.join(projectRoot, '.carto');
  if (!fs.existsSync(cartoDir)) {
    fs.mkdirSync(cartoDir, { recursive: true });
  }

  const config = {
    version: '2',
    framework: detection.framework,
    language: detection.language,
    projectRoot: projectRoot,
    output: 'AGENTS.md',
    generated: new Date().toISOString()
  };

  fs.writeFileSync(
    path.join(cartoDir, 'config.json'),
    JSON.stringify(config, null, 2) + '\n',
    'utf-8'
  );

  // Install git hooks (silent freshness on git events)
  installGitHooks(projectRoot);

  // Run the first sync against the SQLite-backed indexer.
  await runSync({
    projectRoot,
    output: path.resolve(projectRoot, config.output || 'AGENTS.md')
  });

  // Auto-wire MCP config into installed AI tools
  wireIDEs(projectRoot);

  console.log('[CARTO] AGENTS.md generated. Index stays fresh via git hooks + lazy MCP re-parse.');

  // The "mirror moment" — print the headline numbers + a surprising
  // fact (highest-risk file, cross-domain count). Decorative, never
  // throws, gated on a valid index.
  printSummaryBox(projectRoot);
}

/**
 * installGitHooks(projectRoot)
 *
 * Installs four git hooks that call `carto sync` quietly:
 *   - pre-commit    fires on `git commit` before the commit lands
 *   - post-checkout fires after `git checkout` (branch switch, file checkout)
 *   - post-merge    fires after `git merge` and `git pull`
 *   - post-rewrite  fires after `git rebase` / `git commit --amend`
 *
 * Together these cover the 90% case of "user did a normal git operation,
 * index should re-sync." The remaining 10% (uncommitted edits) is handled
 * by the lazy mtime check in the MCP server.
 *
 * Hooks are idempotent: re-running `carto init` does not duplicate the
 * `carto sync` line. If a user already has a hook for other reasons, we
 * append non-destructively.
 */
function installGitHooks(projectRoot) {
  const gitDir = path.join(projectRoot, '.git');
  if (!fs.existsSync(gitDir)) return;

  const hooksDir = path.join(gitDir, 'hooks');
  if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });

  // Hook bodies. `>/dev/null 2>&1 || true` keeps git fast and never blocks
  // the user's git command if carto exits non-zero (e.g. transient lock).
  const HOOK_NAMES = ['pre-commit', 'post-checkout', 'post-merge', 'post-rewrite'];
  const HOOK_LINE = 'carto sync >/dev/null 2>&1 || true\n';
  const MARKER = '# carto-md: keep index fresh on git events';

  const installed = [];
  const skipped = [];

  for (const name of HOOK_NAMES) {
    const hookPath = path.join(hooksDir, name);

    if (fs.existsSync(hookPath)) {
      const existing = fs.readFileSync(hookPath, 'utf-8');
      if (existing.includes('carto sync')) {
        skipped.push(name);
        continue;
      }
      // Append to user's existing hook without clobbering it
      fs.appendFileSync(hookPath, `\n${MARKER}\n${HOOK_LINE}`);
    } else {
      fs.writeFileSync(hookPath, `#!/bin/sh\n${MARKER}\n${HOOK_LINE}`);
    }

    try { fs.chmodSync(hookPath, 0o755); } catch {}
    installed.push(name);
  }

  if (installed.length > 0) {
    console.log(`[CARTO] Git hooks installed: ${installed.join(', ')}`);
  }
  if (skipped.length > 0 && installed.length === 0) {
    console.log(`[CARTO] Git hooks already installed (${skipped.join(', ')}).`);
  }
}

// Back-compat alias — older code/tests import installGitHook.
const installGitHook = installGitHooks;

/**
 * binaryExists(name) → boolean
 *
 * Best-effort cross-platform check for whether a CLI is on the user's PATH.
 * Uses `which` on macOS/Linux and `where` on Windows. Returns false on any
 * error so the caller treats "couldn't tell" as "not present" — we'd rather
 * fall back to dir-based detection than write a config the user didn't want.
 *
 * Test escape hatch: `CARTO_TEST_BINARY_OVERRIDES=claude=1,codex=0` lets the
 * Init-flow suite drive each tool's detection deterministically without
 * depending on what's installed on the dev box. Comma-separated list of
 * `name=0|1` pairs; any binary not listed falls through to the real check.
 */
function binaryExists(name) {
  const override = process.env.CARTO_TEST_BINARY_OVERRIDES;
  if (override) {
    for (const pair of override.split(',')) {
      const [n, v] = pair.split('=');
      if (n && n.trim() === name) return v && v.trim() === '1';
    }
  }
  try {
    const { spawnSync } = require('child_process');
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(cmd, [name], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * claudeDesktopConfigPath() → string
 *
 * Platform-specific Claude Desktop MCP config location.
 *   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
 *   Windows: %APPDATA%\Claude\claude_desktop_config.json
 *   Linux:   ~/.config/Claude/claude_desktop_config.json (unofficial — Anthropic
 *            doesn't ship a Linux build, but community wrappers/Wine installs
 *            put it here, so we honor the path if the dir exists.)
 */
function claudeDesktopConfigPath() {
  const os = require('os');
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

/**
 * mergeMcpJson(filePath, key, entry) — JSON-style MCP config helper.
 *
 * Reads `filePath` (creates {} if missing), merges `entry` under `[key].carto`
 * (where `key` is `mcpServers` or `servers` depending on the host), writes it
 * back. Used by every JSON-based MCP host: Cursor, Kiro, Claude Code, Claude
 * Desktop, Windsurf, VS Code Copilot.
 *
 * Defensive against malformed existing JSON — a single bad config from another
 * tool can't block the rest of the wiring.
 */
function mergeMcpJson(filePath, key, entry) {
  let config = {};
  if (fs.existsSync(filePath)) {
    try {
      config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!config || typeof config !== 'object') config = {};
    } catch {
      // Existing file is malformed — start fresh rather than clobbering blindly.
      // Print a warning so the user knows we replaced it.
      console.warn(`[CARTO] ${filePath} was not valid JSON — rewriting.`);
      config = {};
    }
  }
  if (!config[key] || typeof config[key] !== 'object') config[key] = {};
  config[key].carto = entry;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * upsertCodexToml(filePath, projectRoot) — Append/replace a `[mcp_servers.carto]`
 * block in Codex's `config.toml`. We don't pull in a TOML parser dep — Codex's
 * MCP block has a stable, simple shape, so a small regex+rewrite is enough.
 *
 * Behavior:
 *   - File missing → write a fresh file with just the carto block.
 *   - File present, no carto block → append the block at the end (preserves
 *     all existing content + comments).
 *   - File present, carto block present → replace it in-place via regex.
 *
 * The block we write is exactly:
 *
 *   [mcp_servers.carto]
 *   command = "carto"
 *   args = ["serve"]
 *   cwd = "<project>"
 *   enabled = true
 */
function upsertCodexToml(filePath, projectRoot) {
  const tomlEscape = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const block = [
    '[mcp_servers.carto]',
    `command = ${tomlEscape('carto')}`,
    `args = [${tomlEscape('serve')}]`,
    `cwd = ${tomlEscape(projectRoot)}`,
    'enabled = true',
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, block, 'utf-8');
    return;
  }

  const existing = fs.readFileSync(filePath, 'utf-8');
  // Match the carto section header AND its body up to the next [section]
  // header or end of file. Note: NO `m` flag — we want `$` to mean
  // end-of-input, not end-of-line. The header `[mcp_servers.carto]` is
  // unique per TOML file, so we don't need a line-start anchor.
  const sectionRe = /\[mcp_servers\.carto\][\s\S]*?(?=\n\[|$)/;
  let next;
  if (sectionRe.test(existing)) {
    next = existing.replace(sectionRe, block.trimEnd());
    // Ensure trailing newline.
    if (!next.endsWith('\n')) next += '\n';
  } else {
    // Append. Make sure existing content ends with a newline before the new block.
    next = existing.endsWith('\n') ? existing + '\n' + block : existing + '\n\n' + block;
  }
  fs.writeFileSync(filePath, next, 'utf-8');
}

function wireIDEs(projectRoot) {
  const os = require('os');
  const home = os.homedir();
  const wired = [];
  const errors = [];

  // ─── Cursor ────────────────────────────────────────────────────────
  // Detection: `~/.cursor/` exists. Path stable across macOS/Linux/Windows.
  if (fs.existsSync(path.join(home, '.cursor'))) {
    try {
      mergeMcpJson(
        path.join(home, '.cursor', 'mcp.json'),
        'mcpServers',
        { command: 'carto', args: ['serve'], cwd: projectRoot }
      );
      wired.push('Cursor');
    } catch (err) { errors.push(`Cursor: ${err.message}`); }
  }

  // ─── Claude Code ───────────────────────────────────────────────────
  // Detection: `claude` binary OR `~/.claude/` directory exists. Without
  // this gating we'd write `.mcp.json` into every project regardless of
  // whether the user has Claude Code installed.
  if (binaryExists('claude') || fs.existsSync(path.join(home, '.claude'))) {
    try {
      mergeMcpJson(
        path.join(projectRoot, '.mcp.json'),
        'mcpServers',
        { command: 'carto', args: ['serve'] }
      );
      wired.push('Claude Code');
    } catch (err) { errors.push(`Claude Code: ${err.message}`); }
  }

  // ─── Kiro ──────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(home, '.kiro'))) {
    try {
      mergeMcpJson(
        path.join(home, '.kiro', 'settings', 'mcp.json'),
        'mcpServers',
        { command: 'carto', args: ['serve'], cwd: projectRoot }
      );
      wired.push('Kiro');
    } catch (err) { errors.push(`Kiro: ${err.message}`); }
  }

  // ─── Claude Desktop (cross-platform) ───────────────────────────────
  // macOS: ~/Library/Application Support/Claude/
  // Windows: %APPDATA%\Claude\
  // Linux: ~/.config/Claude/ (unofficial)
  const claudeCfgPath = claudeDesktopConfigPath();
  if (fs.existsSync(path.dirname(claudeCfgPath))) {
    try {
      mergeMcpJson(
        claudeCfgPath,
        'mcpServers',
        { command: 'carto', args: ['serve'], cwd: projectRoot }
      );
      wired.push('Claude Desktop');
    } catch (err) { errors.push(`Claude Desktop: ${err.message}`); }
  }

  // ─── Codex ─────────────────────────────────────────────────────────
  // Detection: `codex` binary OR `~/.codex/` directory exists.
  // Format: TOML with `[mcp_servers.carto]` block.
  if (binaryExists('codex') || fs.existsSync(path.join(home, '.codex'))) {
    try {
      upsertCodexToml(path.join(home, '.codex', 'config.toml'), projectRoot);
      wired.push('Codex');
    } catch (err) { errors.push(`Codex: ${err.message}`); }
  }

  // ─── Windsurf ──────────────────────────────────────────────────────
  // Path: ~/.codeium/windsurf/mcp_config.json (NOT ~/.windsurf/, which
  // older docs sometimes show — the real path lives under .codeium).
  if (fs.existsSync(path.join(home, '.codeium', 'windsurf'))
      || fs.existsSync(path.join(home, '.codeium'))) {
    try {
      mergeMcpJson(
        path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
        'mcpServers',
        { command: 'carto', args: ['serve'], cwd: projectRoot }
      );
      wired.push('Windsurf');
    } catch (err) { errors.push(`Windsurf: ${err.message}`); }
  }

  // ─── VS Code Copilot ───────────────────────────────────────────────
  // Detection: `code` binary on PATH (most reliable; user-profile path
  // varies too much across macOS/Linux/Windows + Insiders/stable to be
  // a good detection signal). Schema differs from the standard MCP shape:
  // VS Code uses `servers` (not `mcpServers`) and requires `type: stdio`.
  if (binaryExists('code')) {
    try {
      mergeMcpJson(
        path.join(projectRoot, '.vscode', 'mcp.json'),
        'servers',
        { type: 'stdio', command: 'carto', args: ['serve'] }
      );
      wired.push('VS Code Copilot');
    } catch (err) { errors.push(`VS Code Copilot: ${err.message}`); }
  }

  // ─── Reporting ─────────────────────────────────────────────────────
  if (wired.length > 0) {
    console.log(`[CARTO] MCP auto-wired into: ${wired.join(', ')}`);
  } else {
    console.log('[CARTO] No supported AI tools detected for auto-wiring.');
    console.log('[CARTO] See https://github.com/theanshsonkar/carto#use-it-with-your-ai-tool for manual config.');
  }
  if (errors.length > 0) {
    for (const e of errors) console.warn(`[CARTO] Could not wire: ${e}`);
  }
}

module.exports = { run };

// Test-only exports — surfaced for the Init flow suite to assert detection
// + format behavior in isolation. Not part of the public API.
module.exports._internal = {
  binaryExists,
  claudeDesktopConfigPath,
  mergeMcpJson,
  upsertCodexToml,
  wireIDEs,
};
