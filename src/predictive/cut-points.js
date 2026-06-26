'use strict';

/**
 * Microservice cut-point finder.
 *
 * Identifies natural microservice boundaries by finding clusters with
 * high internal cohesion and low external coupling.
 *
 * Method:
 *   1. For each domain D in the store, count
 *        - intra_edges    imports where both ends are in D
 *        - external_edges imports from D to ¬D, plus imports from ¬D to D
 *   2. cohesion = intra_edges / (intra_edges + external_edges)
 *   3. A domain with cohesion >= 0.7 and size >= 10 is a candidate cut-point.
 *
 * Output: per-domain { domain, files, intra_edges, external_edges,
 *                       cohesion_score, candidate: boolean }.
 */

function findCutPoints({ store, threshold = 0.7, minSize = 10 } = {}) {
  if (!store || !store.db) return { cut_points: [], all_domains: [] };

  const allDomains = store.getDomainsList();
  const intraEdges = store.db.prepare(`
    SELECT d.name as domain, COUNT(*) as c
    FROM imports i
    JOIN files f1 ON i.from_file_id = f1.id
    JOIN files f2 ON i.to_file_id = f2.id
    JOIN domains d ON f1.domain_id = d.id
    WHERE f1.domain_id = f2.domain_id AND i.to_file_id IS NOT NULL
    GROUP BY d.name
  `).all();
  const intraMap = new Map(intraEdges.map(r => [r.domain, r.c]));

  const externalEdges = store.db.prepare(`
    SELECT d.name as domain, COUNT(*) as c
    FROM imports i
    JOIN files f1 ON i.from_file_id = f1.id
    JOIN files f2 ON i.to_file_id = f2.id
    JOIN domains d ON f1.domain_id = d.id
    WHERE f1.domain_id != f2.domain_id AND i.to_file_id IS NOT NULL
    GROUP BY d.name
  `).all();
  const externalMap = new Map(externalEdges.map(r => [r.domain, r.c]));

  // Inbound external edges: imports INTO domain D from other domains.
  const inboundExt = store.db.prepare(`
    SELECT d.name as domain, COUNT(*) as c
    FROM imports i
    JOIN files f1 ON i.from_file_id = f1.id
    JOIN files f2 ON i.to_file_id = f2.id
    JOIN domains d ON f2.domain_id = d.id
    WHERE f1.domain_id != f2.domain_id AND i.to_file_id IS NOT NULL
    GROUP BY d.name
  `).all();
  const inboundMap = new Map(inboundExt.map(r => [r.domain, r.c]));

  const out = [];
  for (const d of allDomains) {
    const intra = intraMap.get(d.name) || 0;
    const outbound = externalMap.get(d.name) || 0;
    const inbound = inboundMap.get(d.name) || 0;
    const external = outbound + inbound;
    const total = intra + external;
    const cohesion = total === 0 ? 0 : intra / total;
    out.push({
      domain: d.name,
      files: d.fileCount,
      intra_edges: intra,
      outbound_edges: outbound,
      inbound_edges: inbound,
      cohesion: Math.round(cohesion * 1000) / 1000,
      candidate: cohesion >= threshold && d.fileCount >= minSize,
    });
  }
  out.sort((a, b) => b.cohesion - a.cohesion);
  return {
    cut_points: out.filter(x => x.candidate),
    all_domains: out,
  };
}

module.exports = { findCutPoints };
