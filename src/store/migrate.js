'use strict';

const fs = require('fs');
const path = require('path');

/**
 * migrateFromJsonBlobs(store, projectRoot)
 *
 * Reads existing graph-cache.json, map.json, hashes.json and populates
 * the SQLite database. Backs up old files on success.
 *
 * Returns true if migration happened, false if no migration needed.
 */
function migrateFromJsonBlobs(store, projectRoot) {
  const cartoDir = path.join(projectRoot, '.carto');
  const graphCachePath = path.join(cartoDir, 'graph-cache.json');
  const hashesPath = path.join(cartoDir, 'hashes.json');
  const mapPath = path.join(cartoDir, 'map.json');
  const dbPath = path.join(cartoDir, 'carto.db');

  // Only migrate if graph-cache.json exists but carto.db didn't exist before
  // (the store was just freshly created with 0 files)
  if (!fs.existsSync(graphCachePath)) return false;
  if (store.getFileCount() > 0) return false;

  let cache;
  try {
    const raw = fs.readFileSync(graphCachePath, 'utf-8');
    cache = JSON.parse(raw);
  } catch (err) {
    console.warn(`[CARTO] Migration: Could not parse graph-cache.json: ${err.message}`);
    return false;
  }

  if (cache.version !== '2') {
    console.warn(`[CARTO] Migration: Unsupported graph-cache version "${cache.version}", skipping`);
    return false;
  }

  // Load hashes
  let hashes = {};
  try {
    hashes = JSON.parse(fs.readFileSync(hashesPath, 'utf-8'));
  } catch {}

  console.log('[CARTO] Migrating from JSON blobs to SQLite...');

  try {
    store.transaction(() => {
      // 1. Insert all files from hashes + fileData
      const allPaths = new Set([
        ...Object.keys(hashes),
        ...Object.keys(cache.fileData || {}),
        ...Object.keys(cache.importGraph || {})
      ]);

      const fileIdMap = new Map(); // relPath -> fileId

      for (const relPath of allPaths) {
        const ext = path.extname(relPath).toLowerCase();
        const lang = detectLanguage(ext);
        const hash = hashes[relPath] || null;
        const fileId = store.upsertFile(relPath, {
          language: lang,
          hash,
          mtime: null,
          size: null
        });
        fileIdMap.set(relPath, fileId);
      }

      // 2. Migrate fileData (routes, models, functions, envVars, dbTables)
      for (const [relPath, data] of Object.entries(cache.fileData || {})) {
        const fileId = fileIdMap.get(relPath);
        if (!fileId) continue;

        const symbols = (data.functions || []).map(name => ({
          name: typeof name === 'string' ? name : name.name || 'unknown',
          kind: 'function',
          exported: true
        }));

        const models = (data.models || []).map(m => ({
          name: typeof m === 'string' ? m : m.name || 'unknown',
          kind: m.kind || m.type || 'unknown',
          fields: m.fields || null
        }));

        const envVars = (data.envVars || []).map(v =>
          typeof v === 'string' ? v : v.name || String(v)
        );

        const dbTables = (data.dbTables || []).map(t => ({
          table: t.table || t.table_name || t.name || 'unknown',
          operation: t.operation || null
        }));

        store.storeExtraction(fileId, {
          imports: [], // will be filled from importGraph
          symbols,
          routes: data.routes || [],
          models,
          envVars,
          dbTables
        });
      }

      // 3. Migrate import graph
      for (const [fromPath, deps] of Object.entries(cache.importGraph || {})) {
        const fromId = fileIdMap.get(fromPath);
        if (!fromId) continue;

        const imports = (deps || []).map(toPath => {
          const toId = fileIdMap.get(toPath) || null;
          return { path: toPath, resolvedFileId: toId };
        });

        // Only insert imports (don't clear other extraction data)
        const db = store.db;
        db.prepare('DELETE FROM imports WHERE from_file_id = ?').run(fromId);
        const ins = db.prepare(
          'INSERT INTO imports (from_file_id, to_file_id, to_path, resolved) VALUES (?,?,?,?)'
        );
        for (const imp of imports) {
          ins.run(fromId, imp.resolvedFileId, imp.path, imp.resolvedFileId ? 1 : 0);
        }
      }

      // 4. Migrate domains
      for (const [domainName, cluster] of Object.entries(cache.domains || {})) {
        const domainId = store.upsertDomain(domainName, {
          fileCount: (cluster.files || []).length
        });
        for (const filePath of (cluster.files || [])) {
          const fileId = fileIdMap.get(filePath);
          if (fileId) store.assignFileToDomain(fileId, domainId);
        }
      }

      // 5. Migrate meta
      if (cache.meta) {
        store.setMeta('total_files', String(cache.meta.totalFiles || 0));
        store.setMeta('total_routes', String(cache.meta.totalRoutes || 0));
        store.setMeta('total_import_edges', String(cache.meta.totalImportEdges || 0));
        store.setMeta('index_duration_ms', String(cache.meta.indexDuration || 0));
        store.setMeta('last_full_sync', cache.meta.lastIndexed || new Date().toISOString());
      }
      if (cache.stack) {
        store.setMeta('stack_json', JSON.stringify(cache.stack));
      }
    });

    // Backup old files
    backupFile(graphCachePath);
    backupFile(hashesPath);
    backupFile(mapPath);

    const fileCount = store.getFileCount();
    console.log(`[CARTO] Migration complete: ${fileCount} files migrated to SQLite`);
    return true;

  } catch (err) {
    console.warn(`[CARTO] Migration failed, preserving JSON files: ${err.message}`);
    // Delete partially created DB if it has no useful data
    const dbPath2 = path.join(cartoDir, 'carto.db');
    try {
      store.close();
      fs.unlinkSync(dbPath2);
      fs.unlinkSync(dbPath2 + '-wal');
      fs.unlinkSync(dbPath2 + '-shm');
    } catch {}
    return false;
  }
}

function backupFile(filePath) {
  if (fs.existsSync(filePath)) {
    try {
      fs.renameSync(filePath, filePath + '.bak');
    } catch {}
  }
}

function detectLanguage(ext) {
  const map = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.rb': 'ruby',
    '.java': 'java',
    '.cs': 'csharp',
    '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.h': 'cpp', '.hpp': 'cpp',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.r': 'r', '.R': 'r',
    '.prisma': 'prisma',
    '.html': 'html'
  };
  return map[ext] || 'unknown';
}

module.exports = { migrateFromJsonBlobs };
