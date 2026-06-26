#!/usr/bin/env node
'use strict';

/**
 * `carto status` — one-screen health view of the index.
 *
 * Different from `carto inspect`:
 *   - `inspect` is a deep diagnostic dump (paths, sizes, mtimes,
 *     bitmap shape, top-impact, extraction errors). For debugging.
 *   - `status` is the quick "is my index in good shape right now?"
 *     answer. Single screen. Designed to be read in <2 seconds.
 *
 * Layout:
 *
 *   carto · my-project · 847 files · 5 domains
 *   ──────────────────────────────────────────
 *   Index   ✓ healthy
 *   Synced  2m ago (147 files, 5 domains, 1,204 imports)
 *   Bitmap  ✓ fresh
 *   Schema  v3
 *   Errors  0 extraction breadcrumbs
 *
 *   Top domains:
 *     CORE     (677 files)
 *     DATABASE  (67 files)
 *     ...
 *
 * Use `carto inspect` for the full breakdown.
 */

const fs = require('fs');
const path = require('path');
const { SQLiteStore } = require('../store/sqlite-store');
const { BITMAP_FILENAME } = require('../bitmap/sidecar');

function formatAge(ts) {
  if (!ts) return 'never';
  const ageSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.round(ageSec / 3600)}h ago`;
  return `${Math.round(ageSec / 86400)}d ago`;
}

/**
 * collect(projectRoot) → status snapshot object
 *   {
 *     healthy: bool,
 *     issues: string[],         // human-readable issue lines
 *     dbExists, dbMtime, schemaVersion,
 *     bitmapExists, bitmapStale,
 *     totalFiles, totalRoutes, totalImportEdges,
 *     domains: [{ name, fileCount }, ...],
 *     extractionErrors,
 *     projectName,
 *   }
 *
 * Pure — no I/O on stdout. The renderer (and tests) consumes this.
 */
function collect(projectRoot) {
  const cartoDir = path.join(projectRoot, '.carto');
  const dbPath = path.join(cartoDir, 'carto.db');
  const bitmapPath = path.join(cartoDir, BITMAP_FILENAME);
  const issues = [];

  const dbStat = (() => { try { return fs.statSync(dbPath); } catch { return null; } })();
  const bmStat = (() => { try { return fs.statSync(bitmapPath); } catch { return null; } })();

  const snapshot = {
    projectName: path.basename(projectRoot),
    healthy: true,
    issues,
    dbExists: !!dbStat,
    dbMtime: dbStat ? dbStat.mtimeMs : null,
    dbSize: dbStat ? dbStat.size : null,
    bitmapExists: !!bmStat,
    bitmapMtime: bmStat ? bmStat.mtimeMs : null,
    bitmapStale: false,
    schemaVersion: null,
    totalFiles: 0,
    totalRoutes: 0,
    totalImportEdges: 0,
    domains: [],
    extractionErrors: 0,
  };

  if (!snapshot.dbExists) {
    snapshot.healthy = false;
    issues.push(`No index at ${dbPath} — run \`carto init\`.`);
    return snapshot;
  }

  // bitmap freshness — stale if missing or older than the DB. This is
  // a *warning* (surfaced under issues), not a `healthy=false` trigger,
  // because lazy-rebuild on next MCP query is the documented design —
  // a missing/stale bitmap doesn't break anything, just costs the first
  // query a few extra ms.
  if (!snapshot.bitmapExists) {
    snapshot.bitmapStale = true;
    issues.push('Bitmap sidecar missing — will rebuild on next MCP query.');
  } else if (snapshot.bitmapMtime < snapshot.dbMtime) {
    snapshot.bitmapStale = true;
    issues.push('Bitmap sidecar older than DB — will rebuild on next MCP query.');
  }

  // Open SQLite readonly to harvest the rest.
  let storeOpenFailed = false;
  let store;
  try {
    store = new SQLiteStore(projectRoot);
    store.open({ readonly: true });
    const structure = store.getStructure();
    // Schema version is a row in the `meta` table, not part of getStructure().
    const sv = store.getMeta && store.getMeta('schema_version');
    snapshot.schemaVersion = sv ? parseInt(sv, 10) : null;
    snapshot.totalFiles = (structure.meta && structure.meta.totalFiles) || 0;
    snapshot.totalRoutes = (structure.meta && structure.meta.totalRoutes) || 0;
    snapshot.totalImportEdges = (structure.meta && structure.meta.totalImportEdges) || 0;
    snapshot.domains = (store.getDomainsList() || []).map((d) => ({
      name: d.name,
      fileCount: d.fileCount,
    }));
    // Extraction errors — older DBs don't have the table; tolerate it.
    try {
      const row = store.db.prepare('SELECT COUNT(*) AS c FROM extraction_errors').get();
      snapshot.extractionErrors = row.c || 0;
      if (snapshot.extractionErrors > 0) {
        issues.push(`${snapshot.extractionErrors} files had extractor errors — run \`carto inspect\`.`);
      }
    } catch { /* pre-v2 schema */ }
  } catch (err) {
    storeOpenFailed = true;
    issues.push(`Could not open index: ${err.message}`);
  } finally {
    try { store && store.close(); } catch {}
  }

  // healthy=false only when something actually broken — DB missing or
  // open failed. Warnings (bitmap stale, extraction errors) live in
  // `issues` for visibility without flipping the healthy flag.
  if (storeOpenFailed) snapshot.healthy = false;
  return snapshot;
}

function render(snapshot) {
  const lines = [];
  const head = `carto · ${snapshot.projectName} · ${snapshot.totalFiles} files · ${snapshot.domains.length} domains`;
  lines.push(head);
  lines.push('─'.repeat(Math.min(head.length, 60)));

  const ok = (b) => b ? '✓' : '✗';
  if (!snapshot.dbExists) {
    lines.push('Index   ✗ missing — run `carto init`');
    return lines.join('\n');
  }
  lines.push(`Index   ${ok(snapshot.healthy)} ${snapshot.healthy ? 'healthy' : 'has issues'}`);
  lines.push(`Synced  ${formatAge(snapshot.dbMtime)}  (${snapshot.totalFiles} files, ${snapshot.totalRoutes} routes, ${snapshot.totalImportEdges} imports)`);
  lines.push(`Bitmap  ${snapshot.bitmapStale ? '⚠ stale (rebuilds on next query)' : '✓ fresh'}`);
  if (snapshot.schemaVersion !== null) {
    lines.push(`Schema  v${snapshot.schemaVersion}`);
  }
  lines.push(`Errors  ${snapshot.extractionErrors} extraction breadcrumb${snapshot.extractionErrors === 1 ? '' : 's'}`);

  if (snapshot.domains.length > 0) {
    lines.push('');
    lines.push('Top domains:');
    const top = snapshot.domains.slice().sort((a, b) => b.fileCount - a.fileCount).slice(0, 6);
    const widest = Math.max(...top.map((d) => d.name.length), 6);
    for (const d of top) {
      lines.push(`  ${d.name.padEnd(widest)}  (${d.fileCount} file${d.fileCount === 1 ? '' : 's'})`);
    }
  }

  if (snapshot.issues.length > 0) {
    lines.push('');
    lines.push('Issues:');
    for (const i of snapshot.issues) lines.push(`  • ${i}`);
  }

  lines.push('');
  lines.push('Use `carto inspect` for the full breakdown.');
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
    stdout.write(`\nUsage: carto status [--json]\n\nQuick one-screen health view of the carto index.\nUse \`carto inspect\` for deeper diagnostics.\n\n`);
    return 0;
  }

  let snapshot;
  try { snapshot = collect(projectRoot); }
  catch (err) {
    stderr.write(`[CARTO] ${err.message}\n`);
    return 1;
  }
  if (json) stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
  else stdout.write(render(snapshot) + '\n');
  return snapshot.healthy ? 0 : 1;
}

module.exports = { run, collect, render };

if (require.main === module) process.exit(run());
