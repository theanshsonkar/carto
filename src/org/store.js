'use strict';

/**
 * OrgStore — `~/.carto/org.db` for cross-repo Carto data.
 *
 * Shared SQLite for polyrepo / monorepo-of-monorepos setups. Lives in the
 * user's home directory so multiple projects in `carto org` can reference
 * the same federated dataset.
 *
 * Two tables:
 *   - `repos`              registered repos (one row per `carto org add`)
 *   - `cross_repo_edges`   detected edges (npm, pypi, go-mod, maven, grpc,
 *                          openapi, db-table)
 *
 * Concurrency: WAL mode. Multiple `carto org sync` calls in parallel
 * serialize on the SQLite busy_timeout.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ORG_DB_FILENAME = 'org.db';
const SCHEMA_VERSION = '1';

function defaultOrgDbDir() {
  return path.join(os.homedir(), '.carto');
}

class OrgStore {
  constructor(orgDir = defaultOrgDbDir()) {
    this._dir = orgDir;
    this._db = null;
  }

  get dbPath() { return path.join(this._dir, ORG_DB_FILENAME); }

  open() {
    fs.mkdirSync(this._dir, { recursive: true });
    try {
      this._db = new Database(this.dbPath);
    } catch {
      try { fs.unlinkSync(this.dbPath); } catch {}
      this._db = new Database(this.dbPath);
    }
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('synchronous = NORMAL');
    this._db.pragma('busy_timeout = 5000');
    this._ensureSchema();
    return this;
  }

  static openIfExists(orgDir = defaultOrgDbDir()) {
    const p = path.join(orgDir, ORG_DB_FILENAME);
    if (!fs.existsSync(p)) return null;
    try { return new OrgStore(orgDir).open(); } catch { return null; }
  }

  close() {
    if (this._db) { try { this._db.close(); } catch {} this._db = null; }
  }

  get db() { return this._db; }

  _ensureSchema() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS org_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS repos (
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        root_path TEXT NOT NULL,
        carto_db_path TEXT,
        added_at INTEGER,
        last_sync_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_repos_name ON repos(name);

      CREATE TABLE IF NOT EXISTS cross_repo_edges (
        id INTEGER PRIMARY KEY,
        from_repo TEXT NOT NULL,
        to_repo TEXT,
        edge_kind TEXT NOT NULL,
        from_file TEXT,
        target TEXT,
        detail_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_edge_from_repo ON cross_repo_edges(from_repo);
      CREATE INDEX IF NOT EXISTS idx_edge_to_repo ON cross_repo_edges(to_repo);
      CREATE INDEX IF NOT EXISTS idx_edge_kind ON cross_repo_edges(edge_kind);
      CREATE INDEX IF NOT EXISTS idx_edge_target ON cross_repo_edges(target);
    `);
    const row = this._db.prepare('SELECT value FROM org_meta WHERE key = ?').get('schema_version');
    if (!row) this._db.prepare('INSERT INTO org_meta(key, value) VALUES(?, ?)').run('schema_version', SCHEMA_VERSION);
  }

  addRepo({ name, rootPath, cartoDbPath = null }) {
    if (!name || !rootPath) throw new Error('addRepo: name and rootPath required');
    const now = Date.now();
    try {
      this._db.prepare(`
        INSERT INTO repos (name, root_path, carto_db_path, added_at)
        VALUES (?, ?, ?, ?)
      `).run(name, rootPath, cartoDbPath, now);
      return { name, rootPath, added_at: now };
    } catch (err) {
      if (/UNIQUE/.test(err.message)) {
        this._db.prepare(`
          UPDATE repos SET root_path = ?, carto_db_path = ? WHERE name = ?
        `).run(rootPath, cartoDbPath, name);
        return { name, rootPath, updated: true };
      }
      throw err;
    }
  }

  removeRepo(name) {
    this._db.prepare('DELETE FROM repos WHERE name = ?').run(name);
    this._db.prepare('DELETE FROM cross_repo_edges WHERE from_repo = ? OR to_repo = ?').run(name, name);
  }

  listRepos() {
    return this._db.prepare('SELECT * FROM repos ORDER BY name ASC').all();
  }

  getRepo(name) {
    return this._db.prepare('SELECT * FROM repos WHERE name = ?').get(name);
  }

  /**
   * insertEdges(repoName, edges) — bulk insert. Each edge:
   *   { edge_kind, from_file?, target, to_repo?, detail? }
   *
   * Replaces all existing edges where `from_repo = repoName` first so
   * re-syncing a repo doesn't accumulate stale edges.
   */
  insertEdges(repoName, edges) {
    const tx = this._db.transaction(() => {
      this._db.prepare('DELETE FROM cross_repo_edges WHERE from_repo = ?').run(repoName);
      const stmt = this._db.prepare(`
        INSERT INTO cross_repo_edges (from_repo, to_repo, edge_kind, from_file, target, detail_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const e of edges || []) {
        stmt.run(
          repoName,
          e.to_repo || null,
          e.edge_kind,
          e.from_file || null,
          e.target,
          e.detail ? JSON.stringify(e.detail) : null,
        );
      }
      this._db.prepare('UPDATE repos SET last_sync_at = ? WHERE name = ?').run(Date.now(), repoName);
    });
    tx();
  }

  getEdges({ from_repo = null, to_repo = null, edge_kind = null } = {}) {
    const where = [];
    const args = [];
    if (from_repo) { where.push('from_repo = ?'); args.push(from_repo); }
    if (to_repo)   { where.push('to_repo = ?'); args.push(to_repo); }
    if (edge_kind) { where.push('edge_kind = ?'); args.push(edge_kind); }
    const w = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    return this._db.prepare(`SELECT * FROM cross_repo_edges ${w} ORDER BY edge_kind, target`).all(...args);
  }
}

module.exports = { OrgStore, ORG_DB_FILENAME, defaultOrgDbDir };
