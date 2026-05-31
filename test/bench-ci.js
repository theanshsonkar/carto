#!/usr/bin/env node
'use strict';

/**
 * test/bench-ci.js — minimal self-benchmark for CI.
 *
 * Indexes the carto repo on itself (no external repo clones) and prints
 * metrics in a stable `<key>: <number> ms` format that
 * test/bench-regression-check.js can parse.
 *
 * Why a separate script from test/benchmark.js?
 *   - benchmark.js targets external repos (prisma/supabase/vscode/zed)
 *     pre-cloned at tmp-bench/<name>. That setup doesn't exist on a fresh
 *     GitHub Actions runner, so every repo gets skipped → empty output →
 *     regression-check has nothing to compare → false-pass.
 *   - bench-ci.js is hermetic: copies the working tree to a tmpdir,
 *     runs runSyncV2 against it twice (cold + warm cache), measures MCP
 *     query latencies, prints stable metrics, cleans up. Runs in <5s
 *     on a typical runner.
 *
 * The user's actual `.carto/` is never touched — we copy the tree to
 * os.tmpdir() and bench there.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const EXCLUDE_DIRS = new Set(['.git', '.carto', 'node_modules', 'tmp-bench', 'Progress']);

function hrMs(start) {
  const [s, ns] = process.hrtime(start);
  return Math.round(s * 1000 + ns / 1e6);
}

function copyTree(src, dst) {
  // Node 18+ has fs.cpSync; use the filter to skip excluded dirs at the top level.
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(src, source);
      if (!rel) return true; // root itself
      const top = rel.split(path.sep)[0];
      return !EXCLUDE_DIRS.has(top);
    },
  });
}

async function main() {
  const sourceRoot = process.cwd();
  const target = path.join(os.tmpdir(), `carto-bench-${process.pid}-${Date.now()}`);

  console.log('--- carto self-bench (CI) ---');
  console.log(`Node ${process.version} · ${os.platform()} ${os.arch()} · ${os.cpus().length} CPUs`);
  console.log(`Source: ${sourceRoot}`);
  console.log(`Target: ${target}`);
  console.log('');

  // Copy the source tree (without .git/.carto/node_modules) to a tmpdir.
  // We'll bench against the copy so the user's .carto/ stays untouched
  // and the run is reproducible (fixed mtimes from the copy).
  const copyStart = process.hrtime();
  copyTree(sourceRoot, target);
  console.log(`copy_tree_ms: ${hrMs(copyStart)} ms`);

  // Lazy-require so import errors during fs.cpSync don't poison the run.
  const { runSyncV2 } = require('../src/store/sync-v2');
  const { SQLiteStore } = require('../src/store/sqlite-store');

  // ── Cold run ──────────────────────────────────────────────────────────
  let t = process.hrtime();
  const r1 = await runSyncV2({
    projectRoot: target,
    output: path.join(target, 'AGENTS.md'),
  });
  const coldMs = hrMs(t);
  console.log(`self_repo_first_run_ms: ${coldMs} ms`);

  // ── Warm run (everything cached) ──────────────────────────────────────
  t = process.hrtime();
  await runSyncV2({
    projectRoot: target,
    output: path.join(target, 'AGENTS.md'),
  });
  const warmMs = hrMs(t);
  console.log(`self_repo_second_run_ms: ${warmMs} ms`);

  // ── MCP query latencies ───────────────────────────────────────────────
  const store = new SQLiteStore(target);
  store.open();

  t = process.hrtime();
  store.getStructure();
  console.log(`mcp_get_structure_ms: ${hrMs(t)} ms`);

  t = process.hrtime();
  store.getRoutes();
  console.log(`mcp_get_routes_ms: ${hrMs(t)} ms`);

  t = process.hrtime();
  store.getDomainsList();
  console.log(`mcp_get_domains_list_ms: ${hrMs(t)} ms`);

  // get_blast_radius on the highest-impact file (if any)
  const highImpact = store.getHighImpactFiles(1);
  if (highImpact.length > 0) {
    t = process.hrtime();
    store.getBlastRadius(highImpact[0].file);
    console.log(`mcp_get_blast_radius_ms: ${hrMs(t)} ms`);
  } else {
    console.log(`mcp_get_blast_radius_ms: 0 ms (no high-impact files)`);
  }

  // ── Counts (informational, not used by regression-check) ──────────────
  console.log('');
  console.log(`files_indexed: ${store.getFileCount()}`);
  console.log(`routes_found: ${store.getRoutes().length}`);
  console.log(`models_found: ${store.getModels().length}`);
  console.log(`domains_found: ${store.getDomainsList().length}`);

  store.close();

  // ── Cleanup ───────────────────────────────────────────────────────────
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    console.error(`Warning: failed to remove ${target}: ${err.message}`);
  }

  console.log('');
  console.log(`files_processed_first_run: ${r1.filesProcessed}`);
  console.log('--- bench complete ---');
}

main().catch((err) => {
  console.error('Bench failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
