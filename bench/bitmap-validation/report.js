'use strict';

/**
 * Report generator. Reads raw-results.json, produces REPORT.md
 * with per-tool latency tables and a GO/INVESTIGATE/DEFER verdict.
 */

const fs = require('fs');
const path = require('path');

function percentile(arr, p) {
  const sorted = arr.slice().sort((a, b) => a - b);
  const i = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, i)];
}

function formatNs(ns) {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)}ms`;
  if (ns >= 1_000) return `${(ns / 1_000).toFixed(1)}µs`;
  return `${ns}ns`;
}

function generateReport(rawPath, outputDir) {
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf-8'));
  const lines = [];
  const toolNames = Object.keys(raw.results);
  const speedups = [];

  lines.push('# Bitmap Engine Validation — REPORT');
  lines.push('');
  lines.push(`**Repo:** \`${raw.repo}\``);
  lines.push(`**Files indexed:** ${raw.fileCount}`);
  lines.push(`**Import edges:** ${raw.edgeCount}`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Per-tool latency (1000 calls, excluding 50 warmup)');
  lines.push('');
  lines.push('| Tool | SQLite p50 | SQLite p99 | Bitmap p50 | Bitmap p99 | Speedup (p50) |');
  lines.push('|------|-----------|-----------|-----------|-----------|--------------|');

  for (const tool of toolNames) {
    const { sqliteTimes, bitmapTimes } = raw.results[tool];
    const sqP50 = percentile(sqliteTimes, 50);
    const sqP99 = percentile(sqliteTimes, 99);
    const bmP50 = percentile(bitmapTimes, 50);
    const bmP99 = percentile(bitmapTimes, 99);
    const speedup = bmP50 > 0 ? sqP50 / bmP50 : Infinity;
    speedups.push(speedup);
    lines.push(`| ${tool} | ${formatNs(sqP50)} | ${formatNs(sqP99)} | ${formatNs(bmP50)} | ${formatNs(bmP99)} | ${speedup.toFixed(1)}× |`);
  }

  lines.push('');
  lines.push('## Memory');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| RSS start | ${(raw.rssStart / 1024 / 1024).toFixed(1)} MB |`);
  lines.push(`| RSS end | ${(raw.rssEnd / 1024 / 1024).toFixed(1)} MB |`);
  lines.push(`| Sidecar in-memory | ${(raw.sidecarBytes / 1024).toFixed(1)} KB |`);
  lines.push('');
  lines.push('## Verdict');
  lines.push('');

  // Decision rule: median of per-tool speedups
  speedups.sort((a, b) => a - b);
  const medianSpeedup = speedups[Math.floor(speedups.length / 2)];

  let verdict;
  if (medianSpeedup >= 10) {
    verdict = 'GO';
    lines.push(`**${verdict}** — Median speedup ${medianSpeedup.toFixed(1)}× (≥10×). Proceed with bitmap engine integration.`);
  } else if (medianSpeedup >= 3) {
    verdict = 'INVESTIGATE';
    lines.push(`**${verdict}** — Median speedup ${medianSpeedup.toFixed(1)}× (3-10×). Promising but needs query reshape or Roaring upgrade before committing to full rewrite.`);
  } else {
    verdict = 'DEFER';
    lines.push(`**${verdict}** — Median speedup ${medianSpeedup.toFixed(1)}× (<3×). SQLite is fast enough at this scale. Revisit when file count exceeds 50K+.`);
  }

  lines.push('');
  lines.push(`---`);
  lines.push(`*Decision rule: median p50 speedup across ${toolNames.length} tools. ≥10× = GO, 3-10× = INVESTIGATE, <3× = DEFER.*`);

  const report = lines.join('\n') + '\n';
  const reportPath = path.join(outputDir, 'REPORT.md');
  fs.writeFileSync(reportPath, report);
  return { reportPath, verdict, medianSpeedup };
}

module.exports = { generateReport };
