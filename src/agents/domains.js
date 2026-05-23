const path = require('path');

const DOMAIN_MAP = [
  { keywords: ['auth', 'login', 'session', 'oauth', 'token', 'jwt', 'password', 'credential'], domain: 'AUTH' },
  { keywords: ['payment', 'billing', 'stripe', 'invoice', 'charge', 'subscription', 'checkout'], domain: 'PAYMENTS' },
  { keywords: ['trpc', 'router', 'routers', 'procedure'], domain: 'TRPC' },
  { keywords: ['prisma', 'database', 'db', 'model', 'migration', 'schema'], domain: 'DATABASE' },
  { keywords: ['webhook', 'event', 'queue', 'job', 'worker', 'cron', 'task'], domain: 'EVENTS' },
  { keywords: ['email', 'notification', 'mail', 'sms', 'alert'], domain: 'NOTIFICATIONS' },
];

/**
 * getDomainForFile(relPath) → domain string or null
 * Returns domain if path matches a keyword, null if no match.
 * Returns null (not 'CORE') so callers know it wasn't matched.
 */
function getDomainForFile(relPath) {
  const lower = relPath.toLowerCase();
  for (const { keywords, domain } of DOMAIN_MAP) {
    for (const kw of keywords) {
      if (
        lower.includes(`/${kw}/`) ||
        lower.includes(`/${kw}.`) ||
        lower.includes(`-${kw}.`) ||
        lower.includes(`_${kw}.`) ||
        lower.includes(`/${kw}-`) ||
        lower.includes(`/${kw}_`)
      ) {
        return domain;
      }
    }
  }
  return null;
}

/**
 * buildFileAssignments(allFiles, importGraph) → Map<filePath, domain>
 *
 * Two-pass clustering:
 * Pass 1 — assign seeds via keyword matching
 * Pass 2 — expand seeds via import graph (up to 2 hops)
 * Remaining unassigned → 'CORE'
 *
 * allFiles: string[] of relative file paths (all files in scope)
 * importGraph: { 'relPath': ['dep1', 'dep2'] } from map.json
 */
function buildFileAssignments(allFiles, importGraph) {
  const assignments = new Map();

  // Pass 1 — keyword seeds
  for (const f of allFiles) {
    const domain = getDomainForFile(f);
    if (domain) assignments.set(f, domain);
  }

  // Build reverse graph (importedBy) for bidirectional lookup
  const importedBy = {};
  for (const [file, deps] of Object.entries(importGraph || {})) {
    for (const dep of deps) {
      if (!importedBy[dep]) importedBy[dep] = [];
      importedBy[dep].push(file);
    }
  }

  // Pass 2 — expand via graph, up to 2 hops
  for (let hop = 0; hop < 2; hop++) {
    let changed = false;
    for (const f of allFiles) {
      if (assignments.has(f)) continue;

      // Collect all neighbors (files this imports + files that import this)
      const neighbors = [
        ...(importGraph[f] || []),
        ...(importedBy[f] || [])
      ];

      if (neighbors.length === 0) continue;

      // Count domain votes from assigned neighbors
      const votes = {};
      for (const neighbor of neighbors) {
        const d = assignments.get(neighbor);
        if (d) votes[d] = (votes[d] || 0) + 1;
      }

      if (Object.keys(votes).length === 0) continue;

      // Assign domain with most votes (majority wins)
      const winner = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
      assignments.set(f, winner);
      changed = true;
    }
    // Stop early if no new assignments in this hop
    if (!changed) break;
  }

  // Everything still unassigned → CORE
  for (const f of allFiles) {
    if (!assignments.has(f)) assignments.set(f, 'CORE');
  }

  return assignments;
}

/**
 * clusterByDomain(data) → { DOMAIN: { routes, models, functions, envVars, dbTables, fileMap } }
 *
 * data = { routes, models, functions, envVars, dbTables, fileMap, routesByFile, importGraph }
 */
function clusterByDomain(data) {
  const clusters = {};

  function getCluster(domain) {
    if (!clusters[domain]) {
      clusters[domain] = { routes: [], models: [], functions: {}, envVars: [], dbTables: [], fileMap: [] };
    }
    return clusters[domain];
  }

  // Build file list from all sources
  const allFiles = new Set();
  for (const f of Object.keys(data.routesByFile || {})) allFiles.add(f);
  for (const f of Object.keys(data.functions || {})) allFiles.add(f);
  for (const f of Object.keys(data.importGraph || {})) allFiles.add(f);
  for (const entry of data.fileMap || []) allFiles.add(entry.file);

  // Build assignments using graph clustering
  const assignments = buildFileAssignments([...allFiles], data.importGraph || {});

  // Routes — assign via routesByFile
  for (const [file, routes] of Object.entries(data.routesByFile || {})) {
    const domain = assignments.get(file) || getDomainForFile(file) || 'CORE';
    const cluster = getCluster(domain);
    for (const routeStr of routes) {
      const match = data.routes.find(r => `${r.method} ${r.path}` === routeStr);
      if (match) cluster.routes.push(match);
    }
  }

  // Models — assign by className keywords first, then DATABASE fallback
  for (const model of data.models || []) {
    const lower = model.className.toLowerCase();
    let assigned = false;
    for (const { keywords, domain } of DOMAIN_MAP) {
      if (keywords.some(kw => lower.includes(kw))) {
        getCluster(domain).models.push(model);
        assigned = true;
        break;
      }
    }
    if (!assigned) getCluster('DATABASE').models.push(model);
  }

  // Functions — assign via graph
  for (const [filePath, funcs] of Object.entries(data.functions || {})) {
    const domain = assignments.get(filePath) || getDomainForFile(filePath) || 'CORE';
    getCluster(domain).functions[filePath] = funcs;
  }

  // DB Tables — always DATABASE
  for (const table of data.dbTables || []) {
    getCluster('DATABASE').dbTables.push(table);
  }

  // Env Vars — assign by name keywords
  for (const envVar of data.envVars || []) {
    const lower = envVar.name.toLowerCase();
    let assigned = false;
    for (const { keywords, domain } of DOMAIN_MAP) {
      if (keywords.some(kw => lower.includes(kw))) {
        getCluster(domain).envVars.push(envVar);
        assigned = true;
        break;
      }
    }
    if (!assigned) getCluster('CORE').envVars.push(envVar);
  }

  // File map — assign via graph
  for (const entry of data.fileMap || []) {
    const domain = assignments.get(entry.file) || getDomainForFile(entry.file) || 'CORE';
    getCluster(domain).fileMap.push(entry);
  }

  return clusters;
}

module.exports = { clusterByDomain, getDomainForFile, buildFileAssignments };
