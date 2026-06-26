'use strict';

/**
 * Swift extractor — regex-based.
 *
 * Tree-sitter-swift is community-maintained and not yet in Carto's
 * optional-deps. Regex coverage is adequate for typical iOS/macOS
 * codebases: SwiftUI views, structs, classes, protocols.
 *
 * Frameworks:
 *   - SwiftUI: View structs are surfaced as "models" of kind `swiftui-view`
 *     so AGENTS.md + change-plan tools can find them.
 *   - Vapor: backend Swift framework. `app.get("/path") { ... }` route DSL.
 */

module.exports = {
  name: 'swift',
  extensions: ['.swift'],
  extract(content, filename) {
    return {
      routes:     extractSwiftRoutes(content),
      models:     extractSwiftModels(content),
      functions:  extractSwiftFunctions(content),
      envVars:    extractSwiftEnvVars(content),
      dbTables:   [],
      fetches:    [],
      storageKeys: [],
      _tsImports: extractSwiftImports(content),
      _tsSymbols: extractSwiftSymbols(content),
    };
  },
};

// ── Routes (Vapor) ──────────────────────────────────────────────────
function extractSwiftRoutes(content) {
  const routes = [];

  // Vapor: app.get("path") { ... } / app.post(...), app.put, etc.
  const pattern = /\bapp\.(get|post|put|delete|patch|on)\s*\(\s*["']([^"']+)["']/g;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    routes.push({ method: m[1].toUpperCase(), path: m[2], functionName: '[vapor]' });
  }

  // Vapor: router.get("path", use: handler)
  const router = /\brouter\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/g;
  while ((m = router.exec(content)) !== null) {
    routes.push({ method: m[1].toUpperCase(), path: m[2], functionName: '[vapor]' });
  }

  const seen = new Set();
  return routes.filter(r => {
    const key = `${r.method}::${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Models ──────────────────────────────────────────────────────────
function extractSwiftModels(content) {
  const models = [];
  let m;

  // struct X: View / struct X: Codable / struct X
  const structPattern = /struct\s+(\w+)(?:\s*:\s*([\w,\s]+))?\s*\{/g;
  while ((m = structPattern.exec(content)) !== null) {
    const conforms = (m[2] || '').split(/[,\s]+/).filter(Boolean);
    const kind = conforms.includes('View') ? 'swiftui-view'
               : conforms.includes('Codable') || conforms.includes('Decodable') || conforms.includes('Encodable') ? 'codable'
               : 'struct';
    // Find `let foo: Type` / `var foo: Type` inside the struct.
    const idx = m.index + m[0].length;
    // Bounded body scan to keep regex cheap.
    const body = content.slice(idx, idx + 2000);
    const fieldPattern = /(?:let|var)\s+(\w+)\s*:\s*([\w<>?,\s\[\]]+?)(?:\s*=|$|\n)/g;
    const fields = [];
    let fm;
    while ((fm = fieldPattern.exec(body)) !== null && fields.length < 30) {
      fields.push({ name: fm[1], type: fm[2].trim() });
    }
    models.push({ className: m[1], fields, kind });
  }

  // class X: NSObject / class X { (capture top-level model-like classes)
  const classPattern = /class\s+(\w+)(?:\s*:\s*[\w,\s]+)?\s*\{/g;
  while ((m = classPattern.exec(content)) !== null) {
    if (!models.some(x => x.className === m[1])) {
      models.push({ className: m[1], fields: [], kind: 'class' });
    }
  }

  return models;
}

// ── Functions ──────────────────────────────────────────────────────
function extractSwiftFunctions(content) {
  const out = [];
  const pattern = /(?:public|private|internal|fileprivate)?\s*(?:static\s+)?func\s+(\w+)\s*\(/g;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    out.push({ name: m[1], params: '—', returnType: '—' });
  }
  return out;
}

// ── Env vars (ProcessInfo.processInfo.environment[...]) ──────────────
function extractSwiftEnvVars(content) {
  const vars = new Set();
  const pattern = /ProcessInfo\s*(?:\.\s*processInfo)?\s*\.\s*environment\s*\[\s*["']([A-Z_][A-Z0-9_]+)["']\s*\]/g;
  let m;
  while ((m = pattern.exec(content)) !== null) vars.add(m[1]);
  return [...vars];
}

// ── Imports ────────────────────────────────────────────────────────
function extractSwiftImports(content) {
  const out = [];
  const pattern = /^import\s+(\w+)/gm;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    out.push({ from: m[1], symbols: [] });
  }
  return out;
}

// ── Symbols ────────────────────────────────────────────────────────
function extractSwiftSymbols(content) {
  const out = [];
  let m;
  const types = /(?:class|struct|enum|protocol|actor)\s+(\w+)/g;
  while ((m = types.exec(content)) !== null) {
    out.push({ name: m[1], kind: 'class', exported: true });
  }
  const fns = /(?:public|private|internal|fileprivate)?\s*(?:static\s+)?func\s+(\w+)\s*\(/g;
  while ((m = fns.exec(content)) !== null) {
    out.push({ name: m[1], kind: 'function', exported: true });
  }
  return out;
}
