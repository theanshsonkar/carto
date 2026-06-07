#!/usr/bin/env node
'use strict';

/**
 * Real-world scale runner — Linux kernel, Chromium, or any other huge
 * tree the maintainer wants to feed Carto.
 *
 * Usage:
 *   node bench/scale-test/real-world.js --repo <path> [--name linux-kernel]
 *
 * Prerequisites:
 *   - The target repo MUST be a complete clone on local disk.
 *     Linux kernel: `git clone --depth=1 https://github.com/torvalds/linux ~/clones/linux`
 *     Chromium:     `fetch --no-history chromium` (per Chromium docs;
 *                   ~75K source files, ~30M LOC; expect a multi-GB clone).
 *   - This driver does NOT clone for you — too easy to nuke a developer's disk.
 *
 * What happens:
 *   1. Wipe `<repo>/.carto`
 *   2. `runSyncV2` cold (full index)
 *   3. `runSyncV2` again (warm sync)
 *   4. Capture DB + bitmap.bin sizes, peak RSS, extraction-error count
 *   5. Run 1000-call latency for the 5 production bitmap tools +
 *      `simulate_change_impact` against the indexed graph
 *   6. Write `bench/scale-test/results/real-<name>-<ts>.json`
 *   7. Refresh `bench/scale-test/REPORT.md`
 *
 * The result JSON is shaped identically to a synth run so the
 * aggregator merges them into the same table.
 *
 * Time + memory reality check:
 *   - Linux kernel @ ~75K source files (the languages Carto supports
 *     after `.cartoignore` exclusions): expect 5-15 min on Apple
 *     M-series, 4-6 GB RSS during init.
 *   - Chromium @ ~75K-100K source files: 10-25 min, 6-10 GB RSS.
 *
 * Re-running with `--queries-only` skips init/sync (assumes the index
 * is already on disk) and runs only the query benchmark.
 */

const fs = require('fs');
const path = require('path');
const { runScale } = require('./runner');
const { generateReport } = require('./report');

function parseArgs(argv) {
  const opts = { queriesOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') opts.repo = path.resolve(argv[++i]);
    else if (a === '--name') opts.name = argv[++i];
    else if (a === '--queries-only') opts.queriesOnly = true;
    else if (a === '--seed') opts.seed = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown flag: ${a}`);
  }
  return opts;
}

function usage() {
  console.log(`Usage: node bench/scale-test/real-world.js --repo <path> [options]

Required:
  --repo PATH       Path to an already-cloned repo (e.g. ~/clones/linux)

Options:
  --name NAME       Label for the report row (default: dirname of --repo)
  --queries-only    Skip init/sync; only run the query benchmark
  --seed N          PRNG seed for query inputs (default 42)
  --help, -h        Show this help

Examples:
  node bench/scale-test/real-world.js --repo ~/clones/linux --name linux-kernel
  node bench/scale-test/real-world.js --repo ~/clones/chromium/src --name chromium
`);
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(err.message); usage(); process.exit(1); }

  if (opts.help) { usage(); process.exit(0); }
  if (!opts.repo) { usage(); process.exit(1); }
  if (!fs.existsSync(opts.repo)) {
    console.error(`--repo does not exist: ${opts.repo}`);
    process.exit(1);
  }

  const repoName = opts.name || path.basename(opts.repo);
  console.log(`[scale-real] Repo: ${opts.repo} (label: ${repoName})`);
  if (opts.queriesOnly) console.log('[scale-real] --queries-only: skipping init/sync');

  const result = await runScale(opts.repo, {
    skipInit: opts.queriesOnly,
    querySeed: opts.seed,
  });

  const stamped = { kind: 'real', repoName, ...result };

  const resultsDir = path.join(__dirname, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(resultsDir, `real-${repoName}-${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify(stamped, null, 2));
  console.log(`[scale-real] raw → ${path.relative(process.cwd(), outPath)}`);

  const reportPath = generateReport(resultsDir, path.join(__dirname, 'REPORT.md'));
  console.log(`[scale-real] REPORT → ${path.relative(process.cwd(), reportPath)}`);

  console.log('');
  console.log(`Summary (${repoName}):`);
  console.log(`  Files indexed     : ${result.totalFiles?.toLocaleString() || '?'}`);
  console.log(`  Import edges      : ${result.edgeCount?.toLocaleString() || '?'}`);
  console.log(`  Extraction errors : ${result.extractionErrorCount ?? 0}`);
  if (result.initMs != null) console.log(`  Init              : ${(result.initMs / 1000).toFixed(2)}s`);
  if (result.syncMs != null) console.log(`  Sync              : ${(result.syncMs / 1000).toFixed(2)}s`);
  console.log(`  DB                : ${(result.dbBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  bitmap.bin        : ${(result.bitmapBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  Peak RSS          : ${(result.peakRss / 1024 / 1024).toFixed(0)} MB`);
  console.log('');
}

main().catch((err) => { console.error(err); process.exit(1); });
