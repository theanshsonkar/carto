'use strict';

/**
 * Lexical retrieval — SQLite FTS5 over file paths + symbol names.
 *
 * Hybrid retrieval needs a fast lexical leg alongside the structural graph
 * queries. FTS5 ships with better-sqlite3's bundled SQLite build, so no
 * extra dependency.
 *
 * Strategy: a lightweight `files_fts` virtual table indexed on:
 *   - path     (tokenized path; "src/auth/login.ts" yields tokens
 *               "src", "auth", "login", "ts")
 *   - symbols  (concatenated symbol names from the `symbols` table)
 *
 * We deliberately don't index file CONTENT — that would double the on-disk
 * index size and isn't needed for intent matching at the granularity Block
 * 4.B targets. The bitmap engine + path/symbol FTS together cover the
 * "find files relevant to this intent" question.
 *
 * Lifecycle:
 *   - `ensureFtsIndex(store)` — opens/creates the virtual table + populates
 *     it lazily on first call. After population, the meta key
 *     `fts_built_at` records the timestamp.
 *   - `searchFts(store, query, { limit })` — runs an FTS5 MATCH and returns
 *     file_id + bm25-derived rank. Returns [] if the index isn't ready.
 *   - `refreshFts(store)` — full rebuild; called by `runSync` when
 *     `files` table changes.
 *
 * Failure mode: any FTS5 error is caught + logged; callers treat the
 * lexical channel as empty and fall back to structural + (optional)
 * semantic.
 */

function ensureFtsIndex(store) {
  if (!store || !store.db) return false;
  const db = store.db;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
        file_id UNINDEXED,
        path,
        symbols,
        tokenize = "porter unicode61"
      );
    `);
  } catch (err) {
    // FTS5 not available (very old SQLite). Quietly disable.
    return false;
  }

  // Check whether populate has run.
  const built = store.getMeta && store.getMeta('fts_built_at');
  if (built) return true;

  return rebuildFts(store);
}

function rebuildFts(store) {
  if (!store || !store.db) return false;
  const db = store.db;
  try {
    db.exec('DELETE FROM files_fts');
    const files = db.prepare('SELECT id, path FROM files').all();
    const symStmt = db.prepare('SELECT name FROM symbols WHERE file_id = ? AND exported = 1');
    const insert = db.prepare('INSERT INTO files_fts(file_id, path, symbols) VALUES (?, ?, ?)');
    const tx = db.transaction(() => {
      for (const f of files) {
        // Path tokens: replace path separators with spaces so the porter
        // tokenizer sees individual segments. Drop the file extension.
        const pathTokens = f.path
          .replace(/\.[a-z0-9]+$/i, '')
          .replace(/[\/\\\-_.]/g, ' ');
        const symbols = symStmt.all(f.id).map(r => r.name).join(' ');
        insert.run(f.id, pathTokens, symbols);
      }
    });
    tx();
    if (store.setMeta) store.setMeta('fts_built_at', String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

function refreshFts(store) {
  return rebuildFts(store);
}

/**
 * searchFts(store, query, { limit })
 *
 * Returns [{ file_id, path, score }], score is `-bm25(files_fts)` so higher
 * is better (FTS5's bm25() returns lower-is-better).
 *
 * Query escaping: we strip operator chars from the user input then quote
 * each token, so `add rate limiter` becomes `"add" "rate" "limiter"` —
 * an implicit OR across tokens. Phrase quoting prevents FTS5 syntax
 * errors on user-supplied strings.
 */
function searchFts(store, query, { limit = 30 } = {}) {
  if (!store || !store.db) return [];
  if (typeof query !== 'string' || query.length === 0) return [];
  const tokens = query.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2);
  if (tokens.length === 0) return [];
  const ftsQuery = tokens.map(t => `"${t}"`).join(' OR ');
  try {
    return store.db.prepare(`
      SELECT files_fts.file_id as file_id, f.path as path, -bm25(files_fts) as score
      FROM files_fts
      JOIN files f ON f.id = files_fts.file_id
      WHERE files_fts MATCH ?
      ORDER BY score DESC
      LIMIT ?
    `).all(ftsQuery, limit);
  } catch {
    return [];
  }
}

module.exports = { ensureFtsIndex, refreshFts, rebuildFts, searchFts };
