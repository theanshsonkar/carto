'use strict';

/**
 * Semantic retrieval — opt-in local embeddings.
 *
 * Bundling a ~90 MB `all-MiniLM-L6-v2` model by default would bloat the
 * Carto install. This channel is opt-in via `carto init --with-embeddings`
 * (or `carto.config.json` → `ai.embeddings: true`). When the model isn't
 * installed, `semanticSearch()` returns [] and the hybrid layer runs
 * without the semantic channel — structural + lexical still produce
 * useful results.
 *
 * Contract when the model is installed:
 *   - `getEmbeddingModel(projectRoot)` returns an object with
 *     `embed(text) → Float32Array`, or null if unavailable.
 *   - File embeddings are cached at `.carto/embeddings.db` keyed by file
 *     hash; re-embed only when the hash changes.
 *
 * Today we ship the stub — `isAvailable() === false` — until we wire up
 * `@xenova/transformers` or a similar local runtime. The 14 AI-native
 * tools work without it; they just drop the semantic channel out of the
 * RRF fusion.
 */

function isAvailable(_projectRoot) {
  // Future: probe @xenova/transformers + a pre-downloaded model.
  // Returns false today so callers fall back gracefully.
  return false;
}

function semanticSearch(_store, _intent, _opts = {}) {
  return [];
}

module.exports = { isAvailable, semanticSearch };
