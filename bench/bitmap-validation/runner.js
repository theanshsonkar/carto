'use strict';

/**
 * Bitmap engine benchmark runner.
 *
 * Compares the bitmap query path against SQLite for the 5 wired-up MCP
 * tools, plus `simulate_change_impact`. 50 warmup + 1000 measurement
 * calls per tool, seeded random inputs for reproducibility.
 *
 * Imports the production bitmap modules from `src/bitmap/`. The
 * popcount-index fix for `highImpactFiles` is in scope here.
 * Acceptance criterion: all 5 tools should show ≥10× speedup on vscode.
 */

const path = require('path');
const { SQLiteStore } = require('../../src/store/sqlite-store');
const { buildFromStore } = require('../../src/bitmap/sidecar');
const prodTools = require('../../src/bitmap/tools');

const WARMUP = 50;
const CALLS = 1000;

function seededRandom(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) & 0xFFFFFFFF; return (s >>> 0) / 0xFFFFFFFF; };
}

function run(repoPath) {
  const store = new SQLiteStore(repoPath);
  store.open({ readonly: true });

  // Build the sidecar via the same code path that ships in production.
  const sidecar = buildFromStore(store);
  const fileIds = Array.from(sidecar.fileIdToPath.keys());
  const fileCount = fileIds.length;

  // Generate seeded random inputs.
  const rand = seededRandom(42);
  const randomFileIds = Array.from({ length: CALLS }, () => fileIds[Math.floor(rand() * fileCount)]);
  const randomPaths = randomFileIds.map(id => sidecar.fileIdToPath.get(id));
  const randomGroups = []; // for simulateChangeImpact: groups of 5 paths
  for (let i = 0; i < CALLS; i++) {
    const group = [];
    for (let j = 0; j < 5; j++) {
      const fid = fileIds[Math.floor(rand() * fileCount)];
      group.push(sidecar.fileIdToPath.get(fid));
    }
    randomGroups.push(group);
  }

  const results = {};
  const rssStart = process.memoryUsage().rss;

  results.blastRadius = benchTool(
    (i) => store.getBlastRadius(randomPaths[i], 5),
    (i) => prodTools.blastRadius(sidecar, randomPaths[i], 5),
  );

  results.crossDomain = benchTool(
    () => store.getCrossDomainDeps(),
    () => prodTools.crossDomain(sidecar),
  );

  results.highImpactFiles = benchTool(
    () => store.getHighImpactFiles(10),
    () => prodTools.highImpactFiles(sidecar, 10),
  );

  results.similarPatterns = benchTool(
    (i) => {
      const p = randomPaths[i];
      const file = store.getFileByPath(p);
      if (!file) return [];
      // SQLite has no native single-call equivalent to the bitmap Jaccard
      // similarity. Use getNeighbors(2) as a comparable-cost graph
      // traversal (server-v2.js's legacy 3-strategy SQLite path runs
      // multiple separate queries, so picking any one of them would
      // understate the SQLite cost).
      return store.getNeighbors(p, 2);
    },
    (i) => prodTools.similarPatterns(sidecar, randomPaths[i], 5),
  );

  results.simulateChangeImpact = benchTool(
    (i) => {
      // SQLite equivalent: N individual blastRadius calls + dedup. This
      // is the cost the new `simulate_change_impact` MCP tool replaces.
      const group = randomGroups[i];
      const all = new Set();
      for (const p of group) {
        const br = store.getBlastRadius(p, 3);
        if (br) for (const r of br) all.add(r.file);
      }
      return all.size;
    },
    (i) => prodTools.simulateChangeImpact(sidecar, randomGroups[i]),
  );

  const rssEnd = process.memoryUsage().rss;
  store.close();

  // Approximate sidecar in-memory bytes — sum of all bitmap word arrays.
  let sidecarBytes = 0;
  for (const m of [sidecar.forward, sidecar.reverse, sidecar.domainBitmaps]) {
    for (const bitmap of m.values()) sidecarBytes += bitmap.words.byteLength;
  }

  // Total import-edge count (sum of popcounts across forward bitmaps).
  // An earlier prototype reported `forward.size` here, which is the count
  // of distinct source files with imports — off by ~10× on vscode.
  let edgeCount = 0;
  for (const bitmap of sidecar.forward.values()) edgeCount += bitmap.popcount();

  return {
    repo: repoPath,
    fileCount,
    edgeCount,
    sidecarBytes,
    rssStart,
    rssEnd,
    results,
  };
}

function benchTool(sqliteFn, bitmapFn) {
  const sqliteTimes = [];
  const bitmapTimes = [];

  // Warmup
  for (let i = 0; i < WARMUP; i++) { sqliteFn(i); bitmapFn(i); }

  // Measure SQLite
  for (let i = 0; i < CALLS; i++) {
    const start = process.hrtime.bigint();
    sqliteFn(i);
    sqliteTimes.push(Number(process.hrtime.bigint() - start));
  }

  // Measure bitmap
  for (let i = 0; i < CALLS; i++) {
    const start = process.hrtime.bigint();
    bitmapFn(i);
    bitmapTimes.push(Number(process.hrtime.bigint() - start));
  }

  return { sqliteTimes, bitmapTimes };
}

module.exports = { run };
