'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { SQLiteStore } = require('../store/sqlite-store');
const { checkForUpdate } = require('./update-check');

async function run(projectRoot, opts = {}) {
  // Parse `--temporal` from argv if not explicitly passed in opts.
  const wantTemporal = opts.temporal || (Array.isArray(opts.argv)
    ? opts.argv.includes('--temporal')
    : process.argv.slice(2).includes('--temporal'));
  checkForUpdate(); // fire and forget
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

  // Language coverage (only shows when grammars are missing)
  const unavailRaw = store.getMeta('unavailable_languages_json');
  const unavailLangs = unavailRaw ? (() => { try { return JSON.parse(unavailRaw); } catch { return []; } })() : [];
  if (unavailLangs.length > 0) {
    console.log(`  Lang coverage : ⚠️  ${unavailLangs.length} grammar${unavailLangs.length === 1 ? '' : 's'} unavailable (${unavailLangs.join(', ')}) — regex fallback active`);
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

  // ── Domain stability ──────────────────────────────────────────────────
  const driftPct = parseFloat(store.getMeta('domain_stability_drift_pct') || '0');
  const reassignmentsRaw = store.getMeta('last_reassignments_json');
  const reassignments = reassignmentsRaw ? (() => { try { return JSON.parse(reassignmentsRaw); } catch { return []; } })() : [];

  if (driftPct > 0 || reassignments.length > 0) {
    if (driftPct > 5) {
      hasIssues = true;
      console.log(`  ⚠️  Domain stability: ${driftPct.toFixed(1)}% drift`);
    } else {
      console.log(`  ✅ Domain stability: ${driftPct.toFixed(1)}% drift`);
    }
    if (reassignments.length > 0) {
      console.log('     Recent reassignments:');
      for (const r of reassignments.slice(0, 5)) {
        console.log(`       ${path.basename(r.file)}: ${r.from} → ${r.to}`);
      }
      if (reassignments.length > 5) console.log(`       ...and ${reassignments.length - 5} more`);
    }
    console.log('');
  } else if (domains.length > 1) {
    console.log('  ✅ Domain stability: 0.0% drift (no reassignments)\n');
  }

  // ── Extraction errors ─────────────────────────────────────────────────
  const errorCount = store.getExtractionErrorCount();
  if (errorCount > 0) {
    hasIssues = true;
    const topFiles = store.getExtractionErrorsTopFiles(5);
    console.log(`  ⚠️  Extraction errors (${errorCount}):`);
    console.log('     These files failed to parse — their routes/models/imports are missing from the index.\n');
    for (const f of topFiles) {
      const phases = f.phases ? ` [${f.phases}]` : '';
      console.log(`     ${f.file}${phases}`);
      if (f.sample) {
        // Truncate sample for terminal readability
        const sample = String(f.sample).split('\n')[0].slice(0, 120);
        console.log(`       └─ ${sample}`);
      }
    }
    // Errors NOT covered by the top-5 file slice (i.e., 6th+ file's errors).
    const shown = topFiles.reduce((a, f) => a + (f.errorCount || 0), 0);
    const remainingErrors = errorCount - shown;
    if (remainingErrors > 0) {
      console.log(`     ...and ${remainingErrors} more error${remainingErrors === 1 ? '' : 's'} in additional files`);
    }
    console.log('');
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
    // Low-resolution warning: when a single domain (typically the CORE
    // fallback) swallows >70% of files, the taxonomy told you almost
    // nothing about the repo's structure — every cross-domain feature
    // degrades with it (CARTO-006).
    const totalDomainFiles = domains.reduce((s, d) => s + d.fileCount, 0);
    if (totalDomainFiles > 0) {
      const top = domains.reduce((a, b) => (b.fileCount > a.fileCount ? b : a));
      const share = top.fileCount / totalDomainFiles;
      if (share > 0.70) {
        console.log('');
        console.log(`  ⚠️  Low domain resolution: ${(share * 100).toFixed(0)}% of files are in ${top.name}.`);
        console.log(`     Domain classification added little — cross-domain / validate_diff signals will be weak.`);
        console.log(`     Consider declaring domains in carto.config.json (globs/keywords/anchors).`);
      }
    }
    console.log('');
  }

  console.log('─────────────────────────────────────────────────────────\n');
  console.log(hasIssues ? '  ⚠️  Issues found above.' : '  ✅ All clear.');
  console.log('');

  // ── Temporal layer (opt-in via --temporal) ───────────────────────────────
  if (wantTemporal) {
    try {
      const { TemporalStore } = require('../temporal/store');
      const temporal = TemporalStore.openIfExists(projectRoot, { readonly: true });
      if (!temporal) {
        console.log('  ℹ️  --temporal: no temporal database. Run `carto temporal init`.\n');
      } else {
        try {
          const q = require('../temporal/queries');
          const drift = q.getArchitecturalDrift(temporal, { timeRange: '30d' });
          const hotspots = q.getHotspotFiles(temporal, { timeRange: '90d', limit: 5 });
          const events = q.getArchEvents(temporal, { timeRange: '30d', limit: 10 });

          console.log('  📈 Temporal (last 30d)');
          console.log(`     Trend: ${drift.trend}`);
          if (drift.byDomain && drift.byDomain.length > 0) {
            const top = drift.byDomain.slice(0, 5);
            for (const d of top) {
              const arrow = d.delta > 0 ? `+${d.delta}` : `${d.delta}`;
              console.log(`     ${d.domain.padEnd(16)} ${String(d.before).padStart(4)} → ${String(d.after).padStart(4)} (${arrow})`);
            }
          }
          if (hotspots.hotspots && hotspots.hotspots.length > 0) {
            console.log('  🔥 Hotspots (top 5):');
            for (const h of hotspots.hotspots) {
              console.log(`     ${String(h.commit_count).padStart(3)} commits · blast ${String(h.blast_radius).padStart(3)} — ${h.file_path}`);
            }
          }
          if (events.events && events.events.length > 0) {
            console.log(`  ⚠️  ${events.events.length} architectural event${events.events.length === 1 ? '' : 's'} (last 30d)`);
          }
          console.log('');
        } finally {
          temporal.close();
        }
      }
    } catch (err) {
      console.log(`  ⚠️  --temporal: ${err.message}\n`);
    }
  }

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
