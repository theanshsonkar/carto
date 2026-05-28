'use strict';

/**
 * leiden.js — Leiden community detection with CPM quality function.
 *
 * Pure JS implementation (~250 lines). Zero external dependencies.
 * Based on: Traag, Waltman & van Eck (2019) "From Louvain to Leiden"
 *
 * Key difference from Louvain: the refinement phase guarantees that
 * every community is a connected subgraph (Louvain can produce
 * disconnected communities). This matters for import graphs where
 * disconnected clusters produce nonsensical domain names.
 *
 * CPM quality function:
 *   Q = Σ_c [ e_c - γ * n_c * (n_c - 1) / 2 ]
 *   where e_c = internal edges in community c
 *         n_c = nodes in community c
 *         γ   = resolution parameter (default 0.03)
 *
 * Lower γ → fewer, larger communities
 * Higher γ → more, smaller communities
 */

/**
 * leiden(nodes, edges, gamma) → Map<nodeId, communityId>
 *
 * @param {string[]} nodes - Array of node IDs (file paths)
 * @param {Array<[string, string]>} edges - Undirected edges as [from, to] pairs
 * @param {number} gamma - CPM resolution parameter (default 0.03)
 * @returns {Map<string, number>} - Map from node ID to community ID
 */
function leiden(nodes, edges, gamma = 0.03) {
  if (nodes.length === 0) return new Map();
  if (nodes.length === 1) return new Map([[nodes[0], 0]]);

  // Build integer-indexed adjacency for performance
  const nodeIndex = new Map();
  for (let i = 0; i < nodes.length; i++) nodeIndex.set(nodes[i], i);

  const n = nodes.length;
  const adj = new Array(n).fill(null).map(() => new Set());

  for (const [a, b] of edges) {
    const ai = nodeIndex.get(a);
    const bi = nodeIndex.get(b);
    if (ai === undefined || bi === undefined || ai === bi) continue;
    adj[ai].add(bi);
    adj[bi].add(ai);
  }

  // Initial partition: each node in its own community
  const community = new Int32Array(n);
  for (let i = 0; i < n; i++) community[i] = i;

  let improved = true;
  let iterations = 0;
  const MAX_ITER = 20;

  while (improved && iterations < MAX_ITER) {
    improved = false;
    iterations++;

    // Move phase: try to move each node to a neighboring community
    const order = shuffleIndices(n);
    for (const i of order) {
      const currentComm = community[i];

      // Count edges to each neighboring community
      const commEdges = new Map();
      for (const j of adj[i]) {
        const c = community[j];
        commEdges.set(c, (commEdges.get(c) || 0) + 1);
      }

      if (commEdges.size === 0) continue;

      // Current community size (excluding i)
      let currentSize = 0;
      for (let k = 0; k < n; k++) {
        if (k !== i && community[k] === currentComm) currentSize++;
      }

      const edgesToCurrent = commEdges.get(currentComm) || 0;
      // CPM gain of removing i from current community
      const gainRemove = edgesToCurrent - gamma * currentSize;

      // Find best community to move to
      let bestComm = currentComm;
      let bestGain = 0;

      for (const [c, edgesToC] of commEdges) {
        if (c === currentComm) continue;
        let cSize = 0;
        for (let k = 0; k < n; k++) {
          if (community[k] === c) cSize++;
        }
        // CPM gain of adding i to community c
        const gainAdd = edgesToC - gamma * cSize;
        const netGain = gainAdd - gainRemove;
        if (netGain > bestGain) {
          bestGain = netGain;
          bestComm = c;
        }
      }

      if (bestComm !== currentComm) {
        community[i] = bestComm;
        improved = true;
      }
    }

    // Refinement phase: split internally disconnected communities
    _refinementPhase(n, adj, community);
  }

  // Normalize community IDs to 0..k-1
  const idMap = new Map();
  let nextId = 0;
  const result = new Map();
  for (let i = 0; i < n; i++) {
    const c = community[i];
    if (!idMap.has(c)) idMap.set(c, nextId++);
    result.set(nodes[i], idMap.get(c));
  }

  return result;
}

/**
 * Refinement phase: for each community, check connectivity.
 * If a community is internally disconnected, split it into
 * connected components. This is the key Leiden improvement over Louvain.
 */
function _refinementPhase(n, adj, community) {
  // Group nodes by community
  const commNodes = new Map();
  for (let i = 0; i < n; i++) {
    const c = community[i];
    if (!commNodes.has(c)) commNodes.set(c, []);
    commNodes.get(c).push(i);
  }

  let nextNewComm = Math.max(...community) + 1;

  for (const [commId, members] of commNodes) {
    if (members.length <= 1) continue;

    // BFS within community to find connected components
    const memberSet = new Set(members);
    const visited = new Set();
    const components = [];

    for (const start of members) {
      if (visited.has(start)) continue;
      const component = [];
      const queue = [start];
      visited.add(start);
      while (queue.length > 0) {
        const node = queue.shift();
        component.push(node);
        for (const neighbor of adj[node]) {
          if (memberSet.has(neighbor) && !visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
      components.push(component);
    }

    // If more than one component, assign new community IDs to extras
    for (let ci = 1; ci < components.length; ci++) {
      const newComm = nextNewComm++;
      for (const node of components[ci]) {
        community[node] = newComm;
      }
    }
  }
}

/**
 * Fisher-Yates shuffle of indices 0..n-1
 */
function shuffleIndices(n) {
  const arr = new Int32Array(n);
  for (let i = 0; i < n; i++) arr[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

/**
 * nameCommunity(filePaths, keywordSeeds) → string
 *
 * Names a community by:
 * 1. Checking if any file paths match well-known keyword seeds (AUTH, PAYMENTS, etc.)
 * 2. Falling back to the most common distinctive path segment
 *
 * @param {string[]} filePaths - Relative file paths in this community
 * @param {object} keywordSeeds - { 'AUTH': ['auth', 'login'], 'PAYMENTS': ['payment', 'stripe'] }
 * @returns {string} - Domain name in UPPER_CASE
 */
function nameCommunity(filePaths, keywordSeeds = {}) {
  if (filePaths.length === 0) return 'CORE';

  // Check keyword seeds first
  const seedScores = {};
  for (const [domainName, keywords] of Object.entries(keywordSeeds)) {
    let score = 0;
    for (const fp of filePaths) {
      const lower = fp.toLowerCase();
      for (const kw of keywords) {
        if (lower.includes(kw)) { score++; break; }
      }
    }
    if (score > 0) seedScores[domainName] = score;
  }

  if (Object.keys(seedScores).length > 0) {
    // Return the seed domain with the highest match count
    return Object.entries(seedScores).sort((a, b) => b[1] - a[1])[0][0];
  }

  // Fall back to path token frequency
  const SKIP_SEGMENTS = new Set([
    'src', 'lib', 'app', 'pkg', 'internal', 'cmd', 'api',
    'utils', 'util', 'helpers', 'helper', 'common', 'shared',
    'index', 'main', 'mod', 'core', 'base', 'types', 'type',
    'components', 'component', 'services', 'service',
    'controllers', 'controller', 'models', 'model',
    'routes', 'route', 'handlers', 'handler',
    'js', 'ts', 'py', 'go', 'rs',
  ]);

  const segmentCounts = {};
  for (const fp of filePaths) {
    const parts = fp.replace(/\\/g, '/').split('/');
    // Skip the filename itself, focus on directory segments
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i].toLowerCase().replace(/[^a-z0-9]/g, '');
      if (seg.length < 2 || SKIP_SEGMENTS.has(seg)) continue;
      segmentCounts[seg] = (segmentCounts[seg] || 0) + 1;
    }
  }

  if (Object.keys(segmentCounts).length === 0) return 'CORE';

  const topSegment = Object.entries(segmentCounts)
    .sort((a, b) => b[1] - a[1])[0][0];

  return topSegment.toUpperCase();
}

/**
 * clusterByGraph(importGraph, gamma, keywordSeeds) → Map<filePath, domainName>
 *
 * Main entry point for graph-based domain detection.
 *
 * @param {object} importGraph - { 'file.ts': ['dep1.ts', 'dep2.ts'] }
 * @param {number} gamma - CPM resolution (default 0.03)
 * @param {object} keywordSeeds - Domain keyword hints for naming
 * @returns {Map<string, string>} - Map from file path to domain name
 */
function clusterByGraph(importGraph, gamma = 0.03, keywordSeeds = {}) {
  const nodes = Object.keys(importGraph);

  // Add nodes that appear as targets but not as sources
  const allNodes = new Set(nodes);
  for (const deps of Object.values(importGraph)) {
    for (const dep of deps) allNodes.add(dep);
  }

  const nodeList = [...allNodes];
  if (nodeList.length === 0) return new Map();

  // Build undirected edges (merge A→B and B→A)
  const edgeSet = new Set();
  const edges = [];
  for (const [from, deps] of Object.entries(importGraph)) {
    for (const to of deps) {
      const key = [from, to].sort().join('|||');
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push([from, to]);
      }
    }
  }

  // Run Leiden
  const communityMap = leiden(nodeList, edges, gamma);

  // Group files by community ID
  const communities = new Map();
  for (const [node, commId] of communityMap) {
    if (!communities.has(commId)) communities.set(commId, []);
    communities.get(commId).push(node);
  }

  // Name each community
  const commNames = new Map();
  const usedNames = new Map(); // name → count (for deduplication)

  for (const [commId, members] of communities) {
    let name = nameCommunity(members, keywordSeeds);

    // Deduplicate: if name already used, append a number
    if (usedNames.has(name)) {
      const count = usedNames.get(name) + 1;
      usedNames.set(name, count);
      name = `${name}_${count}`;
    } else {
      usedNames.set(name, 1);
    }

    commNames.set(commId, name);
  }

  // Build final file → domain map
  const result = new Map();
  for (const [node, commId] of communityMap) {
    result.set(node, commNames.get(commId) || 'CORE');
  }

  return result;
}

module.exports = { leiden, nameCommunity, clusterByGraph };
