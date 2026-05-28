'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { SQLiteStore } = require('./sqlite-store');
const { migrateFromJsonBlobs } = require('./migrate');
const { detectChangedFiles, hashFile, hashContent } = require('./change-detector');
const { loadLanguagePlugins, getPluginForFile } = require('../extractors/loader');
const { extractImports } = require('../extractors/imports');
const { buildStackLine } = require('../extractors/stack');
const { clusterByDomain } = require('../agents/domains');
const { clusterByGraph } = require('../agents/leiden');
const { formatSections, formatDomainFile } = require('../agents/formatter');
const { mergeIntoAgentsMd } = require('../agents/merger');
const { WorkerPool, POOL_SIZE } = require('../engine/worker-pool');
const { parseCartoIgnore } = require('../security/ignore');

const plugins = loadLanguagePlugins();

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv',
  'dist', '.next', '.turbo', 'build', 'coverage', '.carto',
  'out', '.cache', 'generated', '__generated__',
  'storybook-static', 'public', 'static',
  'tmp-bench', 'vendor', 'third_party', '.yarn'
]);

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.r', '.R', '.prisma', '.html', '.go', '.rb',
  '.rs', '.java', '.cs', '.cpp', '.cc', '.cxx', '.h', '.hpp',
  '.swift', '.kt'
]);

/**
 * discoverFiles(projectRoot)
 * Recursively walks the project tree. No file cap. Respects ignore dirs + .cartoignore.
 * Returns array of relative paths.
 */
function discoverFiles(projectRoot) {
  const isIgnored = parseCartoIgnore(projectRoot);
  const results = [];

  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(projectRoot, full);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXTS.has(ext) && !isIgnored(rel)) {
          results.push(rel);
        }
      }
    }
  };
  walk(projectRoot);
  return results;
}

/**
 * extractFile(relPath, projectRoot)
 * Extracts all data from a single file. Returns extraction result or null.
 */
function extractFile(relPath, projectRoot) {
  const fullPath = path.resolve(projectRoot, relPath);
  const fileResult = hashFile(fullPath);
  if (!fileResult) return null;

  const { content, hash } = fileResult;
  const plugin = getPluginForFile(plugins, fullPath);

  let extracted = { routes: [], models: [], functions: [], envVars: [], dbTables: [], fetches: [], storageKeys: [] };
  if (plugin) {
    try {
      extracted = plugin.extract(content, relPath);
    } catch (err) {
      console.warn(`[CARTO] Extraction error for ${relPath}: ${err.message}`);
    }
  }

  // Extract imports
  let imports = [];
  try {
    imports = extractImports(content, fullPath, projectRoot);
  } catch {}

  const stat = fs.statSync(fullPath);

  return {
    relPath,
    hash,
    mtime: Math.floor(stat.mtimeMs),
    size: stat.size,
    language: detectLanguage(path.extname(relPath).toLowerCase()),
    content,
    extracted,
    imports
  };
}

/**
 * runSyncV2(config)
 *
 * The V2 sync pipeline:
 * 1. Open/create SQLite DB
 * 2. Migrate from JSON blobs if needed
 * 3. Discover all files (no cap)
 * 4. Detect changes via mtime+size then hash
 * 5. Extract changed files (parallel if >10)
 * 6. Store in SQLite
 * 7. Compute reverse deps + domains
 * 8. Generate outputs (AGENTS.md, context files, map.json compat)
 */
async function runSyncV2(config) {
  const startTime = Date.now();
  const projectRoot = config.projectRoot || process.cwd();

  // 1. Open SQLite
  const store = new SQLiteStore(projectRoot);
  store.open();

  // 2. Migrate if needed
  migrateFromJsonBlobs(store, projectRoot);

  // 3. Discover all files (NO smartSelect, NO cap)
  const allFiles = discoverFiles(projectRoot);
  console.log(`[CARTO] Discovered ${allFiles.length} source files`);

  // Remove stale files from DB
  const removed = store.removeStaleFiles(allFiles);
  if (removed > 0) console.log(`[CARTO] Removed ${removed} stale files from index`);

  // 4. Detect changes
  const { changed, newFiles } = detectChangedFiles(store, allFiles, projectRoot);
  const toProcess = [...changed, ...newFiles];

  const cached = allFiles.length - toProcess.length;
  if (cached > 0) {
    console.log(`[CARTO] Cache: ${cached} files unchanged, ${toProcess.length} to process`);
  }

  // 5. Extract files (parallel via worker pool if >10 files)
  if (toProcess.length > 0) {
    const total = toProcess.length;

    if (toProcess.length > 10) {
      // Parallel extraction via worker pool
      const pool = new WorkerPool();
      const absolutePaths = toProcess.map(rel => path.resolve(projectRoot, rel));

      let done = 0;
      const onProgress = () => {
        done++;
        if (done % 100 === 0 || done === total) {
          const pct = Math.round((done / total) * 100);
          process.stdout.write(`\r[CARTO] Extracting: ${pct}% (${done}/${total})`);
        }
      };

      const results = await pool.processFiles(absolutePaths, projectRoot, onProgress);
      process.stdout.write('\n');
      pool.terminate();

      // 6. Batch write all results to SQLite in a single transaction
      const batchTx = store.db.transaction(() => {
        for (const result of results) {
          if (!result) continue;
          const { relPath, routes, models, functions, envVars, dbTables, imports } = result;

          const stat = (() => {
            try { return fs.statSync(path.resolve(projectRoot, relPath)); } catch { return null; }
          })();
          const fullPath = path.resolve(projectRoot, relPath);
          const content = (() => {
            try { return fs.readFileSync(fullPath, 'utf-8'); } catch { return ''; }
          })();
          const hash = hashContent(content);

          const fileId = store.upsertFile(relPath, {
            language: detectLanguage(path.extname(relPath).toLowerCase()),
            hash,
            mtime: stat ? Math.floor(stat.mtimeMs) : null,
            size: stat ? stat.size : null
          });

          const resolvedImports = (imports || []).map(impPath => {
            const resolved = store.getFileByPath(impPath);
            return { path: impPath, resolvedFileId: resolved ? resolved.id : null };
          });

          const symbols = (functions || []).map(name => ({
            name: typeof name === 'string' ? name : name.name || 'unknown',
            kind: 'function',
            exported: true
          }));

          store.storeExtraction(fileId, {
            imports: resolvedImports,
            symbols,
            routes: routes || [],
            models: models || [],
            envVars: envVars || [],
            dbTables: (dbTables || []).map(t => ({ table: t.table || t.table_name || t.name, operation: t.operation }))
          });
        }
      });
      batchTx();

    } else {
      // Single-threaded for small change sets (avoids worker overhead)
      let done = 0;
      for (const relPath of toProcess) {
        const result = extractFile(relPath, projectRoot);
        if (!result) { done++; continue; }

        const fileId = store.upsertFile(relPath, {
          language: result.language,
          hash: result.hash,
          mtime: result.mtime,
          size: result.size
        });

        const resolvedImports = (result.imports || []).map(impPath => {
          const resolved = store.getFileByPath(impPath);
          return { path: impPath, resolvedFileId: resolved ? resolved.id : null };
        });

        const symbols = (result.extracted.functions || []).map(name => ({
          name: typeof name === 'string' ? name : name.name || 'unknown',
          kind: 'function',
          exported: true
        }));

        store.storeExtraction(fileId, {
          imports: resolvedImports,
          symbols,
          routes: result.extracted.routes || [],
          models: result.extracted.models || [],
          envVars: result.extracted.envVars || [],
          dbTables: result.extracted.dbTables || []
        });

        done++;
        if (done % 100 === 0 || done === total) {
          const pct = Math.round((done / total) * 100);
          process.stdout.write(`\r[CARTO] Extracting: ${pct}% (${done}/${total})`);
        }
      }
      if (total > 0) process.stdout.write('\n');
    }
  }

  // 7. Compute reverse deps (only if imports changed)
  if (toProcess.length > 0) {
    console.log('[CARTO] Computing reverse dependencies...');
    store.computeReverseDeps(5);
  } else {
    console.log('[CARTO] Skipping reverse deps (no files changed)');
  }

  // 7b. Domain clustering (only if files changed)
  if (toProcess.length > 0) {
    const importGraph = store.getImportGraph();

    // Use graph-based Leiden+CPM clustering for any-repo domain detection
    // Falls back to keyword clustering if graph is too sparse (< 10 edges)
    const edgeCount = Object.values(importGraph).reduce((s, d) => s + d.length, 0);

    let fileAssignments; // Map<filePath, domainName>

    if (edgeCount >= 10) {
      // Graph-based: works on any repo (vscode, zed, game engines, etc.)
      const keywordSeeds = {
        AUTH:          ['auth', 'login', 'session', 'oauth', 'jwt', 'password'],
        PAYMENTS:      ['payment', 'billing', 'stripe', 'invoice', 'subscription'],
        DATABASE:      ['prisma', 'database', 'db', 'migration', 'schema', 'drizzle'],
        TRPC:          ['trpc', 'router', 'procedure'],
        EVENTS:        ['webhook', 'event', 'queue', 'job', 'worker', 'cron'],
        NOTIFICATIONS: ['email', 'notification', 'mail', 'sms', 'alert'],
      };

      // Compute graph density to decide clustering strategy
      // Monorepos have sparse cross-package edges → graph clustering produces
      // hundreds of micro-communities. Use keyword fallback for sparse graphs.
      const fileCount = allFiles.length;
      const density = edgeCount / Math.max(fileCount, 1); // avg edges per file

      let rawAssignments;

      if (density >= 1.5) {
        // Dense enough for graph clustering (typical app repos)
        // Scale gamma: larger repos need coarser resolution
        let gamma = 0.03;
        if (fileCount > 5000) gamma = 0.08;
        else if (fileCount > 2000) gamma = 0.05;
        else if (fileCount > 500) gamma = 0.04;

        rawAssignments = clusterByGraph(importGraph, gamma, keywordSeeds);

        // Merge micro-communities (< minSize files) into CORE
        const minSize = Math.max(3, Math.floor(fileCount / 100));
        const domainCounts = new Map();
        for (const domain of rawAssignments.values()) {
          domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
        }

        fileAssignments = new Map();
        for (const [fp, domain] of rawAssignments) {
          const count = domainCounts.get(domain) || 0;
          fileAssignments.set(fp, count >= minSize ? domain : 'CORE');
        }
      } else {
        // Sparse graph (monorepo, Rust workspace, etc.)
        // Fall back to keyword-based clustering which works better here
        const routes = store.getRoutes();
        const models = store.getModels();
        const envVars = store.getEnvVars();
        const routesByFile = buildRoutesByFile(store);
        const functions = {};
        const allFilesForDomain = store.getAllFiles();
        for (const f of allFilesForDomain) {
          const syms = store.db.prepare(
            'SELECT name FROM symbols WHERE file_id = ? AND kind = ?'
          ).all(f.id, 'function').map(r => r.name);
          if (syms.length > 0) functions[f.path] = syms;
        }
        const dbTables = store.db.prepare(`
          SELECT dt.table_name, dt.operation, f.path as file
          FROM db_tables dt JOIN files f ON dt.file_id = f.id
        `).all().map(r => ({ table: r.table_name, operation: r.operation, file: r.file }));

        const domainResult = clusterByDomain({
          routes, models: models.filter(m => m.name).map(m => ({ ...m, className: m.name })),
          functions, envVars, dbTables, fileMap: [], routesByFile, importGraph
        });

        fileAssignments = new Map();
        for (const [domainName, cluster] of Object.entries(domainResult)) {
          for (const fp of (cluster.files || [])) fileAssignments.set(fp, domainName);
        }
      }
    } else {
      // Sparse graph — fall back to keyword-based clustering
      const routes = store.getRoutes();
      const models = store.getModels();
      const envVars = store.getEnvVars();
      const routesByFile = buildRoutesByFile(store);
      const functions = {};
      const allFilesForDomain = store.getAllFiles();
      for (const f of allFilesForDomain) {
        const syms = store.db.prepare(
          'SELECT name FROM symbols WHERE file_id = ? AND kind = ?'
        ).all(f.id, 'function').map(r => r.name);
        if (syms.length > 0) functions[f.path] = syms;
      }
      const dbTables = store.db.prepare(`
        SELECT dt.table_name, dt.operation, f.path as file
        FROM db_tables dt JOIN files f ON dt.file_id = f.id
      `).all().map(r => ({ table: r.table_name, operation: r.operation, file: r.file }));

      const domainResult = clusterByDomain({
        routes, models: models.filter(m => m.name).map(m => ({ ...m, className: m.name })),
        functions, envVars, dbTables, fileMap: [], routesByFile, importGraph
      });

      fileAssignments = new Map();
      for (const [domainName, cluster] of Object.entries(domainResult)) {
        for (const fp of (cluster.files || [])) fileAssignments.set(fp, domainName);
      }
    }

    // Write domain assignments to SQLite
    store.clearDomainAssignments();
    // Group by domain name
    const domainGroups = new Map();
    for (const [fp, domainName] of fileAssignments) {
      if (!domainGroups.has(domainName)) domainGroups.set(domainName, []);
      domainGroups.get(domainName).push(fp);
    }
    for (const [domainName, filePaths] of domainGroups) {
      const domainId = store.upsertDomain(domainName, { fileCount: filePaths.length });
      for (const fp of filePaths) {
        const file = store.getFileByPath(fp);
        if (file) store.assignFileToDomain(file.id, domainId);
      }
    }
  }

  // Store metadata
  const elapsed = Date.now() - startTime;
  const structure = store.getStructure();
  store.setMeta('total_files', String(allFiles.length));
  store.setMeta('total_routes', String(structure.meta.totalRoutes));
  store.setMeta('total_import_edges', String(structure.meta.totalImportEdges));
  store.setMeta('index_duration_ms', String(elapsed));
  store.setMeta('last_full_sync', new Date().toISOString());

  // Detect stack
  if (toProcess.length > 0) {
    const changedContents = [];
    for (const relPath of toProcess.slice(0, 50)) { // sample for stack detection
      const fullPath = path.resolve(projectRoot, relPath);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        changedContents.push({ filePath: fullPath, content });
      } catch {}
    }
    if (changedContents.length > 0) {
      const stack = buildStackLine(changedContents, projectRoot);
      store.setMeta('stack_json', JSON.stringify(stack));
    }
  }

  // 8. Generate outputs (only if files changed)
  if (toProcess.length > 0) {
    generateOutputs(store, config, projectRoot, store.getImportGraph());
  }

  console.log(`[CARTO] Indexed ${toProcess.length} files (${cached} cached) in ${elapsed}ms`);
  console.log(`[CARTO] Total: ${allFiles.length} files, ${structure.meta.totalRoutes} routes, ${structure.meta.totalImportEdges} import edges`);

  store.close();
  return { filesProcessed: toProcess.length, totalFiles: allFiles.length, elapsed };
}

/**
 * Build fileData object from SQLite for backward-compat with domain clustering
 */
function buildFileDataFromStore(store) {
  const files = store.getAllFiles();
  const fileData = {};
  for (const f of files) {
    const routes = store.db.prepare(
      'SELECT method, path FROM routes WHERE file_id = ?'
    ).all(f.id);
    const models = store.db.prepare(
      'SELECT name, kind FROM models WHERE file_id = ?'
    ).all(f.id);
    const envVars = store.db.prepare(
      'SELECT name FROM env_vars WHERE file_id = ?'
    ).all(f.id).map(r => r.name);
    const dbTables = store.db.prepare(
      'SELECT table_name, operation FROM db_tables WHERE file_id = ?'
    ).all(f.id);
    const functions = store.db.prepare(
      'SELECT name FROM symbols WHERE file_id = ? AND kind = ?'
    ).all(f.id, 'function').map(r => r.name);

    fileData[f.path] = { routes, models, functions, envVars, dbTables };
  }
  return fileData;
}

/**
 * Generate backward-compatible outputs (AGENTS.md, context files, map.json)
 */
function generateOutputs(store, config, projectRoot, importGraph) {
  const structure = store.getStructure();
  const routes = store.getRoutes();
  const models = store.getModels();
  const envVars = store.getEnvVars();
  const domains = store.getDomainsList();

  // Write domain context files — lazy: only write if stale or missing
  const contextDir = path.join(projectRoot, '.carto', 'context');
  fs.mkdirSync(contextDir, { recursive: true });
  const lastSync = store.getMeta('last_full_sync');

  for (const d of domains) {
    if (d.fileCount === 0 && d.routeCount === 0 && d.modelCount === 0) continue;

    const domainPath = path.join(contextDir, `${d.name}.md`);

    // Skip regeneration if context file is newer than last sync
    if (lastSync && fs.existsSync(domainPath)) {
      try {
        const fileMtime = fs.statSync(domainPath).mtimeMs;
        const syncTime = new Date(lastSync).getTime();
        if (fileMtime >= syncTime) continue; // still fresh
      } catch {}
    }

    const domainData = store.getDomain(d.name);
    if (!domainData) continue;

    const cluster = {
      files: domainData.files,
      routes: domainData.routes.map(r => ({ ...r, functionName: r.handler_name || '' })),
      models: domainData.models.map(m => ({
        ...m,
        className: m.name,
        fields: m.fields_json ? JSON.parse(m.fields_json) : []
      })),
      functions: {},
      envVars: [],
      dbTables: [],
      fileMap: []
    };

    const content = formatDomainFile(d.name, cluster);
    try {
      fs.writeFileSync(domainPath + '.tmp', content, 'utf-8');
      fs.renameSync(domainPath + '.tmp', domainPath);
    } catch {}
  }

  // Generate AGENTS.md
  if (config.output) {
    const highImpact = store.getHighImpactFiles(15);
    const autoContent = formatSections({
      routes,
      models,
      frontend: { fetches: [], storageKeys: [] },
      structure: [],
      warnings: [],
      fileMap: [],
      functions: {},
      dbTables: [],
      envVars,
      importGraph,
      stackItems: structure.stack,
      entryPoints: structure.entryPoints,
      highImpact: highImpact.map(h => ({ file: h.file, count: h.dependents }))
    });
    mergeIntoAgentsMd(config.output, autoContent);
  }

  // Write map.json (backward compat)
  const mapData = {
    version: '2',
    generated: new Date().toISOString(),
    imports: importGraph,
    routes,
    routesByFile: buildRoutesByFile(store),
    models,
    highImpact: store.getHighImpactFiles(15),
    entryPoints: structure.entryPoints,
    stack: structure.stack,
    domains: domains.map(d => d.name),
    meta: {
      totalFiles: store.getFileCount(),
      totalRoutes: structure.meta.totalRoutes,
      totalImportEdges: structure.meta.totalImportEdges,
      lastIndexed: new Date().toISOString(),
      indexDuration: structure.meta.indexDuration
    }
  };

  const mapPath = path.join(projectRoot, '.carto', 'map.json');
  try {
    fs.writeFileSync(mapPath + '.tmp', JSON.stringify(mapData, null, 2) + '\n', 'utf-8');
    fs.renameSync(mapPath + '.tmp', mapPath);
  } catch {}
}

function buildRoutesByFile(store) {
  const routes = store.getRoutes();
  const byFile = {};
  for (const r of routes) {
    if (!byFile[r.file]) byFile[r.file] = [];
    byFile[r.file].push(`${r.method} ${r.path}`);
  }
  return byFile;
}

function detectLanguage(ext) {
  const map = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python', '.go': 'go', '.rs': 'rust', '.rb': 'ruby',
    '.java': 'java', '.cs': 'csharp',
    '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.h': 'cpp', '.hpp': 'cpp',
    '.swift': 'swift', '.kt': 'kotlin',
    '.r': 'r', '.R': 'r', '.prisma': 'prisma', '.html': 'html'
  };
  return map[ext] || 'unknown';
}

module.exports = { runSyncV2, discoverFiles, extractFile, buildFileDataFromStore, generateOutputs, buildRoutesByFile, detectLanguage };
