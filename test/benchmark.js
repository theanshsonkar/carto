#!/usr/bin/env node
'use strict';

/**
 * Carto V2 Benchmark Suite
 *
 * Tests against 4 real-world repos:
 *   - prisma    (TypeScript monorepo, ~4,600 total files)
 *   - supabase  (Next.js monorepo, ~15,700 total files)
 *   - vscode    (TypeScript, ~14,900 total files)
 *   - zed       (Rust, ~3,800 total files)
 *
 * Measures:
 *   - File discovery count
 *   - First-run index time
 *   - Second-run time (mtime+size cache)
 *   - SQLite DB size
 *   - Routes, models, import edges extracted
 *   - Domains detected
 *   - MCP query latency (blast radius, get_structure)
 *   - Incremental update time (single file touch)
 *   - Memory usage (RSS before/after)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const BENCH_DIR = path.join(__dirname, '..', 'tmp-bench');
const REPOS = ['prisma', 'supabase', 'vscode', 'zed'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hrMs(start) {
  const [s, ns] = process.hrtime(start);
  return Math.round(s * 1000 + ns / 1e6);
}

function dbSize(projectRoot) {
  const dbPath = path.join(projectRoot, '.carto', 'carto.db');
  try {
    const stat = fs.statSync(dbPath);
    return stat.size;
  } catch { return 0; }
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function rss() {
  return process.memoryUsage().rss;
}

function deleteCarto(projectRoot) {
  const cartoDir = path.join(projectRoot, '.carto');
  try {
    fs.rmSync(cartoDir, { recursive: true, force: true });
  } catch {}
}

// ─── Core benchmark for one repo ─────────────────────────────────────────────

async function benchmarkRepo(repoName) {
  const projectRoot = path.join(BENCH_DIR, repoName);

  if (!fs.existsSync(projectRoot)) {
    console.log(`  ⚠️  ${repoName}: not found at ${projectRoot}, skipping`);
    return null;
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${repoName.toUpperCase()}`);
  console.log(`${'─'.repeat(60)}`);

  // Ensure clean state for first run
  deleteCarto(projectRoot);

  const { runSync, discoverFiles } = require('../src/store/sync');

  // ── File discovery ──────────────────────────────────────────────────────────
  const discStart = process.hrtime();
  const allFiles = discoverFiles(projectRoot);
  const discMs = hrMs(discStart);
  console.log(`  Discovery:    ${allFiles.length} files in ${fmtMs(discMs)}`);

  // ── First run ───────────────────────────────────────────────────────────────
  const rssBefore = rss();
  const run1Start = process.hrtime();

  let run1Result;
  try {
    run1Result = await runSync({
      projectRoot,
      output: path.join(projectRoot, 'AGENTS.md')
    });
  } catch (err) {
    console.log(`  ❌ First run FAILED: ${err.message}`);
    return null;
  }

  const run1Ms = hrMs(run1Start);
  const rssAfter = rss();
  const rssSpike = Math.max(0, rssAfter - rssBefore);
  const db1 = dbSize(projectRoot);

  console.log(`  First run:    ${fmtMs(run1Ms)} (${run1Result.filesProcessed} files processed)`);
  console.log(`  DB size:      ${fmtBytes(db1)}`);
  console.log(`  RAM spike:    ${fmtBytes(rssSpike)}`);

  // ── Second run (cache) ──────────────────────────────────────────────────────
  const run2Start = process.hrtime();
  let run2Result;
  try {
    run2Result = await runSync({
      projectRoot,
      output: path.join(projectRoot, 'AGENTS.md')
    });
  } catch (err) {
    console.log(`  ❌ Second run FAILED: ${err.message}`);
    return null;
  }
  const run2Ms = hrMs(run2Start);
  console.log(`  Second run:   ${fmtMs(run2Ms)} (${run2Result.filesProcessed} files changed)`);

  // ── Query what was extracted ────────────────────────────────────────────────
  const { SQLiteStore } = require('../src/store/sqlite-store');
  const store = new SQLiteStore(projectRoot);
  store.open();

  const totalFiles = store.getFileCount();
  const routes = store.getRoutes();
  const models = store.getModels();
  const domains = store.getDomainsList();
  const structure = store.getStructure();

  console.log(`\n  Extraction results:`);
  console.log(`    Files indexed:   ${totalFiles}`);
  console.log(`    Routes:          ${routes.length}`);
  console.log(`    Models:          ${models.length}`);
  console.log(`    Import edges:    ${structure.meta.totalImportEdges}`);
  console.log(`    Domains:         ${domains.map(d => `${d.name}(${d.fileCount})`).join(' · ')}`);

  // ── MCP query latency ───────────────────────────────────────────────────────
  console.log(`\n  MCP query latency:`);

  // get_structure
  const q1Start = process.hrtime();
  store.getStructure();
  const q1Ms = hrMs(q1Start);
  console.log(`    get_structure:   ${q1Ms}ms`);

  // get_blast_radius on a high-impact file
  const highImpact = store.getHighImpactFiles(1);
  if (highImpact.length > 0) {
    const q2Start = process.hrtime();
    store.getBlastRadius(highImpact[0].file);
    const q2Ms = hrMs(q2Start);
    console.log(`    get_blast_radius(${path.basename(highImpact[0].file)}): ${q2Ms}ms`);
  }

  // get_routes
  const q3Start = process.hrtime();
  store.getRoutes();
  const q3Ms = hrMs(q3Start);
  console.log(`    get_routes:      ${q3Ms}ms`);

  // get_domains_list
  const q4Start = process.hrtime();
  store.getDomainsList();
  const q4Ms = hrMs(q4Start);
  console.log(`    get_domains_list:${q4Ms}ms`);

  // ── Incremental update ──────────────────────────────────────────────────────
  // Touch a real source file and measure incremental update time
  const sampleFile = allFiles.find(f => f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.rs') || f.endsWith('.py'));
  if (sampleFile) {
    const fullPath = path.resolve(projectRoot, sampleFile);
    // Touch the file (update mtime without changing content)
    const now = new Date();
    try {
      fs.utimesSync(fullPath, now, now);
    } catch {}

    const incrStart = process.hrtime();
    try {
      await runSync({ projectRoot, output: path.join(projectRoot, 'AGENTS.md') });
    } catch {}
    const incrMs = hrMs(incrStart);
    console.log(`\n  Incremental (1 file touched): ${fmtMs(incrMs)}`);
  }

  store.close();

  // ── Pass/fail assessment ────────────────────────────────────────────────────
  const targets = {
    firstRunOk: run1Ms < (repoName === 'vscode' ? 60000 : 30000), // vscode gets 60s target
    secondRunOk: run2Ms < 5000,
    dbSizeOk: db1 < 300 * 1024 * 1024, // <300MB
    q1Ok: q1Ms < 10,
    q3Ok: q3Ms < 10,
  };

  const allPass = Object.values(targets).every(Boolean);
  console.log(`\n  ${allPass ? '✅ ALL TARGETS MET' : '⚠️  SOME TARGETS MISSED'}`);
  if (!targets.firstRunOk) console.log(`    ❌ First run ${fmtMs(run1Ms)} exceeds target`);
  if (!targets.secondRunOk) console.log(`    ❌ Second run ${fmtMs(run2Ms)} exceeds 5s target`);
  if (!targets.q1Ok) console.log(`    ❌ get_structure ${q1Ms}ms exceeds 10ms target`);
  if (!targets.q3Ok) console.log(`    ❌ get_routes ${q3Ms}ms exceeds 10ms target`);

  return {
    repo: repoName,
    totalSourceFiles: allFiles.length,
    filesIndexed: totalFiles,
    firstRunMs: run1Ms,
    secondRunMs: run2Ms,
    dbBytes: db1,
    rssSpike,
    routes: routes.length,
    models: models.length,
    importEdges: structure.meta.totalImportEdges,
    domains: domains.map(d => `${d.name}(${d.fileCount})`),
    queryMs: { structure: q1Ms, routes: q3Ms, domains: q4Ms },
    allTargetsMet: allPass,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Carto V2 Benchmark Suite');
  console.log(`Node ${process.version} · ${os.cpus().length} CPUs · ${fmtBytes(os.totalmem())} RAM`);
  console.log(`Platform: ${os.platform()} ${os.arch()}`);

  const results = [];

  for (const repo of REPOS) {
    try {
      const result = await benchmarkRepo(repo);
      if (result) results.push(result);
    } catch (err) {
      console.log(`\n  ❌ ${repo} crashed: ${err.message}`);
      console.log(err.stack);
    }
  }

  // ── Summary table ───────────────────────────────────────────────────────────
  if (results.length > 0) {
    console.log(`\n${'═'.repeat(80)}`);
    console.log('SUMMARY');
    console.log(`${'═'.repeat(80)}`);
    console.log(
      'Repo'.padEnd(12) +
      'Files'.padStart(8) +
      'Indexed'.padStart(10) +
      'First'.padStart(10) +
      'Second'.padStart(10) +
      'DB'.padStart(10) +
      'Routes'.padStart(8) +
      'Edges'.padStart(8)
    );
    console.log('─'.repeat(80));
    for (const r of results) {
      console.log(
        r.repo.padEnd(12) +
        String(r.totalSourceFiles).padStart(8) +
        String(r.filesIndexed).padStart(10) +
        fmtMs(r.firstRunMs).padStart(10) +
        fmtMs(r.secondRunMs).padStart(10) +
        fmtBytes(r.dbBytes).padStart(10) +
        String(r.routes).padStart(8) +
        String(r.importEdges).padStart(8)
      );
    }
    console.log('─'.repeat(80));

    // Write results to file
    const reportPath = path.join(__dirname, '..', 'BENCHMARK_RESULTS.md');
    const lines = [
      '# Carto V2 Benchmark Results\n',
      `Generated: ${new Date().toISOString()}`,
      `Platform: Node ${process.version} · ${os.cpus().length} CPUs · ${fmtBytes(os.totalmem())} RAM · ${os.platform()} ${os.arch()}\n`,
      '| Repo | Source Files | Indexed | First Run | Second Run | DB Size | Routes | Import Edges |',
      '|------|-------------|---------|-----------|------------|---------|--------|--------------|',
    ];
    for (const r of results) {
      lines.push(
        `| ${r.repo} | ${r.totalSourceFiles} | ${r.filesIndexed} | ${fmtMs(r.firstRunMs)} | ${fmtMs(r.secondRunMs)} | ${fmtBytes(r.dbBytes)} | ${r.routes} | ${r.importEdges} |`
      );
    }
    lines.push('\n## Domains Detected\n');
    for (const r of results) {
      lines.push(`**${r.repo}:** ${r.domains.join(' · ')}`);
    }
    lines.push('\n## MCP Query Latency\n');
    lines.push('| Repo | get_structure | get_routes | get_domains_list |');
    lines.push('|------|--------------|------------|-----------------|');
    for (const r of results) {
      lines.push(`| ${r.repo} | ${r.queryMs.structure}ms | ${r.queryMs.routes}ms | ${r.queryMs.domains}ms |`);
    }
    lines.push('\n## Target Assessment\n');
    for (const r of results) {
      lines.push(`- **${r.repo}**: ${r.allTargetsMet ? '✅ All targets met' : '⚠️ Some targets missed'}`);
    }

    fs.writeFileSync(reportPath, lines.join('\n') + '\n', 'utf-8');
    console.log(`\nResults written to BENCHMARK_RESULTS.md`);
  }
}

main().catch(err => {
  console.error('Benchmark failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
