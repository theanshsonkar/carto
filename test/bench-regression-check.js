#!/usr/bin/env node
'use strict';

/**
 * test/bench-regression-check.js
 *
 * Reads benchmark output (free-form text containing lines like
 * `metric_name: 123 ms`), compares against test/bench-baseline.json, and
 * exits non-zero if any tracked metric exceeds (baseline.value * (1 +
 * baseline.tolerance_pct / 100)).
 *
 * Usage:
 *   node test/bench-regression-check.js <bench-output-file>
 *
 * Or pipe via stdin:
 *   node test/bench-ci.js | node test/bench-regression-check.js -
 *
 * Exit codes:
 *   0 — all tracked metrics within tolerance (or skipped, see below)
 *   1 — at least one tracked metric over tolerance
 *   2 — usage error (missing baseline, bad input)
 *
 * Skipped metrics: if a metric is in the baseline but not in the output,
 * we log SKIP and do NOT count it as a regression. The artifact upload
 * lets a human notice if a metric goes silently missing.
 */

const fs = require('fs');
const path = require('path');

const BASELINE_PATH = path.join(__dirname, 'bench-baseline.json');

// Match lines like:
//   `self_repo_first_run_ms: 1234 ms`
//   `mcp_get_structure_ms:  3 ms`
//   `something = 12.4ms`
// The trailing `ms` is required to avoid catching `5 routes`, `12 files`, etc.
const METRIC_RE = /^\s*([a-z][a-z0-9_]*)\s*[:=]\s*([\d.]+)\s*ms\b/i;

function readInput(arg) {
  if (!arg) {
    console.error('Usage: bench-regression-check.js <output-file | ->');
    process.exit(2);
  }
  if (arg === '-') {
    return fs.readFileSync(0, 'utf8'); // stdin
  }
  if (!fs.existsSync(arg)) {
    console.error(`Input file not found: ${arg}`);
    process.exit(2);
  }
  return fs.readFileSync(arg, 'utf8');
}

function parseMetrics(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(METRIC_RE);
    if (m) out[m[1]] = parseFloat(m[2]);
  }
  return out;
}

function main() {
  const arg = process.argv[2];
  const text = readInput(arg);

  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`Baseline not found: ${BASELINE_PATH}`);
    process.exit(2);
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

  const measured = parseMetrics(text);

  console.log('--- bench regression check ---');
  console.log(`Baseline runner: ${baseline.runner || 'unspecified'}`);
  console.log(`Baseline node:   ${baseline.node_version || 'unspecified'}`);
  console.log('');

  let regressed = 0;
  let checked = 0;
  let skipped = 0;

  const padName = Math.max(20, ...Object.keys(baseline.metrics || {}).map((k) => k.length));

  for (const [name, spec] of Object.entries(baseline.metrics || {})) {
    const got = measured[name];
    const display = name.padEnd(padName);

    if (got == null) {
      console.log(`SKIP  ${display}  (not present in output)`);
      skipped++;
      continue;
    }

    const tolerancePct = spec.tolerance_pct ?? 25;
    const limit = spec.value * (1 + tolerancePct / 100);
    const ok = got <= limit;
    const status = ok ? 'OK  ' : 'SLOW';

    console.log(
      `${status}  ${display}  measured=${got}ms  baseline=${spec.value}ms  +${tolerancePct}% tolerance → limit ${limit.toFixed(0)}ms`
    );

    checked++;
    if (!ok) regressed++;
  }

  console.log('');
  console.log(`Checked: ${checked} · Regressed: ${regressed} · Skipped: ${skipped}`);

  if (regressed > 0) {
    console.error(`\n${regressed} metric(s) regressed beyond tolerance.`);
    process.exit(1);
  }
  console.log('\nAll tracked metrics within tolerance.');
}

main();
