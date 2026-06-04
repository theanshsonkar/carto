#!/usr/bin/env node
'use strict';

/**
 * Bitmap validation benchmark orchestrator.
 * Usage: node bench/bitmap-validation/index.js --repo <path>
 */

const fs = require('fs');
const path = require('path');
const { run } = require('./runner');
const { generateReport } = require('./report');

const args = process.argv.slice(2);
const repoIdx = args.indexOf('--repo');
const repoPath = repoIdx !== -1 ? path.resolve(args[repoIdx + 1]) : null;

if (!repoPath) {
  console.error('Usage: node bench/bitmap-validation/index.js --repo <path>');
  process.exit(1);
}

const dbPath = path.join(repoPath, '.carto', 'carto.db');
if (!fs.existsSync(dbPath)) {
  console.error(`No .carto/carto.db found at ${repoPath}. Run "carto init" first.`);
  process.exit(1);
}

const outputDir = path.join(__dirname);

console.log(`[bitmap-bench] Benchmarking: ${repoPath}`);
console.log(`[bitmap-bench] DB: ${dbPath}`);

const rawResults = run(repoPath);

const rawPath = path.join(outputDir, 'raw-results.json');
fs.writeFileSync(rawPath, JSON.stringify(rawResults, null, 2));
console.log(`[bitmap-bench] Raw results → ${rawPath}`);

const { reportPath, verdict, medianSpeedup } = generateReport(rawPath, outputDir);
console.log(`[bitmap-bench] Report → ${reportPath}`);
console.log(`[bitmap-bench] Verdict: ${verdict} (median speedup: ${medianSpeedup.toFixed(1)}×)`);
