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
const { clusterByDomain, setDomainMap } = require('../agents/domains');
const { clusterByGraph } = require('../agents/leiden');
const { formatSections, formatDomainFile } = require('../agents/formatter');
const { mergeIntoAgentsMd } = require('../agents/merger');
const { scanStructure } = require('../agents/scan-structure');
const { WorkerPool, POOL_SIZE } = require('../engine/worker-pool');
const { parseCartoIgnore } = require('../security/ignore');
const { loadCartoConfig, applyAnchors } = require('./config-loader');
const { buildFromStore: buildBitmap, saveToDisk: saveBitmap } = require('../bitmap/sidecar');
const { invalidate: invalidateBitmap } = require('../bitmap/index');

const plugins = loadLanguagePlugins();

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv',
  'dist', '.next', '.turbo', 'build', 'coverage', '.carto',
  'out', '.cache', 'generated', '__generated__',
  'storybook-static', 'public', 'static',
  'tmp-bench', 'vendor', 'third_party', '.yarn',
  // Test directories — ported from V1 detector/files.js
  'test', 'tests', '__tests__', 'e2e', 'playwright',
  'cypress', 'fixtures', 'mocks', '__mocks__'
]);

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.r', '.R', '.prisma', '.html', '.go', '.rb',
  '.rs', '.java', '.cs', '.cpp', '.cc', '.cxx', '.h', '.hpp',
  '.swift', '.kt'
]);

const JS_LIKE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

/**
 * isTestFile(relPath) → true if the file is a test/spec/stories file
 * Ported from V1 detector/files.js exclusion patterns.
 *   R:      test_*, test-*, *_test.r (case-insensitive)
 *   Python: test_*.py, *_test.py
 *   JS/TS:  *.test.*, *.spec.*, *.stories.*
 * Path-based directory exclusions (test/, tests/, __tests__/, etc.)
 * are handled by IGNORE_DIRS during the walk — see above.
 */
function isTestFile(relPath) {
  const base = path.basename(relPath);
  const lbase = base.toLowerCase();
  const ext = path.extname(base).toLowerCase();

  if (ext === '.r') {
    return lbase.startsWith('test_') || lbase.startsWith('test-') || lbase.endsWith('_test.r');
  }
  if (ext === '.py') {
    return lbase.startsWith('test_') || lbase.endsWith('_test.py');
  }
  if (JS_LIKE_EXTS.has(ext)) {
    if (lbase.includes('.test.') || lbase.includes('.spec.') || lbase.includes('.stories.')) {
      return true;
    }
  }
  return false;
}

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
        if (CODE_EXTS.has(ext) && !isIgnored(rel) && !isTestFile(rel)) {
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
 *
 * Instead of just `console.warn`-ing on extractor failures, the
 * returned result includes an `errors` array of `{ phase, message }` so
 * the caller can persist them in `extraction_errors`. Phases:
 *   - 'extract'  → plugin.extract threw (parse error, plugin bug, ...)
 *   - 'imports'  → extractImports threw
 * On a plugin.extract throw the file is still indexed with empty
 * routes/models/etc. — visibility beats silent skipping.
 */
function extractFile(relPath, projectRoot) {
  const fullPath = path.resolve(projectRoot, relPath);
  const fileResult = hashFile(fullPath);
  if (!fileResult) return null;

  const { content, hash } = fileResult;
  const plugin = getPluginForFile(plugins, fullPath);

  const errors = [];
  let extracted = { routes: [], models: [], functions: [], envVars: [], dbTables: [], fetches: [], storageKeys: [] };
  if (plugin) {
    try {
      extracted = plugin.extract(content, relPath);
      // Plugins may surface their own internal failures (e.g. Babel parse
      // errors that they recover from with tree-sitter) via `_errors`.
      // Promote those into our breadcrumb stream so they show up in
      // `carto check` rather than only on stderr.
      if (Array.isArray(extracted._errors) && extracted._errors.length > 0) {
        for (const e of extracted._errors) {
          if (e && e.phase && e.message) errors.push({ phase: e.phase, message: e.message });
        }
      }
    } catch (err) {
      console.warn(`[CARTO] Extraction error for ${relPath}: ${err.message}`);
      errors.push({ phase: 'extract', message: err.message || String(err) });
    }
  }

  // Extract imports
  let imports = [];
  try {
    imports = extractImports(content, fullPath, projectRoot);
  } catch (err) {
    errors.push({ phase: 'imports', message: err.message || String(err) });
  }

  const stat = fs.statSync(fullPath);

  return {
    relPath,
    hash,
    mtime: Math.floor(stat.mtimeMs),
    size: stat.size,
    language: detectLanguage(path.extname(relPath).toLowerCase()),
    content,
    extracted,
    imports,
    errors
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
          const { relPath, routes, models, functions, envVars, dbTables, imports, errors } = result;

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
            dbTables: (dbTables || []).map(t => ({ table: t.table || t.table_name || t.name, operation: t.operation })),
            errors: errors || []
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
          dbTables: result.extracted.dbTables || [],
          errors: result.errors || []
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
    // Repair imports whose `to_file_id` was null because the target
    // file hadn't been upserted yet during this file's extraction
    // (alphabetical-order chicken-and-egg). Cheap one-shot UPDATE.
    const repaired = store.resolveUnresolvedImports();
    if (repaired > 0) {
      console.log(`[CARTO] Resolved ${repaired} previously-unresolved imports`);
    }
    console.log('[CARTO] Computing reverse dependencies...');
    store.computeReverseDeps(5);
  } else {
    console.log('[CARTO] Skipping reverse deps (no files changed)');
  }

  // 7b. Domain clustering (only if files changed)
  if (toProcess.length > 0) {
    const importGraph = store.getImportGraph();
    const edgeCount = Object.values(importGraph).reduce((s, d) => s + d.length, 0);
    const fileCount = allFiles.length;

    // 10b — Load carto.config.json for custom domain keywords + anchors
    const cartoConfig = loadCartoConfig(projectRoot);
    if (cartoConfig) {
      // Feed custom keywords into the keyword-based domain map
      const customKeywords = {};
      for (const [name, cfg] of Object.entries(cartoConfig.domains)) {
        if (cfg.keywords && cfg.keywords.length > 0) customKeywords[name] = cfg.keywords;
      }
      if (Object.keys(customKeywords).length > 0) setDomainMap(customKeywords);
    }

    const strategy = selectClusteringStrategy(fileCount, edgeCount);
    let fileAssignments; // Map<filePath, domainName>

    if (strategy.method === 'graph') {
      // Merge default + config keywords for graph naming
      const keywordSeeds = {
        AUTH:          ['auth', 'login', 'session', 'oauth', 'jwt', 'password'],
        PAYMENTS:      ['payment', 'billing', 'stripe', 'invoice', 'subscription'],
        DATABASE:      ['prisma', 'database', 'db', 'migration', 'schema', 'drizzle'],
        TRPC:          ['trpc', 'router', 'procedure'],
        EVENTS:        ['webhook', 'event', 'queue', 'job', 'worker', 'cron'],
        NOTIFICATIONS: ['email', 'notification', 'mail', 'sms', 'alert'],
      };
      if (cartoConfig) {
        for (const [name, cfg] of Object.entries(cartoConfig.domains)) {
          if (cfg.keywords && cfg.keywords.length > 0) {
            keywordSeeds[name] = [...(keywordSeeds[name] || []), ...cfg.keywords];
          }
        }
      }

      const rawAssignments = clusterByGraph(importGraph, strategy.gamma, keywordSeeds);

      // Merge micro-communities (< minSize files) into CORE
      const domainCounts = new Map();
      for (const domain of rawAssignments.values()) {
        domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
      }
      fileAssignments = new Map();
      for (const [fp, domain] of rawAssignments) {
        fileAssignments.set(fp, (domainCounts.get(domain) || 0) >= strategy.minSize ? domain : 'CORE');
      }
    } else {
      fileAssignments = runKeywordClustering(store, importGraph);
    }

    // 10b — Apply anchor pinning from config
    if (cartoConfig) applyAnchors(fileAssignments, cartoConfig);

    // Reset domain map to defaults after use (avoid polluting subsequent runs)
    if (cartoConfig) setDomainMap(null);

    // 10c — Domain stability metric: compare to previous snapshot
    computeDomainStability(store, fileAssignments);

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

  // Extraction error count for fast access by `carto check`,
  // `carto init` summary, and MCP get_architecture.
  const extractionErrorCount = store.getExtractionErrorCount();
  store.setMeta('extraction_error_count', String(extractionErrorCount));

  // Record unavailable grammars so `carto check` and MCP
  // `get_architecture` can surface language coverage gaps.
  const { getUnavailableLanguages } = require('../extractors/tree-sitter-parser');
  const unavailableLangs = getUnavailableLanguages();
  store.setMeta('unavailable_languages_json', JSON.stringify(unavailableLangs));
  if (unavailableLangs.length > 0) {
    console.log(`[CARTO] ⚠️  ${unavailableLangs.length} language grammar${unavailableLangs.length === 1 ? '' : 's'} unavailable (${unavailableLangs.join(', ')}) — using regex fallback`);
  }

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

  // 8. Generate outputs (only if files changed AND output not suppressed)
  if (toProcess.length > 0 && config.output !== null && config.output !== false) {
    await generateOutputs(store, config, projectRoot, store.getImportGraph());
  }

  // Build bitmap sidecar. Always run — the bitmap layer is
  //    derived + disposable, so we rebuild on every sync to keep
  //    `.carto/bitmap.bin` aligned with the SQLite source of truth.
  //    Best-effort: a build/persist failure is logged but never fails the
  //    sync (MCP tools fall back to SQLite when bitmap is unavailable).
  try {
    const cartoDir = path.join(projectRoot, '.carto');
    const sidecar = buildBitmap(store);
    saveBitmap(cartoDir, sidecar);
    // Drop any in-memory cache held by the same Node process — e.g. when
    // sync runs from inside `carto serve`'s lazy reparse path. Next MCP
    // query loads the freshly-saved file.
    invalidateBitmap();
  } catch (err) {
    process.stderr.write(
      `[CARTO] bitmap sidecar build failed (queries will use SQLite): ` +
      `${err && err.message ? err.message : err}\n`
    );
  }

  console.log(`[CARTO] Indexed ${toProcess.length} files (${cached} cached) in ${elapsed}ms`);
  console.log(`[CARTO] Total: ${allFiles.length} files, ${structure.meta.totalRoutes} routes, ${structure.meta.totalImportEdges} import edges`);

  // Surface extraction failures so users notice them
  // immediately, not after they ask the AI a question and get bad
  // answers. Pointed at `carto check` for the full breakdown.
  if (extractionErrorCount > 0) {
    console.log(`[CARTO] ⚠️  ${extractionErrorCount} extraction error${extractionErrorCount === 1 ? '' : 's'} (run \`carto check\` for details)`);
  }

  store.close();
  return { filesProcessed: toProcess.length, totalFiles: allFiles.length, elapsed, extractionErrorCount };
}

/**
 * selectClusteringStrategy(fileCount, edgeCount) → { method, gamma?, minSize? }
 *
 * Adaptive clustering strategy selection:
 *   - <100 files → keyword (kills over-fragmentation for small repos)
 *   - density <1.5 → keyword (sparse graph / monorepo)
 *   - else → graph with continuous gamma = min(0.10, 0.02 + 0.02·log10(fileCount/10))
 *     minSize = clamp(sqrt(fileCount), 5, 20)
 */
function selectClusteringStrategy(fileCount, edgeCount) {
  if (fileCount < 100) return { method: 'keyword' };
  const density = edgeCount / Math.max(fileCount, 1);
  if (density < 1.5) return { method: 'keyword' };
  const gamma = Math.min(0.10, 0.02 + 0.02 * Math.log10(fileCount / 10));
  const minSize = Math.max(5, Math.min(20, Math.round(Math.sqrt(fileCount))));
  return { method: 'graph', gamma, minSize };
}

/**
 * runKeywordClustering(store, importGraph) → Map<filePath, domainName>
 * Consolidated keyword-based clustering used for small/sparse repos.
 */
function runKeywordClustering(store, importGraph) {
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

  const fileAssignments = new Map();
  for (const [domainName, cluster] of Object.entries(domainResult)) {
    for (const fp of (cluster.files || [])) fileAssignments.set(fp, domainName);
  }
  return fileAssignments;
}

/**
 * computeDomainStability(store, fileAssignments)
 * Compares current assignments to previous snapshot, stores drift %.
 * Warns if total>=10 && drift>5%.
 */
function computeDomainStability(store, fileAssignments) {
  const prevRaw = store.getMeta('previous_domain_snapshot');
  const currentSnapshot = {};
  for (const [fp, domain] of fileAssignments) currentSnapshot[fp] = domain;

  let driftPct = 0;
  const reassignments = [];

  if (prevRaw) {
    try {
      const prev = JSON.parse(prevRaw);
      const total = fileAssignments.size;
      let changed = 0;
      for (const [fp, domain] of fileAssignments) {
        if (prev[fp] && prev[fp] !== domain) {
          changed++;
          if (reassignments.length < 20) {
            reassignments.push({ file: fp, from: prev[fp], to: domain });
          }
        }
      }
      driftPct = total > 0 ? (changed / total) * 100 : 0;
      if (total >= 10 && driftPct > 5) {
        console.warn(`[CARTO] ⚠️  Domain stability: ${driftPct.toFixed(1)}% files changed domain (${changed}/${total})`);
      }
    } catch { /* malformed snapshot — treat as first run */ }
  }

  store.setMeta('previous_domain_snapshot', JSON.stringify(currentSnapshot));
  store.setMeta('domain_stability_drift_pct', driftPct.toFixed(2));
  store.setMeta('last_reassignments_json', JSON.stringify(reassignments));
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
async function generateOutputs(store, config, projectRoot, importGraph) {
  const structure = store.getStructure();
  const routes = store.getRoutes();
  const models = store.getModels();
  const envVars = store.getEnvVars();
  const domains = store.getDomainsList();
  const topLevelStructure = await scanStructure(projectRoot);

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
      structure: topLevelStructure,
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

/**
 * syncFiles(projectRoot, paths, opts?) → { reparsed, skipped, removed, elapsed }
 *
 * Hot re-parse a small set of files. Used by:
 *   - The MCP server's lazy mtime check at query time
 *   - The optional `carto watch` command (incremental save handler)
 *
 * Each path is mtime+size-checked against the SQLite row. Unchanged files
 * are skipped. Changed files are extracted and written, and reverse_deps
 * are updated incrementally for just the file's neighbors (NOT the whole
 * graph). No discovery pass, no domain reclustering, no AGENTS.md
 * regeneration — this is the freshness equivalent of `git status` and
 * finishes in <50ms for a single file.
 *
 * Files that no longer exist on disk are removed from the index.
 *
 * Opts:
 *   store — Optional pre-opened writable SQLiteStore. If omitted, a new
 *           connection is opened and closed. Pass an existing store when
 *           batching many calls (e.g. the watcher debounce loop).
 */
function syncFiles(projectRoot, paths, opts = {}) {
  const startTime = Date.now();
  if (!Array.isArray(paths) || paths.length === 0) {
    return { reparsed: 0, skipped: 0, removed: 0, elapsed: 0 };
  }

  const ownsStore = !opts.store;
  let store = opts.store;
  if (ownsStore) {
    store = new SQLiteStore(projectRoot);
    store.open();
  }

  let reparsed = 0;
  let skipped = 0;
  let removed = 0;

  try {
    for (const relPath of paths) {
      if (!relPath || typeof relPath !== 'string') { skipped++; continue; }

      const fullPath = path.resolve(projectRoot, relPath);

      // Stat — if missing, treat as deletion
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        const existing = store.getFileByPath(relPath);
        if (existing) {
          store.removeFile(relPath);
          updateReverseDepsPartial(store, existing.id);
          removed++;
        }
        continue;
      }

      const mtime = Math.floor(stat.mtimeMs);
      const size = stat.size;
      const existing = store.getFileByPath(relPath);

      // Fast path: mtime+size unchanged → DB row is current
      if (existing && existing.mtime === mtime && existing.size === size) {
        skipped++;
        continue;
      }

      // Skip large files (extractor cap matches runSyncV2 / applyIncrementalV2)
      if (size > 1024 * 1024) { skipped++; continue; }

      // Extract — single source of truth, same path runSyncV2 uses
      const result = extractFile(relPath, projectRoot);
      if (!result) { skipped++; continue; }

      // Hash-equal but mtime drifted (e.g. `touch foo.ts`) — just refresh
      // the cached mtime/size so future stat checks short-circuit.
      if (existing && existing.hash === result.hash) {
        store.updateFileMtime(relPath, mtime, size);
        skipped++;
        continue;
      }

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
        dbTables: (result.extracted.dbTables || []).map(t => ({
          table: t.table || t.table_name || t.name,
          operation: t.operation
        })),
        errors: result.errors || []
      });

      // Repair any prior unresolved imports that point AT this file —
      // e.g. another file imported foo.ts before foo.ts was indexed.
      // Now foo.ts exists, so those imports become resolvable. Cheap:
      // single UPDATE WHERE to_path = relPath.
      store.resolveUnresolvedImports();

      updateReverseDepsPartial(store, fileId);
      reparsed++;
    }

    // Track partial-sync timestamp so observability tools can tell apart a
    // full reindex from a hot reparse.
    if (reparsed > 0 || removed > 0) {
      try { store.setMeta('last_partial_sync', new Date().toISOString()); } catch {}
      // Keep extraction_error_count fresh on partial syncs too
      try { store.setMeta('extraction_error_count', String(store.getExtractionErrorCount())); } catch {}
      // Invalidate the bitmap sidecar so the next MCP query
      // rebuilds it from the now-fresh SQLite state. Removes both the
      // in-memory singleton and the on-disk `bitmap.bin` so a different
      // process (e.g. the MCP server when watch.js triggered the
      // partial sync) also picks up the change.
      try { invalidateBitmap(path.join(projectRoot, '.carto')); } catch {}
    }
  } finally {
    if (ownsStore) {
      try { store.close(); } catch {}
    }
  }

  return { reparsed, skipped, removed, elapsed: Date.now() - startTime };
}

/**
 * updateReverseDepsPartial(store, fileId)
 *
 * Recompute reverse_deps for `fileId` plus its direct import neighbors only.
 * O(neighbors) instead of O(all files). Used by syncFiles() and watch.js.
 *
 * Lifted out of the original watch.js implementation so MCP-side lazy
 * reparse and the watcher share one code path.
 */
function updateReverseDepsPartial(store, fileId) {
  const outgoing = store.db.prepare(
    'SELECT to_file_id FROM imports WHERE from_file_id = ? AND to_file_id IS NOT NULL'
  ).all(fileId).map(r => r.to_file_id);

  const incoming = store.db.prepare(
    'SELECT from_file_id FROM imports WHERE to_file_id = ?'
  ).all(fileId).map(r => r.from_file_id);

  const affectedIds = new Set([fileId, ...outgoing, ...incoming]);

  const del = store.db.prepare('DELETE FROM reverse_deps WHERE file_id = ? OR dependent_file_id = ?');
  const ins = store.db.prepare(
    'INSERT OR IGNORE INTO reverse_deps (file_id, dependent_file_id, hop_distance) VALUES (?,?,?)'
  );

  // Build local reverse-edge map ONCE, reuse across affected ids.
  const allEdges = store.db.prepare(
    'SELECT from_file_id, to_file_id FROM imports WHERE to_file_id IS NOT NULL'
  ).all();

  const reverseDirect = new Map();
  for (const e of allEdges) {
    if (!reverseDirect.has(e.to_file_id)) reverseDirect.set(e.to_file_id, []);
    reverseDirect.get(e.to_file_id).push(e.from_file_id);
  }

  const tx = store.db.transaction(() => {
    for (const fid of affectedIds) {
      del.run(fid, fid);
      let frontier = new Set(reverseDirect.get(fid) || []);
      const visited = new Set();
      for (let hop = 1; hop <= 5; hop++) {
        const next = new Set();
        for (const depId of frontier) {
          if (visited.has(depId) || depId === fid) continue;
          visited.add(depId);
          ins.run(fid, depId, hop);
          for (const nd of (reverseDirect.get(depId) || [])) {
            if (!visited.has(nd) && nd !== fid) next.add(nd);
          }
        }
        if (next.size === 0) break;
        frontier = next;
      }
    }
  });
  tx();

  const updateCentrality = store.db.prepare(
    'UPDATE files SET centrality = (SELECT COUNT(DISTINCT dependent_file_id) FROM reverse_deps WHERE file_id = files.id) WHERE id = ?'
  );
  for (const fid of affectedIds) updateCentrality.run(fid);
}

module.exports = { runSyncV2, syncFiles, updateReverseDepsPartial, discoverFiles, extractFile, buildFileDataFromStore, generateOutputs, buildRoutesByFile, detectLanguage, selectClusteringStrategy };
