'use strict';

/**
 * Kotlin extractor — regex-based.
 *
 * Reuses no tree-sitter for now (tree-sitter-kotlin exists as community
 * grammar but isn't in Carto's optional-deps yet). Regex covers the
 * cases that matter: Spring annotations, Ktor `routing { }` DSL, data
 * classes, top-level functions, imports.
 *
 * Frameworks supported:
 *   - Spring Boot / Spring MVC: `@GetMapping`, `@PostMapping`, etc.
 *   - Ktor: `get("/path") { ... }`, `post("/path") { ... }` inside routing blocks
 *   - Android (basic class detection)
 */

module.exports = {
  name: 'kotlin',
  extensions: ['.kt', '.kts'],
  extract(content, filename) {
    return {
      routes:     extractKotlinRoutes(content),
      models:     extractKotlinModels(content),
      functions:  extractKotlinFunctions(content),
      envVars:    extractKotlinEnvVars(content),
      dbTables:   [],
      fetches:    [],
      storageKeys: [],
      _tsImports: extractKotlinImports(content),
      _tsSymbols: extractKotlinSymbols(content),
    };
  },
};

// ── Routes ───────────────────────────────────────────────────────────
function extractKotlinRoutes(content) {
  const routes = [];
  let m;

  // Spring: @GetMapping("/path") / @RequestMapping(method = RequestMethod.GET, path = "/x")
  const springMethod = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g;
  while ((m = springMethod.exec(content)) !== null) {
    const method = m[1].replace('Mapping', '').toUpperCase();
    routes.push({ method, path: m[2], functionName: '[spring]' });
  }
  // @GetMapping with no path / no quotes — applies to controller root
  const springNoPath = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*(?:\(\s*\))?\s*\n/g;
  while ((m = springNoPath.exec(content)) !== null) {
    routes.push({ method: m[1].replace('Mapping', '').toUpperCase(), path: '/', functionName: '[spring]' });
  }

  // @RequestMapping(value = "/x", method = RequestMethod.GET)
  const requestMapping = /@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["'](?:\s*,\s*method\s*=\s*RequestMethod\.(\w+))?/g;
  while ((m = requestMapping.exec(content)) !== null) {
    routes.push({ method: m[2] ? m[2].toUpperCase() : 'ALL', path: m[1], functionName: '[spring]' });
  }

  // Ktor: get("/path") { ... }, post(...), put, delete, patch
  const ktorPattern = /\b(get|post|put|delete|patch|head|options)\s*\(\s*["']([^"']+)["']\s*\)\s*\{/g;
  while ((m = ktorPattern.exec(content)) !== null) {
    routes.push({ method: m[1].toUpperCase(), path: m[2], functionName: '[ktor]' });
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
function extractKotlinModels(content) {
  const models = [];
  let m;

  // data class User(val id: Int, val email: String)
  const dataClass = /data\s+class\s+(\w+)\s*\(([^)]*)\)/g;
  while ((m = dataClass.exec(content)) !== null) {
    const fields = parseKotlinParams(m[2]);
    models.push({ className: m[1], fields, kind: 'data-class' });
  }

  // @Entity / @Table annotated class
  const entity = /@(?:Entity|Table)(?:\([^)]*\))?\s*(?:@\w+(?:\([^)]*\))?\s*)*\s*(?:data\s+)?class\s+(\w+)\s*\(?([^)]*)\)?/g;
  while ((m = entity.exec(content)) !== null) {
    if (!models.some(x => x.className === m[1])) {
      const fields = parseKotlinParams(m[2] || '');
      models.push({ className: m[1], fields, kind: 'jpa-entity' });
    }
  }

  // Kotlinx serialization: @Serializable data class
  const serial = /@Serializable[\s\S]{0,80}?data\s+class\s+(\w+)\s*\(([^)]*)\)/g;
  while ((m = serial.exec(content)) !== null) {
    if (!models.some(x => x.className === m[1])) {
      const fields = parseKotlinParams(m[2]);
      models.push({ className: m[1], fields, kind: 'kotlinx-serializable' });
    }
  }

  return models;
}

function parseKotlinParams(params) {
  const fields = [];
  if (!params) return fields;
  const parts = params.split(',').map(s => s.trim()).filter(Boolean);
  for (const p of parts) {
    const match = /(?:val|var)?\s*(\w+)\s*:\s*([\w<>?]+)/.exec(p);
    if (match) fields.push({ name: match[1], type: match[2] });
  }
  return fields;
}

// ── Functions ──────────────────────────────────────────────────────
function extractKotlinFunctions(content) {
  const out = [];
  const pattern = /^(?:(?:public|private|internal|protected)\s+)?(?:suspend\s+)?fun\s+(\w+)\s*\(/gm;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    out.push({ name: m[1], params: '—', returnType: '—' });
  }
  return out;
}

// ── Env vars ───────────────────────────────────────────────────────
function extractKotlinEnvVars(content) {
  const vars = new Set();
  // System.getenv("VAR") / System.getProperty("VAR")
  const sys = /System\.(?:getenv|getProperty)\s*\(\s*["']([A-Z_][A-Z0-9_.]+)["']\s*\)/g;
  let m;
  while ((m = sys.exec(content)) !== null) vars.add(m[1]);
  // @Value("\${VAR}") Spring property
  const value = /@Value\s*\(\s*['"]\$\{([A-Z_][A-Z0-9_.]+)\}['"]/g;
  while ((m = value.exec(content)) !== null) vars.add(m[1]);
  return [...vars];
}

// ── Imports ────────────────────────────────────────────────────────
function extractKotlinImports(content) {
  const out = [];
  const pattern = /^import\s+([\w.]+)(?:\.\*)?(?:\s+as\s+\w+)?\s*$/gm;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    out.push({ from: m[1], symbols: [] });
  }
  return out;
}

// ── Symbols ────────────────────────────────────────────────────────
function extractKotlinSymbols(content) {
  const out = [];
  const classes = /(?:(?:open|abstract|sealed|data)\s+)?class\s+(\w+)/g;
  let m;
  while ((m = classes.exec(content)) !== null) {
    out.push({ name: m[1], kind: 'class', exported: true });
  }
  const objects = /\bobject\s+(\w+)/g;
  while ((m = objects.exec(content)) !== null) {
    out.push({ name: m[1], kind: 'object', exported: true });
  }
  const fns = /^(?:public|private|internal|protected)?\s*(?:suspend\s+)?fun\s+(\w+)\s*\(/gm;
  while ((m = fns.exec(content)) !== null) {
    out.push({ name: m[1], kind: 'function', exported: true });
  }
  return out;
}
