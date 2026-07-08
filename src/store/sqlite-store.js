'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Schema version 4 — adds the `gaps` table (derived view of what
// the rule engine currently finds). Prior versions:
//   1 — initial schema
//   2 — reverse_deps + centrality
//   3 — episodic memory (ai_sessions, decisions, interventions)
//   4 — gaps table for the rule engine
// _ensureSchema() is idempotent (CREATE TABLE IF NOT EXISTS on every
// table), so older DBs cleanly pick up the new tables on next open.
const SCHEMA_VERSION = '4';

/**
 * normalizePath(p) — Canonicalize a relative path for storage and query.
 *
 * Converts backslashes to forward slashes (Windows → POSIX), strips leading
 * './', and rejects absolute paths (callers must `path.relative(projectRoot, p)`
 * before passing in).
 *
 * Single-source-of-truth for "what does a row in `files.path` look like?".
 * Apply this at every boundary that writes or queries the column, and every
 * downstream join (imports.from_file_id → files.path) stays consistent.
 *
 * Cross-platform invariant: same code, same DB, same query results on macOS,
 * Linux, and Windows.
 */
function normalizePath(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  let out = p;
  // Backslash → forward slash (Windows → POSIX). path.sep is '\\' on Windows.
  if (path.sep !== '/') out = out.split(path.sep).join('/');
  // Some inputs may already use mixed separators (e.g., `src\utils/foo.js`).
  // Normalize aggressively.
  out = out.replace(/\\/g, '/');
  // Strip leading './'
  if (out.startsWith('./')) out = out.slice(2);
  return out;
}

class SQLiteStore {
  constructor(projectRoot) {
    this._projectRoot = projectRoot;
    this._db = null;
  }

  /**
   * open(opts) — Opens or creates the database. Applies pragmas and schema.
   *
   * Options:
   *   readonly  — Open the DB in read-only mode. Used by the MCP server
   *               (`carto serve`) so a malformed/buggy tool can never write
   *               through the SQLite layer. Skips mkdir, schema bootstrap, and
   *               WAL pragma (WAL needs write capability and would otherwise
   *               create `carto.db-wal`/`carto.db-shm` in repos that only run
   *               the MCP server). Sets `fileMustExist: true` so a missing DB
   *               returns a clear SQLite error instead of silently creating an
   *               empty file in the wrong location.
   */
  open(opts = {}) {
    const cartoDir = path.join(this._projectRoot, '.carto');
    const dbPath = path.join(cartoDir, 'carto.db');

    if (opts.readonly) {
      // Read-only path: dir must already exist (a writer process — `carto sync`
      // or `carto init` — created the DB). Don't mkdir, don't ensure schema,
      // don't apply write-only pragmas.
      this._db = new Database(dbPath, { readonly: true, fileMustExist: true });
      // Read-only safe pragmas only:
      this._db.pragma('busy_timeout = 5000');
      this._db.pragma('cache_size = -64000'); // 64MB cache
      return this;
    }

    fs.mkdirSync(cartoDir, { recursive: true });

    try {
      this._db = new Database(dbPath);
    } catch (err) {
      // Corrupted — delete and recreate
      console.warn(`[CARTO] Database corrupted, recreating: ${err.message}`);
      try { fs.unlinkSync(dbPath); } catch {}
      try { fs.unlinkSync(dbPath + '-wal'); } catch {}
      try { fs.unlinkSync(dbPath + '-shm'); } catch {}
      this._db = new Database(dbPath);
    }

    this._applyPragmas();
    this._ensureSchema();
    return this;
  }

  _applyPragmas() {
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('synchronous = NORMAL');
    this._db.pragma('busy_timeout = 5000');
    this._db.pragma('cache_size = -64000'); // 64MB cache
    this._db.pragma('foreign_keys = ON');
  }

  _ensureSchema() {
    const version = this.getMeta('schema_version');
    if (version === SCHEMA_VERSION) return;

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        language TEXT,
        hash TEXT,
        mtime INTEGER,
        size INTEGER,
        domain_id INTEGER,
        is_entry_point INTEGER DEFAULT 0,
        centrality REAL DEFAULT 0,
        last_indexed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
      CREATE INDEX IF NOT EXISTS idx_files_domain ON files(domain_id);
      CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS imports (
        id INTEGER PRIMARY KEY,
        from_file_id INTEGER NOT NULL,
        to_file_id INTEGER,
        to_path TEXT NOT NULL,
        symbol_name TEXT,
        resolved INTEGER DEFAULT 1,
        FOREIGN KEY (from_file_id) REFERENCES files(id) ON DELETE CASCADE,
        FOREIGN KEY (to_file_id) REFERENCES files(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_imports_from ON imports(from_file_id);
      CREATE INDEX IF NOT EXISTS idx_imports_to ON imports(to_file_id);
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER,
        exported INTEGER DEFAULT 0,
        is_default_export INTEGER DEFAULT 0,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS routes (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        handler_name TEXT,
        framework TEXT,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_routes_file ON routes(file_id);
      CREATE INDEX IF NOT EXISTS idx_routes_method ON routes(method);
      CREATE INDEX IF NOT EXISTS idx_routes_path ON routes(path);
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS models (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        fields_json TEXT,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_models_file ON models(file_id);
      CREATE INDEX IF NOT EXISTS idx_models_name ON models(name);
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS env_vars (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        access_pattern TEXT,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_env_vars_name ON env_vars(name);
      CREATE INDEX IF NOT EXISTS idx_env_vars_file ON env_vars(file_id);
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS db_tables (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL,
        table_name TEXT NOT NULL,
        operation TEXT,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_db_tables_name ON db_tables(table_name);
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS domains (
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        auto_detected INTEGER DEFAULT 1,
        file_count INTEGER DEFAULT 0,
        description TEXT
      );
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS domain_assignments (
        file_id INTEGER NOT NULL,
        domain_id INTEGER NOT NULL,
        confidence REAL DEFAULT 1.0,
        PRIMARY KEY (file_id, domain_id),
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
        FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
      );
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS reverse_deps (
        file_id INTEGER NOT NULL,
        dependent_file_id INTEGER NOT NULL,
        hop_distance INTEGER NOT NULL,
        PRIMARY KEY (file_id, dependent_file_id),
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
        FOREIGN KEY (dependent_file_id) REFERENCES files(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_reverse_deps_file ON reverse_deps(file_id);
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // ─── extraction_errors ──────────────────────────────────────────
    // One row per (file, phase) extractor failure. Lets `carto check`,
    // the init summary, and MCP get_architecture surface broken parses
    // instead of silently dropping their data. file_id is FK with
    // ON DELETE CASCADE so removeFile() automatically cleans up.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS extraction_errors (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL,
        phase TEXT NOT NULL,
        error_message TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_extraction_errors_file ON extraction_errors(file_id);
      CREATE INDEX IF NOT EXISTS idx_extraction_errors_phase ON extraction_errors(phase);
    `);

    // ─── Episodic Memory ────────────────────────────────────────────
    // Three append-mostly tables that turn Carto from an amnesiac
    // lookup layer into a durable record of what the AI is doing.
    //
    //   ai_sessions   — one row per MCP connection or ACP session.
    //                   Created lazily by getOrCreateActiveSession().
    //   decisions     — append-only log of validation requests and
    //                   architectural choices. payload_json holds the
    //                   structured body (diff hash, violation summary,
    //                   etc.); kept TEXT so the schema doesn't need to
    //                   evolve when callers add fields.
    //   interventions — Carto's outputs back to the AI: violations and
    //                   suggestions. `accepted` is a tri-state (NULL =
    //                   unknown, 0 = rejected, 1 = accepted) so clients
    //                   that track follow-through can update later.
    //
    // No FK on session_id — sessions are convenience anchors; we don't
    // want a session row that gets purged in a future cleanup to
    // cascade-delete the historical record.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS ai_sessions (
        id INTEGER PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        client_name TEXT,
        metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ai_sessions_started ON ai_sessions(started_at);
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY,
        session_id INTEGER,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        file TEXT,
        payload_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts);
      CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
      CREATE INDEX IF NOT EXISTS idx_decisions_kind ON decisions(kind);
    `);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS interventions (
        id INTEGER PRIMARY KEY,
        session_id INTEGER,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        file TEXT,
        severity TEXT,
        message TEXT,
        accepted INTEGER DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_interventions_file ON interventions(file);
      CREATE INDEX IF NOT EXISTS idx_interventions_ts ON interventions(ts);
      CREATE INDEX IF NOT EXISTS idx_interventions_session ON interventions(session_id);
    `);

    // ─── Rule Engine gaps ───────────────────────────────────────────
    // A gap is a claim, grounded in a Carto fact, that the code
    // violates a rule ("SHOULD − IS"). The `gaps` table is derived
    // state — it's completely replaced on every rule-engine run
    // (`replaceGaps()`). Persistence lets get_gaps be a cheap query
    // instead of re-running the engine on every MCP call.
    //
    //   gap_hash    — sha1(rule_id + file + line). Stable across
    //                 runs; used to dedup against dismissals.
    //   dismissed   — 1 if the user marked this gap intentional
    //                 (via dismiss_gap). Preserved across gap
    //                 replacements — see replaceGaps() logic.
    //   reason      — user's dismissal reason, free text.
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS gaps (
        id INTEGER PRIMARY KEY,
        gap_hash TEXT UNIQUE NOT NULL,
        rule_id TEXT NOT NULL,
        file TEXT,
        line INTEGER,
        severity TEXT NOT NULL,
        reversibility TEXT,
        concept TEXT,
        evidence TEXT,
        detected_at INTEGER NOT NULL,
        dismissed INTEGER DEFAULT 0,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_gaps_rule ON gaps(rule_id);
      CREATE INDEX IF NOT EXISTS idx_gaps_file ON gaps(file);
      CREATE INDEX IF NOT EXISTS idx_gaps_dismissed ON gaps(dismissed);
    `);

    this.setMeta('schema_version', SCHEMA_VERSION);
  }

  // ─── Meta helpers ──────────────────────────────────────────────────────

  getMeta(key) {
    if (!this._db) return null;
    try {
      const row = this._db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  setMeta(key, value) {
    this._db.prepare(
      'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'
    ).run(key, String(value));
  }

  // ─── File operations ───────────────────────────────────────────────────

  getFileByPath(relPath) {
    return this._db.prepare('SELECT * FROM files WHERE path = ?').get(normalizePath(relPath));
  }

  getFileById(id) {
    return this._db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  }

  getAllFiles() {
    return this._db.prepare('SELECT * FROM files').all();
  }

  getFileCount() {
    const row = this._db.prepare('SELECT COUNT(*) as cnt FROM files').get();
    return row.cnt;
  }

  upsertFile(relPath, { language, hash, mtime, size }) {
    const norm = normalizePath(relPath);
    const existing = this.getFileByPath(norm);
    if (existing) {
      this._db.prepare(
        'UPDATE files SET language=?, hash=?, mtime=?, size=?, last_indexed_at=? WHERE id=?'
      ).run(language, hash, mtime, size, Date.now(), existing.id);
      return existing.id;
    }
    const info = this._db.prepare(
      'INSERT INTO files (path, language, hash, mtime, size, last_indexed_at) VALUES (?,?,?,?,?,?)'
    ).run(norm, language, hash, mtime, size, Date.now());
    return info.lastInsertRowid;
  }

  updateFileMtime(relPath, mtime, size) {
    this._db.prepare(
      'UPDATE files SET mtime=?, size=? WHERE path=?'
    ).run(mtime, size, normalizePath(relPath));
  }

  removeFile(relPath) {
    this._db.prepare('DELETE FROM files WHERE path = ?').run(normalizePath(relPath));
  }

  removeStaleFiles(currentPaths) {
    const existing = this._db.prepare('SELECT path FROM files').all();
    const currentSet = new Set(currentPaths);
    const toRemove = existing.filter(f => !currentSet.has(f.path));
    const del = this._db.prepare('DELETE FROM files WHERE path = ?');
    for (const f of toRemove) del.run(f.path);
    return toRemove.length;
  }

  // ─── Extraction storage ────────────────────────────────────────────────

  /**
   * storeExtraction(fileId, data)
   * Replaces all extracted data for a file in a single transaction.
   * data = { imports, symbols, routes, models, envVars, dbTables }
   */
  storeExtraction(fileId, data) {
    const tx = this._db.transaction(() => {
      // Clear old data
      this._db.prepare('DELETE FROM imports WHERE from_file_id = ?').run(fileId);
      this._db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
      this._db.prepare('DELETE FROM routes WHERE file_id = ?').run(fileId);
      this._db.prepare('DELETE FROM models WHERE file_id = ?').run(fileId);
      this._db.prepare('DELETE FROM env_vars WHERE file_id = ?').run(fileId);
      this._db.prepare('DELETE FROM db_tables WHERE file_id = ?').run(fileId);
      // Clear stale extraction errors for this file. We're
      // about to record fresh ones (or none, if the re-extraction
      // succeeded). Without this, a previously-broken file that's now
      // fixed would still show up in `carto check`.
      this._db.prepare('DELETE FROM extraction_errors WHERE file_id = ?').run(fileId);

      // Insert imports
      if (data.imports && data.imports.length > 0) {
        const ins = this._db.prepare(
          'INSERT INTO imports (from_file_id, to_file_id, to_path, symbol_name, resolved) VALUES (?,?,?,?,?)'
        );
        for (const imp of data.imports) {
          const toFileId = imp.resolvedFileId || null;
          const resolved = toFileId ? 1 : 0;
          ins.run(fileId, toFileId, imp.path, imp.symbol || null, resolved);
        }
      }

      // Insert symbols (functions)
      if (data.symbols && data.symbols.length > 0) {
        const ins = this._db.prepare(
          'INSERT INTO symbols (file_id, name, kind, line, exported, is_default_export) VALUES (?,?,?,?,?,?)'
        );
        for (const sym of data.symbols) {
          if (!sym.name) continue;
          ins.run(fileId, sym.name, sym.kind || 'function', sym.line || null,
                  sym.exported ? 1 : 0, sym.isDefault ? 1 : 0);
        }
      }

      // Insert routes
      if (data.routes && data.routes.length > 0) {
        const ins = this._db.prepare(
          'INSERT INTO routes (file_id, method, path, handler_name, framework) VALUES (?,?,?,?,?)'
        );
        for (const r of data.routes) {
          if (!r.method || !r.path) continue;
          ins.run(fileId, r.method, r.path, r.handler || null, r.framework || null);
        }
      }

      // Insert models
      if (data.models && data.models.length > 0) {
        const ins = this._db.prepare(
          'INSERT INTO models (file_id, name, kind, fields_json) VALUES (?,?,?,?)'
        );
        for (const m of data.models) {
          // Extractors are inconsistent: prisma/zod/interface/etc. emit
          // `className`, drizzle emits both `name` and `className`,
          // pydantic emits `className`. Fall through the whole chain so
          // no extractor's models silently vanish.
          const name = m.name || m.className || m.model || (typeof m === 'string' ? m : null);
          if (!name) continue; // skip models without a name
          const fields = m.fields ? JSON.stringify(m.fields) : null;
          ins.run(fileId, name, m.kind || m.type || 'unknown', fields);
        }
      }

      // Insert env vars
      if (data.envVars && data.envVars.length > 0) {
        const ins = this._db.prepare(
          'INSERT INTO env_vars (file_id, name, access_pattern) VALUES (?,?,?)'
        );
        for (const v of data.envVars) {
          const name = typeof v === 'string' ? v : v.name;
          const pattern = typeof v === 'string' ? null : v.pattern;
          ins.run(fileId, name, pattern);
        }
      }

      // Insert db tables
      if (data.dbTables && data.dbTables.length > 0) {
        const ins = this._db.prepare(
          'INSERT INTO db_tables (file_id, table_name, operation) VALUES (?,?,?)'
        );
        for (const t of data.dbTables) {
          const tableName = t.table || t.table_name || t.name;
          if (!tableName) continue; // skip entries without a table name
          ins.run(fileId, tableName, t.operation || null);
        }
      }

      // Insert extraction errors
      if (data.errors && data.errors.length > 0) {
        const ins = this._db.prepare(
          'INSERT INTO extraction_errors (file_id, phase, error_message, timestamp) VALUES (?,?,?,?)'
        );
        const now = Date.now();
        for (const err of data.errors) {
          if (!err || !err.phase || !err.message) continue;
          // Truncate enormous error messages so a single corrupt file
          // can never bloat the DB. 2KB is plenty for any stack frame
          // we'd surface in `carto check`.
          const msg = String(err.message).slice(0, 2000);
          ins.run(fileId, String(err.phase), msg, now);
        }
      }
    });

    tx();
  }

  // ─── Query methods (for MCP tools) ────────────────────────────────────

  getRoutes() {
    return this._db.prepare(`
      SELECT r.method, r.path, r.handler_name, r.framework, f.path as file
      FROM routes r JOIN files f ON r.file_id = f.id
      ORDER BY r.path
    `).all();
  }

  searchRoutes(query) {
    const pattern = `%${query}%`;
    return this._db.prepare(`
      SELECT r.method, r.path, r.handler_name, r.framework, f.path as file
      FROM routes r JOIN files f ON r.file_id = f.id
      WHERE r.path LIKE ? OR r.method LIKE ?
      ORDER BY r.path
    `).all(pattern, pattern);
  }

  getModels(domainName) {
    if (domainName) {
      return this._db.prepare(`
        SELECT m.name, m.kind, m.fields_json, f.path as file
        FROM models m
        JOIN files f ON m.file_id = f.id
        JOIN domain_assignments da ON da.file_id = f.id
        JOIN domains d ON da.domain_id = d.id
        WHERE d.name = ?
        ORDER BY m.name
      `).all(domainName.toUpperCase());
    }
    return this._db.prepare(`
      SELECT m.name, m.kind, m.fields_json, f.path as file
      FROM models m JOIN files f ON m.file_id = f.id
      ORDER BY m.name
    `).all();
  }

  getEnvVars(domainName) {
    if (domainName) {
      return this._db.prepare(`
        SELECT ev.name, ev.access_pattern, f.path as file
        FROM env_vars ev
        JOIN files f ON ev.file_id = f.id
        JOIN domain_assignments da ON da.file_id = f.id
        JOIN domains d ON da.domain_id = d.id
        WHERE d.name = ?
        ORDER BY ev.name
      `).all(domainName.toUpperCase());
    }
    return this._db.prepare(`
      SELECT ev.name, ev.access_pattern, f.path as file
      FROM env_vars ev JOIN files f ON ev.file_id = f.id
      ORDER BY ev.name
    `).all();
  }

  getHighImpactFiles(limit = 10) {
    return this._db.prepare(`
      SELECT path as file, centrality as dependents
      FROM files
      WHERE centrality > 0
      ORDER BY centrality DESC
      LIMIT ?
    `).all(limit);
  }

  getBlastRadius(relPath, maxHops = 5) {
    const file = this.getFileByPath(relPath);
    if (!file) return null;
    return this._db.prepare(`
      SELECT f.path as file, rd.hop_distance
      FROM reverse_deps rd
      JOIN files f ON rd.dependent_file_id = f.id
      WHERE rd.file_id = ? AND rd.hop_distance <= ?
      ORDER BY rd.hop_distance, f.path
    `).all(file.id, maxHops);
  }

  getNeighbors(relPath, hops = 1) {
    const file = this.getFileByPath(relPath);
    if (!file) return { nodes: [], edges: [] };

    const visited = new Set([file.id]);
    const edges = [];
    let frontier = new Set([file.id]);

    for (let h = 0; h < hops; h++) {
      const next = new Set();
      for (const fid of frontier) {
        // Outgoing imports
        const outgoing = this._db.prepare(
          'SELECT to_file_id FROM imports WHERE from_file_id = ? AND to_file_id IS NOT NULL'
        ).all(fid);
        for (const row of outgoing) {
          edges.push({ source: fid, target: row.to_file_id });
          if (!visited.has(row.to_file_id)) {
            visited.add(row.to_file_id);
            next.add(row.to_file_id);
          }
        }
        // Incoming imports
        const incoming = this._db.prepare(
          'SELECT from_file_id FROM imports WHERE to_file_id = ?'
        ).all(fid);
        for (const row of incoming) {
          edges.push({ source: row.from_file_id, target: fid });
          if (!visited.has(row.from_file_id)) {
            visited.add(row.from_file_id);
            next.add(row.from_file_id);
          }
        }
      }
      if (next.size === 0) break;
      frontier = next;
    }

    // Resolve file paths
    const nodes = [];
    for (const fid of visited) {
      const f = this.getFileById(fid);
      if (f) {
        nodes.push({
          id: f.path,
          label: path.basename(f.path),
          domain: this._getDomainForFileId(fid) || 'CORE',
          isRoot: fid === file.id
        });
      }
    }

    const resolvedEdges = [];
    const seen = new Set();
    for (const e of edges) {
      const sf = this.getFileById(e.source);
      const tf = this.getFileById(e.target);
      if (sf && tf) {
        const key = `${sf.path}->${tf.path}`;
        if (!seen.has(key)) {
          seen.add(key);
          resolvedEdges.push({ id: key, source: sf.path, target: tf.path });
        }
      }
    }

    return { nodes, edges: resolvedEdges };
  }

  getCrossDomainDeps() {
    return this._db.prepare(`
      SELECT
        f1.path as "from", d1.name as fromDomain,
        f2.path as "to", d2.name as toDomain
      FROM imports i
      JOIN files f1 ON i.from_file_id = f1.id
      JOIN files f2 ON i.to_file_id = f2.id
      JOIN domain_assignments da1 ON da1.file_id = f1.id
      JOIN domain_assignments da2 ON da2.file_id = f2.id
      JOIN domains d1 ON da1.domain_id = d1.id
      JOIN domains d2 ON da2.domain_id = d2.id
      WHERE d1.id != d2.id
      ORDER BY d1.name, d2.name
    `).all();
  }

  // ─── Extraction errors ─────────────────────────────────────────────────

  /**
   * getExtractionErrorCount() → integer count of all error rows.
   * Used by `carto init` summary, `carto check`, and MCP get_architecture
   * for a fast "did anything fail?" signal without listing rows.
   */
  getExtractionErrorCount() {
    const row = this._db.prepare('SELECT COUNT(*) as cnt FROM extraction_errors').get();
    return row ? row.cnt : 0;
  }

  /**
   * getExtractionErrorsTopFiles(limit) → [{ file, errorCount, phases, sample }]
   * Aggregates by file. `phases` is a comma-joined list of distinct phase
   * tokens for the file; `sample` is one error_message (the most recent).
   */
  getExtractionErrorsTopFiles(limit = 5) {
    return this._db.prepare(`
      SELECT
        f.path as file,
        COUNT(e.id) as errorCount,
        GROUP_CONCAT(DISTINCT e.phase) as phases,
        (
          SELECT error_message FROM extraction_errors e2
          WHERE e2.file_id = e.file_id
          ORDER BY e2.timestamp DESC, e2.id DESC LIMIT 1
        ) as sample
      FROM extraction_errors e
      JOIN files f ON e.file_id = f.id
      GROUP BY e.file_id
      ORDER BY errorCount DESC, f.path
      LIMIT ?
    `).all(limit);
  }

  /**
   * getExtractionErrorsForFile(relPath) → [{ phase, error_message, timestamp }]
   * Returns all error rows for a single file, newest first.
   */
  getExtractionErrorsForFile(relPath) {
    const file = this.getFileByPath(relPath);
    if (!file) return [];
    return this._db.prepare(`
      SELECT phase, error_message, timestamp
      FROM extraction_errors
      WHERE file_id = ?
      ORDER BY timestamp DESC, id DESC
    `).all(file.id);
  }

  getDomainsList() {
    return this._db.prepare(`
      SELECT d.name, d.file_count as fileCount,
        (SELECT COUNT(*) FROM routes r JOIN files f ON r.file_id = f.id
         JOIN domain_assignments da ON da.file_id = f.id WHERE da.domain_id = d.id) as routeCount,
        (SELECT COUNT(*) FROM models m JOIN files f ON m.file_id = f.id
         JOIN domain_assignments da ON da.file_id = f.id WHERE da.domain_id = d.id) as modelCount
      FROM domains d
      ORDER BY d.file_count DESC
    `).all();
  }

  getDomain(name) {
    const domain = this._db.prepare('SELECT * FROM domains WHERE name = ?').get(name.toUpperCase());
    if (!domain) return null;

    const files = this._db.prepare(`
      SELECT f.path FROM files f
      JOIN domain_assignments da ON da.file_id = f.id
      WHERE da.domain_id = ?
      ORDER BY f.path
    `).all(domain.id).map(r => r.path);

    const routes = this._db.prepare(`
      SELECT r.method, r.path, f.path as file FROM routes r
      JOIN files f ON r.file_id = f.id
      JOIN domain_assignments da ON da.file_id = f.id
      WHERE da.domain_id = ?
    `).all(domain.id);

    const models = this._db.prepare(`
      SELECT m.name, m.kind, m.fields_json, f.path as file FROM models m
      JOIN files f ON m.file_id = f.id
      JOIN domain_assignments da ON da.file_id = f.id
      WHERE da.domain_id = ?
    `).all(domain.id);

    const symbols = this._db.prepare(`
      SELECT s.name, s.kind, f.path as file FROM symbols s
      JOIN files f ON s.file_id = f.id
      JOIN domain_assignments da ON da.file_id = f.id
      WHERE da.domain_id = ? AND s.exported = 1
    `).all(domain.id);

    return { name: domain.name, files, routes, models, symbols, description: domain.description };
  }

  getStructure() {
    const totalFiles = this.getFileCount();
    const totalRoutes = this._db.prepare('SELECT COUNT(*) as cnt FROM routes').get().cnt;
    const totalImports = this._db.prepare('SELECT COUNT(*) as cnt FROM imports').get().cnt;
    const entryPoints = this._db.prepare(
      'SELECT path FROM files WHERE is_entry_point = 1'
    ).all().map(r => r.path);
    const highImpact = this.getHighImpactFiles(15);
    const domains = this._db.prepare('SELECT name FROM domains ORDER BY file_count DESC').all().map(r => r.name);
    const stack = this.getMeta('stack_json');

    return {
      meta: {
        totalFiles,
        totalRoutes,
        totalImportEdges: totalImports,
        lastIndexed: this.getMeta('last_full_sync'),
        indexDuration: parseInt(this.getMeta('index_duration_ms') || '0', 10)
      },
      entryPoints,
      highImpact,
      // Defensive parse — a corrupt stack_json row must never crash callers.
      stack: (() => {
        if (!stack) return [];
        try { return JSON.parse(stack); } catch { return []; }
      })(),
      domains
    };
  }

  getImportGraph() {
    const rows = this._db.prepare(`
      SELECT f1.path as from_path, f2.path as to_path
      FROM imports i
      JOIN files f1 ON i.from_file_id = f1.id
      JOIN files f2 ON i.to_file_id = f2.id
      WHERE i.resolved = 1
    `).all();

    const graph = {};
    for (const row of rows) {
      if (!graph[row.from_path]) graph[row.from_path] = [];
      graph[row.from_path].push(row.to_path);
    }
    return graph;
  }

  // ─── Domain operations ─────────────────────────────────────────────────

  upsertDomain(name, { autoDetected = true, fileCount = 0, description = null } = {}) {
    this._db.prepare(`
      INSERT INTO domains (name, auto_detected, file_count, description)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET file_count=?, description=COALESCE(?, description)
    `).run(name, autoDetected ? 1 : 0, fileCount, description, fileCount, description);
    return this._db.prepare('SELECT id FROM domains WHERE name = ?').get(name).id;
  }

  assignFileToDomain(fileId, domainId, confidence = 1.0) {
    // domain_assignments is the single source of truth. files.domain_id is a
    // denormalized mirror written here in the same call so that every reader —
    // whether it queries domain_assignments (getDomainForFile, getCrossDomainDeps,
    // the bitmap sidecar) or JOINs on files.domain_id (brain/predictive/retrieval
    // SQL) — always sees the same domain for a file. The two can never drift
    // because they are written together and cleared together (see
    // clearDomainAssignments). This is the CF-3 single-source-of-truth fix.
    this._db.prepare(`
      INSERT OR REPLACE INTO domain_assignments (file_id, domain_id, confidence)
      VALUES (?, ?, ?)
    `).run(fileId, domainId, confidence);
    this._db.prepare('UPDATE files SET domain_id = ? WHERE id = ?').run(domainId, fileId);
  }

  clearDomainAssignments() {
    this._db.prepare('DELETE FROM domain_assignments').run();
    this._db.prepare('DELETE FROM domains').run();
    // Reset the denormalized mirror so files that lose an assignment on the
    // next full re-cluster don't retain a stale domain_id.
    this._db.prepare('UPDATE files SET domain_id = NULL').run();
  }

  _getDomainForFileId(fileId) {
    const row = this._db.prepare(`
      SELECT d.name FROM domain_assignments da
      JOIN domains d ON da.domain_id = d.id
      WHERE da.file_id = ?
      ORDER BY da.confidence DESC LIMIT 1
    `).get(fileId);
    return row ? row.name : null;
  }

  getDomainForFile(relPath) {
    const file = this.getFileByPath(relPath);
    if (!file) return null;
    return this._getDomainForFileId(file.id);
  }

  /**
   * getDomainOf(fileIdOrPath) → domain name (string) or null
   *
   * The single canonical accessor every tool should use to answer
   * "what domain is this file in?". Accepts either a numeric file id or a
   * relative path, and always resolves against domain_assignments (the source
   * of truth) so no two tools can disagree. Returns null when the file is
   * unknown or unassigned; callers decide whether to display 'CORE'.
   */
  getDomainOf(fileIdOrPath) {
    if (fileIdOrPath == null) return null;
    if (typeof fileIdOrPath === 'number') {
      return this._getDomainForFileId(fileIdOrPath);
    }
    return this.getDomainForFile(String(fileIdOrPath));
  }

  // ─── Reverse deps (blast radius) ──────────────────────────────────────

  /**
   * resolveUnresolvedImports() → number
   *
   * Post-pass repair for the chicken-and-egg ordering problem during
   * extraction: when file A is processed before file B but imports it,
   * `to_file_id` is null because B isn't yet in the files table. After
   * the full extraction pass completes, every target path that's an
   * indexed file should be resolvable. This single UPDATE catches them.
   *
   * Returns the number of rows newly resolved. Cheap: one UPDATE with a
   * correlated subquery, indexed on imports.to_path implicitly via the
   * files.path uniqueness constraint.
   */
  resolveUnresolvedImports() {
    const before = this._db.prepare(
      'SELECT COUNT(*) AS n FROM imports WHERE to_file_id IS NULL'
    ).get().n;
    if (before === 0) return 0;

    this._db.prepare(`
      UPDATE imports
      SET to_file_id = (SELECT id FROM files WHERE path = imports.to_path),
          resolved = 1
      WHERE to_file_id IS NULL
        AND EXISTS (SELECT 1 FROM files WHERE path = imports.to_path)
    `).run();

    const after = this._db.prepare(
      'SELECT COUNT(*) AS n FROM imports WHERE to_file_id IS NULL'
    ).get().n;
    return before - after;
  }

  computeReverseDeps(maxHops = 5) {
    this._db.prepare('DELETE FROM reverse_deps').run();

    // Build adjacency from imports
    const edges = this._db.prepare(
      'SELECT from_file_id, to_file_id FROM imports WHERE to_file_id IS NOT NULL'
    ).all();

    // reverse map: file -> files that import it (direct dependents)
    const reverseDirect = new Map();
    for (const e of edges) {
      if (!reverseDirect.has(e.to_file_id)) reverseDirect.set(e.to_file_id, []);
      reverseDirect.get(e.to_file_id).push(e.from_file_id);
    }

    // For each file, BFS up to maxHops through reverse edges
    const allFileIds = this._db.prepare('SELECT id FROM files').all().map(r => r.id);
    const ins = this._db.prepare(
      'INSERT OR IGNORE INTO reverse_deps (file_id, dependent_file_id, hop_distance) VALUES (?,?,?)'
    );

    const tx = this._db.transaction(() => {
      for (const fileId of allFileIds) {
        let frontier = new Set(reverseDirect.get(fileId) || []);
        const visited = new Set();

        for (let hop = 1; hop <= maxHops; hop++) {
          const next = new Set();
          for (const depId of frontier) {
            if (visited.has(depId) || depId === fileId) continue;
            visited.add(depId);
            ins.run(fileId, depId, hop);
            // Expand
            const nextDeps = reverseDirect.get(depId) || [];
            for (const nd of nextDeps) {
              if (!visited.has(nd) && nd !== fileId) next.add(nd);
            }
          }
          if (next.size === 0) break;
          frontier = next;
        }
      }
    });
    tx();

    // Update centrality scores
    this._db.exec(`
      UPDATE files SET centrality = (
        SELECT COUNT(DISTINCT dependent_file_id) FROM reverse_deps WHERE file_id = files.id
      )
    `);
  }

  // ─── Episodic Memory ──────────────────────────────────────────────────

  /**
   * getOrCreateActiveSession(clientName, metadata) → { id, started_at, ... }
   *
   * Returns the most recent open session (no `ended_at`) if any exists,
   * otherwise creates a new one. "Active" is loosely defined — sessions
   * stay open until something explicitly calls `endSession`. The MCP
   * server lazily creates a session per process, so a long-lived MCP
   * connection naturally accretes decisions/interventions under one
   * session row.
   *
   * Requires a writable DB connection. Read-only callers should use
   * `getCurrentSession()` (read-only) or pass an explicit session_id.
   */
  getOrCreateActiveSession(clientName = null, metadata = null) {
    const existing = this._db.prepare(
      'SELECT id, started_at, ended_at, client_name, metadata_json FROM ai_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1'
    ).get();
    if (existing) return existing;

    const now = Date.now();
    const metaJson = metadata ? JSON.stringify(metadata) : null;
    const info = this._db.prepare(
      'INSERT INTO ai_sessions (started_at, ended_at, client_name, metadata_json) VALUES (?,?,?,?)'
    ).run(now, null, clientName || null, metaJson);
    return {
      id: info.lastInsertRowid,
      started_at: now,
      ended_at: null,
      client_name: clientName || null,
      metadata_json: metaJson,
    };
  }

  /**
   * getCurrentSession() → row | null
   *
   * Read-only lookup of the most recent active session. Used by the MCP
   * episodic tools to default `session_id` when the caller omits it.
   */
  getCurrentSession() {
    return this._db.prepare(
      'SELECT id, started_at, ended_at, client_name, metadata_json FROM ai_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1'
    ).get() || null;
  }

  /**
   * endSession(sessionId) — stamp `ended_at` so the session stops being
   * "active". Idempotent: re-ending a session is a no-op.
   */
  endSession(sessionId) {
    if (!sessionId) return;
    this._db.prepare(
      'UPDATE ai_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL'
    ).run(Date.now(), sessionId);
  }

  /**
   * recordDecision({sessionId, kind, file, payload}) → id
   *
   * Append-only insert into `decisions`. payload is JSON-serialized
   * (defensively — callers may pass strings, objects, or null). Returns
   * the inserted row id so callers can correlate downstream interventions.
   * Requires a writable connection.
   */
  recordDecision({ sessionId, kind, file, payload }) {
    const ts = Date.now();
    let payloadJson = null;
    if (payload !== undefined && payload !== null) {
      if (typeof payload === 'string') {
        payloadJson = payload;
      } else {
        try { payloadJson = JSON.stringify(payload); } catch { payloadJson = null; }
      }
    }
    const info = this._db.prepare(
      'INSERT INTO decisions (session_id, ts, kind, file, payload_json) VALUES (?,?,?,?,?)'
    ).run(sessionId || null, ts, String(kind), file ? normalizePath(file) : null, payloadJson);
    return info.lastInsertRowid;
  }

  /**
   * recordIntervention({sessionId, kind, file, severity, message}) → id
   *
   * Append-only insert into `interventions`. `accepted` is left NULL —
   * clients that track follow-through update it later. Requires a
   * writable connection.
   */
  recordIntervention({ sessionId, kind, file, severity, message }) {
    const ts = Date.now();
    const info = this._db.prepare(
      'INSERT INTO interventions (session_id, ts, kind, file, severity, message, accepted) VALUES (?,?,?,?,?,?,NULL)'
    ).run(
      sessionId || null,
      ts,
      String(kind),
      file ? normalizePath(file) : null,
      severity ? String(severity) : null,
      message ? String(message).slice(0, 4000) : null
    );
    return info.lastInsertRowid;
  }

  /**
   * getRecentDecisions(timeRangeMs, kind?) → [row, ...]
   *
   * Decisions in the last `timeRangeMs` ms, newest first. Optional
   * `kind` filter (e.g. 'validation'). Read-only.
   */
  getRecentDecisions(timeRangeMs, kind) {
    const since = Date.now() - (timeRangeMs > 0 ? timeRangeMs : 0);
    if (kind) {
      return this._db.prepare(
        'SELECT id, session_id, ts, kind, file, payload_json FROM decisions WHERE ts >= ? AND kind = ? ORDER BY ts DESC, id DESC'
      ).all(since, String(kind));
    }
    return this._db.prepare(
      'SELECT id, session_id, ts, kind, file, payload_json FROM decisions WHERE ts >= ? ORDER BY ts DESC, id DESC'
    ).all(since);
  }

  /**
   * getSessionContext(sessionId) → { session, decisions, interventions } | null
   *
   * Returns full context for a session: the session row plus all its
   * decisions and interventions ordered by timestamp ascending (so a
   * caller can replay the session chronologically). Returns null for
   * unknown ids. Read-only.
   */
  getSessionContext(sessionId) {
    if (!sessionId) return null;
    const session = this._db.prepare(
      'SELECT id, started_at, ended_at, client_name, metadata_json FROM ai_sessions WHERE id = ?'
    ).get(sessionId);
    if (!session) return null;
    const decisions = this._db.prepare(
      'SELECT id, session_id, ts, kind, file, payload_json FROM decisions WHERE session_id = ? ORDER BY ts ASC, id ASC'
    ).all(sessionId);
    const interventions = this._db.prepare(
      'SELECT id, session_id, ts, kind, file, severity, message, accepted FROM interventions WHERE session_id = ? ORDER BY ts ASC, id ASC'
    ).all(sessionId);
    return { session, decisions, interventions };
  }

  /**
   * searchDecisions(topic) → [row, ...]
   *
   * Substring search over decisions: matches `kind`, `file`, or
   * `payload_json`. Case-insensitive (LIKE with lowercase). Newest
   * first. Read-only.
   */
  searchDecisions(topic) {
    if (!topic || typeof topic !== 'string') return [];
    const pattern = `%${topic.toLowerCase()}%`;
    return this._db.prepare(`
      SELECT id, session_id, ts, kind, file, payload_json
      FROM decisions
      WHERE LOWER(kind) LIKE ? OR LOWER(IFNULL(file, '')) LIKE ? OR LOWER(IFNULL(payload_json, '')) LIKE ?
      ORDER BY ts DESC, id DESC
      LIMIT 100
    `).all(pattern, pattern, pattern);
  }

  /**
   * searchInterventions(topic) → [row, ...]
   *
   * Substring search over interventions for `did_we_discuss_this`. Newest
   * first. Read-only.
   */
  searchInterventions(topic) {
    if (!topic || typeof topic !== 'string') return [];
    const pattern = `%${topic.toLowerCase()}%`;
    return this._db.prepare(`
      SELECT id, session_id, ts, kind, file, severity, message, accepted
      FROM interventions
      WHERE LOWER(kind) LIKE ? OR LOWER(IFNULL(file, '')) LIKE ? OR LOWER(IFNULL(message, '')) LIKE ?
      ORDER BY ts DESC, id DESC
      LIMIT 100
    `).all(pattern, pattern, pattern);
  }

  /**
   * getInterventionsForFile(file?) → [row, ...]
   *
   * If `file` provided, returns interventions for that path (normalized).
   * If null/undefined, returns all interventions. Newest first.
   * Read-only.
   */
  getInterventionsForFile(file) {
    if (file) {
      return this._db.prepare(
        'SELECT id, session_id, ts, kind, file, severity, message, accepted FROM interventions WHERE file = ? ORDER BY ts DESC, id DESC LIMIT 200'
      ).all(normalizePath(file));
    }
    return this._db.prepare(
      'SELECT id, session_id, ts, kind, file, severity, message, accepted FROM interventions ORDER BY ts DESC, id DESC LIMIT 200'
    ).all();
  }

  // ─── Rule Engine gaps ─────────────────────────────────────────────────

  /**
   * replaceGaps(newGaps) → { inserted, preserved, removed }
   *
   * The rule engine calls this once per run. Semantics:
   *   - Rows for gaps present in `newGaps` are refreshed (detected_at
   *     bumped). If the same gap_hash was previously dismissed, the
   *     `dismissed` + `reason` fields carry over — dismissals persist
   *     across runs.
   *   - Rows whose gap_hash is NOT in `newGaps` are deleted. Gaps
   *     that no longer fire disappear from the table.
   *
   * `newGaps` is an array of `{ gap_hash, rule_id, file, line,
   * severity, reversibility, concept, evidence }`.
   *
   * Runs in a single transaction. Requires a writable connection.
   */
  replaceGaps(newGaps) {
    if (!Array.isArray(newGaps)) return { inserted: 0, preserved: 0, removed: 0 };
    const now = Date.now();
    let inserted = 0;
    let preserved = 0;
    let removed = 0;

    const tx = this._db.transaction(() => {
      // 1. Snapshot existing dismissals so they survive the rewrite.
      const priorDismissals = new Map();
      const priorRows = this._db.prepare(
        'SELECT gap_hash, dismissed, reason FROM gaps WHERE dismissed = 1'
      ).all();
      for (const r of priorRows) priorDismissals.set(r.gap_hash, { dismissed: r.dismissed, reason: r.reason });

      // 2. Collect surviving hashes.
      const surviving = new Set(newGaps.map((g) => g.gap_hash));

      // 3. Delete rows no longer emitted by the engine.
      const existing = this._db.prepare('SELECT gap_hash FROM gaps').all();
      const del = this._db.prepare('DELETE FROM gaps WHERE gap_hash = ?');
      for (const r of existing) {
        if (!surviving.has(r.gap_hash)) {
          del.run(r.gap_hash);
          removed++;
        }
      }

      // 4. Upsert the new set. Preserve dismissed/reason when the row
      //    was already dismissed.
      const upsert = this._db.prepare(`
        INSERT INTO gaps (gap_hash, rule_id, file, line, severity, reversibility, concept, evidence, detected_at, dismissed, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(gap_hash) DO UPDATE SET
          rule_id = excluded.rule_id,
          file = excluded.file,
          line = excluded.line,
          severity = excluded.severity,
          reversibility = excluded.reversibility,
          concept = excluded.concept,
          evidence = excluded.evidence,
          detected_at = excluded.detected_at
      `);
      for (const g of newGaps) {
        const wasDismissed = priorDismissals.get(g.gap_hash);
        const dismissed = wasDismissed ? 1 : 0;
        const reason = wasDismissed ? wasDismissed.reason : null;
        const info = upsert.run(
          g.gap_hash,
          g.rule_id,
          g.file ? normalizePath(g.file) : null,
          g.line != null ? g.line : null,
          g.severity,
          g.reversibility || null,
          g.concept || null,
          g.evidence || null,
          now,
          dismissed,
          reason
        );
        if (info.changes === 1 && info.lastInsertRowid) {
          if (wasDismissed) preserved++;
          else inserted++;
        }
      }
    });
    tx();
    return { inserted, preserved, removed };
  }

  /**
   * getGaps({ includeDismissed = false, rule_id, file, severity }?) → [row, ...]
   *
   * Read-only. Returns the current gap set, filtered by the given
   * predicates. Dismissed gaps are excluded by default — `get_gaps`
   * surfaces "what still fires and hasn't been intentionally accepted."
   * Ranked by severity (HIGH > MEDIUM > LOW) then by detected_at DESC.
   */
  getGaps(opts = {}) {
    const where = [];
    const params = [];
    if (!opts.includeDismissed) where.push('dismissed = 0');
    if (opts.rule_id) { where.push('rule_id = ?'); params.push(String(opts.rule_id)); }
    if (opts.file) { where.push('file = ?'); params.push(normalizePath(opts.file)); }
    if (opts.severity) { where.push('severity = ?'); params.push(String(opts.severity)); }
    const clause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    return this._db.prepare(`
      SELECT id, gap_hash, rule_id, file, line, severity, reversibility, concept, evidence, detected_at, dismissed, reason
      FROM gaps
      ${clause}
      ORDER BY
        CASE severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 ELSE 3 END,
        detected_at DESC,
        id DESC
    `).all(...params);
  }

  /**
   * getGapByHash(gap_hash) → row | null
   */
  getGapByHash(gap_hash) {
    if (!gap_hash) return null;
    return this._db.prepare(
      'SELECT id, gap_hash, rule_id, file, line, severity, reversibility, concept, evidence, detected_at, dismissed, reason FROM gaps WHERE gap_hash = ?'
    ).get(String(gap_hash)) || null;
  }

  /**
   * dismissGap(gap_hash, reason) → { dismissed: boolean, gap: row | null }
   *
   * Marks a gap as intentionally accepted by the user. Idempotent —
   * re-dismissing the same gap updates the reason and stamps a new
   * timestamp but doesn't create a second row. Requires a writable
   * connection. Returns { dismissed: false, gap: null } if the hash
   * doesn't correspond to a known gap (fresh hashes only enter the
   * table via replaceGaps).
   */
  dismissGap(gap_hash, reason) {
    if (!gap_hash) return { dismissed: false, gap: null };
    const gap = this.getGapByHash(gap_hash);
    if (!gap) return { dismissed: false, gap: null };
    this._db.prepare(
      'UPDATE gaps SET dismissed = 1, reason = ? WHERE gap_hash = ?'
    ).run(reason ? String(reason).slice(0, 2000) : null, String(gap_hash));
    return { dismissed: true, gap: this.getGapByHash(gap_hash) };
  }

  /**
   * countGaps({ includeDismissed = false }?) → { total, bySeverity, byRule }
   */
  countGaps(opts = {}) {
    const clause = opts.includeDismissed ? '' : 'WHERE dismissed = 0';
    const total = this._db.prepare(`SELECT COUNT(*) as n FROM gaps ${clause}`).get().n;
    const bySeverity = {};
    for (const r of this._db.prepare(
      `SELECT severity, COUNT(*) as n FROM gaps ${clause} GROUP BY severity`
    ).all()) {
      bySeverity[r.severity] = r.n;
    }
    const byRule = {};
    for (const r of this._db.prepare(
      `SELECT rule_id, COUNT(*) as n FROM gaps ${clause} GROUP BY rule_id`
    ).all()) {
      byRule[r.rule_id] = r.n;
    }
    return { total, bySeverity, byRule };
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  close() {
    if (this._db) {
      try {
        this._db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {}
      this._db.close();
      this._db = null;
    }
  }

  get db() {
    return this._db;
  }

  /**
   * transaction(fn) — Run fn inside a transaction with retry on SQLITE_BUSY.
   */
  transaction(fn) {
    const tx = this._db.transaction(fn);
    let attempts = 0;
    while (attempts < 3) {
      try {
        return tx();
      } catch (err) {
        if (err.code === 'SQLITE_BUSY' && attempts < 2) {
          attempts++;
          const delay = 100 * Math.pow(2, attempts - 1);
          const end = Date.now() + delay;
          while (Date.now() < end) {} // busy wait (sync)
        } else {
          throw err;
        }
      }
    }
  }
}

module.exports = { SQLiteStore, normalizePath };
