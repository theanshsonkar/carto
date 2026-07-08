const path = require('path');

// Narrowed keyword seeds (CF-3). Each keyword must be specific enough that a
// path-segment match is almost certainly that domain. Over-broad tokens that
// caused the audit's false positives were removed:
//   'token'  → matches design tokens, tokenizers, CSRF tokens (byte-util→AUTH)
//   'db','model','schema' → match schema.ts / model files everywhere
//   'event','job','task'  → match generic app code
//   'router','routers'    → match every framework router, not just tRPC
// Matching is still anchored to path *segments* (see getDomainForFile), never
// arbitrary substrings.
const DEFAULT_DOMAIN_MAP = [
  { keywords: ['auth', 'login', 'logout', 'signin', 'signup', 'oauth', 'jwt', 'session', 'password', 'credential'], domain: 'AUTH' },
  { keywords: ['payment', 'payments', 'billing', 'stripe', 'invoice', 'subscription', 'checkout'], domain: 'PAYMENTS' },
  { keywords: ['trpc', 'procedure'], domain: 'TRPC' },
  { keywords: ['prisma', 'drizzle', 'migration', 'migrations', 'sqlalchemy'], domain: 'DATABASE' },
  { keywords: ['webhook', 'webhooks', 'queue', 'worker', 'cron'], domain: 'EVENTS' },
  { keywords: ['notification', 'notifications', 'mailer', 'sms'], domain: 'NOTIFICATIONS' },
];

// Confidence tiers recorded on each assignment (persisted to
// domain_assignments.confidence). Declared config (globs/anchors) is written
// by the sync layer at 1.0; these are the inference tiers.
const CONF_SEED = 0.9;   // matched a keyword seed on its own path
const CONF_VOTE = 0.5;   // inferred from a clear majority of assigned neighbors
const CONF_CORE = 0.2;   // no signal — fell through to CORE

// Vote must clear all of these to assign a domain; otherwise the file stays
// CORE. This is what stops a single AUTH neighbor from painting an entire
// import chain AUTH (the theme→AUTH / byte-util→AUTH class of bug).
const VOTE_MIN = 2;          // need at least this many neighbor votes for the winner
const VOTE_FRACTION = 0.5;   // winner must be at least this share of all domain votes

// Active domain map — replaced by setDomainMap() when carto.config.json is present
let DOMAIN_MAP = DEFAULT_DOMAIN_MAP;

/**
 * setDomainMap(customDomains)
 * Override the domain map from carto.config.json.
 *
 * customDomains format:
 *   { "EDITOR": ["editor", "monaco"], "WORKBENCH": ["workbench", "panel"] }
 *
 * Pass null to reset to defaults.
 */
function setDomainMap(customDomains) {
  if (!customDomains || typeof customDomains !== 'object' || Array.isArray(customDomains)) {
    DOMAIN_MAP = DEFAULT_DOMAIN_MAP;
    return;
  }
  DOMAIN_MAP = Object.entries(customDomains).map(([domain, keywords]) => ({
    domain: domain.toUpperCase(),
    keywords: keywords.map(k => String(k).toLowerCase()),
  }));
}

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
 * buildFileAssignments(allFiles, importGraph, confidenceOut?) → Map<filePath, domain>
 *
 * Two-pass clustering (inference — the FALLBACK; declared config wins upstream):
 * Pass 1 — assign seeds via keyword path-segment matching (confidence 0.9)
 * Pass 2 — expand seeds via import graph (up to 2 hops) using a *conservative*
 *          majority vote: a file only inherits a neighbor domain when that
 *          domain has ≥ VOTE_MIN votes AND is a strict plurality of ≥
 *          VOTE_FRACTION of all domain votes among assigned neighbors.
 *          A single weak vote is no longer enough — this is what prevents one
 *          AUTH-labelled neighbor from painting an entire import chain AUTH.
 * Remaining unassigned → 'CORE' (confidence 0.2).
 *
 * allFiles: string[] of relative file paths (all files in scope)
 * importGraph: { 'relPath': ['dep1', 'dep2'] } from map.json
 * confidenceOut: optional Map<filePath, number> populated with per-file confidence
 */
function buildFileAssignments(allFiles, importGraph, confidenceOut = null) {
  const assignments = new Map();
  const conf = confidenceOut instanceof Map ? confidenceOut : new Map();

  // Pass 1 — keyword seeds
  for (const f of allFiles) {
    const domain = getDomainForFile(f);
    if (domain) {
      assignments.set(f, domain);
      conf.set(f, CONF_SEED);
    }
  }

  // Build reverse graph (importedBy) for bidirectional lookup
  const importedBy = {};
  for (const [file, deps] of Object.entries(importGraph || {})) {
    for (const dep of deps) {
      if (!importedBy[dep]) importedBy[dep] = [];
      importedBy[dep].push(file);
    }
  }

  // Pass 2 — expand via graph, up to 2 hops. Only files assigned in pass 1
  // (seeds, confidence ≥ CONF_SEED) count as voters, so weak vote-inferred
  // labels don't cascade into further weak labels across hops.
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

      // Count domain votes from *seed-strength* neighbors only.
      const votes = {};
      let total = 0;
      for (const neighbor of neighbors) {
        const d = assignments.get(neighbor);
        if (d && (conf.get(neighbor) || 0) >= CONF_SEED) {
          votes[d] = (votes[d] || 0) + 1;
          total++;
        }
      }
      if (total === 0) continue;

      // Rank domains; require a clear, dominant winner.
      const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
      const [winner, winnerVotes] = ranked[0];
      const runnerUp = ranked[1] ? ranked[1][1] : 0;
      if (
        winnerVotes >= VOTE_MIN &&
        winnerVotes > runnerUp &&
        winnerVotes / total >= VOTE_FRACTION
      ) {
        assignments.set(f, winner);
        conf.set(f, CONF_VOTE);
        changed = true;
      }
    }
    // Stop early if no new assignments in this hop
    if (!changed) break;
  }

  // Everything still unassigned → CORE
  for (const f of allFiles) {
    if (!assignments.has(f)) {
      assignments.set(f, 'CORE');
      conf.set(f, CONF_CORE);
    }
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
      clusters[domain] = { routes: [], models: [], functions: {}, envVars: [], dbTables: [], fileMap: [], files: [] };
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

  // Files — populate from assignments so cluster.files is always set
  for (const [file, domain] of assignments.entries()) {
    getCluster(domain).files.push(file);
  }

  return clusters;
}

module.exports = { clusterByDomain, getDomainForFile, buildFileAssignments, setDomainMap };
