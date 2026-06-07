'use strict';

/**
 * Aggregator. Reads `bench/scale-test/results/*.json` (one file per
 * scale run) and produces `bench/scale-test/REPORT.md` with one row
 * per (size or repo-name).
 *
 * The report shape mirrors the scale tables in `docs/scale.md` so the
 * blog post and the docs page can be regenerated mechanically.
 */

const fs = require('fs');
const path = require('path');

function fmtMs(ms) {
  if (ms == null) return 'n/a';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtBytes(b) {
  if (b == null) return 'n/a';
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtNs(ns) {
  if (ns == null) return 'n/a';
  if (ns < 1000) return `${Math.round(ns)}ns`;
  if (ns < 1_000_000) return `${(ns / 1000).toFixed(1)}µs`;
  return `${(ns / 1_000_000).toFixed(2)}ms`;
}

function readResults(dir) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const records = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const fullPath = path.join(dir, f);
    try {
      const text = fs.readFileSync(fullPath, 'utf-8');
      const json = JSON.parse(text);
      records.push({ filename: f, ...json });
    } catch (err) {
      process.stderr.write(`[scale-bench] skipping ${f}: ${err.message}\n`);
    }
  }
  return records;
}

/**
 * Pick the latest run per (kind, label) — kind is 'synth' or 'real',
 * label is the size for synth or the repo-name for real. Latest = newest
 * `capturedAt` ISO string.
 */
function latestPerLabel(records) {
  const byKey = new Map();
  for (const r of records) {
    const kind = r.kind || (r.repoName ? 'real' : 'synth');
    const label = kind === 'real' ? (r.repoName || 'unknown') : String(r.size || r.totalFiles || 'unknown');
    const key = `${kind}:${label}`;
    const prev = byKey.get(key);
    if (!prev || r.capturedAt > prev.capturedAt) byKey.set(key, { ...r, kind, label });
  }
  return Array.from(byKey.values());
}

function generateReport(resultsDir, outputPath) {
  const records = readResults(resultsDir);
  const latest = latestPerLabel(records);

  // Stable sort: synth first by size ascending, then real by name.
  latest.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'synth' ? -1 : 1;
    if (a.kind === 'synth') {
      return (parseInt(a.label, 10) || 0) - (parseInt(b.label, 10) || 0);
    }
    return a.label.localeCompare(b.label);
  });

  const lines = [];
  lines.push('# Carto scale validation — REPORT');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Runs: ${latest.length}`);
  lines.push('');

  if (latest.length === 0) {
    lines.push('_No runs yet. Use `npm run bench:scale -- --size 10000` or `node bench/scale-test/real-world.js --repo <path>` to capture a run._');
    fs.writeFileSync(outputPath, lines.join('\n') + '\n');
    return outputPath;
  }

  // ── Index + storage ────────────────────────────────────────────────
  lines.push('## Indexing & on-disk storage');
  lines.push('');
  lines.push('| Run | Files | Edges | Init | Sync | DB | bitmap.bin | Sidecar (RAM) | RSS post-init | Extr. errors |');
  lines.push('|-----|------:|------:|-----:|-----:|---:|-----------:|--------------:|--------------:|-------------:|');
  for (const r of latest) {
    const tag = r.kind === 'synth' ? `synth ${formatSize(r.label)}` : r.label;
    lines.push(`| ${tag} | ${r.totalFiles ?? '?'} | ${r.edgeCount ?? '?'} | ${fmtMs(r.initMs)} | ${fmtMs(r.syncMs)} | ${fmtBytes(r.dbBytes)} | ${fmtBytes(r.bitmapBytes)} | ${fmtBytes(r.sidecar?.bytes)} | ${fmtBytes(r.initRssAfter)} | ${r.extractionErrorCount ?? 0} |`);
  }
  lines.push('');

  // ── Query latency ─────────────────────────────────────────────────
  lines.push('## MCP query latency (1000 calls per tool, bitmap path)');
  lines.push('');
  lines.push('| Run | blastRadius p50/p99 | crossDomain p50/p99 | highImpactFiles p50/p99 | similarPatterns p50/p99 | simulateChangeImpact p50/p99 |');
  lines.push('|-----|--------------------|--------------------|------------------------|------------------------|------------------------------|');
  for (const r of latest) {
    const tag = r.kind === 'synth' ? `synth ${formatSize(r.label)}` : r.label;
    const t = r.perTool || {};
    const cell = (k) => {
      const x = t[k];
      if (!x) return 'n/a';
      return `${fmtNs(x.p50)} / ${fmtNs(x.p99)}`;
    };
    lines.push(`| ${tag} | ${cell('blastRadius')} | ${cell('crossDomain')} | ${cell('highImpactFiles')} | ${cell('similarPatterns')} | ${cell('simulateChangeImpact')} |`);
  }
  lines.push('');

  // ── Provenance ────────────────────────────────────────────────────
  lines.push('## Provenance');
  lines.push('');
  lines.push('| Run | Captured | Node | Platform |');
  lines.push('|-----|----------|------|----------|');
  for (const r of latest) {
    const tag = r.kind === 'synth' ? `synth ${formatSize(r.label)}` : r.label;
    lines.push(`| ${tag} | ${r.capturedAt || 'n/a'} | ${r.nodeVersion || 'n/a'} | ${r.platform || 'n/a'} |`);
  }
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push('_Reproduce: `npm run bench:scale -- --size <N>` for synth, `node bench/scale-test/real-world.js --repo <path>` for kernel/Chromium runs._');

  fs.writeFileSync(outputPath, lines.join('\n') + '\n');
  return outputPath;
}

function formatSize(label) {
  const n = parseInt(label, 10);
  if (!Number.isFinite(n)) return label;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(n);
}

module.exports = { generateReport, formatSize, latestPerLabel, readResults };
