'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { StoreAdapter } = require('../store/store-adapter');
const { AcpStore } = require('./persistence');

class Session {
  constructor(id, workingDir) {
    this.id = id;
    this.workingDir = workingDir;
    this.history = [];
    this.metadata = null;
    this.createdAt = Date.now();
    this.abortController = null;
    this.carto = null;
    this._indexed = false;
  }

  /**
   * ensureIndexed() — Auto-indexes the project if .carto/carto.db is missing.
   * Returns a status message if indexing was performed, null otherwise.
   */
  async ensureIndexed() {
    if (this._indexed) return null;

    const dbPath = path.join(this.workingDir, '.carto', 'carto.db');
    const wasIndexed = fs.existsSync(dbPath);

    this.carto = new StoreAdapter();
    const start = Date.now();
    await this.carto.index(this.workingDir, { writeOutputs: false });
    this._indexed = true;

    if (wasIndexed) return null;

    // Fresh index — surface status message
    const meta = this.carto.getMeta();
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    const domains = this.carto.getDomainsList();
    const routes = this.carto.getRoutes();

    return `✓ Indexed project in ${duration}s — ${meta.totalFiles || 0} files, ${routes.length} routes, ${domains.length} domains detected.\n\n`;
  }
}

class SessionManager {
  constructor() {
    this._sessions = new Map();
    // Lazy-open AcpStores per workingDir so we don't pay startup cost
    // when persistence isn't actually used.
    this._stores = new Map();
  }

  _storeFor(workingDir) {
    if (!workingDir) return null;
    if (this._stores.has(workingDir)) return this._stores.get(workingDir);
    try {
      const store = new AcpStore(workingDir).open();
      this._stores.set(workingDir, store);
      return store;
    } catch {
      this._stores.set(workingDir, null);
      return null;
    }
  }

  create(workingDir) {
    const id = crypto.randomBytes(16).toString('hex');
    const dir = workingDir || process.cwd();
    const session = new Session(id, dir);
    this._sessions.set(id, session);
    return session;
  }

  /**
   * persist(session) — write session history + metadata to disk. Called
   * after each prompt completion so an editor restart never loses
   * conversation context.
   */
  persist(session) {
    if (!session || !session.workingDir) return;
    const store = this._storeFor(session.workingDir);
    if (!store) return;
    try { store.saveSession(session); } catch {}
  }

  /**
   * resume(id, workingDir) — load a session from disk into memory. Used
   * by `loadSession` ACP method (when capability is enabled) or by a
   * client passing a known session id at startup.
   */
  resume(id, workingDir) {
    if (!id || !workingDir) return null;
    const store = this._storeFor(workingDir);
    if (!store) return null;
    const row = store.loadSession(id);
    if (!row) return null;
    const session = new Session(id, row.workingDir);
    session.history = row.history || [];
    session.metadata = row.metadata || null;
    session.createdAt = row.createdAt || Date.now();
    this._sessions.set(id, session);
    return session;
  }

  /**
   * list({ workingDir }) — list persisted sessions for a working directory.
   */
  list(workingDir) {
    if (!workingDir) return [];
    const store = this._storeFor(workingDir);
    if (!store) return [];
    try { return store.listSessions(); } catch { return []; }
  }

  get(id) {
    return this._sessions.get(id) || null;
  }

  delete(id) {
    const s = this._sessions.get(id);
    if (s && s.carto) s.carto.close();
    this._sessions.delete(id);
  }

  closeAll() {
    for (const s of this._sessions.values()) {
      if (s && s.carto) {
        try { s.carto.close(); } catch {}
      }
    }
    this._sessions.clear();
    for (const store of this._stores.values()) {
      if (store) { try { store.close(); } catch {} }
    }
    this._stores.clear();
  }
}

module.exports = { Session, SessionManager };
