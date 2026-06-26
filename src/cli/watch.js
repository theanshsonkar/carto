'use strict';

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { SQLiteStore } = require('../store/sqlite-store');
const { discoverFiles, generateOutputs, buildRoutesByFile, detectLanguage } = require('../store/sync');
const { runSync } = require('../store/sync');
const { detectChangedFiles, hashFile, hashContent } = require('../store/change-detector');
const { loadLanguagePlugins, getPluginForFile } = require('../extractors/loader');
const { extractImports } = require('../extractors/imports');
const { checkForUpdate } = require('./update-check');

const plugins = loadLanguagePlugins();

/**
 * applyIncrementalV2(store, relPath, projectRoot)
 *
 * Re-extracts a single changed file and updates SQLite atomically.
 * Updates reverse_deps for direct neighbors only (not full recompute).
 * Returns elapsed ms.
 */
async function applyIncrementalV2(store, relPath, projectRoot) {
  const start = Date.now();
  const fullPath = path.resolve(projectRoot, relPath);

  // stat + hash check
  let stat;
  try { stat = fs.statSync(fullPath); } catch {
    // File deleted — remove from DB
    store.removeFile(relPath);
    return Date.now() - start;
  }

  const mtime = Math.floor(stat.mtimeMs);
  const size = stat.size;
  const existing = store.getFileByPath(relPath);

  if (existing && existing.mtime === mtime && existing.size === size) {
    return 0; // unchanged
  }

  const fileResult = hashFile(fullPath);
  if (!fileResult) return 0;

  const { content, hash } = fileResult;

  if (existing && existing.hash === hash) {
    store.updateFileMtime(relPath, mtime, size);
    return Date.now() - start;
  }

  // Skip files > 1MB
  if (size > 1024 * 1024) return 0;

  // Extract
  const plugin = getPluginForFile(plugins, fullPath);
  let extracted = { routes: [], models: [], functions: [], envVars: [], dbTables: [] };
  if (plugin) {
    try { extracted = plugin.extract(content, relPath); } catch {}
  }

  let imports = [];
  try { imports = extractImports(content, fullPath, projectRoot); } catch {}

  // Write to SQLite atomically
  const fileId = store.upsertFile(relPath, {
    language: detectLanguage(path.extname(relPath).toLowerCase()),
    hash,
    mtime,
    size
  });

  const resolvedImports = imports.map(impPath => {
    const resolved = store.getFileByPath(impPath);
    return { path: impPath, resolvedFileId: resolved ? resolved.id : null };
  });

  const symbols = (extracted.functions || []).map(name => ({
    name: typeof name === 'string' ? name : name.name || 'unknown',
    kind: 'function',
    exported: true
  }));

  store.storeExtraction(fileId, {
    imports: resolvedImports,
    symbols,
    routes: extracted.routes || [],
    models: extracted.models || [],
    envVars: extracted.envVars || [],
    dbTables: extracted.dbTables || []
  });

  // Partial reverse_deps update — only recompute for this file's direct neighbors
  updateReverseDepsPartial(store, fileId);

  return Date.now() - start;
}

/**
 * Recompute reverse_deps for a single file and its direct import neighbors.
 * Much cheaper than full recompute — O(neighbors) not O(all files).
 */
function updateReverseDepsPartial(store, fileId) {
  // Get direct imports of this file
  const outgoing = store.db.prepare(
    'SELECT to_file_id FROM imports WHERE from_file_id = ? AND to_file_id IS NOT NULL'
  ).all(fileId).map(r => r.to_file_id);

  // Get files that import this file
  const incoming = store.db.prepare(
    'SELECT from_file_id FROM imports WHERE to_file_id = ?'
  ).all(fileId).map(r => r.from_file_id);

  const affectedIds = new Set([fileId, ...outgoing, ...incoming]);

  // Delete and recompute reverse_deps only for affected files
  const del = store.db.prepare('DELETE FROM reverse_deps WHERE file_id = ? OR dependent_file_id = ?');
  const ins = store.db.prepare(
    'INSERT OR IGNORE INTO reverse_deps (file_id, dependent_file_id, hop_distance) VALUES (?,?,?)'
  );

  // Build local reverse map for affected files
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

  // Update centrality for affected files
  const updateCentrality = store.db.prepare(
    'UPDATE files SET centrality = (SELECT COUNT(DISTINCT dependent_file_id) FROM reverse_deps WHERE file_id = files.id) WHERE id = ?'
  );
  for (const fid of affectedIds) updateCentrality.run(fid);
}

async function run(projectRoot) {
  checkForUpdate();
  const configPath = path.join(projectRoot, '.carto', 'config.json');

  if (!fs.existsSync(configPath)) {
    console.error('[CARTO] Run "carto init" first.');
    process.exit(1);
  }

  // `carto watch` is opt-in. Git hooks + lazy MCP re-parse
  // handle the 90% case automatically with no background process. Surface
  // that to anyone who runs this command so they know it's not required.
  console.log('[CARTO] Note: `carto watch` is opt-in. Git hooks + lazy MCP re-parse (installed by `carto init`) keep the index fresh without a background process.');
  console.log('[CARTO] Use `carto watch` for AI-heavy workflows where many files are edited between commits and you want sub-second freshness.');

  // Initial full sync using V2
  console.log('[CARTO] Starting initial sync...');
  await runSync({
    projectRoot,
    output: path.join(projectRoot, 'AGENTS.md')
  });
  console.log('[CARTO] Initial sync complete. Watching for changes...');

  // Open store for incremental updates
  const store = new SQLiteStore(projectRoot);
  store.open();

  // Recursive directory watcher — one watch on the project root, not per-file
  const watcher = chokidar.watch(projectRoot, {
    persistent: true,
    ignoreInitial: true,
    ignored: [
      /(^|[/\\])\../, // dotfiles
      /node_modules/,
      /\.carto/,
      /dist/,
      /build/,
      /\.next/,
      /coverage/,
      /tmp-bench/
    ],
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 50 }
  });

  const debounceMap = new Map(); // relPath → timer

  // ── Dirty-flag domain recluster ──────────────────────────────────────────
  // If a file's imports change AND cross a domain boundary, mark domains dirty.
  // Recluster after 5 min idle (not on every save).
  let domainsDirty = false;
  let reclusterTimer = null;
  const RECLUSTER_IDLE_MS = 5 * 60 * 1000; // 5 minutes

  function markDomainsDirty() {
    domainsDirty = true;
    if (reclusterTimer) clearTimeout(reclusterTimer);
    reclusterTimer = setTimeout(async () => {
      reclusterTimer = null;
      if (!domainsDirty) return;
      domainsDirty = false;
      console.log('[CARTO] Idle 5min — reclustering domains...');
      try {
        await runSync({ projectRoot, output: path.join(projectRoot, 'AGENTS.md') });
        console.log('[CARTO] Domain recluster complete.');
      } catch (err) {
        console.error(`[CARTO] Recluster error: ${err.message}`);
      }
    }, RECLUSTER_IDLE_MS);
  }

  function checkImportsCrossDomain(store, relPath) {
    const file = store.getFileByPath(relPath);
    if (!file) return false;
    const fileDomain = store.getDomainForFile(relPath);
    if (!fileDomain) return false;

    const imports = store.db.prepare(
      'SELECT to_file_id FROM imports WHERE from_file_id = ? AND to_file_id IS NOT NULL'
    ).all(file.id);

    for (const imp of imports) {
      const impFile = store.getFileById(imp.to_file_id);
      if (!impFile) continue;
      const impDomain = store.getDomainForFile(impFile.path);
      if (impDomain && impDomain !== fileDomain) return true;
    }
    return false;
  }

  const handleChange = async (fullPath, eventType) => {
    const relPath = path.relative(projectRoot, fullPath);
    const ext = path.extname(relPath).toLowerCase();

    // Only process known code extensions
    const CODE_EXTS = new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','.r','.R','.prisma','.go','.rb','.rs','.java','.cs','.cpp','.cc','.h','.hpp','.swift','.kt']);
    if (!CODE_EXTS.has(ext)) return;

    // Debounce per file (50ms)
    if (debounceMap.has(relPath)) clearTimeout(debounceMap.get(relPath));
    debounceMap.set(relPath, setTimeout(async () => {
      debounceMap.delete(relPath);
      try {
        const elapsed = await applyIncrementalV2(store, relPath, projectRoot);
        if (elapsed > 0) {
          console.log(`[CARTO] ${path.basename(relPath)} → updated in ${elapsed}ms`);
          // Check if imports now cross domain boundaries → schedule recluster
          if (checkImportsCrossDomain(store, relPath)) {
            markDomainsDirty();
          }
        }
      } catch (err) {
        console.error(`[CARTO] Incremental error for ${relPath}: ${err.message}`);
      }
    }, 50));
  };

  watcher.on('change', (p) => handleChange(p, 'change'));
  watcher.on('add', (p) => handleChange(p, 'add'));
  watcher.on('unlink', async (fullPath) => {
    const relPath = path.relative(projectRoot, fullPath);
    store.removeFile(relPath);
    console.log(`[CARTO] Removed: ${relPath}`);
  });

  watcher.on('error', (err) => console.error(`[CARTO] Watcher error: ${err.message}`));

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[CARTO] Shutting down...');
    if (reclusterTimer) clearTimeout(reclusterTimer);
    watcher.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`[CARTO] Watching ${projectRoot} (recursive, incremental mode)`);
}

module.exports = { run, applyIncrementalV2 };
