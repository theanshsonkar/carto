'use strict';

/**
 * ACP session persistence.
 *
 * ACP sessions survive `carto agent` restart. We persist:
 *   - session id, working_dir, created_at, updated_at
 *   - conversation history (serialized JSON)
 *   - optional metadata (client info, etc.)
 *
 * Storage lives in `.carto/acp-sessions.db` — a separate SQLite file so it
 * doesn't bloat the hot index. Each agent process opens its own connection
 * (WAL mode handles concurrent reads + serialized writes).
 *
 * Privacy: API keys are NEVER persisted. The provider config file
 * (`agent-config.json`) and this session DB both omit them. Keys come from
 * the environment / IDE settings at agent-start time.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = '1';
const ACP_DB_FILENAME = 'acp-sessions.db';

class AcpStore {
  constructor(projectRoot) {
    this._projectRoot = projectRoot;
    this._db = null;
  }

  get dbPath() {
    return path.join(this._projectRoot, '.carto', ACP_DB_FILENAME);
  }

  open() {
    const cartoDir = path.join(this._projectRoot, '.carto');
    fs.mkdirSync(cartoDir, { recursive: true });
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

  static openIfExists(projectRoot) {
    const p = path.join(projectRoot, '.carto', ACP_DB_FILENAME);
    if (!fs.existsSync(p)) return null;
    try { return new AcpStore(projectRoot).open(); } catch { return null; }
  }

  close() {
    if (this._db) { try { this._db.close(); } catch {} this._db = null; }
  }

  get db() { return this._db; }

  _ensureSchema() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS acp_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS acp_sessions (
        id TEXT PRIMARY KEY,
        working_dir TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        history_json TEXT,
        metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_acp_updated ON acp_sessions(updated_at DESC);
    `);
    const row = this._db.prepare('SELECT value FROM acp_meta WHERE key = ?').get('schema_version');
    if (!row) {
      this._db.prepare('INSERT INTO acp_meta(key, value) VALUES(?, ?)').run('schema_version', SCHEMA_VERSION);
    }
  }

  /**
   * saveSession(session) — serializes Session.history + metadata.
   *
   * `session` is the in-memory Session object. We pluck only the fields
   * safe to persist; abortController, carto instance, providers are
   * runtime-only.
   */
  saveSession(session) {
    if (!this._db) return;
    if (!session || !session.id) return;
    const now = Date.now();
    const history = JSON.stringify(session.history || []);
    const metadata = JSON.stringify(session.metadata || null);
    this._db.prepare(`
      INSERT INTO acp_sessions (id, working_dir, created_at, updated_at, history_json, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        working_dir = excluded.working_dir,
        updated_at = excluded.updated_at,
        history_json = excluded.history_json,
        metadata_json = excluded.metadata_json
    `).run(session.id, session.workingDir, session.createdAt || now, now, history, metadata);
  }

  loadSession(id) {
    if (!this._db || !id) return null;
    const row = this._db.prepare('SELECT * FROM acp_sessions WHERE id = ?').get(id);
    if (!row) return null;
    let history = [];
    let metadata = null;
    try { history = JSON.parse(row.history_json || '[]'); } catch {}
    try { metadata = JSON.parse(row.metadata_json || 'null'); } catch {}
    return {
      id: row.id,
      workingDir: row.working_dir,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      history,
      metadata,
    };
  }

  listSessions({ limit = 50 } = {}) {
    if (!this._db) return [];
    return this._db.prepare(`
      SELECT id, working_dir, created_at, updated_at,
             (SELECT json_array_length(history_json) FROM acp_sessions s2 WHERE s2.id = acp_sessions.id) as msg_count
      FROM acp_sessions
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT ?
    `).all(limit);
  }

  deleteSession(id) {
    if (!this._db || !id) return;
    this._db.prepare('DELETE FROM acp_sessions WHERE id = ?').run(id);
  }
}

module.exports = { AcpStore, ACP_DB_FILENAME };
