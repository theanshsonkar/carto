'use strict';

/**
 * 5 bitmap-based MCP tool reimplementations.
 * Each mirrors the SQLite equivalent's semantics for parity comparison.
 */

const { Bitset } = require('./sidecar');

/**
 * BFS over reverse adjacency bitmaps. Returns array of dependent fileIds.
 */
function bitmapBlastRadius(sidecar, fileId, maxHops = 5) {
  const { reverse, size } = sidecar;
  let visited = new Bitset(size);
  visited.set(fileId);
  let frontier = new Bitset(size);
  frontier.set(fileId);

  for (let hop = 0; hop < maxHops; hop++) {
    let next = new Bitset(size);
    for (const fid of frontier.iterate()) {
      const deps = reverse.get(fid);
      if (deps) next = next.or(deps);
    }
    next = next.andNot(visited);
    if (next.popcount() === 0) break;
    visited = visited.or(next);
    frontier = next;
  }

  visited.words[fileId >>> 5] &= ~(1 << (fileId & 31)); // exclude self
  return visited.iterate();
}

/**
 * Cross-domain edges: for each import edge, check if from/to are in different domains.
 */
function bitmapCrossDomain(sidecar) {
  const { forward, fileDomain, fileIdToPath } = sidecar;
  const results = [];
  for (const [fromId, bitmap] of forward) {
    const fromDomain = fileDomain.get(fromId);
    if (fromDomain === undefined) continue;
    for (const toId of bitmap.iterate()) {
      const toDomain = fileDomain.get(toId);
      if (toDomain === undefined) continue;
      if (fromDomain !== toDomain) {
        results.push({ from: fromId, to: toId, fromDomain, toDomain });
      }
    }
  }
  return results;
}

/**
 * Top N files by reverse-dep popcount (number of direct dependents).
 */
function bitmapHighImpactFiles(sidecar, n = 10) {
  const { reverse, fileIdToPath } = sidecar;
  const scores = [];
  for (const [fileId, bitmap] of reverse) {
    scores.push({ fileId, dependents: bitmap.popcount() });
  }
  scores.sort((a, b) => b.dependents - a.dependents);
  return scores.slice(0, n);
}

/**
 * Jaccard similarity over import sets: |A AND B| / |A OR B|. Top K by score.
 */
function bitmapSimilarPatterns(sidecar, fileId, k = 5) {
  const { forward } = sidecar;
  const target = forward.get(fileId);
  if (!target || target.popcount() === 0) return [];

  const scores = [];
  for (const [otherId, bitmap] of forward) {
    if (otherId === fileId) continue;
    const intersection = target.and(bitmap).popcount();
    if (intersection === 0) continue;
    const union = target.or(bitmap).popcount();
    scores.push({ fileId: otherId, score: intersection / union });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, k);
}

/**
 * OR-aggregate reverse bitmaps for multiple fileIds. Returns total affected count.
 * This tool is NEW — only possible with bitmaps efficiently.
 */
function bitmapSimulateChangeImpact(sidecar, fileIds) {
  const { reverse, size } = sidecar;
  let union = new Bitset(size);
  for (const fid of fileIds) {
    const deps = reverse.get(fid);
    if (deps) union = union.or(deps);
  }
  // Exclude the input files themselves
  for (const fid of fileIds) {
    union.words[fid >>> 5] &= ~(1 << (fid & 31));
  }
  return { count: union.popcount(), affected: union.iterate() };
}

module.exports = {
  bitmapBlastRadius,
  bitmapCrossDomain,
  bitmapHighImpactFiles,
  bitmapSimilarPatterns,
  bitmapSimulateChangeImpact,
};
