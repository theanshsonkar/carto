'use strict';

/**
 * Runtime fusion — overlay runtime observability data on the static graph.
 *
 * Ingests OTLP traces (the open standard), eBPF profiler data, and
 * Datadog/New Relic/Sentry exports. Today ships the OTLP parser (because
 * it's the open format) plus stubs for the SaaS connectors. Users pipe
 * trace data from any of the supported sources to compute:
 *
 *   risk_weighted_blast_radius = static_dependents × runtime_call_volume
 *
 * The canonical OTLP JSON shape:
 *   {
 *     "resourceSpans": [{
 *       "resource": { "attributes": [...] },
 *       "scopeSpans": [{
 *         "spans": [{ "name": "...", "kind": ..., "attributes": [...] }]
 *       }]
 *     }]
 *   }
 *
 * The parser extracts `route_path + method` from the `http.method` +
 * `http.route` / `url.path` attributes and produces:
 *   `{ method, path, count }[]`
 */

const fs = require('fs');

/**
 * parseOtlpFile(filePath) → Array<{ method, path, count }>
 *
 * Reads an OTLP JSON file (or JSONL — one OTLP envelope per line) and
 * aggregates HTTP-server span counts by (method, route).
 */
function parseOtlpFile(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  return parseOtlpText(text);
}

function parseOtlpText(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const counts = new Map();

  // Detect JSONL vs single-doc. JSONL: every line is its own JSON.
  const trimmed = text.trim();
  const docs = [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try { docs.push(JSON.parse(trimmed)); } catch {}
  } else {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { docs.push(JSON.parse(line)); } catch {}
    }
  }

  for (const doc of docs) {
    walkOtlpSpans(doc, (span) => {
      const attrs = spanAttrs(span);
      const method = (attrs['http.method'] || attrs['http.request.method'] || '').toUpperCase();
      const path = attrs['http.route'] || attrs['url.path'] || attrs['http.target'];
      if (method && path) {
        const key = `${method}::${stripQuery(path)}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    });
  }

  return Array.from(counts.entries()).map(([k, count]) => {
    const [method, path] = k.split('::');
    return { method, path, count };
  });
}

function walkOtlpSpans(doc, visit) {
  if (!doc) return;
  if (Array.isArray(doc.resourceSpans)) {
    for (const rs of doc.resourceSpans) {
      for (const ss of (rs.scopeSpans || rs.instrumentationLibrarySpans || [])) {
        for (const span of (ss.spans || [])) visit(span);
      }
    }
  }
  // Also accept a flat array of spans.
  if (Array.isArray(doc.spans)) {
    for (const span of doc.spans) visit(span);
  }
}

function spanAttrs(span) {
  const out = {};
  if (!span || !Array.isArray(span.attributes)) return out;
  for (const a of span.attributes) {
    if (!a || !a.key) continue;
    const v = a.value || {};
    out[a.key] = v.stringValue || v.intValue || v.doubleValue || v.boolValue;
  }
  return out;
}

function stripQuery(p) {
  const q = (p || '').indexOf('?');
  return q >= 0 ? p.slice(0, q) : p;
}

/**
 * riskWeightedBlastRadius({ store, runtimeCounts }) → ranked routes.
 *
 * Joins `routes` to runtime counts by (method, normalizedPath). For each
 * route, returns `{ method, path, file, dependents, runtime_calls, risk_score }`.
 *
 * `risk_score = dependents × runtime_calls + dependents` (additive so
 * routes with no runtime data still surface, just deprioritized).
 */
function riskWeightedBlastRadius({ store, runtimeCounts = [] }) {
  if (!store || !store.db) return [];
  const { normalizePath } = require('./call-graph');

  const countMap = new Map();
  for (const r of runtimeCounts) {
    countMap.set(`${r.method.toUpperCase()}::${normalizePath(r.path)}`, r.count);
  }

  const rows = store.db.prepare(`
    SELECT r.method, r.path, f.path as file, f.centrality
    FROM routes r JOIN files f ON r.file_id = f.id
  `).all();

  const out = [];
  for (const r of rows) {
    const key = `${r.method.toUpperCase()}::${normalizePath(r.path)}`;
    const rt = countMap.get(key) || 0;
    const dependents = r.centrality || 0;
    out.push({
      method: r.method, path: r.path, file: r.file,
      dependents, runtime_calls: rt,
      risk_score: dependents * rt + dependents,
    });
  }
  out.sort((a, b) => b.risk_score - a.risk_score);
  return out;
}

/**
 * deadCodeWithConfidence({ store, runtimeCounts }) → Array<file>
 *
 * Files in the index with:
 *   - 0 reverse dependents (nothing imports them)
 *   - AND, when runtime data is provided, no observed runtime hits on any
 *     route they contain
 *
 * Without runtime data, this falls back to the static check only.
 */
function deadCodeWithConfidence({ store, runtimeCounts = null }) {
  if (!store || !store.db) return [];
  const orphans = store.db.prepare(`
    SELECT f.path, f.id, f.centrality
    FROM files f
    LEFT JOIN imports i ON i.to_file_id = f.id
    WHERE i.id IS NULL AND f.centrality = 0
    LIMIT 500
  `).all();

  if (!runtimeCounts) return orphans.map(o => ({ path: o.path, runtime_hit: null }));

  // For each orphan, check if it owns any route hit at runtime.
  const { normalizePath } = require('./call-graph');
  const countMap = new Map();
  for (const r of runtimeCounts) {
    countMap.set(`${r.method.toUpperCase()}::${normalizePath(r.path)}`, r.count);
  }

  const out = [];
  for (const o of orphans) {
    const routes = store.db.prepare('SELECT method, path FROM routes WHERE file_id = ?').all(o.id);
    let hit = 0;
    for (const r of routes) {
      hit += countMap.get(`${r.method.toUpperCase()}::${normalizePath(r.path)}`) || 0;
    }
    if (hit === 0) out.push({ path: o.path, runtime_hit: 0 });
  }
  return out;
}

/**
 * hotInProdNoTests({ store, projectRoot, runtimeCounts }) → Array<file>
 *
 * Files whose routes get >0 runtime hits but have no detected test.
 */
function hotInProdNoTests({ store, projectRoot, runtimeCounts = [] }) {
  if (!store || !store.db || !runtimeCounts || runtimeCounts.length === 0) return [];
  const { normalizePath } = require('./call-graph');
  const { filesWithoutTests } = require('../mcp/files-without-tests');

  const hotFiles = new Set();
  const rows = store.db.prepare(`
    SELECT r.method, r.path, f.path as file FROM routes r JOIN files f ON r.file_id = f.id
  `).all();
  const countMap = new Map();
  for (const r of runtimeCounts) {
    countMap.set(`${r.method.toUpperCase()}::${normalizePath(r.path)}`, r.count);
  }
  for (const r of rows) {
    const key = `${r.method.toUpperCase()}::${normalizePath(r.path)}`;
    if ((countMap.get(key) || 0) > 0) hotFiles.add(r.file);
  }
  if (hotFiles.size === 0) return [];
  const result = filesWithoutTests(projectRoot, [...hotFiles]);
  return (result.files || []).map(f => ({ path: f }));
}

module.exports = {
  parseOtlpFile, parseOtlpText, riskWeightedBlastRadius,
  deadCodeWithConfidence, hotInProdNoTests,
};
