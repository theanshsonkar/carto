'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { SQLiteStore } = require('../store/sqlite-store');

async function run(projectRoot) {
  const dbPath = path.join(projectRoot, '.carto', 'carto.db');

  if (!fs.existsSync(dbPath)) {
    console.error('[CARTO] No .carto/carto.db found. Run `carto sync` first.');
    process.exit(1);
  }

  const store = new SQLiteStore(projectRoot);
  store.open();

  const structure = store.getStructure();
  const domains = store.getDomainsList();
  const crossDomain = store.getCrossDomainDeps();
  const highImpact = store.getHighImpactFiles(20);

  let hasIssues = false;

  console.log('\n── Carto Check ─────────────────────────────────────────\n');

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`  Files indexed : ${structure.meta.totalFiles}`);
  console.log(`  Routes found  : ${structure.meta.totalRoutes}`);
  console.log(`  Import edges  : ${structure.meta.totalImportEdges}`);
  if (domains.length > 0) {
    console.log(`  Domains       : ${domains.map(d => d.name).join(' · ')}`);
  }
  if (structure.meta.lastIndexed) {
    const age = Math.round((Date.now() - new Date(structure.meta.lastIndexed).getTime()) / 1000);
    const ageStr = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.round(age / 60)}m ago` : `${Math.round(age / 3600)}h ago`;
    console.log(`  Last indexed  : ${ageStr}`);
  }
  console.log('');

  // ── Uncommitted changes that touch high-blast-radius files ───────────────
  const modifiedFiles = getModifiedFiles(projectRoot);
  if (modifiedFiles.length > 0) {
    const highImpactSet = new Set(highImpact.map(f => f.file));
    const riskyChanges = modifiedFiles.filter(f => highImpactSet.has(f));

    if (riskyChanges.length > 0) {
      hasIssues = true;
      console.log(`  ⚠️  High-risk uncommitted changes (${riskyChanges.length}):`);
      for (const f of riskyChanges) {
        const hi = highImpact.find(h => h.file === f);
        const blastDeps = store.getBlastRadius(f) || [];
        const risk = blastDeps.length >= 10 ? 'HIGH' : blastDeps.length >= 5 ? 'MEDIUM' : 'LOW';
        console.log(`     🔴 ${f}`);
        console.log(`        ${hi.dependents} files depend on this — blast risk: ${risk}`);
      }
      console.log('');
    } else {
      console.log(`  ✅ ${modifiedFiles.length} modified file(s) — none are high-impact\n`);
    }
  }

  // ── Cross-domain dependency violations ───────────────────────────────────
  if (crossDomain.length > 0) {
    hasIssues = true;
    console.log(`  ⚠️  Cross-domain dependencies (${crossDomain.length}):`);
    console.log('     These files import across domain boundaries.\n');

    // Group by fromDomain → toDomain pair
    const grouped = {};
    for (const d of crossDomain) {
      const key = `${d.fromDomain} → ${d.toDomain}`;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(d);
    }

    for (const [pair, deps] of Object.entries(grouped)) {
      console.log(`     ${pair} (${deps.length})`);
      for (const d of deps.slice(0, 3)) {
        console.log(`       ${path.basename(d.from)} imports ${path.basename(d.to)}`);
      }
      if (deps.length > 3) console.log(`       ...and ${deps.length - 3} more`);
    }
    console.log('');
  } else if (domains.length > 1) {
    console.log('  ✅ No cross-domain dependency violations\n');
  }

  // ── Top high-impact files ────────────────────────────────────────────────
  if (highImpact.length > 0) {
    console.log(`  🔥 Top high-impact files (changing these = highest blast radius):`);
    for (const f of highImpact.slice(0, 5)) {
      console.log(`     ${String(f.dependents).padStart(3)} dependents — ${f.file}`);
    }
    console.log('');
  }

  // ── Domain breakdown ─────────────────────────────────────────────────────
  if (domains.length > 0) {
    console.log('  Domains:');
    for (const d of domains) {
      console.log(`     ${d.name.padEnd(16)} ${String(d.fileCount).padStart(5)} files  ${String(d.routeCount).padStart(4)} routes  ${String(d.modelCount).padStart(4)} models`);
    }
    console.log('');
  }

  console.log('─────────────────────────────────────────────────────────\n');
  console.log(hasIssues ? '  ⚠️  Issues found above.' : '  ✅ All clear.');
  console.log('');

  store.close();
}

function getModifiedFiles(projectRoot) {
  try {
    const output = execSync('git diff --name-only HEAD 2>/dev/null && git diff --name-only 2>/dev/null', {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return [...new Set(output.trim().split('\n').filter(Boolean))];
  } catch {
    return [];
  }
}

module.exports = { run };
