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
    parentPort.postMessage({ id, error: err.message, result: null });
    return;
  }

  const relPath = path.relative(projectRoot, filePath);
  const plugin = getPluginForFile(plugins, filePath);

  if (!plugin) {
    parentPort.postMessage({ id, result: null });
    return;
  }

  let extracted;
  try {
    extracted = plugin.extract(content, relPath);
  } catch (err) {
    parentPort.postMessage({ id, error: err.message, result: null });
    return;
  }

  const imports = extractImports(content, filePath, projectRoot);

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
    }
  });
});
