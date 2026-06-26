'use strict';

/**
 * LLM-enriched graphs — opt-in node summaries via a local LLM.
 *
 * Bolts one-sentence summaries onto every node in the import graph so MCP
 * responses can include richer per-file descriptions without bloating
 * prompts. Local LLM only (privacy + cost).
 *
 * Contract today:
 *   - `isAvailable()` returns `false` until we wire Ollama or similar.
 *   - `enrichNode(filePath)` returns null when unavailable.
 *
 * Caching plan for the real implementation:
 *   `.carto/llm-cache.db` with `(file_hash, summary, intent, risk)`.
 *   Re-summarize only when the content hash changes. Configurable model
 *   via `carto.config.json` → `ai.llm: { provider: 'ollama', model: '...' }`.
 *
 * The stub is here so the MCP tool has a deterministic
 * "feature exists, currently disabled" surface to register against.
 */

function isAvailable(_projectRoot) {
  return false;
}

function enrichNode(_filePath, _opts = {}) {
  return null;
}

function enrichGraph(_store, _opts = {}) {
  return { enriched: 0, cached: 0, summaries: [] };
}

module.exports = { isAvailable, enrichNode, enrichGraph };
