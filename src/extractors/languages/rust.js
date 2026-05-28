'use strict';

/**
 * Rust extractor — uses tree-sitter for imports (use declarations) and symbols.
 * Regex for Actix/Axum/Rocket route extraction and env var detection.
 */
const tsParser = require('../tree-sitter-parser');

module.exports = {
  name: 'rust',
  extensions: ['.rs'],
  extract(content, filename) {
    const { imports: tsImports, symbols: tsSymbols } = tsParser.isAvailable()
      ? tsParser.extractAll(content, '.rs')
      : { imports: [], symbols: [] };

    return {
      routes:      extractRustRoutes(content),
      models:      extractRustStructs(content),
      functions:   tsSymbols.filter(s => s.kind === 'function').map(s => ({ name: s.name, params: '—', returnType: '—' })),
      envVars:     extractRustEnvVars(content),
      dbTables:    [],
      fetches:     [],
      storageKeys: [],
      _tsImports:  tsImports,
      _tsSymbols:  tsSymbols,
    };
  }
};

// ─── Routes ───────────────────────────────────────────────────────────────────

function extractRustRoutes(content) {
  const routes = [];

  // Actix-web: #[get("/path")] / #[post("/path")] / #[route("/path", method="GET")]
  const actixPattern = /#\[(get|post|put|delete|patch|head|options)\s*\(\s*"([^"]+)"\s*\)/gi;
  let m;
  while ((m = actixPattern.exec(content)) !== null) {
    routes.push({ method: m[1].toUpperCase(), path: m[2], functionName: '[handler]' });
  }

  // Axum: .route("/path", get(handler)) / .route("/path", post(handler))
  const axumPattern = /\.route\s*\(\s*"([^"]+)"\s*,\s*(get|post|put|delete|patch)\s*\(\s*(\w+)/gi;
  while ((m = axumPattern.exec(content)) !== null) {
    routes.push({ method: m[2].toUpperCase(), path: m[1], functionName: m[3] });
  }

  // Rocket: #[get("/path")] fn handler
  const rocketPattern = /#\[(get|post|put|delete|patch)\s*\(\s*"([^"]+)"\s*\)\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gi;
  while ((m = rocketPattern.exec(content)) !== null) {
    routes.push({ method: m[1].toUpperCase(), path: m[2], functionName: m[3] });
  }

  // Deduplicate
  const seen = new Set();
  return routes.filter(r => {
    const key = `${r.method}::${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Structs → models ─────────────────────────────────────────────────────────

function extractRustStructs(content) {
  const models = [];
  // pub struct User { pub id: u64, pub name: String }
  const structPattern = /(?:pub\s+)?struct\s+(\w+)\s*\{([^}]*)\}/g;
  let m;
  while ((m = structPattern.exec(content)) !== null) {
    const name = m[1];
    const body = m[2];
    const fields = [];
    const fieldPattern = /(?:pub\s+)?(\w+)\s*:\s*([\w:<>, &']+)/g;
    let fm;
    while ((fm = fieldPattern.exec(body)) !== null) {
      fields.push({ name: fm[1], type: fm[2].trim() });
    }
    if (fields.length > 0) {
      models.push({ className: name, fields, kind: 'rust-struct' });
    }
  }
  return models;
}

// ─── Env vars ─────────────────────────────────────────────────────────────────

function extractRustEnvVars(content) {
  const vars = new Set();
  // std::env::var("VAR") / env::var("VAR") / env!("VAR")
  const pattern = /(?:std::)?env::(?:var|var_os)\s*\(\s*"([^"]+)"|env!\s*\(\s*"([^"]+)"/g;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    vars.add(m[1] || m[2]);
  }
  return [...vars];
}
