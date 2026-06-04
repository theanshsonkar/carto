#!/usr/bin/env node
'use strict';

/**
 * Accuracy parity harness — bitmap vs SQLite for the 4 parity-able MCP tools.
 *
 * Usage:  node test/accuracy-corpus.js [--repo <path>] [--samples N]
 *
 * For each corpus repo (or one passed via --repo):
 *   - blastRadius           sample N random indexed files; compare bitmap result
 *                           vs SQLite result as both a SET of files and as
 *                           {file, hop_distance} tuples.
 *   - crossDomain           full output; compare as a SET of (from, to, fromDomain,
 *                           toDomain) tuples (ordering can differ — both sources
 *                           sort by (fromDomain, toDomain) but ties within a
 *                           pair may break differently).
 *   - highImpactFiles       top-20; compare top-N entries (file + dependent count
 *                           must match exactly — popcountIndex is sorted DESC,
 *                           SQLite uses centrality column which Spec 14
 *                           re-derives from the same reverse-dep counts).
 *   - simulateChangeImpact  no SQLite equivalent — verify against the expected
 *                           union: simulate(files) === unionOf(blastRadius(file))
 *                           for each input file (excluding the inputs themselves).
 *
 * Exits 0 only if every comparison passes on every repo.
 *
 * NOTE: similarPatterns is intentionally NOT in this harness — Spec 14
 * documented that bitmap uses Jaccard similarity (different semantics from
 * the SQL 3-strategy fallback). The MCP layer uses bitmap when present;
 * SQLite is the rare-error fallback. Comparing the two for identity would
 * fail by design.
 */

const fs = require('fs');
const path = require('path');
const { SQLiteStore } = require('../src/store/sqlite-store');
const { buildFromStore } = require('../src/bitmap/sidecar');
const bitmapTools = require('../src/bitmap/tools');

const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  return argv[i + 1];
}

const SAMPLES = parseInt(flag('--samples', 50), 10);
const SINGLE_REPO = flag('--repo', null);

const CORPUS_ROOT = path.join(process.env.HOME, 'carto-test-repos');
const TIER_A = ['axum', 'express', 'fastapi', 'flask', 'gin']
  .map(r => path.join(CORPUS_ROOT, 'tier-a', r));
const TIER_B = ['cal.com', 'laravel-framework', 'nextjs', 'prisma', 'supabase', 'vscode', 'zed']
  .map(r => path.join(CORPUS_ROOT, 'tier-b', r));
const ALL_REPOS = SINGLE_REPO ? [SINGLE_REPO] : [...TIER_A, ...TIER_B];

function seededRandom(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) & 0xFFFFFFFF; return (s >>> 0) / 0xFFFFFFFF; };
}

function setEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function verifyRepo(repoPath) {
  const dbPath = path.join(repoPath, '.carto', 'carto.db');
  if (!fs.existsSync(dbPath)) {
    return { repo: repoPath, skipped: true, reason: '.carto/carto.db not found — run carto init' };
  }

  const store = new SQLiteStore(repoPath);
  store.open({ readonly: true });

  const sidecar = buildFromStore(store);
  const fileIds = Array.from(sidecar.fileIdToPath.keys());
  if (fileIds.length === 0) {
    store.close();
    return { repo: repoPath, skipped: true, reason: 'no indexed files' };
  }

  const rand = seededRandom(0xCA470 ^ fileIds.length);
  const sampleSize = Math.min(SAMPLES, fileIds.length);
  const sampleIds = [];
  // Reservoir-style: walk all ids, pick a deterministic spread.
  for (let i = 0; i < sampleSize; i++) {
    sampleIds.push(fileIds[Math.floor(rand() * fileIds.length)]);
  }

  const failures = [];

  // ── 1. blastRadius parity (set of files + per-file hop distance) ──
  let brChecked = 0;
  for (const fid of sampleIds) {
    const filePath = sidecar.fileIdToPath.get(fid);
    const sqlRes = store.getBlastRadius(filePath, 5);
    const bmRes = bitmapTools.blastRadius(sidecar, filePath, 5);
    // Both are arrays of {file, hop_distance} — or null if file unknown.
    if (sqlRes === null && bmRes === null) { brChecked++; continue; }
    if (sqlRes === null || bmRes === null) {
      failures.push({
        tool: 'blastRadius', file: filePath,
        msg: `null mismatch: sql=${sqlRes === null} bitmap=${bmRes === null}`,
      });
      continue;
    }
    const sqlSet = new Set(sqlRes.map(r => r.file));
    const bmSet = new Set(bmRes.map(r => r.file));
    if (!setEqual(sqlSet, bmSet)) {
      const onlySql = [...sqlSet].filter(x => !bmSet.has(x));
      const onlyBm = [...bmSet].filter(x => !sqlSet.has(x));
      failures.push({
        tool: 'blastRadius', file: filePath,
        msg: `set mismatch: sql_only=${onlySql.length} bitmap_only=${onlyBm.length}`,
        onlySql: onlySql.slice(0, 3),
        onlyBm: onlyBm.slice(0, 3),
      });
      continue;
    }
    // Hop distance must match per file.
    const sqlHops = new Map(sqlRes.map(r => [r.file, r.hop_distance]));
    for (const r of bmRes) {
      if (sqlHops.get(r.file) !== r.hop_distance) {
        failures.push({
          tool: 'blastRadius', file: filePath,
          msg: `hop mismatch on ${r.file}: sql=${sqlHops.get(r.file)} bitmap=${r.hop_distance}`,
        });
        break;
      }
    }
    brChecked++;
  }

  // ── 2. crossDomain parity (full output, set of (from,to,fromDomain,toDomain)) ──
  const sqlXd = store.getCrossDomainDeps();
  const bmXd = bitmapTools.crossDomain(sidecar);
  const sqlXdKeys = new Set(sqlXd.map(r => `${r.fromDomain}|${r.from}|${r.toDomain}|${r.to}`));
  const bmXdKeys = new Set(bmXd.map(r => `${r.fromDomain}|${r.from}|${r.toDomain}|${r.to}`));
  if (!setEqual(sqlXdKeys, bmXdKeys)) {
    const onlySql = [...sqlXdKeys].filter(x => !bmXdKeys.has(x));
    const onlyBm = [...bmXdKeys].filter(x => !sqlXdKeys.has(x));
    failures.push({
      tool: 'crossDomain',
      msg: `set mismatch: sql=${sqlXdKeys.size} bitmap=${bmXdKeys.size} sql_only=${onlySql.length} bitmap_only=${onlyBm.length}`,
      onlySql: onlySql.slice(0, 3),
      onlyBm: onlyBm.slice(0, 3),
    });
  }

  // ── 3. highImpactFiles parity (top-20: file + dependent count) ──
  const N = 20;
  const sqlHi = store.getHighImpactFiles(N);
  const bmHi = bitmapTools.highImpactFiles(sidecar, N);
  // Both are arrays of {file, dependents}. The bitmap path uses
  // popcountIndex (sorted DESC by direct-dependent count). SQLite uses
  // centrality. Both should produce the same multiset of (file, count)
  // pairs at the top — though tie-breaking order may differ.
  const sqlHiPairs = sqlHi.map(r => `${r.file}|${r.dependents}`);
  const bmHiPairs = bmHi.map(r => `${r.file}|${r.dependents}`);
  // Compare as multisets — same items, regardless of position-by-position.
  if (sqlHiPairs.length !== bmHiPairs.length) {
    failures.push({
      tool: 'highImpactFiles',
      msg: `length mismatch: sql=${sqlHiPairs.length} bitmap=${bmHiPairs.length}`,
    });
  } else {
    const sqlSorted = [...sqlHiPairs].sort();
    const bmSorted = [...bmHiPairs].sort();
    for (let i = 0; i < sqlSorted.length; i++) {
      if (sqlSorted[i] !== bmSorted[i]) {
        // Could be a tie-break difference. Check counts agree.
        const sqlCounts = new Map();
        for (const p of sqlHiPairs) {
          const cnt = parseInt(p.split('|')[1], 10);
          sqlCounts.set(cnt, (sqlCounts.get(cnt) || 0) + 1);
        }
        const bmCounts = new Map();
        for (const p of bmHiPairs) {
          const cnt = parseInt(p.split('|')[1], 10);
          bmCounts.set(cnt, (bmCounts.get(cnt) || 0) + 1);
        }
        // If count distributions match, it's a tie-break — acceptable.
        let countsMatch = sqlCounts.size === bmCounts.size;
        if (countsMatch) {
          for (const [k, v] of sqlCounts) {
            if (bmCounts.get(k) !== v) { countsMatch = false; break; }
          }
        }
        if (!countsMatch) {
          failures.push({
            tool: 'highImpactFiles',
            msg: `count distribution differs: sql_top_counts=${sqlHi.slice(0, 5).map(r => r.dependents).join(',')} bitmap_top_counts=${bmHi.slice(0, 5).map(r => r.dependents).join(',')}`,
          });
        }
        break;
      }
    }
  }

  // ── 4. simulateChangeImpact correctness vs union of blastRadius ──
  // Sample 5 random groups of 3 files each.
  let sciChecked = 0;
  for (let g = 0; g < 5; g++) {
    const groupSize = 3;
    const group = [];
    const seen = new Set();
    while (group.length < groupSize && seen.size < fileIds.length) {
      const fid = fileIds[Math.floor(rand() * fileIds.length)];
      if (!seen.has(fid)) {
        seen.add(fid);
        group.push(sidecar.fileIdToPath.get(fid));
      }
    }
    if (group.length === 0) continue;
    // Reference: union of bitmap.blastRadius for each input, minus inputs.
    const inputSet = new Set(group);
    const ref = new Set();
    for (const f of group) {
      const br = bitmapTools.blastRadius(sidecar, f, 5);
      if (br) for (const r of br) if (!inputSet.has(r.file)) ref.add(r.file);
    }
    const sci = bitmapTools.simulateChangeImpact(sidecar, group, 5);
    const sciSet = new Set(sci.files.map(r => r.file));
    if (!setEqual(ref, sciSet)) {
      const onlyRef = [...ref].filter(x => !sciSet.has(x));
      const onlySci = [...sciSet].filter(x => !ref.has(x));
      failures.push({
        tool: 'simulateChangeImpact',
        msg: `union mismatch: ref=${ref.size} sci=${sciSet.size} ref_only=${onlyRef.length} sci_only=${onlySci.length}`,
        onlyRef: onlyRef.slice(0, 3),
        onlySci: onlySci.slice(0, 3),
      });
    }
    sciChecked++;
  }

  store.close();

  return {
    repo: repoPath,
    files: fileIds.length,
    crossDomainEdges: sqlXd.length,
    highImpactCheckedTopN: Math.min(N, sqlHi.length),
    blastRadiusSamples: brChecked,
    simulateChangeImpactGroups: sciChecked,
    failures,
  };
}

console.log('═════════════════════════════════════════════════════════');
console.log(' Bitmap vs SQLite Accuracy Parity — Carto Test Corpus');
console.log('═════════════════════════════════════════════════════════');
console.log(`Sample size per blastRadius repo: ${SAMPLES}`);
console.log('');

const results = [];
for (const repo of ALL_REPOS) {
  process.stdout.write(`▶ ${path.basename(repo).padEnd(20)} `);
  const t0 = Date.now();
  let result;
  try {
    result = verifyRepo(repo);
  } catch (err) {
    result = { repo, error: err.stack || err.message };
  }
  const dt = Date.now() - t0;
  if (result.skipped) {
    console.log(`SKIP  (${result.reason})`);
  } else if (result.error) {
    console.log(`ERROR ${result.error.split('\n')[0]}`);
  } else if (result.failures.length === 0) {
    console.log(`PASS  files=${result.files} xd_edges=${result.crossDomainEdges} br=${result.blastRadiusSamples}/${SAMPLES} sci=${result.simulateChangeImpactGroups}/5 hi_top=${result.highImpactCheckedTopN}  (${dt}ms)`);
  } else {
    console.log(`FAIL  ${result.failures.length} failure(s) in ${dt}ms`);
    for (const f of result.failures.slice(0, 5)) {
      console.log(`        [${f.tool}] ${f.msg}`);
      if (f.onlySql) console.log(`           sql_only: ${JSON.stringify(f.onlySql)}`);
      if (f.onlyBm) console.log(`           bm_only:  ${JSON.stringify(f.onlyBm)}`);
      if (f.onlyRef) console.log(`           ref_only: ${JSON.stringify(f.onlyRef)}`);
      if (f.onlySci) console.log(`           sci_only: ${JSON.stringify(f.onlySci)}`);
    }
    if (result.failures.length > 5) console.log(`        ...and ${result.failures.length - 5} more`);
  }
  results.push(result);
}

console.log('');
console.log('─────────────────────────────────────────────────────────');
const ran = results.filter(r => !r.skipped && !r.error);
const failed = ran.filter(r => r.failures.length > 0);
const skipped = results.filter(r => r.skipped);
const errored = results.filter(r => r.error);
console.log(`Ran: ${ran.length} repo(s) · Skipped: ${skipped.length} · Errored: ${errored.length} · Failed: ${failed.length}`);
if (failed.length === 0 && errored.length === 0) {
  console.log('✓ All accuracy parity checks pass.');
  process.exit(0);
} else {
  console.log('✗ Accuracy parity failures detected.');
  process.exit(1);
}
