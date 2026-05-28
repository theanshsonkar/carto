'use strict';

/**
 * C/C++ extractor — tree-sitter for imports (#include) + symbols.
 * No framework-specific route extraction (C++ has no dominant web framework convention).
 */
const tsParser = require('../tree-sitter-parser');

module.exports = {
  name: 'cpp',
  extensions: ['.cpp', '.cc', '.cxx', '.h', '.hpp'],
  extract(content, filename) {
    const ext = require('path').extname(filename) || '.cpp';
    const { imports: tsImports, symbols: tsSymbols } = tsParser.isAvailable()
      ? tsParser.extractAll(content, ext)
      : { imports: [], symbols: [] };

    return {
      routes:     [],
      models:     extractCppStructs(content),
      functions:  tsSymbols.filter(s => s.kind === 'function')
                           .map(s => ({ name: s.name, params: '—', returnType: '—' })),
      envVars:    extractCppEnvVars(content),
      dbTables:   [],
      fetches:    [],
      storageKeys: [],
      _tsImports: tsImports,
      _tsSymbols: tsSymbols,
    };
  }
};

// ─── Structs/classes → models ─────────────────────────────────────────────────

function extractCppStructs(content) {
  const models = [];
  // struct User { int id; std::string name; };
  const structPattern = /(?:struct|class)\s+(\w+)\s*(?::\s*[^{]*)?\{([^}]*)\}/g;
  let m;
  while ((m = structPattern.exec(content)) !== null) {
    const name = m[1];
    if (['public', 'private', 'protected'].includes(name.toLowerCase())) continue;
    const body = m[2];
    const fields = [];
    const fieldPattern = /(?:int|float|double|bool|char|std::string|string|auto|size_t|uint\w*|int\w*)\s+(\w+)\s*[;=]/g;
    let fm;
    while ((fm = fieldPattern.exec(body)) !== null) {
      fields.push({ name: fm[1], type: 'auto' });
    }
    if (fields.length > 0) {
      models.push({ className: name, fields, kind: 'cpp-struct' });
    }
  }
  return models;
}

// ─── Env vars ─────────────────────────────────────────────────────────────────

function extractCppEnvVars(content) {
  const vars = new Set();
  // getenv("VAR") / std::getenv("VAR")
  const pattern = /(?:std::)?getenv\s*\(\s*"([^"]+)"/g;
  let m;
  while ((m = pattern.exec(content)) !== null) vars.add(m[1]);
  return [...vars];
}
