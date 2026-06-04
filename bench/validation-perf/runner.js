'use strict';

/**
 * validateDiff benchmark runner.
 *
 * Loads a real corpus repo's .carto/carto.db read-only, builds the
 * bitmap sidecar, generates seeded-random representative 20-line diffs,
 * and measures `validateDiff` latency over 1000 calls per target.
 *
 * Pure read — never writes to the corpus DB or triggers a rebuild.
 */

const path = require('path');
const { SQLiteStore } = require('../../src/store/sqlite-store');
const { buildFromStore } = require('../../src/bitmap/sidecar');
const { validateDiff } = require('../../src/mcp/validate');

const WARMUP = 50;
const CALLS = 1000;
const TARGET_COUNT = 20;

function seededRandom(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) & 0xFFFFFFFF; return (s >>> 0) / 0xFFFFFFFF; };
}

/**
 * Build a representative 20-line diff against `target` that adds an
 * import line. The import target is chosen to potentially be a
 * cross-domain hit so the cross_domain code path is exercised.
 */
function buildDiff(target) {
  const lines = [
    `diff --git a/${target} b/${target}`,
    `--- a/${target}`,
    `+++ b/${target}`,
    `@@ -1,1 +1,21 @@`,
    ` original`,
  ];
  // 20 added lines including one import.
  lines.push(`+import { __probe } from './__probe-${Date.now()}';`);
  for (let i = 0; i < 19; i++) lines.push(`+const v${i} = ${i};`);
  return lines.join('\n') + '\n';
}

function percentiles(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    min: sorted[0],
    p50: p(0.50),
    p90: p(0.90),
    p95: p(0.95),
    p99: p(0.99),
    max: sorted[sorted.length - 1],
  };
}

function run(repoPath) {
  const store = new SQLiteStore(repoPath);
  store.open({ readonly: true });
  const sidecar = buildFromStore(store);
  const fileIds = Array.from(sidecar.fileIdToPath.keys());

  // Pick TARGET_COUNT files weighted toward mid-blast-radius (skip the
  // top-10 hottest files and the pure leaves).
  const popcountIdx = sidecar.popcountIndex;
  const total = popcountIdx.length;
  const start = Math.floor(total * 0.05);
  const end = Math.floor(total * 0.5);
  const rand = seededRandom(42);
  const targets = [];
  for (let i = 0; i < TARGET_COUNT; i++) {
    const idx = start + Math.floor(rand() * Math.max(1, end - start));
    const entry = popcountIdx[Math.min(idx, total - 1)];
    if (!entry) continue;
    const p = sidecar.fileIdToPath.get(entry.fileId);
    if (p) targets.push(p);
  }
  if (targets.length === 0) {
    // Fallback: any file with a path.
    targets.push(...fileIds.slice(0, TARGET_COUNT).map((id) => sidecar.fileIdToPath.get(id)));
  }

  // Pre-build diffs.
  const diffs = targets.map(buildDiff);

  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    validateDiff(store, sidecar, diffs[i % diffs.length]);
  }

  // Measure
  const samples = [];
  for (let i = 0; i < CALLS; i++) {
    const diff = diffs[i % diffs.length];
    const t0 = process.hrtime.bigint();
    validateDiff(store, sidecar, diff);
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6); // ms
  }

  store.close();

  const stats = percentiles(samples);
  return { repo: repoPath, fileCount: fileIds.length, calls: CALLS, targets: targets.length, stats };
}

module.exports = { run };
