'use strict';

/**
 * Cross-language call graph.
 *
 * Joins frontend HTTP fetches (`fetch('/api/users')`) to backend route
 * handlers. Both sides are already extracted by the existing language
 * plugins — JS/TS plugins extract `fetches` arrays; every language plugin
 * extracts `routes` with method + path. This module joins them.
 *
 * Strategy:
 *   1. Read `routes` from the existing table, and re-derive frontend
 *      fetches by running a regex pass over current file content. Extracted
 *      fetches live in JS plugin output but aren't persisted; the SQLite
 *      schema doesn't carry a `fetches` table yet.
 *   2. Normalize paths: strip query strings, collapse path params
 *      (`/users/123` → `/users/:id`).
 *   3. Match each fetch to one or more routes by (method, normalizedPath).
 *
 * Output: `{ matches: [{ caller_file, callee_file, method, path,
 *           fetch_path, route_path }] }`.
 */

const fs = require('fs');
const path = require('path');

/**
 * collectFetchesFromContent(content) → [{ method, path }]
 *
 * Regex pass over a single file. Catches:
 *   - fetch('/api/x', { method: 'POST' })
 *   - fetch(`/api/x/${id}`, { method: 'GET' })
 *   - axios.get('/api/x')
 *   - $.get('/api/x') (jQuery)
 */
function collectFetchesFromContent(content) {
  if (typeof content !== 'string' || content.length === 0) return [];
  const out = [];
  // fetch('/path', { method: 'POST' })
  const fetchRe = /fetch\s*\(\s*[`'"](\/[^`'"\s]+)[`'"]\s*(?:,\s*\{[^}]*method\s*:\s*['"]([A-Z]+)['"])?/g;
  let m;
  while ((m = fetchRe.exec(content)) !== null) {
    out.push({ method: (m[2] || 'GET').toUpperCase(), path: stripQuery(m[1]) });
  }
  // axios.get/post/put/delete('/path')
  const axiosRe = /axios\.(get|post|put|delete|patch)\s*\(\s*[`'"](\/[^`'"\s]+)[`'"]/g;
  while ((m = axiosRe.exec(content)) !== null) {
    out.push({ method: m[1].toUpperCase(), path: stripQuery(m[2]) });
  }
  // $.get / $.post
  const jqRe = /\$\.(get|post|ajax)\s*\(\s*[`'"](\/[^`'"\s]+)[`'"]/g;
  while ((m = jqRe.exec(content)) !== null) {
    out.push({ method: m[1] === 'ajax' ? 'ALL' : m[1].toUpperCase(), path: stripQuery(m[2]) });
  }
  return dedupe(out);
}

function stripQuery(p) {
  const q = p.indexOf('?');
  return q >= 0 ? p.slice(0, q) : p;
}

/**
 * normalizePath(p) — collapse path params to `:id`-style.
 *
 *   /users/123       → /users/:id
 *   /users/abc-def   → /users/:id
 *   /users/uuid-...  → /users/:id
 *
 * Heuristic only; misses semantic param names but groups equivalent
 * routes for matching.
 */
function normalizePath(p) {
  if (typeof p !== 'string') return p;
  return p.split('/').map(seg => {
    if (!seg) return seg;
    // Already-templated param (Express :id, FastAPI {id})
    if (seg.startsWith(':') || (seg.startsWith('{') && seg.endsWith('}'))) return ':id';
    // Numeric or uuid-like: collapse
    if (/^\d+$/.test(seg)) return ':id';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}/.test(seg)) return ':id';
    return seg;
  }).join('/');
}

/**
 * buildCallGraph({ store, projectRoot, maxFiles }) → graph
 *
 * Walks every JS/TS/Python file in the store, extracts fetches, then
 * joins to the routes table. Bounded to `maxFiles` (default 500) so we
 * don't run a regex pass over a 10K-file monorepo on every call.
 *
 * Result: { matches, unmatched_fetches, total_fetches_seen }
 */
function buildCallGraph({ store, projectRoot, maxFiles = 500 } = {}) {
  if (!store || !store.db) return { matches: [], unmatched_fetches: [], total_fetches_seen: 0 };

  // Index routes by (method, normalizedPath) and (ALL, normalizedPath).
  const routeIdx = new Map();
  const allRoutes = store.db.prepare(`
    SELECT r.method, r.path, f.path as file FROM routes r
    JOIN files f ON r.file_id = f.id
  `).all();
  for (const r of allRoutes) {
    const norm = normalizePath(r.path);
    const key = `${r.method.toUpperCase()}::${norm}`;
    if (!routeIdx.has(key)) routeIdx.set(key, []);
    routeIdx.get(key).push(r);
    // Also bucket under ALL for catchall matching
    const allKey = `ALL::${norm}`;
    if (!routeIdx.has(allKey)) routeIdx.set(allKey, []);
    routeIdx.get(allKey).push(r);
  }

  // Walk source files looking for fetches.
  const matches = [];
  const unmatched = [];
  let totalFetches = 0;

  const files = store.db.prepare(`
    SELECT path FROM files WHERE language IN ('JavaScript', 'TypeScript') LIMIT ?
  `).all(maxFiles);

  for (const f of files) {
    const full = path.resolve(projectRoot, f.path);
    let content;
    try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
    if (content.length > 1_000_000) continue; // skip huge files
    const fetches = collectFetchesFromContent(content);
    totalFetches += fetches.length;

    for (const fetch of fetches) {
      const norm = normalizePath(fetch.path);
      const key = `${fetch.method}::${norm}`;
      const allKey = `ALL::${norm}`;
      const hits = routeIdx.get(key) || routeIdx.get(allKey) || [];
      if (hits.length === 0) {
        unmatched.push({ caller_file: f.path, method: fetch.method, fetch_path: fetch.path });
      } else {
        for (const r of hits) {
          matches.push({
            caller_file: f.path,
            callee_file: r.file,
            method: fetch.method,
            fetch_path: fetch.path,
            route_path: r.path,
          });
        }
      }
    }
  }

  return { matches, unmatched_fetches: unmatched.slice(0, 50), total_fetches_seen: totalFetches };
}

function dedupe(arr) {
  const seen = new Set();
  return arr.filter(r => {
    const key = `${r.method}::${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  collectFetchesFromContent,
  normalizePath,
  buildCallGraph,
};
