'use strict';

const { extractRoutes } = require('../routes');
const { extractModels } = require('../models');
const { extractFunctions } = require('../functions');
const { extractEnvVars } = require('../envvars');
const { extractDBTables } = require('../dbtables');
const tsParser = require('../tree-sitter-parser');
const { extractPythonFrameworkRoutes } = require('../frameworks');

module.exports = {
  name: 'python',
  extensions: ['.py'],
  extract(content, filename) {
    try {
      // Fast path: tree-sitter for imports + symbols
      const { imports: tsImports, symbols: tsSymbols } = tsParser.isAvailable()
        ? tsParser.extractAll(content, '.py')
        : { imports: [], symbols: [] };

      // Keep regex-based extractors for routes, models, env vars, db tables
      // (tree-sitter doesn't do deep FastAPI/Django/Flask route extraction)
      const mainRoutes = extractRoutes(content);
      const frameworkRoutes = extractPythonFrameworkRoutes(content);
      // Merge + dedupe (Sanic/Quart/Tornado long-tail)
      const seen = new Set(mainRoutes.map(r => `${r.method}::${r.path}`));
      const extra = frameworkRoutes.filter(r => {
        const key = `${r.method}::${r.path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return {
        routes:      [...mainRoutes, ...extra],
        models:      extractModels(content),
        functions:   tsSymbols.length > 0
          ? tsSymbols.filter(s => s.kind === 'function').map(s => ({ name: s.name, params: '—', returnType: '—' }))
          : extractFunctions(content, filename),
        envVars:     extractEnvVars(content),
        dbTables:    extractDBTables(content),
        fetches:     [],
        storageKeys: [],
        _tsImports:  tsImports,
        _tsSymbols:  tsSymbols,
      };
    } catch (err) {
      console.warn(`[CARTO] python plugin error on ${filename}: ${err.message}`);
      return {
        routes: [], models: [], functions: [], envVars: [], dbTables: [], fetches: [], storageKeys: [],
        // Record the failure so it's visible in `carto check`.
        _errors: [{ phase: 'extract', message: err.message || String(err) }],
      };
    }
  }
};
