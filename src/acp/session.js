'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Carto } = require('../engine/carto');

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
    this.carto = new Carto();

    if (fs.existsSync(dbPath)) {
      // DB exists — just load the index (fast path, <10ms)
      await this.carto.index(this.workingDir);
      this._indexed = true;
      return null;
    }

    // No DB — run full indexing
    const start = Date.now();
    await this.carto.index(this.workingDir, { useWorkers: true });
    this._indexed = true;

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
    this._sessions.delete(id);
  }
}

module.exports = { Session, SessionManager };
