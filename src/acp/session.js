'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { StoreAdapter } = require('../store/store-adapter');

class Session {
  constructor(id, workingDir) {
    this.id = id;
    this.workingDir = workingDir;
    this.history = [];
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
  }

  create(workingDir) {
    const id = crypto.randomBytes(16).toString('hex');
    const dir = workingDir || process.cwd();
    const session = new Session(id, dir);
    this._sessions.set(id, session);
    return session;
  }

  get(id) {
    return this._sessions.get(id) || null;
  }

  delete(id) {
    const s = this._sessions.get(id);
    if (s && s.carto) s.carto.close();
    this._sessions.delete(id);
  }
}

module.exports = { Session, SessionManager };
