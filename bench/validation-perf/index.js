#!/usr/bin/env node
'use strict';

/**
 * Validation perf gate orchestrator.
 *
 * Usage:
 *   node bench/validation-perf/index.js --repo <path>
 *
 * Targets (vscode, 7K files):
 *   p50 ≤ 5ms · p99 ≤ 15ms
 */

const fs = require('fs');
const path = require('path');
const { run } = require('./runner');

const args = process.argv.slice(2);
const repoIdx = args.indexOf('--repo');
const repoPath = repoIdx !== -1 ? path.resolve(args[repoIdx + 1]) : null;

if (!repoPath) {
  console.error('Usage: node bench/validation-perf/index.js --repo <path>');
  process.exit(1);
}

const dbPath = path.join(repoPath, '.carto', 'carto.db');
if (!fs.existsSync(dbPath)) {
  console.error(`No .carto/carto.db found at ${repoPath}. Run "carto init" first.`);
  process.exit(1);
}

console.log(`[validation-perf] Repo: ${repoPath}`);
const r = run(repoPath);
console.log('');
console.log(`Files indexed   : ${r.fileCount}`);
console.log(`Diff targets    : ${r.targets}`);
console.log(`Calls           : ${r.calls}`);
console.log('');
console.log('validateDiff latency (ms):');
console.log(`  min : ${r.stats.min.toFixed(3)}`);
console.log(`  p50 : ${r.stats.p50.toFixed(3)}`);
console.log(`  p90 : ${r.stats.p90.toFixed(3)}`);
console.log(`  p95 : ${r.stats.p95.toFixed(3)}`);
console.log(`  p99 : ${r.stats.p99.toFixed(3)}`);
console.log(`  max : ${r.stats.max.toFixed(3)}`);
console.log('');

const p50Pass = r.stats.p50 <= 5;
const p99Pass = r.stats.p99 <= 15;
const verdict = p50Pass && p99Pass ? 'GO' : 'INVESTIGATE';
console.log(`Verdict: ${verdict}  (p50 ≤ 5ms: ${p50Pass ? '✓' : '✗'}, p99 ≤ 15ms: ${p99Pass ? '✓' : '✗'})`);

const reportPath = path.join(__dirname, 'REPORT.md');
const report = [
  '# validate_diff perf benchmark',
  '',
  `Repo: \`${repoPath}\``,
  `Files indexed: ${r.fileCount}`,
  `Calls: ${r.calls}, targets: ${r.targets}`,
  '',
  '| metric | ms |',
  '|--------|----|',
  `| min | ${r.stats.min.toFixed(3)} |`,
  `| p50 | ${r.stats.p50.toFixed(3)} |`,
  `| p90 | ${r.stats.p90.toFixed(3)} |`,
  `| p95 | ${r.stats.p95.toFixed(3)} |`,
  `| p99 | ${r.stats.p99.toFixed(3)} |`,
  `| max | ${r.stats.max.toFixed(3)} |`,
  '',
  `**Verdict:** ${verdict}`,
  `- p50 ≤ 5ms: ${p50Pass ? '✓' : '✗'}`,
  `- p99 ≤ 15ms: ${p99Pass ? '✓' : '✗'}`,
  '',
].join('\n');
fs.writeFileSync(reportPath, report);
console.log(`Report → ${reportPath}`);

process.exit(verdict === 'GO' ? 0 : 1);
