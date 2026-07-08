#!/usr/bin/env node
'use strict';

/**
 * Audit gate — locks in the Workstream-A (M1a) correctness fixes against a real
 * supabase clone, so trust can't silently regress when someone edits the
 * extractors or the domain classifier.
 *
 * It re-asserts the concrete findings from the external audit (see CARTO_PLAN.md
 * §9) that CF-2b / CF-3 / CF-1 fixed:
 *
 *   1. models > 0            — CF-2b: Zod/Drizzle/etc. schemas are extracted
 *                              (the audit saw 338 `z.object(` reported as 0).
 *   2. example files not     — CF-3: a byte-size util must not land in AUTH and a
 *      misclassified            theme resolver must not land in NOTIFICATIONS;
 *                              both are generic → CORE.
 *   3. temporal store         — CF-1: snapshots + churn are backfilled, so the
 *      non-empty                predictive/temporal tools aren't dead.
 *   4. data_flow / cross_      — CF-3 single-source-of-truth: the domain reported
 *      domain agreement          by get_data_flow (store.getDomainOf) equals the
 *                              domain in get_cross_domain for every edge.
 *
 * Usage:
 *   CARTO_SUPABASE_REPO=/path/to/supabase node test/audit-supabase.js
 *   # or, with the local corpus:
 *   node test/audit-supabase.js
 *
 * Repo resolution order:
 *   --repo <path>  →  $CARTO_SUPABASE_REPO  →  ~/carto-test-repos/tier-b/supabase
 *
 * If the repo isn't present / isn't indexed, the gate SKIPS (exit 0) with a
 * clear message — matching test/accuracy-corpus.js. CI is responsible for
 * cloning + indexing a pinned commit before invoking it (see the workflow).
 * Exit 1 only when the repo IS indexed AND an audit assertion fails.
 */

const fs = require('fs');
const path = require('path');
const { SQLiteStore } = require('../src/store/sqlite-store');
const { TemporalStore } = require('../src/temporal/store');
const ai = require('../src/ai/tools');

const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(name);
  return i < 0 ? def : argv[i + 1];
}

const REPO = flag('--repo', null)
  || process.env.CARTO_SUPABASE_REPO
  || path.join(process.env.HOME || '', 'carto-test-repos', 'tier-b', 'supabase');

// Domains a generic utility must never be forced into.
const WRONG_FOR_BYTE_UTIL = 'AUTH';
const WRONG_FOR_THEME = 'NOTIFICATIONS';
// Candidate paths for the two audit example files (first existing one wins).
const BYTE_UTIL_CANDIDATES = [
  'apps/studio/lib/helpers.ts',
  'apps/studio/components/interfaces/Storage/StorageSettings/StorageSettings.utils.ts',
];
const THEME_CANDIDATES = [
  'packages/ui/src/lib/theme/styleHandler.ts',
  'packages/ui/src/lib/theme/themeContext.tsx',
  'packages/ui/src/lib/theme/defaultTheme.ts',
  'apps/www/lib/theme.utils.ts',
];

function firstIndexed(store, candidates) {
  for (const p of candidates) {
    if (store.getFileByPath(p)) return p;
  }
  return null;
}

function log(line) { console.log(line); }

function run() {
  log('═════════════════════════════════════════════════════════');
  log(' Audit Gate — supabase reference repo (M1a correctness)');
  log('═════════════════════════════════════════════════════════');
  log(`Repo: ${REPO}`);

  const dbPath = path.join(REPO, '.carto', 'carto.db');
  if (!fs.existsSync(dbPath)) {
    log(`\nSKIP — ${dbPath} not found.`);
    log('Clone supabase and run `carto init` (or set CARTO_SUPABASE_REPO) to enable this gate.');
    process.exit(0);
  }

  const store = new SQLiteStore(REPO);
  store.open({ readonly: true });

  const failures = [];
  const notes = [];
  const check = (name, cond, detail) => {
    if (cond) { log(`  ✓ ${name}`); }
    else { log(`  ✗ ${name} — ${detail}`); failures.push(`${name}: ${detail}`); }
  };

  // ── 1. models > 0 (CF-2b) ─────────────────────────────────────────
  log('\n[1] Model extraction');
  const modelCount = store.db.prepare('SELECT COUNT(*) AS c FROM models').get().c;
  const zodCount = store.db.prepare("SELECT COUNT(*) AS c FROM models WHERE kind = 'zod'").get().c;
  check('models > 0', modelCount > 0, `got ${modelCount}`);
  check('zod schemas extracted (audit saw 0)', zodCount > 0, `got ${zodCount} zod models`);
  log(`    (${modelCount} models total; ${zodCount} zod)`);

  // ── 2. example files not misclassified (CF-3) ─────────────────────
  log('\n[2] Domain classification of generic utilities');
  const byteFile = firstIndexed(store, BYTE_UTIL_CANDIDATES);
  const themeFile = firstIndexed(store, THEME_CANDIDATES);

  if (byteFile) {
    const d = store.getDomainOf(byteFile);
    check(`byte-size util not in ${WRONG_FOR_BYTE_UTIL}`, d !== WRONG_FOR_BYTE_UTIL,
      `${byteFile} → ${d}`);
    check('byte-size util resolves to CORE (or unassigned)', d === 'CORE' || d == null,
      `${byteFile} → ${d} (expected CORE)`);
    log(`    ${byteFile} → ${d}`);
  } else {
    notes.push('byte-util example file not present in this clone — skipped its domain check');
    log('    (no byte-util candidate indexed — skipped)');
  }

  if (themeFile) {
    const d = store.getDomainOf(themeFile);
    check(`theme resolver not in ${WRONG_FOR_THEME}`, d !== WRONG_FOR_THEME,
      `${themeFile} → ${d}`);
    check('theme resolver resolves to CORE (or unassigned)', d === 'CORE' || d == null,
      `${themeFile} → ${d} (expected CORE)`);
    log(`    ${themeFile} → ${d}`);
  } else {
    notes.push('theme example file not present in this clone — skipped its domain check');
    log('    (no theme candidate indexed — skipped)');
  }

  // ── 3. temporal store non-empty (CF-1) ────────────────────────────
  log('\n[3] Temporal layer');
  const temporal = TemporalStore.openIfExists(REPO, { readonly: true });
  if (!temporal) {
    check('temporal store initialized', false, 'carto-temporal.db not found (run `carto temporal init`)');
  } else {
    try {
      const snapshots = temporal.db.prepare('SELECT COUNT(*) AS c FROM snapshots').get().c;
      const churn = temporal.db.prepare('SELECT COUNT(*) AS c FROM file_churn').get().c;
      check('snapshots present', snapshots > 0, `got ${snapshots}`);
      check('file churn backfilled (predictive depends on it)', churn > 0, `got ${churn} churn rows`);
      log(`    (${snapshots} snapshots; ${churn} churn rows)`);
    } finally {
      temporal.close();
    }
  }

  // ── 4. data_flow / cross_domain domain agreement (CF-3 SoT) ────────
  log('\n[4] data_flow ↔ cross_domain domain agreement');
  const xd = store.getCrossDomainDeps();
  let disagreements = 0;
  let firstDisagreement = null;
  const ctx = { store, projectRoot: REPO, temporalStore: null };
  // Sample up to 300 edges; check both endpoints resolve identically via the
  // get_data_flow accessor (store.getDomainOf) and the get_cross_domain output.
  const sample = xd.slice(0, 300);
  for (const e of sample) {
    const dfFrom = ai.dataFlow({ file: e.from }, ctx).domain;
    const dfTo = ai.dataFlow({ file: e.to }, ctx).domain;
    if (dfFrom !== e.fromDomain || dfTo !== e.toDomain) {
      disagreements++;
      if (!firstDisagreement) {
        firstDisagreement = `${e.from} (df=${dfFrom} vs xd=${e.fromDomain}) / ${e.to} (df=${dfTo} vs xd=${e.toDomain})`;
      }
    }
  }
  check('every sampled cross-domain edge agrees with get_data_flow',
    disagreements === 0,
    `${disagreements}/${sample.length} disagreed; e.g. ${firstDisagreement}`);
  log(`    (${xd.length} cross-domain edges; checked ${sample.length}, ${disagreements} disagreements)`);

  store.close();

  // ── Summary ───────────────────────────────────────────────────────
  log('\n─────────────────────────────────────────────────────────');
  for (const n of notes) log(`note: ${n}`);
  if (failures.length === 0) {
    log('✓ Audit gate passed — supabase findings hold.');
    process.exit(0);
  } else {
    log(`✗ Audit gate FAILED — ${failures.length} assertion(s):`);
    for (const f of failures) log(`   - ${f}`);
    process.exit(1);
  }
}

run();
