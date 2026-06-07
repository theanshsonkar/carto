#!/usr/bin/env node
'use strict';

/**
 * Scale-test driver CLI.
 *
 * Usage:
 *   node bench/scale-test/index.js --size 100000
 *   node bench/scale-test/index.js --size 1000000 --out /tmp/carto-scale-1m
 *   node bench/scale-test/index.js --size 100000 --queries-only --keep
 *
 * Flags:
 *   --size N           Number of synth files (required unless --repo)
 *   --repo PATH        Run against an already-generated dir (skip generator)
 *   --out PATH         Output dir (default: $TMPDIR/carto-scale-<size>)
 *   --seed N           Generator + query PRNG seed (default 42)
 *   --queries-only     Skip init/sync; assume `.carto/carto.db` already exists
 *   --keep             Don't delete output dir on completion (default: cleanup)
 *   --regen            Force regeneration even if outDir already populated
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateRepo } = require('./generator');
const { runScale } = require('./runner');
const { generateReport } = require('./report');

function parseArgs(argv) {
  const opts = { keep: false, queriesOnly: false, regen: false, seed: 42 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--size') opts.size = parseInt(argv[++i], 10);
    else if (a === '--repo') opts.repo = path.resolve(argv[++i]);
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--seed') opts.seed = parseInt(argv[++i], 10);
    else if (a === '--queries-only') opts.queriesOnly = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--regen') opts.regen = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown flag: ${a}`);
  }
  return opts;
}

function usage() {
  console.log(`Usage: node bench/scale-test/index.js --size <N> [options]

Options:
  --size N          Number of synth files (e.g. 1000, 100000, 1000000)
  --repo PATH       Run against an already-generated dir (skip generator)
  --out PATH        Output dir (default: $TMPDIR/carto-scale-<size>)
  --seed N          PRNG seed for generation + queries (default: 42)
  --queries-only    Skip init/sync; only run query benchmarks
  --keep            Don't delete output dir on completion
  --regen           Force regeneration even if outDir already exists
  --help, -h        Show this help

Examples:
  npm run bench:scale -- --size 10000
  node bench/scale-test/index.js --size 1000000 --out /tmp/carto-1m --keep
  node bench/scale-test/index.js --repo /tmp/carto-1m --queries-only
`);
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(err.message); usage(); process.exit(1); }

  if (opts.help) { usage(); process.exit(0); }
  if (!opts.size && !opts.repo) { usage(); process.exit(1); }

  // Resolve project root.
  let projectRoot;
  if (opts.repo) {
    projectRoot = opts.repo;
    if (!fs.existsSync(projectRoot)) {
      console.error(`--repo path does not exist: ${projectRoot}`);
      process.exit(1);
    }
  } else {
    projectRoot = opts.out || path.join(os.tmpdir(), `carto-scale-${opts.size}`);
  }

  // Generate (unless skipped).
  if (!opts.repo && !opts.queriesOnly) {
    const alreadyHas = fs.existsSync(path.join(projectRoot, 'package.json')) &&
                       fs.existsSync(path.join(projectRoot, 'src'));
    if (alreadyHas && !opts.regen) {
      console.log(`[scale-bench] reusing existing repo at ${projectRoot} (pass --regen to rebuild)`);
    } else {
      // Wipe + regenerate.
      try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
      console.log(`[scale-bench] generating ${opts.size.toLocaleString()} files at ${projectRoot}…`);
      const t0 = Date.now();
      let lastTick = Date.now();
      const meta = generateRepo(projectRoot, {
        size: opts.size,
        seed: opts.seed,
        onProgress: (count) => {
          const now = Date.now();
          if (now - lastTick > 1500 || count === opts.size) {
            const pct = Math.round((count / opts.size) * 100);
            process.stdout.write(`\r[scale-bench] generated ${count.toLocaleString()}/${opts.size.toLocaleString()} (${pct}%)`);
            lastTick = now;
          }
        },
      });
      process.stdout.write('\n');
      const elapsed = Date.now() - t0;
      console.log(`[scale-bench] generation: ${meta.size.toLocaleString()} files, ${meta.edgeCount.toLocaleString()} declared edges, ${(elapsed / 1000).toFixed(1)}s`);
    }
  }

  // Run.
  console.log('[scale-bench] running carto sync + bitmap query benchmark…');
  const result = await runScale(projectRoot, {
    skipInit: opts.queriesOnly,
    querySeed: opts.seed,
  });

  // Stamp synth metadata onto the result for the report.
  const stamped = {
    kind: opts.repo ? 'synth-external' : 'synth',
    size: opts.size,
    seed: opts.seed,
    ...result,
  };

  // Persist raw result.
  const resultsDir = path.join(__dirname, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = opts.size ? `synth-${opts.size}` : `repo-${path.basename(projectRoot)}`;
  const outPath = path.join(resultsDir, `${tag}-${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify(stamped, null, 2));
  console.log(`[scale-bench] raw → ${path.relative(process.cwd(), outPath)}`);

  // Refresh REPORT.md.
  const reportPath = generateReport(resultsDir, path.join(__dirname, 'REPORT.md'));
  console.log(`[scale-bench] REPORT → ${path.relative(process.cwd(), reportPath)}`);

  // Headline summary.
  console.log('');
  console.log('Summary:');
  console.log(`  Files indexed: ${result.totalFiles.toLocaleString()}`);
  console.log(`  Import edges : ${result.edgeCount.toLocaleString()}`);
  if (result.initMs != null) console.log(`  Init time    : ${(result.initMs / 1000).toFixed(2)}s`);
  if (result.syncMs != null) console.log(`  Sync time    : ${(result.syncMs / 1000).toFixed(3)}s`);
  console.log(`  DB on disk   : ${(result.dbBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  bitmap.bin   : ${(result.bitmapBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Sidecar RAM  : ${(result.sidecar.bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Peak RSS     : ${(result.peakRss / 1024 / 1024).toFixed(0)} MB`);
  console.log('');
  console.log('  MCP query p50 / p99:');
  for (const [tool, stats] of Object.entries(result.perTool)) {
    const fmt = (ns) => ns < 1_000_000 ? `${(ns / 1000).toFixed(1)}µs` : `${(ns / 1_000_000).toFixed(2)}ms`;
    console.log(`    ${tool.padEnd(22)} ${fmt(stats.p50).padStart(10)} / ${fmt(stats.p99).padStart(10)}`);
  }
  console.log('');

  // Cleanup unless --keep.
  if (!opts.keep && !opts.repo && !opts.queriesOnly) {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
    console.log(`[scale-bench] removed ${projectRoot} (pass --keep to retain)`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
