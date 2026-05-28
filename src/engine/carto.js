'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const { loadGraphCache, saveGraphCache, buildEmptyCache } = require('../cache/graph-cache');
const { loadHashes, saveHashes, computeChangedFiles, updateFileHash } = require('../cache/file-hash');
const { applyIncrementalUpdate, removeFileFromGraph, recomputeGraphMetrics } = require('./incremental');
const { WorkerPool } = require('./worker-pool');
const { loadLanguagePlugins, getPluginForFile } = require('../extractors/loader');
const { buildImportGraph } = require('../extractors/imports');
const { buildStackLine } = require('../extractors/stack');
const { getDomainForFile, buildFileAssignments } = require('../agents/domains');
const { extractImports } = require('../extractors/imports');

const plugins = loadLanguagePlugins();

const IGNORE_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', '.next', '.turbo', 'build', 'coverage', '.carto']);
const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.r', '.R', '.prisma', '.html', '.go', '.rb']);

/**
 * Carto — programmatic API for codebase intelligence.
 *
 * Events:
 *   'status'  { state: 'indexing'|'updating'|'ready', progress?: number }
 *   'indexed' { meta }
 *   'updated' { file, blastRadius }
 *
 * Usage:
 *   const { Carto } = require('carto-md');
 *   const carto = new Carto();
 *   await carto.index('/path/to/project');
 *   const ctx = carto.getContextForFile('src/auth/auth.service.ts');
 */
class Carto extends EventEmitter {
  constructor() {
    super();
    this._cache = null;
    this._projectRoot = null;
    this._pool = null;
  }

  // ─── Indexing ────────────────────────────────────────────────────────────

  /**
   * index(projectRoot, { onProgress, useWorkers, force })
   * Full index of a project. Loads from disk cache, only re-parses changed files.
   * Emits 'status' and 'indexed' events.
   */
  async index(projectRoot, { onProgress, useWorkers = true, force = false } = {}) {
    this._projectRoot = projectRoot;
    const start = Date.now();

    this.emit('status', { state: 'indexing', progress: 0 });

    const cartoDir = path.join(projectRoot, '.carto');
    try { fs.mkdirSync(cartoDir, { recursive: true }); } catch {}

    const storedHashes = force ? {} : loadHashes(projectRoot);
    const existingCache = force ? buildEmptyCache() : (loadGraphCache(projectRoot) || buildEmptyCache());

    // Discover all code files
    const allFiles = this._discoverFiles(projectRoot);

    const { changed, hashes: newHashes } = computeChangedFiles(allFiles, storedHashes, projectRoot);
    const changedSet = new Set(changed.map(f => path.relative(projectRoot, f)));

    // Remove stale files from cache
    const currentRel = new Set(allFiles.map(f => path.relative(projectRoot, f)));
    for (const relPath of Object.keys(existingCache.fileData)) {
      if (!currentRel.has(relPath)) {
        delete existingCache.fileData[relPath];
        delete existingCache.importGraph[relPath];
        delete existingCache.routesByFile[relPath];
      }
    }

    this._cache = existingCache;

    if (changed.length > 0) {
      const progress = (pct) => {
        this.emit('status', { state: 'indexing', progress: pct });
        if (onProgress) onProgress(pct);
      };

      if (useWorkers && changed.length > 10) {
        // Parallel parsing via worker threads
        if (!this._pool) this._pool = new WorkerPool();
        const results = await this._pool.processFiles(changed, projectRoot, progress);

        for (const result of results) {
          if (!result) continue;
          const { relPath, imports, ...data } = result;
          this._cache.fileData[relPath] = {
            routes: data.routes,
            models: data.models,
            functions: data.functions,
            envVars: data.envVars,
            dbTables: data.dbTables,
            fetches: data.fetches,
            storageKeys: data.storageKeys,
          };
          if (data.routes.length > 0) {
            this._cache.routesByFile[relPath] = data.routes.map(r => `${r.method} ${r.path}`);
          } else {
            delete this._cache.routesByFile[relPath];
          }
          this._cache.importGraph[relPath] = imports;
        }
      } else {
        // Single-threaded fallback for small change sets
        let done = 0;
        for (const filePath of changed) {
          const relPath = path.relative(projectRoot, filePath);
          let content;
          try { content = fs.readFileSync(filePath, 'utf-8'); } catch { done++; continue; }

          const plugin = getPluginForFile(plugins, filePath);
          if (!plugin) { done++; continue; }

          const extracted = plugin.extract(content, relPath);
          const imports = extractImports(content, filePath, projectRoot);

          this._cache.fileData[relPath] = {
            routes: extracted.routes || [],
            models: extracted.models || [],
            functions: extracted.functions || [],
            envVars: extracted.envVars || [],
            dbTables: (extracted.dbTables || []).map(t => ({ ...t, file: relPath })),
            fetches: extracted.fetches || [],
            storageKeys: extracted.storageKeys || [],
          };
          if ((extracted.routes || []).length > 0) {
            this._cache.routesByFile[relPath] = extracted.routes.map(r => `${r.method} ${r.path}`);
          } else {
            delete this._cache.routesByFile[relPath];
          }
          this._cache.importGraph[relPath] = imports;

          done++;
          if (onProgress) onProgress(Math.round((done / changed.length) * 100));
          this.emit('status', { state: 'indexing', progress: Math.round((done / changed.length) * 100) });
        }
      }
    }

    recomputeGraphMetrics(this._cache);
    this._cache.meta.indexDuration = Date.now() - start;
    this._cache.meta.lastIndexed = new Date().toISOString();
    this._cache.generated = new Date().toISOString();

    saveHashes(projectRoot, newHashes);
    saveGraphCache(projectRoot, this._cache);

    this.emit('status', { state: 'ready' });
    this.emit('indexed', { meta: this._cache.meta });

    return this._cache;
  }

  /**
   * reindex(filePath)
   * Incremental update — re-parses one file, updates graph in ~100ms.
   * Emits 'updated' event.
   */
  async reindex(filePath) {
    this._assertIndexed();
    this.emit('status', { state: 'updating' });

    const relPath = path.relative(this._projectRoot, filePath);
    let content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch {
      this.emit('status', { state: 'ready' });
      return;
    }

    const plugin = getPluginForFile(plugins, filePath);
    if (!plugin) { this.emit('status', { state: 'ready' }); return; }

    const extracted = plugin.extract(content, relPath);
    applyIncrementalUpdate(this._cache, relPath, extracted, content, this._projectRoot);
    this._cache.generated = new Date().toISOString();

    updateFileHash(this._projectRoot, relPath, content);
    saveGraphCache(this._projectRoot, this._cache);

    const blastRadius = this.getBlastRadius(relPath);
    this.emit('status', { state: 'ready' });
    this.emit('updated', { file: relPath, blastRadius });

    return { file: relPath, blastRadius };
  }

  /**
   * removeFile(filePath)
   * Removes a deleted file from the graph.
   */
  removeFile(filePath) {
    this._assertIndexed();
    const relPath = path.relative(this._projectRoot, filePath);
    removeFileFromGraph(this._cache, relPath);
    saveGraphCache(this._projectRoot, this._cache);
  }

  // ─── Query API ───────────────────────────────────────────────────────────

  /**
   * getBlastRadius(file)
   * Returns full impact analysis for a file.
   * {
   *   file, risk, directlyAffected, potentiallyAffected,
   *   routesImpacted [{ method, path, risk }],
   *   domainsImpacted, dependentFiles
   * }
   */
  getBlastRadius(file) {
    this._assertIndexed();
    const relPath = this._resolveFile(file);
    if (!relPath) return null;

    const importGraph = this._cache.importGraph;
    const domains = this._cache.domains || {};

    // Direct dependents (1 hop)
    const directDeps = [];
    for (const [f, deps] of Object.entries(importGraph)) {
      if (deps.includes(relPath)) directDeps.push(f);
    }

    // All transitive dependents (up to 5 hops)
    const allDeps = new Set(directDeps);
    let frontier = new Set(directDeps);
    for (let hop = 0; hop < 4; hop++) {
      const next = new Set();
      for (const [f, deps] of Object.entries(importGraph)) {
        if (allDeps.has(f)) continue;
        for (const dep of deps) {
          if (frontier.has(dep)) { allDeps.add(f); next.add(f); break; }
        }
      }
      if (next.size === 0) break;
      frontier = next;
    }
    allDeps.add(relPath);

    // Routes impacted
    const affectedRoutes = new Set();
    for (const f of allDeps) {
      const fileRoutes = this._cache.routesByFile[f];
      if (fileRoutes) fileRoutes.forEach(r => affectedRoutes.add(r));
    }

    // Risk per route
    const routesImpacted = [...affectedRoutes].sort().map(r => {
      const [method, ...rest] = r.split(' ');
      const routePath = rest.join(' ');
      const isAuth = routePath.includes('auth') || routePath.includes('login') || routePath.includes('session');
      const isPayment = routePath.includes('billing') || routePath.includes('payment') || routePath.includes('checkout');
      const riskLevel = isAuth || isPayment ? 'HIGH' : directDeps.length >= 3 ? 'HIGH' : directDeps.length >= 2 ? 'MEDIUM' : 'LOW';
      return { method, path: routePath, risk: riskLevel };
    });

    // Domains impacted
    const domainsImpacted = new Set();
    const fileDomain = this._getDomainForFile(relPath);
    if (fileDomain) domainsImpacted.add(fileDomain);
    for (const f of allDeps) {
      const d = this._getDomainForFile(f);
      if (d) domainsImpacted.add(d);
    }

    const depCount = directDeps.length;
    const risk = depCount >= 5 ? 'HIGH' : depCount >= 3 ? 'HIGH' : depCount >= 2 ? 'MEDIUM' : depCount >= 1 ? 'LOW' : 'SAFE';

    return {
      file: relPath,
      risk,
      directlyAffected: { files: directDeps.length, domains: domainsImpacted.size },
      potentiallyAffected: { files: allDeps.size - 1, domains: domainsImpacted.size },
      routesImpacted,
      domainsImpacted: [...domainsImpacted],
      dependentFiles: [...allDeps].filter(f => f !== relPath).sort()
    };
  }

  /**
   * getNeighbors(file, hops)
   * Returns import graph neighbors in React Flow compatible format.
   * { nodes: [{ id, label, domain }], edges: [{ id, source, target }] }
   */
  getNeighbors(file, hops = 1) {
    this._assertIndexed();
    const relPath = this._resolveFile(file);
    if (!relPath) return { nodes: [], edges: [] };

    const importGraph = this._cache.importGraph;
    const visited = new Set([relPath]);
    let frontier = new Set([relPath]);

    for (let h = 0; h < hops; h++) {
      const next = new Set();
      for (const f of frontier) {
        // Files this file imports
        for (const dep of (importGraph[f] || [])) {
          if (!visited.has(dep)) { visited.add(dep); next.add(dep); }
        }
        // Files that import this file
        for (const [other, deps] of Object.entries(importGraph)) {
          if (!visited.has(other) && deps.includes(f)) { visited.add(other); next.add(other); }
        }
      }
      if (next.size === 0) break;
      frontier = next;
    }

    const nodes = [...visited].map(f => ({
      id: f,
      label: path.basename(f),
      domain: this._getDomainForFile(f) || 'CORE',
      isRoot: f === relPath
    }));

    const edges = [];
    for (const f of visited) {
      for (const dep of (importGraph[f] || [])) {
        if (visited.has(dep)) {
          edges.push({ id: `${f}->${dep}`, source: f, target: dep });
        }
      }
    }

    return { nodes, edges };
  }

  /**
   * getContextForFile(file)
   * Single call that returns everything Kepler needs for a file.
   */
  getContextForFile(file) {
    this._assertIndexed();
    const relPath = this._resolveFile(file);
    if (!relPath) return null;

    const domain = this._getDomainForFile(relPath);
    const fileData = this._cache.fileData[relPath] || {};
    const blastRadius = this.getBlastRadius(relPath);
    const neighbors = this.getNeighbors(relPath, 2);
    const crossDomain = this.getCrossDomainDeps().filter(d => d.from === relPath || d.to === relPath);

    // Domain context file content
    let domainContext = null;
    if (domain) {
      const ctxPath = path.join(this._projectRoot, '.carto', 'context', `${domain}.md`);
      try { domainContext = fs.readFileSync(ctxPath, 'utf-8'); } catch {}
    }

    return {
      file: relPath,
      domain: domain || 'CORE',
      routes: (this._cache.routesByFile[relPath] || []),
      models: (fileData.models || []).map(m => m.name || m),
      functions: (fileData.functions || []),
      envVars: (fileData.envVars || []),
      blastRadius,
      neighbors,
      crossDomainDeps: crossDomain,
      domainContext,
      meta: {
        importCount: (this._cache.importGraph[relPath] || []).length,
        dependentCount: blastRadius ? blastRadius.directlyAffected.files : 0
      }
    };
  }

  /**
   * getCrossDomainDeps()
   * Returns all import edges that cross domain boundaries.
   * [{ from, fromDomain, to, toDomain }]
   */
  getCrossDomainDeps() {
    this._assertIndexed();
    const results = [];
    for (const [file, deps] of Object.entries(this._cache.importGraph)) {
      const fromDomain = this._getDomainForFile(file);
      for (const dep of deps) {
        const toDomain = this._getDomainForFile(dep);
        if (fromDomain && toDomain && fromDomain !== toDomain) {
          results.push({ from: file, fromDomain, to: dep, toDomain });
        }
      }
    }
    return results;
  }

  /**
   * getHighImpactFiles(n)
   * Top N files by number of dependents (fan-in).
   */
  getHighImpactFiles(n = 10) {
    this._assertIndexed();
    return (this._cache.highImpact || []).slice(0, n);
  }

  /**
   * searchRoutes(query)
   * Search routes by path or method. Case-insensitive.
   * Returns [{ method, path, file }]
   */
  searchRoutes(query) {
    this._assertIndexed();
    const q = query.toLowerCase();
    const results = [];
    for (const [file, routeStrs] of Object.entries(this._cache.routesByFile)) {
      for (const r of routeStrs) {
        if (r.toLowerCase().includes(q)) {
          const [method, ...rest] = r.split(' ');
          results.push({ method, path: rest.join(' '), file });
        }
      }
    }
    return results;
  }

  /**
   * getRoutes()
   * All API routes across the project.
   */
  getRoutes() {
    this._assertIndexed();
    const routes = [];
    for (const [file, routeStrs] of Object.entries(this._cache.routesByFile)) {
      for (const r of routeStrs) {
        const [method, ...rest] = r.split(' ');
        routes.push({ method, path: rest.join(' '), file });
      }
    }
    return routes.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * getStructure()
   * Full graph structure: importGraph, entryPoints, highImpact, stack, meta.
   */
  getStructure() {
    this._assertIndexed();
    return {
      importGraph: this._cache.importGraph,
      entryPoints: this._cache.entryPoints,
      highImpact: this._cache.highImpact,
      stack: this._cache.stack,
      domains: Object.keys(this._cache.domains || {}),
      meta: this._cache.meta
    };
  }

  /**
   * getDomain(name)
   * Returns domain cluster data + context file content.
   */
  getDomain(name) {
    this._assertIndexed();
    const domain = (this._cache.domains || {})[name.toUpperCase()];
    if (!domain) return null;

    let contextContent = null;
    const ctxPath = path.join(this._projectRoot, '.carto', 'context', `${name.toUpperCase()}.md`);
    try { contextContent = fs.readFileSync(ctxPath, 'utf-8'); } catch {}

    return { ...domain, contextContent };
  }

  /**
   * getDomainsList()
   * All detected domains with file counts.
   */
  getDomainsList() {
    this._assertIndexed();
    return Object.entries(this._cache.domains || {}).map(([name, cluster]) => ({
      name,
      fileCount: (cluster.files || []).length,
      routeCount: (cluster.routes || []).length,
      modelCount: (cluster.models || []).length,
    }));
  }

  /**
   * getModels(domain?)
   * All models, optionally filtered by domain.
   */
  getModels(domain) {
    this._assertIndexed();
    const all = [];
    for (const [relPath, data] of Object.entries(this._cache.fileData)) {
      for (const model of (data.models || [])) {
        const fileDomain = this._getDomainForFile(relPath);
        all.push({ ...model, file: relPath, domain: fileDomain || 'CORE' });
      }
    }
    if (domain) return all.filter(m => m.domain === domain.toUpperCase());
    return all;
  }

  /**
   * getEnvVars(domain?)
   * All environment variables, optionally grouped by domain.
   */
  getEnvVars(domain) {
    this._assertIndexed();
    const envMap = new Map();
    for (const [relPath, data] of Object.entries(this._cache.fileData)) {
      const fileDomain = this._getDomainForFile(relPath) || 'CORE';
      for (const v of (data.envVars || [])) {
        if (!envMap.has(v)) envMap.set(v, { name: v, files: [], domains: new Set() });
        envMap.get(v).files.push(relPath);
        envMap.get(v).domains.add(fileDomain);
      }
    }
    const result = [...envMap.values()].map(e => ({
      name: e.name,
      files: e.files,
      domains: [...e.domains]
    })).sort((a, b) => a.name.localeCompare(b.name));

    if (domain) return result.filter(e => e.domains.includes(domain.toUpperCase()));
    return result;
  }

  /**
   * getMeta()
   * Index stats.
   */
  getMeta() {
    this._assertIndexed();
    return this._cache.meta;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  _assertIndexed() {
    if (!this._cache) throw new Error('[Carto] Call index() first.');
  }

  _resolveFile(file) {
    const importGraph = this._cache.importGraph;
    const fileData = this._cache.fileData;
    const allFiles = new Set([...Object.keys(importGraph), ...Object.keys(fileData)]);
    const normalized = file.replace(/\\/g, '/');

    if (allFiles.has(normalized)) return normalized;
    const bySuffix = [...allFiles].filter(f => f.endsWith('/' + normalized) || f === normalized);
    if (bySuffix.length === 1) return bySuffix[0];
    const byBasename = [...allFiles].filter(f => path.basename(f) === path.basename(normalized));
    if (byBasename.length === 1) return byBasename[0];
    return null;
  }

  _getDomainForFile(relPath) {
    const domains = this._cache.domains || {};
    for (const [name, cluster] of Object.entries(domains)) {
      if ((cluster.files || []).includes(relPath)) return name;
    }
    return null;
  }

  _discoverFiles(projectRoot) {
    const results = [];
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && CODE_EXTS.has(path.extname(entry.name).toLowerCase())) {
          results.push(full);
        }
      }
    };
    walk(projectRoot);
    return results;
  }

  terminate() {
    if (this._pool) { this._pool.terminate(); this._pool = null; }
  }
}

module.exports = { Carto };
