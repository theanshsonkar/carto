#!/usr/bin/env node
'use strict';

/**
 * `carto doctor` — diagnose common issues with the carto installation
 * and the local index, then print actionable fixes.
 *
 * Each check returns one of:
 *   - 'ok'    — pass, no action needed
 *   - 'warn'  — degraded but functional (e.g. bitmap stale)
 *   - 'fail'  — broken, action required (e.g. no index)
 *
 * Output shape (human-readable):
 *
 *   ✓ Node version (v20.10.0 — supported)
 *   ✓ better-sqlite3 native module loaded
 *   ⚠ tree-sitter-rust optional grammar not installed
 *       Fix: npm install -g tree-sitter-rust  (only needed for .rs files)
 *   ✗ No .carto/carto.db at <root>
 *       Fix: carto init
 *
 * Exit codes:
 *   0 if every check is 'ok' or 'warn'
 *   1 if any check is 'fail'
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const REQUIRED_NODE_MAJOR = 18;
const NATIVE_DEPS = [
  ['better-sqlite3', 'better-sqlite3'],
  ['tree-sitter', 'tree-sitter'],
];
const OPTIONAL_GRAMMARS = [
  'tree-sitter-javascript',
  'tree-sitter-typescript',
  'tree-sitter-python',
  'tree-sitter-go',
  'tree-sitter-rust',
  'tree-sitter-java',
  'tree-sitter-cpp',
  'tree-sitter-c-sharp',
];

/**
 * Run all checks. Returns:
 *   { results: [{ id, status, label, detail?, fix? }], ok: bool }
 */
function diagnose(projectRoot) {
  const results = [];

  // ─── Node version ───────────────────────────────────────────────
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  results.push({
    id: 'node-version',
    status: nodeMajor >= REQUIRED_NODE_MAJOR ? 'ok' : 'fail',
    label: `Node ${process.versions.node}`,
    detail: nodeMajor >= REQUIRED_NODE_MAJOR ? 'supported' : `requires ≥ v${REQUIRED_NODE_MAJOR}`,
    fix: nodeMajor >= REQUIRED_NODE_MAJOR ? null : `Install Node ≥ v${REQUIRED_NODE_MAJOR} (https://nodejs.org/).`,
  });

  // ─── Required native deps ───────────────────────────────────────
  for (const [pkg, label] of NATIVE_DEPS) {
    let loaded = false;
    let err = null;
    try { require(pkg); loaded = true; }
    catch (e) { err = e; }
    results.push({
      id: `native-${pkg}`,
      status: loaded ? 'ok' : 'fail',
      label: `Native module: ${label}`,
      detail: loaded ? 'loaded' : `failed: ${err && err.code ? err.code : err && err.message ? err.message.split('\n')[0] : 'unknown'}`,
      fix: loaded
        ? null
        : `Reinstall the package: \`npm install -g carto-md\`. If that fails, you may need a C++ toolchain (Xcode CLT / build-essential / MSVC Build Tools). See README.md → "What Carto never does" for prebuilt-binary platforms.`,
    });
  }

  // ─── Optional tree-sitter grammars ──────────────────────────────
  // Listed as `warn` (not `fail`) because the postinstall script
  // intentionally marks the missing ones as unavailable_languages_json
  // and Carto degrades to regex extraction for those files.
  const missingGrammars = [];
  for (const gr of OPTIONAL_GRAMMARS) {
    try { require(gr); }
    catch { missingGrammars.push(gr); }
  }
  if (missingGrammars.length === 0) {
    results.push({
      id: 'grammars',
      status: 'ok',
      label: 'Tree-sitter grammars',
      detail: `all ${OPTIONAL_GRAMMARS.length} present`,
    });
  } else {
    results.push({
      id: 'grammars',
      status: 'warn',
      label: 'Tree-sitter grammars',
      detail: `${missingGrammars.length} of ${OPTIONAL_GRAMMARS.length} missing: ${missingGrammars.join(', ')}`,
      fix: 'These are optional. Files in those languages will use regex extraction (slightly less accurate). To install: `npm install -g <package-name>`.',
    });
  }

  // ─── .carto directory ───────────────────────────────────────────
  const cartoDir = path.join(projectRoot, '.carto');
  const dbPath = path.join(cartoDir, 'carto.db');
  const dbExists = fs.existsSync(dbPath);
  results.push({
    id: 'index-exists',
    status: dbExists ? 'ok' : 'fail',
    label: `Index at .carto/carto.db`,
    detail: dbExists ? `present (${fileSize(dbPath)})` : 'missing',
    fix: dbExists ? null : 'Run `carto init` to create the index.',
  });

  // Subsequent checks need the index — skip if not present.
  if (!dbExists) return finish(results);

  // ─── Bitmap sidecar freshness ───────────────────────────────────
  const bitmapPath = path.join(cartoDir, 'bitmap.bin');
  const bitmapExists = fs.existsSync(bitmapPath);
  if (!bitmapExists) {
    results.push({
      id: 'bitmap',
      status: 'warn',
      label: 'Bitmap sidecar',
      detail: 'missing — will rebuild on next MCP query',
      fix: 'Optional: run `carto sync` to rebuild it now.',
    });
  } else {
    const bmMtime = fs.statSync(bitmapPath).mtimeMs;
    const dbMtime = fs.statSync(dbPath).mtimeMs;
    const stale = bmMtime < dbMtime;
    results.push({
      id: 'bitmap',
      status: stale ? 'warn' : 'ok',
      label: 'Bitmap sidecar',
      detail: stale ? `stale (older than DB by ${Math.round((dbMtime - bmMtime) / 1000)}s)` : 'fresh',
      fix: stale ? 'Optional: run `carto sync` to rebuild it.' : null,
    });
  }

  // ─── Git hooks ──────────────────────────────────────────────────
  const gitDir = path.join(projectRoot, '.git');
  if (fs.existsSync(gitDir)) {
    const hookNames = ['pre-commit', 'post-checkout', 'post-merge', 'post-rewrite'];
    const installed = hookNames.filter((h) => {
      const p = path.join(gitDir, 'hooks', h);
      try {
        const text = fs.readFileSync(p, 'utf8');
        return text.includes('carto sync') || text.includes('carto-md');
      } catch { return false; }
    });
    results.push({
      id: 'git-hooks',
      status: installed.length === hookNames.length ? 'ok' :
              installed.length > 0 ? 'warn' : 'warn',
      label: 'Git hooks (pre-commit, post-checkout, post-merge, post-rewrite)',
      detail: `${installed.length} of ${hookNames.length} installed${installed.length < hookNames.length ? ' — index may go stale on git events' : ''}`,
      fix: installed.length < hookNames.length
        ? 'Re-run `carto init` to install missing hooks (existing hooks are preserved).'
        : null,
    });
  } else {
    results.push({
      id: 'git-hooks',
      status: 'warn',
      label: 'Git hooks',
      detail: 'no .git directory — hooks can\'t fire',
      fix: 'Not a git repo. Carto still works; the index will only refresh on explicit `carto sync` or MCP lazy re-parse.',
    });
  }

  // ─── .cartoignore conflicts ─────────────────────────────────────
  const cartoIgnore = path.join(projectRoot, '.cartoignore');
  if (fs.existsSync(cartoIgnore)) {
    try {
      const text = fs.readFileSync(cartoIgnore, 'utf8');
      // Sanity: warn if user accidentally excluded their own source tree.
      const looksWrong = /^(src|app|lib)\/?$/m.test(text);
      results.push({
        id: 'cartoignore',
        status: looksWrong ? 'warn' : 'ok',
        label: '.cartoignore',
        detail: looksWrong
          ? 'looks like a top-level source directory is excluded — check syntax'
          : 'present, no obvious conflicts',
        fix: looksWrong ? 'Review .cartoignore — exclusions are gitignore-style patterns relative to project root.' : null,
      });
    } catch { /* unreadable — skip */ }
  }

  // ─── MCP wiring presence ────────────────────────────────────────
  // Best-effort: detect at least one IDE config file. We don't probe
  // every supported IDE — just surface "no wiring detected anywhere".
  const wiringCandidates = [
    path.join(os.homedir(), '.cursor', 'mcp.json'),
    path.join(os.homedir(), '.kiro', 'settings', 'mcp.json'),
    path.join(os.homedir(), '.codex', 'config.toml'),
    path.join(projectRoot, '.mcp.json'),
    path.join(projectRoot, '.vscode', 'mcp.json'),
  ];
  const wired = wiringCandidates.filter((p) => fs.existsSync(p));
  results.push({
    id: 'mcp-wiring',
    status: wired.length > 0 ? 'ok' : 'warn',
    label: 'MCP configuration',
    detail: wired.length > 0
      ? `${wired.length} config file${wired.length === 1 ? '' : 's'} detected`
      : 'no MCP config files found for the common IDEs',
    fix: wired.length > 0 ? null : 'Re-run `carto init` to auto-wire MCP into any installed AI tools, or see README.md → "Use it with your AI tool" for manual config.',
  });

  return finish(results);
}

function finish(results) {
  const ok = !results.some((r) => r.status === 'fail');
  return { results, ok };
}

function fileSize(p) {
  try {
    const n = fs.statSync(p).size;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  } catch { return 'n/a'; }
}

function render(out) {
  const lines = [];
  for (const r of out.results) {
    const icon = r.status === 'ok' ? '✓' : r.status === 'warn' ? '⚠' : '✗';
    lines.push(`${icon} ${r.label}${r.detail ? ` (${r.detail})` : ''}`);
    if (r.fix) lines.push(`    Fix: ${r.fix}`);
  }
  lines.push('');
  lines.push(out.ok ? '✓ All required checks pass.' : '✗ At least one required check failed — see Fix lines above.');
  return lines.join('\n');
}

function run({ argv, stdout, stderr, projectRoot } = {}) {
  argv = argv || process.argv.slice(3);
  stdout = stdout || process.stdout;
  stderr = stderr || process.stderr;
  projectRoot = projectRoot || process.cwd();

  const json = argv.includes('--json');
  const help = argv.includes('--help') || argv.includes('-h');
  if (help) {
    stdout.write(`\nUsage: carto doctor [--json]\n\nDiagnose common issues with the carto installation and local index.\nExits 1 if any check fails (the index is missing or a native module is broken).\n\n`);
    return 0;
  }
  let out;
  try { out = diagnose(projectRoot); }
  catch (err) {
    stderr.write(`[CARTO] doctor failed: ${err.message}\n`);
    return 1;
  }
  if (json) stdout.write(JSON.stringify(out, null, 2) + '\n');
  else stdout.write(render(out) + '\n');
  return out.ok ? 0 : 1;
}

module.exports = { run, diagnose, render };
if (require.main === module) process.exit(run());
