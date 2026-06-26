'use strict';

/**
 * TemporalStore — `.carto/carto-temporal.db` schema + accessors.
 *
 * The temporal layer turns the index into something that compounds with use:
 *
 *   "AUTH gained 3 cross-domain imports this month, grew 18 files, and
 *    lost stability when payments/billing.ts moved out — and six months
 *    from now will tell you which file historically causes the most
 *    regressions."
 *
 * It lives in a separate SQLite file so that:
 *   - The main `carto.db` stays tight (it's the hot path for every MCP query).
 *   - Temporal storage can grow to tens of MB (a year of XOR deltas) without
 *     dragging on bitmap rebuilds.
 *   - The file is fully optional — Carto runs fine without it.
 *
 * Schema:
 *   - snapshots         one row per `carto sync` snapshot
 *   - file_domains_at   file→domain assignment at each snapshot
 *   - file_churn        per-file commit count + last-modified ts (rolling)
 *   - arch_events       significant architectural events (split, merge, new)
 *   - deltas            XOR'd forward adjacency between consecutive snapshots
 *
 * Properties the tests pin down:
 *   1. Opening readonly never crashes when the file is missing —
 *      `getStoreReadonly()` returns null cleanly.
 *   2. Backfilling tens of thousands of commits never blocks on schema
 *      mutation — `CREATE TABLE IF NOT EXISTS`, WAL mode, bulk inserts in a
 *      single transaction.
 *   3. Snapshot inserts are idempotent on (commit_sha, source) so re-running
 *      `carto temporal init` doesn't duplicate rows.
 *   4. No Carto-specific logic in here — `snapshot.js`, `queries.js`, and
 *      `backfill.js` build on top of this primitive.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = '1';
const TEMPORAL_DB_FILENAME = 'carto-temporal.db';

class TemporalStore {
  constructor(projectRoot) {
    this._projectRoot = projectRoot;
    this._db = null;
  }

  /** Path to the temporal DB file. */
  get dbPath() {
    return path.join(this._projectRoot, '.carto', TEMPORAL_DB_FILENAME);
  }

  /**
   * open(opts) — open or create the temporal DB.
   *
   * Options:
   *   readonly  — open RO; throws if file is missing (use openIfExists for
   *               the graceful path).
   */
  open(opts = {}) {
    const cartoDir = path.join(this._projectRoot, '.carto');

    if (opts.readonly) {
      this._db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
      this._db.pragma('busy_timeout = 5000');
      return this;
    }

    fs.mkdirSync(cartoDir, { recursive: true });
    try {
      this._db = new Database(this.dbPath);
    } catch (err) {
      // Corrupt — recreate
      try { fs.unlinkSync(this.dbPath); } catch {}
      try { fs.unlinkSync(this.dbPath + '-wal'); } catch {}
      try { fs.unlinkSync(this.dbPath + '-shm'); } catch {}
      this._db = new Database(this.dbPath);
    }

    this._db.pragma('journal_mode = WAL');
    this._db.pragma('synchronous = NORMAL');
    this._db.pragma('busy_timeout = 5000');
    this._db.pragma('cache_size = -32000');
    this._ensureSchema();
    return this;
  }

  /** Like open() but returns null if the file is missing or unreadable. */
  static openIfExists(projectRoot, opts = {}) {
    const p = path.join(projectRoot, '.carto', TEMPORAL_DB_FILENAME);
    if (!fs.existsSync(p)) return null;
    try {
      return new TemporalStore(projectRoot).open(opts);
    } catch {
      return null;
    }
  }

  close() {
    if (this._db) {
      try { this._db.close(); } catch {}
      this._db = null;
    }
  }

  get db() { return this._db; }

  _ensureSchema() {
    const cur = this.getMeta('schema_version');
    if (cur === SCHEMA_VERSION) return;

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        commit_sha TEXT,
        source TEXT NOT NULL,
        file_count INTEGER DEFAULT 0,
        edge_count INTEGER DEFAULT 0,
        domain_count INTEGER DEFAULT 0,
        summary_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_snapshots_sha ON snapshots(commit_sha);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_sha_source ON snapshots(commit_sha, source);

      CREATE TABLE IF NOT EXISTS file_domains_at (
        snapshot_id INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        domain_name TEXT,
        PRIMARY KEY (snapshot_id, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_fda_snap ON file_domains_at(snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_fda_path ON file_domains_at(file_path);

      CREATE TABLE IF NOT EXISTS file_churn (
        file_path TEXT PRIMARY KEY,
        commit_count INTEGER DEFAULT 0,
        first_seen_ts INTEGER,
        last_modified_ts INTEGER,
        blast_radius INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_churn_count ON file_churn(commit_count DESC);
      CREATE INDEX IF NOT EXISTS idx_churn_last ON file_churn(last_modified_ts DESC);

      CREATE TABLE IF NOT EXISTS arch_events (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        severity TEXT NOT NULL,
        kind TEXT NOT NULL,
        domain TEXT,
        file_path TEXT,
        detail_json TEXT,
        snapshot_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON arch_events(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_events_kind ON arch_events(kind);
      CREATE INDEX IF NOT EXISTS idx_events_severity ON arch_events(severity);

      CREATE TABLE IF NOT EXISTS deltas (
        id INTEGER PRIMARY KEY,
        snapshot_id INTEGER NOT NULL,
        prev_snapshot_id INTEGER,
        kind TEXT NOT NULL,
        delta_blob BLOB NOT NULL,
        bit_size INTEGER NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id)
      );
      CREATE INDEX IF NOT EXISTS idx_deltas_snap ON deltas(snapshot_id);
    `);

    this.setMeta('schema_version', SCHEMA_VERSION);
    this.setMeta('created_at', String(Date.now()));
  }

  // ── Meta helpers ──────────────────────────────────────────────────
  getMeta(key) {
    if (!this._db) return null;
    try {
      const row = this._db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get(key);
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  setMeta(key, value) {
    if (!this._db) return;
    this._db
      .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  // ── Snapshot writes ───────────────────────────────────────────────
  /**
   * insertSnapshot({ ts, commit_sha, source, summary }) → snapshot_id
   *
   * `source` is one of:
   *   - 'sync'      — captured after a successful `carto sync`
   *   - 'commit'    — backfilled from a git commit
   *   - 'backfill'  — explicit `carto temporal init` row
   *
   * Idempotent on (commit_sha, source). If a row with the same SHA + source
   * already exists, the original id is returned (no update; snapshots are
   * historical facts).
   */
  insertSnapshot({ ts, commit_sha = null, source, summary = null }) {
    if (!this._db) throw new Error('insertSnapshot: store not open');
    const summaryJson = summary ? JSON.stringify(summary) : null;
    const fileCount = summary && Number.isFinite(summary.file_count) ? summary.file_count : 0;
    const edgeCount = summary && Number.isFinite(summary.edge_count) ? summary.edge_count : 0;
    const domainCount = summary && Number.isFinite(summary.domain_count) ? summary.domain_count : 0;

    if (commit_sha) {
      const existing = this._db
        .prepare('SELECT id FROM snapshots WHERE commit_sha = ? AND source = ?')
        .get(commit_sha, source);
      if (existing) return existing.id;
    }

    const info = this._db
      .prepare(`
        INSERT INTO snapshots (ts, commit_sha, source, file_count, edge_count, domain_count, summary_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(ts, commit_sha, source, fileCount, edgeCount, domainCount, summaryJson);
    return info.lastInsertRowid;
  }

  /** Bulk insert file→domain mappings for a snapshot. */
  insertFileDomains(snapshotId, mappings) {
    if (!this._db || !mappings || mappings.length === 0) return;
    const stmt = this._db.prepare(
      'INSERT OR REPLACE INTO file_domains_at (snapshot_id, file_path, domain_name) VALUES (?, ?, ?)'
    );
    const tx = this._db.transaction(() => {
      for (const m of mappings) stmt.run(snapshotId, m.file_path, m.domain_name || null);
    });
    tx();
  }

  /**
   * recordCommitChurn(commitTs, changedFiles)
   *
   * Records that `changedFiles` were modified at `commitTs`. Increments
   * commit_count, sets first_seen_ts (if not set), updates last_modified_ts.
   * Used by `carto temporal init` to build the churn table.
   */
  recordCommitChurn(commitTs, changedFiles) {
    if (!this._db || !Array.isArray(changedFiles) || changedFiles.length === 0) return;
    const stmt = this._db.prepare(`
      INSERT INTO file_churn (file_path, commit_count, first_seen_ts, last_modified_ts)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        commit_count = commit_count + 1,
        first_seen_ts = MIN(first_seen_ts, excluded.first_seen_ts),
        last_modified_ts = MAX(last_modified_ts, excluded.last_modified_ts)
    `);
    const tx = this._db.transaction(() => {
      for (const f of changedFiles) {
        if (typeof f === 'string' && f.length > 0) {
          stmt.run(f, commitTs, commitTs);
        }
      }
    });
    tx();
  }

  /** Replace blast_radius column on file_churn. Idempotent. */
  updateBlastRadii(map) {
    if (!this._db || !map) return;
    const stmt = this._db.prepare(
      'UPDATE file_churn SET blast_radius = ? WHERE file_path = ?'
    );
    const tx = this._db.transaction(() => {
      for (const [filePath, radius] of map) {
        stmt.run(Number.isFinite(radius) ? radius : 0, filePath);
      }
    });
    tx();
  }

  /** Insert an architectural event. */
  insertEvent({ ts, severity, kind, domain = null, file_path = null, detail = null, snapshot_id = null }) {
    if (!this._db) return;
    const detailJson = detail ? JSON.stringify(detail) : null;
    this._db.prepare(`
      INSERT INTO arch_events (ts, severity, kind, domain, file_path, detail_json, snapshot_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(ts, severity, kind, domain, file_path, detailJson, snapshot_id);
  }

  /** Insert XOR delta blob. */
  insertDelta(snapshotId, prevSnapshotId, kind, deltaBlob, bitSize) {
    if (!this._db) return;
    this._db.prepare(`
      INSERT INTO deltas (snapshot_id, prev_snapshot_id, kind, delta_blob, bit_size)
      VALUES (?, ?, ?, ?, ?)
    `).run(snapshotId, prevSnapshotId, kind, deltaBlob, bitSize);
  }

  // ── Reads ─────────────────────────────────────────────────────────
  getMostRecentSnapshot(source = null) {
    if (!this._db) return null;
    const sql = source
      ? 'SELECT * FROM snapshots WHERE source = ? ORDER BY ts DESC LIMIT 1'
      : 'SELECT * FROM snapshots ORDER BY ts DESC LIMIT 1';
    return source ? this._db.prepare(sql).get(source) : this._db.prepare(sql).get();
  }

  /** Get snapshots between two timestamps. */
  getSnapshotsBetween(startTs, endTs) {
    if (!this._db) return [];
    return this._db
      .prepare('SELECT * FROM snapshots WHERE ts >= ? AND ts <= ? ORDER BY ts ASC')
      .all(startTs, endTs);
  }

  getSnapshotById(id) {
    if (!this._db) return null;
    return this._db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id);
  }

  getFileDomainsAt(snapshotId) {
    if (!this._db) return [];
    return this._db
      .prepare('SELECT file_path, domain_name FROM file_domains_at WHERE snapshot_id = ?')
      .all(snapshotId);
  }

  getFileChurn(filePath) {
    if (!this._db) return null;
    return this._db.prepare('SELECT * FROM file_churn WHERE file_path = ?').get(filePath);
  }

  getTopChurned(limit = 20, sinceTs = null) {
    if (!this._db) return [];
    if (sinceTs) {
      return this._db.prepare(`
        SELECT * FROM file_churn
        WHERE last_modified_ts >= ?
        ORDER BY commit_count DESC, blast_radius DESC
        LIMIT ?
      `).all(sinceTs, limit);
    }
    return this._db.prepare(`
      SELECT * FROM file_churn
      ORDER BY commit_count DESC, blast_radius DESC
      LIMIT ?
    `).all(limit);
  }

  /** All churn rows (used by hotspot queries). */
  getAllChurn() {
    if (!this._db) return [];
    return this._db.prepare('SELECT * FROM file_churn').all();
  }

  getArchEvents({ severity = null, sinceTs = null, kind = null, limit = 100 } = {}) {
    if (!this._db) return [];
    const where = [];
    const args = [];
    if (severity) { where.push('severity = ?'); args.push(severity); }
    if (kind) { where.push('kind = ?'); args.push(kind); }
    if (sinceTs) { where.push('ts >= ?'); args.push(sinceTs); }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    return this._db.prepare(
      `SELECT * FROM arch_events ${whereSql} ORDER BY ts DESC LIMIT ?`
    ).all(...args, limit);
  }

  countSnapshots() {
    if (!this._db) return 0;
    const r = this._db.prepare('SELECT COUNT(*) as c FROM snapshots').get();
    return r ? r.c : 0;
  }

  countCommits() {
    if (!this._db) return 0;
    const r = this._db.prepare(
      "SELECT COUNT(*) as c FROM snapshots WHERE source = 'commit'"
    ).get();
    return r ? r.c : 0;
  }
}

module.exports = {
  TemporalStore,
  SCHEMA_VERSION,
  TEMPORAL_DB_FILENAME,
};
