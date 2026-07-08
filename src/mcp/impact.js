'use strict';

/**
 * src/mcp/impact.js — the `impact(...)` tool's engine-backed core.
 *
 * CF-7 collapsed four sibling MCP tools (`get_blast_radius`,
 * `simulate_change_impact`, `get_neighbors`, `get_data_flow`) into one
 * parameterized `impact(file|files, mode)` tool. This module holds the
 * *byte-identical* formatters for the three bitmap-engine-backed modes
 * (blast / simulate / neighbors) so that:
 *
 *   1. the legacy handlers, the deprecated shims, and the new `impact`
 *      tool all render from the SAME code — no drift between old and new;
 *   2. the blast-radius correctness + benchmark suites
 *      (test/accuracy-corpus.js, test/benchmark.js) can call these pure
 *      functions per-repo, so the §3 DO-NOT-BREAK guarantee physically
 *      transfers to the new surface.
 *
 * These functions take an explicit `store` + `sidecar` (no module-level
 * singletons) so they are trivially testable against any indexed repo.
 * They return the raw markdown STRING (the MCP layer wraps it in the
 * `{ content: [...] }` envelope). Output is copied verbatim from the
 * pre-CF-7 handlers — do not "clean up" the formatting or you break
 * byte-identity with the episodic decision log.
 *
 * `data_flow` is intentionally NOT here: it composes the richer `ai`
 * module + temporal context in server.js, so the `impact` tool routes
 * that mode straight to the existing get_data_flow handler.
 */

const bitmapTools = require('../bitmap/tools');

/**
 * Blast radius — transitive dependents of a single file.
 * Mirrors the legacy `get_blast_radius` handler exactly.
 */
function blast({ store, sidecar, file }) {
  const deps = sidecar
    ? bitmapTools.blastRadius(sidecar, file)
    : store.getBlastRadius(file);
  if (!deps) return `File not found in index: ${file}`;
  if (deps.length === 0) return `No dependents found for: ${file}`;
  const lines = [`# Blast Radius: ${file}\n`, `**Affected files:** ${deps.length}\n`];
  lines.push('| File | Hops |');
  lines.push('|------|------|');
  for (const d of deps) lines.push(`| ${d.file} | ${d.hop_distance} |`);
  return lines.join('\n');
}

/**
 * Simulate change impact — union of transitive dependents for a SET of
 * files changed simultaneously. Takes the already-normalized file list
 * and the pre-computed bitmap result; mirrors the legacy
 * `simulate_change_impact` formatter exactly.
 */
function formatSimulate(result, normalizedFiles) {
  const lines = [
    `# Simulate Change Impact\n`,
    `Changing **${normalizedFiles.length}** file${normalizedFiles.length === 1 ? '' : 's'} ` +
    `simultaneously affects **${result.count}** transitive dependent` +
    `${result.count === 1 ? '' : 's'}.\n`,
  ];
  lines.push('## Input files\n');
  for (const f of normalizedFiles) lines.push(`- \`${f}\``);
  lines.push('');
  if (result.count === 0) {
    lines.push('_No additional files would be affected. None of the input files have dependents in the index._');
  } else {
    lines.push('## Affected files\n');
    lines.push('| File | Min Hop |');
    lines.push('|------|---------|');
    for (const r of result.files.slice(0, 200)) {
      lines.push(`| \`${r.file}\` | ${r.hop_distance} |`);
    }
    if (result.count > 200) lines.push(`\n_...and ${result.count - 200} more._`);
  }
  return lines.join('\n');
}

/**
 * Convenience wrapper: run the bitmap simulate + format in one call
 * (used by the correctness/benchmark suites). Assumes a valid sidecar
 * and non-empty normalized file list.
 */
function simulate({ sidecar, files }) {
  const result = bitmapTools.simulateChangeImpact(sidecar, files);
  return formatSimulate(result, files);
}

/**
 * Import-graph neighbors of a file. Mirrors the legacy `get_neighbors`
 * handler exactly.
 */
function formatNeighbors(nb, file, hops) {
  if (nb.nodes.length === 0) return `File not found or no neighbors: ${file}`;
  const lines = [`# Import Neighbors: ${file} (${hops} hop${hops > 1 ? 's' : ''})\n`];
  lines.push('| File | Domain | Root |');
  lines.push('|------|--------|------|');
  for (const n of nb.nodes) lines.push(`| ${n.id} | ${n.domain} | ${n.isRoot ? '✓' : ''} |`);
  lines.push('');
  lines.push(`## Edges (${nb.edges.length})`);
  for (const e of nb.edges.slice(0, 50)) lines.push(`- ${e.source} → ${e.target}`);
  if (nb.edges.length > 50) lines.push(`_...and ${nb.edges.length - 50} more_`);
  return lines.join('\n');
}

function neighbors({ store, file, hops }) {
  const h = Math.min(hops || 1, 3);
  const nb = store.getNeighbors(file, h);
  return formatNeighbors(nb, file, h);
}

module.exports = {
  blast,
  simulate,
  formatSimulate,
  neighbors,
  formatNeighbors,
};
