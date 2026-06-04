#!/usr/bin/env node
'use strict';

/**
 * domain-regression-check.js — Spec 10e
 *
 * Validates that domain counts for each corpus repo fall within
 * expected ranges defined in domain-baseline.json.
 *
 * Usage: node test/domain-regression-check.js ~/carto-test-repos
 *
 * Designed to run in bench.yml weekly CI.
 * Exits 0 if all pass, 1 if any regression detected.
 */

const fs = require('fs');
const path = require('path');
const { SQLiteStore } = require('../src/store/sqlite-store');

const baseline = require('./domain-baseline.json');
const reposRoot = process.argv[2] || path.join(process.env.HOME || '~', 'carto-test-repos');

let failures = 0;
let checked = 0;

for (const [repoKey, range] of Object.entries(baseline)) {
  if (repoKey.startsWith('_')) continue;
  const repoPath = path.join(reposRoot, repoKey);
  const dbPath = path.join(repoPath, '.carto', 'carto.db');

  if (!fs.existsSync(dbPath)) {
    console.log(`⏭  ${repoKey}: no .carto/carto.db (skipped)`);
    continue;
  }

  const store = new SQLiteStore(repoPath);
  try {
    store.open({ readonly: true });
    const domains = store.getDomainsList();
    const count = domains.length;
    checked++;

    if (count < range.min || count > range.max) {
      console.log(`✗  ${repoKey}: ${count} domains (expected ${range.min}-${range.max})`);
      failures++;
    } else {
      console.log(`✓  ${repoKey}: ${count} domains (within ${range.min}-${range.max})`);
    }
  } catch (e) {
    console.log(`✗  ${repoKey}: error — ${e.message}`);
    failures++;
  } finally {
    try { store.close(); } catch {}
  }
}

console.log(`\n${checked} repos checked, ${failures} failure(s).`);
process.exit(failures > 0 ? 1 : 0);
