'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SCHEMA_VERSION = '1';

class SQLiteStore {
  constructor(projectRoot) {
    this._projectRoot = projectRoot;
    this._db = null;
  }

  /**
   * open() — Opens or creates the database. Applies pragmas and schema.
   */
  open() {
    const cartoDir = path.join(this._projectRoot, '.carto');
    fs.mkdirSync(cartoDir, { recursive: true });

    const dbPath = path.join(cartoDir, 'carto.db');

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
    return this._db.prepare('SELECT * FROM files WHERE path = ?').get(relPath);
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
    const existing = this.getFileByPath(relPath);
    if (existing) {
      this._db.prepare(
        'UPDATE files SET language=?, hash=?, mtime=?, size=?, last_indexed_at=? WHERE id=?'
      ).run(language, hash, mtime, size, Date.now(), existing.id);
      return existing.id;
    }
    const info = this._db.prepare(
      'INSERT INTO files (path, language, hash, mtime, size, last_indexed_at) VALUES (?,?,?,?,?,?)'
    ).run(relPath, language, hash, mtime, size, Date.now());
    return info.lastInsertRowid;
  }

  updateFileMtime(relPath, mtime, size) {
    this._db.prepare(
      'UPDATE files SET mtime=?, size=? WHERE path=?'
    ).run(mtime, size, relPath);
  }

  removeFile(relPath) {
    this._db.prepare('DELETE FROM files WHERE path = ?').run(relPath);
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
          const name = m.name || m.model || (typeof m === 'string' ? m : null);
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
      stack: stack ? JSON.parse(stack) : [],
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
    this._db.prepare(`
      INSERT OR REPLACE INTO domain_assignments (file_id, domain_id, confidence)
      VALUES (?, ?, ?)
    `).run(fileId, domainId, confidence);
  }

  clearDomainAssignments() {
    this._db.prepare('DELETE FROM domain_assignments').run();
    this._db.prepare('DELETE FROM domains').run();
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

  // ─── Reverse deps (blast radius) ──────────────────────────────────────

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

module.exports = { SQLiteStore };
