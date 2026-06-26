'use strict';

/**
 * Scale-test runner.
 *
 * Drives a synth (or any pre-indexed) repo through:
 *   1. Cold `carto init` (full `runSync`)
 *   2. Warm `carto sync` (no-op `runSync`)
 *   3. Bitmap sidecar load (cold from disk via `ensureBitmapFresh`)
 *   4. 1000-call latency for each of the 5 production bitmap tools
 *      plus `simulate_change_impact`.
 *
 * Captures: file count, edge count, init/sync wall time, peak RSS, DB
 * size, bitmap.bin size, per-tool p50/p99 (bitmap path only — the full
 * SQLite-vs-bitmap comparison is already covered by
 * `bench/bitmap-validation` and would balloon walltime by ~10× at
 * 100K+ files where the SQL path is impractical).
 *
 * Pure read-only of the production code paths under test. The
 * read-only-MCP invariant is honored: the query-side store opens with
 * `{ readonly: true }`.
 */

const path = require('path');
const fs = require('fs');

const { runSync } = require('../../src/store/sync');
const { SQLiteStore } = require('../../src/store/sqlite-store');
const { ensureBitmapFresh, _resetForTests: resetBitmapCache } = require('../../src/bitmap/index');
const bitmapTools = require('../../src/bitmap/tools');

const WARMUP = 50;
const CALLS = 1000;

function seededRandom(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentiles(samplesNs) {
  const sorted = samplesNs.slice().sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    min: sorted[0],
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
  };
}

function fileSizeOrZero(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

/**
 * runScale(projectRoot, { skipInit, querySeed }) → results object
 *
 * Drives one full scale measurement. If `skipInit=true`, assumes the
 * caller already ran `carto init` (used by the kernel/chromium runner
 * and by the `--queries-only` CLI flag).
 */
async function runScale(projectRoot, opts = {}) {
  const skipInit = !!opts.skipInit;
  const querySeed = opts.querySeed != null ? opts.querySeed : 42;

  const cartoDir = path.join(projectRoot, '.carto');
  const dbPath = path.join(cartoDir, 'carto.db');
  const bitmapPath = path.join(cartoDir, 'bitmap.bin');

  let initMs = null;
  let syncMs = null;
  let extractionErrorCount = null;
  let totalFiles = null;
  let initRssAfter = null;

  // Step 1: cold init
  if (!skipInit) {
    // Wipe any previous .carto so we measure cold-build cost.
    try { fs.rmSync(cartoDir, { recursive: true, force: true }); } catch {}

    const t0 = Date.now();
    const initResult = await runSync({ projectRoot, output: null });
    initMs = Date.now() - t0;
    totalFiles = initResult.totalFiles;
    extractionErrorCount = initResult.extractionErrorCount;
    initRssAfter = process.memoryUsage().rss;

    // Step 2: warm sync (no files changed)
    const t1 = Date.now();
    await runSync({ projectRoot, output: null });
    syncMs = Date.now() - t1;
  } else {
    // External-clone case: read totalFiles back from meta.
    const metaStore = new SQLiteStore(projectRoot);
    metaStore.open({ readonly: true });
    try {
      totalFiles = parseInt(metaStore.getMeta('total_files'), 10);
      extractionErrorCount = parseInt(metaStore.getMeta('extraction_error_count'), 10) || 0;
    } finally { metaStore.close(); }
  }

  const dbBytes = fileSizeOrZero(dbPath);
  const bitmapBytes = fileSizeOrZero(bitmapPath);

  // Step 3: query stage (read-only)
  resetBitmapCache(); // cold load — exercises disk path of `loadFromDisk`
  const store = new SQLiteStore(projectRoot);
  store.open({ readonly: true });

  let queryResults;
  try {
    const sidecarLoadT0 = process.hrtime.bigint();
    const sidecar = ensureBitmapFresh(cartoDir, store);
    const sidecarLoadNs = Number(process.hrtime.bigint() - sidecarLoadT0);

    const fileIds = Array.from(sidecar.fileIdToPath.keys());
    if (fileIds.length === 0) {
      throw new Error(`scale-test: 0 indexed files in ${projectRoot} — index is empty`);
    }

    // Approximate sidecar in-memory bytes.
    let sidecarBytes = 0;
    for (const m of [sidecar.forward, sidecar.reverse, sidecar.crossForward || new Map(), sidecar.domainBitmaps]) {
      for (const bitmap of m.values()) sidecarBytes += bitmap.words.byteLength;
    }

    let edgeCount = 0;
    for (const bitmap of sidecar.forward.values()) edgeCount += bitmap.popcount();

    // Pre-generate seeded inputs.
    const rand = seededRandom(querySeed);
    const randomPaths = [];
    for (let i = 0; i < CALLS; i++) {
      const fid = fileIds[Math.floor(rand() * fileIds.length)];
      randomPaths.push(sidecar.fileIdToPath.get(fid));
    }
    const randomGroups = [];
    for (let i = 0; i < CALLS; i++) {
      const g = [];
      for (let j = 0; j < 5; j++) {
        const fid = fileIds[Math.floor(rand() * fileIds.length)];
        g.push(sidecar.fileIdToPath.get(fid));
      }
      randomGroups.push(g);
    }

    const rssBeforeQuery = process.memoryUsage().rss;

    const tools = {
      blastRadius: (i) => bitmapTools.blastRadius(sidecar, randomPaths[i], 5),
      crossDomain: () => bitmapTools.crossDomain(sidecar),
      highImpactFiles: () => bitmapTools.highImpactFiles(sidecar, 10),
      similarPatterns: (i) => bitmapTools.similarPatterns(sidecar, randomPaths[i], 5),
      simulateChangeImpact: (i) => bitmapTools.simulateChangeImpact(sidecar, randomGroups[i]),
    };

    const perTool = {};
    let peakRss = rssBeforeQuery;
    for (const [name, fn] of Object.entries(tools)) {
      // Warmup — keeps tree-sitter / V8 inlining + bitmap sidecar
      // pages hot before we measure.
      for (let i = 0; i < WARMUP; i++) fn(i);

      const samples = new Float64Array(CALLS);
      for (let i = 0; i < CALLS; i++) {
        const t0 = process.hrtime.bigint();
        fn(i);
        samples[i] = Number(process.hrtime.bigint() - t0);
      }
      perTool[name] = percentiles(Array.from(samples));
      const rss = process.memoryUsage().rss;
      if (rss > peakRss) peakRss = rss;
    }

    queryResults = {
      sidecarLoadNs,
      sidecarBytes,
      edgeCount,
      perTool,
      peakRss,
    };
  } finally {
    store.close();
  }

  return {
    projectRoot,
    totalFiles,
    extractionErrorCount,
    initMs,
    syncMs,
    initRssAfter,
    dbBytes,
    bitmapBytes,
    sidecar: {
      loadNs: queryResults.sidecarLoadNs,
      bytes: queryResults.sidecarBytes,
    },
    edgeCount: queryResults.edgeCount,
    perTool: queryResults.perTool,
    peakRss: queryResults.peakRss,
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    capturedAt: new Date().toISOString(),
  };
}

module.exports = { runScale, percentiles, WARMUP, CALLS };
