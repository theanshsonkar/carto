'use strict';

/**
 * `carto inspect` — read-only diagnostic command.
 *
 * Prints a snapshot of the on-disk index state — paths, sizes,
 * freshness, sidecar shape, top-N popcount entries, schema version, sync
 * timestamps, extraction error count, unavailable language grammars.
 *
 * Use cases:
 *   - "Why is bitmap.bin stale?" — shows mtime gap vs carto.db.
 *   - "Are my popcounts well-formed?" — top-10 entries match what
 *     `get_high_impact_files` would return.
 *   - "Did extractors fail silently?" — surfaces the breadcrumb count.
 *   - "Are tree-sitter grammars healthy?" — surfaces the unavailable list.
 *
 * Two output modes:
 *   carto inspect          — human-readable (sectioned text)
 *   carto inspect --json   — single JSON object suitable for `| jq`
 *
 * **Strict invariant — never triggers a rebuild.** Uses the readonly
 * SQLite path and `loadFromDisk` (not `ensureBitmapFresh`),
 * so a missing or stale `bitmap.bin` shows up as `null` / `stale: true`
 * in the output rather than mutating disk state. This is the diagnostic
 * tool — its job is to report, not to fix.
 */

const fs = require('fs');
const path = require('path');
const { SQLiteStore } = require('../store/sqlite-store');
const { loadFromDisk, BITMAP_FILENAME } = require('../bitmap/sidecar');

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return null; }
}

function fileMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
}

function formatBytes(n) {
  if (n === null || n === undefined) return 'n/a';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatAge(ts) {
  if (!ts) return 'never';
  const ageSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.round(ageSec / 3600)}h ago`;
  return `${Math.round(ageSec / 86400)}d ago`;
}

/**
 * Collect everything the inspect command reports, as a plain object.
 * Pure data extraction — no rendering. Both human and JSON modes
 * consume this. Exposed for tests (asserts on the JSON shape are
 * cheaper and more stable than parsing terminal output).
 */
function collect(projectRoot) {
  const cartoDir = path.join(projectRoot, '.carto');
  const dbPath = path.join(cartoDir, 'carto.db');
  const bitmapPath = path.join(cartoDir, BITMAP_FILENAME);

  const dbSize = fileSize(dbPath);
  const dbMtime = fileMtime(dbPath);
  const bitmapSize = fileSize(bitmapPath);
  const bitmapMtime = fileMtime(bitmapPath);

  // Bitmap freshness: stale if it's older than the DB (or missing).
  let stale = null;
  if (bitmapMtime === null) stale = true;
  else if (dbMtime !== null) stale = bitmapMtime < dbMtime;

  const out = {
    paths: {
      projectRoot,
      cartoDir,
      dbPath,
      bitmapPath,
    },
    files: {
      dbExists: dbSize !== null,
      dbSize,
      dbMtime,
      bitmapExists: bitmapSize !== null,
      bitmapSize,
      bitmapMtime,
      bitmapStale: stale,
    },
    meta: null,
    bitmap: null,
    topImpact: [],
    domains: [],
  };

  // SQLite read — readonly path so this can never mutate the index.
  // If the DB is missing, return what we have and let the caller render
  // the "run carto init first" message.
  if (!out.files.dbExists) return out;

  const store = new SQLiteStore(projectRoot);
  try {
    store.open({ readonly: true });
  } catch (err) {
    out.error = `Failed to open ${dbPath}: ${err.message}`;
    return out;
  }

  try {
    const structure = store.getStructure();
    const domainsList = store.getDomainsList();
    // Defensive: getExtractionErrorCount throws on older schemas
    // (no `extraction_errors` table). Inspect must work on every DB
    // we've ever shipped — fall back to 0 on schema mismatch.
    let errCount = 0;
    try { errCount = store.getExtractionErrorCount(); } catch { errCount = 0; }
    const unavailRaw = store.getMeta('unavailable_languages_json');
    let unavail = [];
    if (unavailRaw) {
      try { unavail = JSON.parse(unavailRaw); } catch { unavail = []; }
    }

    out.meta = {
      schemaVersion: store.getMeta('schema_version'),
      lastFullSync: store.getMeta('last_full_sync'),
      lastPartialSync: store.getMeta('last_partial_sync'),
      lastIndexed: structure.meta.lastIndexed,
      indexDurationMs: structure.meta.indexDuration,
      totalFiles: structure.meta.totalFiles,
      totalRoutes: structure.meta.totalRoutes,
      totalImportEdges: structure.meta.totalImportEdges,
      extractionErrorCount: errCount,
      unavailableLanguages: unavail,
    };
    out.domains = domainsList.map(d => ({
      name: d.name,
      files: d.fileCount,
      routes: d.routeCount,
      models: d.modelCount,
    }));

    // Bitmap shape — load from disk only. Returns null if missing or
    // corrupt; we report that rather than rebuilding (see invariant
    // in the file header).
    if (out.files.bitmapExists) {
      const sidecar = loadFromDisk(cartoDir);
      if (sidecar) {
        out.bitmap = {
          loaded: true,
          size: sidecar.size,
          forwardCount: sidecar.forward.size,
          reverseCount: sidecar.reverse.size,
          crossForwardCount: sidecar.crossForward ? sidecar.crossForward.size : 0,
          domainBitmapCount: sidecar.domainBitmaps.size,
          popcountIndexLength: sidecar.popcountIndex.length,
          fileIdMapped: sidecar.fileIdToPath.size,
        };
        // Top-N from popcountIndex, with hydrated paths so caller can
        // sanity-check that get_high_impact_files would return these.
        const topN = Math.min(10, sidecar.popcountIndex.length);
        for (let i = 0; i < topN; i++) {
          const e = sidecar.popcountIndex[i];
          out.topImpact.push({
            file: sidecar.fileIdToPath.get(e.fileId) || `<id ${e.fileId}>`,
            dependents: e.count,
          });
        }
      } else {
        out.bitmap = { loaded: false, reason: 'corrupt or version mismatch' };
      }
    } else {
      out.bitmap = { loaded: false, reason: 'bitmap.bin not present' };
    }
  } finally {
    try { store.close(); } catch {}
  }

  return out;
}

function renderHuman(data) {
  const lines = [];
  lines.push('');
  lines.push('── Carto Inspect ───────────────────────────────────────');
  lines.push('');

  // ── Paths
  lines.push('Paths');
  lines.push(`  project       : ${data.paths.projectRoot}`);
  lines.push(`  .carto/       : ${data.paths.cartoDir}`);
  lines.push(`  carto.db      : ${formatBytes(data.files.dbSize)}` +
    (data.files.dbExists ? ` (${formatAge(data.files.dbMtime)})` : ' (missing)'));
  lines.push(`  bitmap.bin    : ${formatBytes(data.files.bitmapSize)}` +
    (data.files.bitmapExists
      ? ` (${formatAge(data.files.bitmapMtime)}${data.files.bitmapStale ? ', ⚠️ stale vs DB' : ''})`
      : ' (missing)'));
  lines.push('');

  if (!data.files.dbExists) {
    lines.push('  ⚠️  No .carto/carto.db found. Run `carto init` first.');
    lines.push('');
    return lines.join('\n');
  }

  if (data.error) {
    lines.push(`  ⚠️  ${data.error}`);
    lines.push('');
    return lines.join('\n');
  }

  // ── Meta
  const m = data.meta;
  lines.push('Meta');
  lines.push(`  schema version       : ${m.schemaVersion || '?'}`);
  lines.push(`  last full sync       : ${m.lastFullSync || 'never'}`);
  lines.push(`  last partial sync    : ${m.lastPartialSync || 'never'}`);
  lines.push(`  index duration       : ${m.indexDurationMs}ms`);
  lines.push(`  files indexed        : ${m.totalFiles}`);
  lines.push(`  routes               : ${m.totalRoutes}`);
  lines.push(`  import edges         : ${m.totalImportEdges}`);
  lines.push(`  extraction errors    : ${m.extractionErrorCount}` +
    (m.extractionErrorCount > 0 ? ' ⚠️  (run `carto check`)' : ''));
  if (m.unavailableLanguages && m.unavailableLanguages.length > 0) {
    lines.push(`  grammars unavailable : ⚠️  ${m.unavailableLanguages.join(', ')}`);
  }
  lines.push('');

  // ── Bitmap
  lines.push('Bitmap');
  if (!data.bitmap || !data.bitmap.loaded) {
    lines.push(`  ⚠️  not loaded — ${data.bitmap ? data.bitmap.reason : 'unknown'}`);
  } else {
    const b = data.bitmap;
    lines.push(`  size (bits)          : ${b.size}`);
    lines.push(`  forward bitmaps      : ${b.forwardCount}`);
    lines.push(`  reverse bitmaps      : ${b.reverseCount}`);
    lines.push(`  crossForward bitmaps : ${b.crossForwardCount}`);
    lines.push(`  domain bitmaps       : ${b.domainBitmapCount}`);
    lines.push(`  popcount index       : ${b.popcountIndexLength} entries`);
    lines.push(`  file paths mapped    : ${b.fileIdMapped}`);
  }
  lines.push('');

  // ── Top impact (popcount-index head)
  if (data.topImpact.length > 0) {
    lines.push('Top impact (from popcount index)');
    for (const e of data.topImpact) {
      lines.push(`  ${String(e.dependents).padStart(4)}  ${e.file}`);
    }
    lines.push('');
  }

  // ── Domains
  if (data.domains.length > 0) {
    lines.push('Domains');
    for (const d of data.domains) {
      lines.push(`  ${d.name.padEnd(16)} ${String(d.files).padStart(5)} files  ` +
        `${String(d.routes).padStart(4)} routes  ` +
        `${String(d.models).padStart(4)} models`);
    }
    lines.push('');
  }

  lines.push('────────────────────────────────────────────────────────');
  lines.push('');
  return lines.join('\n');
}

/**
 * run(projectRoot, options)
 *   options.json — emit machine-readable JSON instead of human text.
 *
 * Exit code:
 *   0 — DB present, output rendered.
 *   1 — DB missing (caller should run `carto init`).
 */
function run(projectRoot, options = {}) {
  const data = collect(projectRoot);

  if (options.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    process.stdout.write(renderHuman(data));
  }

  if (!data.files.dbExists) return 1;
  if (data.error) return 1;
  return 0;
}

module.exports = { run, collect, renderHuman };
