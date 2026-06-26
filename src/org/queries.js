'use strict';

/**
 * Org-wide query functions backing the 7 cross-repo MCP tools.
 */

const path = require('path');
const fs = require('fs');

/**
 * orgArchitectureOverview(orgStore) → { repos, summary }
 */
function orgArchitectureOverview(orgStore) {
  if (!orgStore || !orgStore.db) return { repos: [], summary: {} };
  const repos = orgStore.listRepos();
  const summary = {
    total_repos: repos.length,
    total_edges: orgStore.db.prepare('SELECT COUNT(*) as c FROM cross_repo_edges').get().c,
    edges_by_kind: orgStore.db.prepare(`
      SELECT edge_kind, COUNT(*) as c FROM cross_repo_edges GROUP BY edge_kind
    `).all(),
  };
  return { repos, summary };
}

/**
 * serviceDependencyGraph(orgStore) → { nodes, edges }
 *
 * Each repo is a node; cross-repo edges are aggregated by (from_repo, to_repo).
 */
function serviceDependencyGraph(orgStore) {
  if (!orgStore || !orgStore.db) return { nodes: [], edges: [] };
  const repos = orgStore.listRepos();
  const edgeRows = orgStore.db.prepare(`
    SELECT from_repo, to_repo, edge_kind, COUNT(*) as count
    FROM cross_repo_edges
    WHERE to_repo IS NOT NULL
    GROUP BY from_repo, to_repo, edge_kind
  `).all();
  return {
    nodes: repos.map(r => ({ name: r.name, root_path: r.root_path })),
    edges: edgeRows,
  };
}

/**
 * crossRepoBlastRadius(orgStore, fromRepo) → { downstream_repos, paths }
 *
 * Returns the set of repos that depend on `fromRepo` (one hop). Deeper
 * hops would need a transitive closure pass; this is direct-only.
 */
function crossRepoBlastRadius(orgStore, fromRepo) {
  if (!orgStore || !orgStore.db || !fromRepo) return { downstream_repos: [], paths: [] };
  const rows = orgStore.db.prepare(`
    SELECT from_repo, edge_kind, target, COUNT(*) as count
    FROM cross_repo_edges
    WHERE to_repo = ?
    GROUP BY from_repo, edge_kind
  `).all(fromRepo);
  const downstream = [...new Set(rows.map(r => r.from_repo))];
  return { downstream_repos: downstream, paths: rows };
}

/**
 * findConsumersOfApi(orgStore, target) → list of consuming repos
 *
 * "Who depends on this npm/pypi/go module?"
 */
function findConsumersOfApi(orgStore, target) {
  if (!orgStore || !orgStore.db || !target) return [];
  return orgStore.db.prepare(`
    SELECT from_repo, edge_kind, from_file
    FROM cross_repo_edges
    WHERE target = ? OR target LIKE ?
    ORDER BY from_repo, edge_kind
  `).all(target, target + '/%');
}

/**
 * orgDomainMapping(orgStore) — for each repo's domain (from its carto.db
 * if present), aggregate cross-domain edges org-wide.
 */
function orgDomainMapping(orgStore) {
  if (!orgStore || !orgStore.db) return { domains: [] };
  const repos = orgStore.listRepos();
  const domains = [];
  for (const repo of repos) {
    if (!repo.carto_db_path || !fs.existsSync(repo.carto_db_path)) continue;
    try {
      const Database = require('better-sqlite3');
      const db = new Database(repo.carto_db_path, { readonly: true, fileMustExist: true });
      const rows = db.prepare('SELECT name, file_count FROM domains').all();
      for (const r of rows) domains.push({ repo: repo.name, domain: r.name, file_count: r.file_count });
      db.close();
    } catch {}
  }
  return { domains };
}

/**
 * serviceBoundaryViolations(orgStore) → boundary-crossing edges where one
 * repo reaches into another's private surface (heuristic: target path
 * includes `internal`, `private`, `_lib`, etc.).
 */
function serviceBoundaryViolations(orgStore) {
  if (!orgStore || !orgStore.db) return { violations: [] };
  const rows = orgStore.db.prepare(`
    SELECT * FROM cross_repo_edges
    WHERE target LIKE '%internal%' OR target LIKE '%private%' OR target LIKE '%_lib%'
       OR target LIKE '%/_%'
  `).all();
  return { violations: rows };
}

/**
 * microservicesMigrationCutPoints(orgStore) → suggested order to split
 *
 * Heuristic: repos with the fewest outgoing edges + the most incoming
 * edges are the most stable producers — extract those first. Repos with
 * many outgoing edges are tightly coupled consumers — extract later.
 */
function microservicesMigrationCutPoints(orgStore) {
  if (!orgStore || !orgStore.db) return { order: [] };
  const repos = orgStore.listRepos();
  const out = [];
  for (const repo of repos) {
    const outgoing = orgStore.db.prepare('SELECT COUNT(*) as c FROM cross_repo_edges WHERE from_repo = ?').get(repo.name).c;
    const incoming = orgStore.db.prepare('SELECT COUNT(*) as c FROM cross_repo_edges WHERE to_repo = ?').get(repo.name).c;
    const stability = incoming / Math.max(1, outgoing + incoming);
    out.push({ repo: repo.name, outgoing, incoming, stability: Math.round(stability * 100) / 100 });
  }
  out.sort((a, b) => b.stability - a.stability);
  return { order: out };
}

module.exports = {
  orgArchitectureOverview,
  serviceDependencyGraph,
  crossRepoBlastRadius,
  findConsumersOfApi,
  orgDomainMapping,
  serviceBoundaryViolations,
  microservicesMigrationCutPoints,
};
