#!/usr/bin/env node
'use strict';

/**
 * `carto why <file>` — 3-line summary of a file: what it does, what
 * depends on it, what it depends on. Mirrors the MCP `get_file_summary`
 * tool but addressable from the terminal.
 *
 * Output:
 *   src/store/sqlite-store.js
 *   ─────────────────────────
 *   Domain: DATABASE · 24 files depend on this · 8 imports.
 *   Exports: open() (function), close() (function), getMeta() (function).
 *   Imports: src/store/migrate.js, src/security/ignore.js, …
 *   Imported by: src/cli/init.js, src/cli/serve.js, src/cli/sync.js, …
 *
 * Use `--json` for a structured payload.
 */

const path = require('path');
const { SQLiteStore } = require('../store/sqlite-store');
const { normalizeFileArg } = require('../store/path-utils');

function collect(projectRoot, fileArg) {
  const store = new SQLiteStore(projectRoot);
  store.open({ readonly: true });
  try {
    const file = normalizeFileArg(projectRoot, fileArg);
    const row = store.getFileByPath(file);
    if (!row) return { error: `File not in index: ${fileArg}`, file };
    const domain = store.getDomainForFile(file) || 'CORE';
    const dependents = store.getBlastRadius(file) || [];
    const nb = store.getNeighbors(file, 1);
    const exports_ = store.db.prepare(
      'SELECT name, kind FROM symbols WHERE file_id = ? AND exported = 1 LIMIT 8'
    ).all(row.id);
    const outgoing = nb.edges.filter((e) => e.source === file).map((e) => e.target);
    const incoming = nb.edges.filter((e) => e.target === file).map((e) => e.source);
    return {
      file,
      domain,
      dependentsCount: dependents.length,
      exports: exports_.map((s) => ({ name: s.name, kind: s.kind })),
      imports: outgoing,
      importedBy: incoming,
    };
  } finally {
    try { store.close(); } catch {}
  }
}

function render(summary) {
  if (summary.error) return `[CARTO] ${summary.error}`;
  const lines = [];
  lines.push(summary.file);
  lines.push('─'.repeat(Math.min(summary.file.length, 60)));
  lines.push(`Domain: ${summary.domain} · ${summary.dependentsCount} file${summary.dependentsCount === 1 ? '' : 's'} depend on this · ${summary.imports.length} import${summary.imports.length === 1 ? '' : 's'}.`);
  if (summary.exports.length > 0) {
    lines.push(`Exports: ${summary.exports.map((s) => `${s.name} (${s.kind})`).join(', ')}.`);
  }
  if (summary.imports.length > 0) {
    const shown = summary.imports.slice(0, 5);
    const more = summary.imports.length - shown.length;
    lines.push(`Imports: ${shown.join(', ')}${more > 0 ? `, …+${more}` : ''}.`);
  }
  if (summary.importedBy.length > 0) {
    const shown = summary.importedBy.slice(0, 5);
    const more = summary.importedBy.length - shown.length;
    lines.push(`Imported by: ${shown.join(', ')}${more > 0 ? `, …+${more}` : ''}.`);
  }
  return lines.join('\n');
}

function run({ argv, stdout, stderr, projectRoot } = {}) {
  argv = argv || process.argv.slice(3);
  stdout = stdout || process.stdout;
  stderr = stderr || process.stderr;
  projectRoot = projectRoot || process.cwd();

  const json = argv.includes('--json');
  const help = argv.includes('--help') || argv.includes('-h');
  const fileArg = argv.find((a) => !a.startsWith('--'));

  if (help || !fileArg) {
    stdout.write('\nUsage: carto why <file> [--json]\n\nPrint a 3-line summary: domain, blast radius, exports, imports, imported-by.\n\n');
    return fileArg ? 0 : 1;
  }

  let summary;
  try { summary = collect(projectRoot, fileArg); }
  catch (err) {
    stderr.write(`[CARTO] ${err.message}\n`);
    return 1;
  }
  if (json) stdout.write(JSON.stringify(summary, null, 2) + '\n');
  else stdout.write(render(summary) + '\n');
  return summary.error ? 1 : 0;
}

module.exports = { run, collect, render };
if (require.main === module) process.exit(run());
