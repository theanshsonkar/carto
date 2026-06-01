'use strict';

const fs = require('fs');
const path = require('path');
const { SQLiteStore } = require('./sqlite-store');
const { runSyncV2 } = require('./sync-v2');

/**
 * StoreAdapter — V1-compatible API wrapping SQLiteStore.
 * Drop-in replacement for the V1 Carto class in acp/session.js.
 * tools.js calls the same methods with the same shapes.
 */
class StoreAdapter {
  constructor() {
    this._store = null;
    this._projectRoot = null;
  }

  /**
   * index(projectRoot, opts?)
   * Opens the SQLite DB; runs runSyncV2 if DB is missing.
   * opts.force — re-extract all files
   * opts.writeOutputs — if false, skip AGENTS.md + context file generation (default: false)
   */
  async index(projectRoot, opts = {}) {
    this._projectRoot = projectRoot;
    const dbPath = path.join(projectRoot, '.carto', 'carto.db');
    const dbExists = fs.existsSync(dbPath);

    if (!dbExists || opts.force) {
      await runSyncV2({
        projectRoot,
        output: opts.writeOutputs ? path.resolve(projectRoot, 'AGENTS.md') : null,
      });
    }

    this._store = new SQLiteStore(projectRoot);
    this._store.open();
    return this.getMeta();
  }

  // ─── V1-shaped query API ────────────────────────────────────────────────

  getMeta() {
    const s = this._store.getStructure();
    return s.meta || { totalFiles: 0, totalRoutes: 0, totalImportEdges: 0 };
  }

  getRoutes()           { return this._store.getRoutes(); }
  searchRoutes(q)       { return this._store.searchRoutes(q); }
  getModels(domain)     { return this._store.getModels(domain); }
  getDomainsList()      { return this._store.getDomainsList(); }
  getDomain(name)       { return this._store.getDomain(name); }
  getCrossDomainDeps()  { return this._store.getCrossDomainDeps(); }
  getHighImpactFiles(n) { return this._store.getHighImpactFiles(n); }

  getStructure() {
    return this._store.getStructure();
  }

  getNeighbors(file, hops = 1) {
    return this._store.getNeighbors(file, hops);
  }

  /**
   * getBlastRadius(file) — V1 rich shape:
   *   { file, risk, directlyAffected, potentiallyAffected,
   *     routesImpacted, domainsImpacted, dependentFiles }
   */
  getBlastRadius(file) {
    const radius = this._store.getBlastRadius(file, 5);
    if (!radius) return null;

    const directDeps = radius.filter(r => r.hop_distance === 1).map(r => r.file);
    const allDepFiles = radius.map(r => r.file);

    // Routes impacted
    const allRoutes = this._store.getRoutes();
    const affectedSet = new Set([file, ...allDepFiles]);
    const routesImpacted = allRoutes
      .filter(r => affectedSet.has(r.file))
      .map(r => {
        const isAuth = /auth|login|session/i.test(r.path);
        const isPay = /billing|payment|checkout/i.test(r.path);
        const riskLevel = isAuth || isPay ? 'HIGH'
          : directDeps.length >= 3 ? 'HIGH'
          : directDeps.length >= 2 ? 'MEDIUM' : 'LOW';
        return { method: r.method, path: r.path, risk: riskLevel };
      });

    // Domains impacted
    const domainsImpacted = new Set();
    const fileDomain = this._store.getDomainForFile(file);
    if (fileDomain) domainsImpacted.add(fileDomain);
    for (const f of allDepFiles) {
      const d = this._store.getDomainForFile(f);
      if (d) domainsImpacted.add(d);
    }

    const depCount = directDeps.length;
    const risk = depCount >= 5 ? 'HIGH'
      : depCount >= 3 ? 'HIGH'
      : depCount >= 2 ? 'MEDIUM'
      : depCount >= 1 ? 'LOW' : 'SAFE';

    return {
      file,
      risk,
      directlyAffected: { files: directDeps.length, domains: domainsImpacted.size },
      potentiallyAffected: { files: allDepFiles.length, domains: domainsImpacted.size },
      routesImpacted,
      domainsImpacted: [...domainsImpacted],
      dependentFiles: allDepFiles,
    };
  }

  /**
   * getContextForFile(file) — composed context matching V1 shape.
   */
  getContextForFile(file) {
    const fileRow = this._store.getFileByPath(file);
    if (!fileRow) return null;

    const domain = this._store.getDomainForFile(file) || 'CORE';
    const routes = this._store.getRoutes().filter(r => r.file === file).map(r => `${r.method} ${r.path}`);
    const models = this._store.getModels().filter(m => m.file === file).map(m => m.name);
    const blastRadius = this.getBlastRadius(file);
    const neighbors = this.getNeighbors(file, 2);
    const crossDomain = this._store.getCrossDomainDeps().filter(d => d.from === file || d.to === file);

    let domainContext = null;
    if (domain && this._projectRoot) {
      const ctxPath = path.join(this._projectRoot, '.carto', 'context', `${domain}.md`);
      try { domainContext = fs.readFileSync(ctxPath, 'utf-8'); } catch {}
    }

    return {
      file,
      domain,
      routes,
      models,
      functions: [],
      envVars: [],
      blastRadius,
      neighbors,
      crossDomainDeps: crossDomain,
      domainContext,
      meta: {
        importCount: 0,
        dependentCount: blastRadius ? blastRadius.directlyAffected.files : 0,
      },
    };
  }

  close() {
    if (this._store) { this._store.close(); this._store = null; }
  }

  /**
   * terminate() — alias for close().
   * Kept so the V1-style `Carto` export from index.js (which is now an alias
   * for StoreAdapter) remains fully API-compatible. The V1 Carto class
   * exposed terminate(); legacy programmatic users may still call it.
   * Safe to remove in 3.0.0 along with the Carto alias.
   */
  terminate() { return this.close(); }
}

module.exports = { StoreAdapter };
