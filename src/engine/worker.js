'use strict';

const { workerData, parentPort } = require('worker_threads');
const { loadLanguagePlugins, getPluginForFile } = require('../extractors/loader');
const { extractImports } = require('../extractors/imports');
const path = require('path');
const fs = require('fs');

const plugins = loadLanguagePlugins();

parentPort.on('message', (task) => {
  const { id, filePath, projectRoot } = task;

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    // Real I/O failure (file deleted between discovery and extraction,
    // permission denied, etc.) — no point trying to extract. Caller
    // turns this into a skip; nothing reaches the index.
    parentPort.postMessage({ id, error: err.message, result: null });
    return;
  }

  const relPath = path.relative(projectRoot, filePath);
  const plugin = getPluginForFile(plugins, filePath);

  if (!plugin) {
    parentPort.postMessage({ id, result: null });
    return;
  }

  // Capture extractor failures as breadcrumbs instead of
  // dropping the file. The file still gets indexed (with empty
  // extraction arrays) so its existence and imports are visible — and
  // the failure shows up in `carto check` instead of vanishing.
  const errors = [];

  let extracted = { routes: [], models: [], functions: [], envVars: [], dbTables: [], fetches: [], storageKeys: [] };
  try {
    extracted = plugin.extract(content, relPath);
    // Plugin-internal failure breadcrumbs — see extractFile().
    if (Array.isArray(extracted._errors) && extracted._errors.length > 0) {
      for (const e of extracted._errors) {
        if (e && e.phase && e.message) errors.push({ phase: e.phase, message: e.message });
      }
    }
  } catch (err) {
    errors.push({ phase: 'extract', message: err.message || String(err) });
  }

  // Use tree-sitter imports if the plugin produced them (faster, no file I/O)
  // Fall back to the regex-based extractImports for resolution
  let imports = [];
  try {
    imports = extractImports(content, filePath, projectRoot);
  } catch (err) {
    errors.push({ phase: 'imports', message: err.message || String(err) });
  }

  // Attach tree-sitter symbols if available (richer than legacy functions array)
  const tsSymbols = extracted._tsSymbols || null;

  parentPort.postMessage({
    id,
    result: {
      relPath,
      content,
      routes: extracted.routes || [],
      models: extracted.models || [],
      functions: extracted.functions || [],
      envVars: extracted.envVars || [],
      dbTables: (extracted.dbTables || []).map(t => ({ ...t, file: relPath })),
      fetches: extracted.fetches || [],
      storageKeys: extracted.storageKeys || [],
      imports,
      tsSymbols,
      errors,
    }
  });
});
