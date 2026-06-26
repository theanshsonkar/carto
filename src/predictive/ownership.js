'use strict';

/**
 * Team intelligence — implicit ownership detection + cross-team coupling.
 *
 * Detects "who touches this file most" from `git blame` and `git log`
 * stats. Returns per-file and per-domain owners. From there we can
 * surface cross-team coupling — Domain A is mostly touched by Alice but
 * imports from Domain B, which Alice never touches → coordination cost.
 *
 * All git-shell-outs are wrapped: 10 s timeout, bounded output, errors
 * fail soft to empty.
 */

const { execFileSync } = require('child_process');

function gitLog(projectRoot, args, timeoutMs = 10_000) {
  try {
    return execFileSync('git', ['-C', projectRoot, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * ownersForFile({ projectRoot, file }) → { file, top_author, authors: [{ name, lines }] }
 *
 * Uses `git blame --line-porcelain` to count lines per author. Fails soft
 * to { file, authors: [] } when git is unavailable / file not tracked.
 */
function ownersForFile({ projectRoot, file }) {
  const out = gitLog(projectRoot, ['blame', '--line-porcelain', '--', file]);
  if (!out) return { file, authors: [], top_author: null };
  const counts = new Map();
  for (const line of out.split('\n')) {
    if (line.startsWith('author ')) {
      const name = line.slice('author '.length);
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  const authors = Array.from(counts.entries())
    .map(([name, lines]) => ({ name, lines }))
    .sort((a, b) => b.lines - a.lines);
  return { file, authors, top_author: authors[0] ? authors[0].name : null };
}

/**
 * ownersForDomain({ store, projectRoot, domain }) — aggregates per-file
 * blame counts across the files in `domain`. Returns top authors.
 */
function ownersForDomain({ store, projectRoot, domain, maxFiles = 100 }) {
  if (!store || !store.db) return { domain, authors: [], top_author: null };
  const files = store.db.prepare(`
    SELECT f.path FROM files f
    JOIN domains d ON f.domain_id = d.id
    WHERE d.name = ?
    ORDER BY f.centrality DESC LIMIT ?
  `).all(domain, maxFiles).map(r => r.path);
  const counts = new Map();
  for (const f of files) {
    const r = ownersForFile({ projectRoot, file: f });
    for (const a of r.authors) {
      counts.set(a.name, (counts.get(a.name) || 0) + a.lines);
    }
  }
  const authors = Array.from(counts.entries())
    .map(([name, lines]) => ({ name, lines }))
    .sort((a, b) => b.lines - a.lines);
  return { domain, authors, top_author: authors[0] ? authors[0].name : null };
}

/**
 * crossTeamCoupling({ store, projectRoot }) → warnings
 *
 * For each cross-domain edge in the graph, look up the owner of the
 * source file and the owner of the target file. If they differ AND the
 * source-side owner has never touched the target file, surface a
 * coordination warning.
 */
function crossTeamCoupling({ store, projectRoot, maxEdges = 50 }) {
  if (!store) return { warnings: [] };
  const edges = (store.getCrossDomainDeps() || []).slice(0, maxEdges);
  const ownerCache = new Map();
  const warnings = [];

  for (const e of edges) {
    if (!ownerCache.has(e.from)) ownerCache.set(e.from, ownersForFile({ projectRoot, file: e.from }).top_author);
    if (!ownerCache.has(e.to)) ownerCache.set(e.to, ownersForFile({ projectRoot, file: e.to }).top_author);
    const fromOwner = ownerCache.get(e.from);
    const toOwner = ownerCache.get(e.to);
    if (fromOwner && toOwner && fromOwner !== toOwner) {
      warnings.push({
        from_file: e.from,
        to_file: e.to,
        from_domain: e.fromDomain || null,
        to_domain: e.toDomain || null,
        from_owner: fromOwner,
        to_owner: toOwner,
      });
    }
  }
  return { warnings };
}

/**
 * aiCostAttribution({ store, hours }) → per-client metrics
 *
 * Cheap proxy for "which AI client is creating the most cross-domain
 * coupling?". Reads `ai_sessions.client_name` + joins to `decisions` and
 * counts violations per client.
 */
function aiCostAttribution({ store, hours = 168 } = {}) {
  if (!store || !store.db) return { clients: [] };
  const since = Date.now() - hours * 60 * 60 * 1000;
  const rows = store.db.prepare(`
    SELECT s.client_name as client, COUNT(d.id) as decisions
    FROM ai_sessions s
    LEFT JOIN decisions d ON d.session_id = s.id
    WHERE s.started_at >= ? OR d.ts >= ?
    GROUP BY s.client_name
  `).all(since, since);
  const violations = store.db.prepare(`
    SELECT s.client_name as client, COUNT(i.id) as violations
    FROM ai_sessions s
    LEFT JOIN interventions i ON i.session_id = s.id
    WHERE s.started_at >= ? OR i.ts >= ?
    GROUP BY s.client_name
  `).all(since, since);
  const vMap = new Map(violations.map(r => [r.client, r.violations]));
  return {
    hours,
    clients: rows.map(r => ({
      client: r.client || '(unknown)',
      decisions: r.decisions || 0,
      violations: vMap.get(r.client) || 0,
    })).sort((a, b) => b.decisions - a.decisions),
  };
}

module.exports = { ownersForFile, ownersForDomain, crossTeamCoupling, aiCostAttribution };
