'use strict';

/**
 * Plugin API — documented contract for language extractors.
 *
 * Carto plugins describe how to read a single language. They live at
 * `src/extractors/languages/*.js` and are auto-discovered by `loader.js`.
 *
 * Shape (all fields required unless marked optional):
 *
 *   {
 *     name:       string                — short, lower-case identifier ('python', 'kotlin')
 *     extensions: string[]              — file extensions including the dot ('.py', '.kt')
 *     extract(content, filename):
 *       returns {
 *         routes:      Route[],         — REST/RPC endpoints
 *         models:      Model[],         — data models / DB entities
 *         functions:   FuncSig[],       — exported functions (rough — used for change-plan ranking)
 *         envVars:     string[],        — env vars read by this file
 *         dbTables:    DbTable[],       — DB table mentions (optional, can be [])
 *         fetches:     Fetch[],         — HTTP calls (optional, mostly empty)
 *         storageKeys: string[],        — localStorage/SessionStorage keys (optional)
 *         _tsImports:  TsImport[],      — tree-sitter resolved imports (or [])
 *         _tsSymbols:  TsSymbol[],      — tree-sitter resolved symbols (or [])
 *       }
 *   }
 *
 * Concrete type aliases:
 *
 *   Route       = { method: string, path: string, functionName?: string }
 *   Model       = { className: string, fields: { name: string, type?: string }[], kind: string }
 *   FuncSig     = { name: string, params?: string, returnType?: string }
 *   DbTable     = { table: string, operation: string }
 *   Fetch       = { url: string, method?: string }
 *   TsImport    = { from: string, symbols?: string[] }
 *   TsSymbol    = { name: string, kind: string, line?: number, exported?: boolean,
 *                   is_default_export?: boolean }
 *
 * Failure mode: throw or return an object with `errors: [{ message, line? }]`.
 * The sync pipeline records errors in `extraction_errors` and continues —
 * one bad file never breaks indexing.
 *
 * Validation: `validatePlugin(p)` rejects malformed plugins before loader.js
 * registers them. Useful for the test suite + community plugin checks.
 */

const REQUIRED_FIELDS = ['name', 'extensions', 'extract'];
const RESULT_FIELDS = ['routes', 'models', 'functions'];

function validatePlugin(plugin) {
  const errors = [];
  if (!plugin || typeof plugin !== 'object') return ['plugin must be an object'];
  for (const f of REQUIRED_FIELDS) {
    if (!(f in plugin)) errors.push(`missing required field: ${f}`);
  }
  if (typeof plugin.name !== 'string' || plugin.name.length === 0) errors.push('name must be a non-empty string');
  if (!Array.isArray(plugin.extensions) || plugin.extensions.length === 0) errors.push('extensions must be a non-empty array');
  if (typeof plugin.extract !== 'function') errors.push('extract must be a function');
  return errors;
}

/**
 * Sanity-test a plugin against a sample input. Returns
 * { passed, errors }. Used by `validatePluginAgainstFixture()`
 * in the test harness — community contributions get a single
 * command to verify their plugin is wired correctly.
 */
function validatePluginOutput(result) {
  const errors = [];
  if (!result || typeof result !== 'object') return ['extract() must return an object'];
  for (const f of RESULT_FIELDS) {
    if (!(f in result)) errors.push(`extract() result missing field: ${f}`);
  }
  if ('routes' in result && !Array.isArray(result.routes)) errors.push('routes must be an array');
  if ('models' in result && !Array.isArray(result.models)) errors.push('models must be an array');
  if ('functions' in result && !Array.isArray(result.functions)) errors.push('functions must be an array');
  return errors;
}

/**
 * Minimal default empty result. Plugin authors can spread this and override
 * fields they actually implement.
 */
const EMPTY_RESULT = Object.freeze({
  routes: [],
  models: [],
  functions: [],
  envVars: [],
  dbTables: [],
  fetches: [],
  storageKeys: [],
  _tsImports: [],
  _tsSymbols: [],
});

module.exports = {
  validatePlugin,
  validatePluginOutput,
  REQUIRED_FIELDS,
  RESULT_FIELDS,
  EMPTY_RESULT,
};
