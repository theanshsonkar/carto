'use strict';

const { execSync } = require('child_process');
const path = require('path');
const { Carto } = require('../../index.js');

async function run(projectRoot) {
  const carto = new Carto();

  try {
    await carto.index(projectRoot, { useWorkers: false });
  } catch (err) {
    console.error(`[CARTO] Error loading index: ${err.message}`);
    process.exit(1);
  }

  const meta = carto.getMeta();
  const domains = carto.getDomainsList();
  const crossDomain = carto.getCrossDomainDeps();
  const highImpact = carto.getHighImpactFiles(20);

  let hasIssues = false;

  console.log('\n── Carto Check ─────────────────────────────────────────\n');

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`  Files indexed : ${meta.totalFiles}`);
  console.log(`  Routes found  : ${meta.totalRoutes}`);
  console.log(`  Import edges  : ${meta.totalImportEdges}`);
  console.log(`  Domains       : ${domains.map(d => d.name).join(', ') || 'none'}`);
  if (meta.lastIndexed) {
    const age = Math.round((Date.now() - new Date(meta.lastIndexed).getTime()) / 1000);
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
        const br = carto.getBlastRadius(f);
        console.log(`     🔴 ${f}`);
        console.log(`        ${hi.dependents} files depend on this — blast risk: ${br ? br.risk : 'UNKNOWN'}`);
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
      console.log(`     ${f.dependents.toString().padStart(3)} dependents — ${f.file}`);
    }
    console.log('');
  }

  // ── Domain breakdown ─────────────────────────────────────────────────────
  if (domains.length > 0) {
    console.log('  Domains:');
    for (const d of domains) {
      console.log(`     ${d.name.padEnd(16)} ${d.fileCount} files  ${d.routeCount} routes  ${d.modelCount} models`);
    }
    console.log('');
  }

  console.log('─────────────────────────────────────────────────────────\n');
  console.log(hasIssues ? '  ⚠️  Issues found above.' : '  ✅ All clear.');
  console.log('');

  carto.terminate();
}

function getModifiedFiles(projectRoot) {
  try {
    const output = execSync('git diff --name-only HEAD 2>/dev/null && git diff --name-only 2>/dev/null', {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const files = [...new Set(output.trim().split('\n').filter(Boolean))];
    return files;
  } catch {
    return [];
  }
}

module.exports = { run };
