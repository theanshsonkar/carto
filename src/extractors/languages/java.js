'use strict';

/**
 * Java extractor — tree-sitter for imports + symbols.
 * Regex for Spring/Jakarta route extraction and JPA model detection.
 */
const tsParser = require('../tree-sitter-parser');

module.exports = {
  name: 'java',
  extensions: ['.java'],
  extract(content, filename) {
    const { imports: tsImports, symbols: tsSymbols } = tsParser.isAvailable()
      ? tsParser.extractAll(content, '.java')
      : { imports: [], symbols: [] };

    return {
      routes:     extractJavaRoutes(content),
      models:     extractJavaModels(content),
      functions:  tsSymbols.filter(s => s.kind === 'method' || s.kind === 'function')
                           .map(s => ({ name: s.name, params: '—', returnType: '—' })),
      envVars:    extractJavaEnvVars(content),
      dbTables:   [],
      fetches:    [],
      storageKeys: [],
      _tsImports: tsImports,
      _tsSymbols: tsSymbols,
    };
  }
};

// ─── Routes ───────────────────────────────────────────────────────────────────

function extractJavaRoutes(content) {
  const routes = [];

  // Spring MVC / Spring Boot: @GetMapping("/path") / @RequestMapping(value="/path", method=GET)
  const mappingPattern = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g;
  let m;
  while ((m = mappingPattern.exec(content)) !== null) {
    const annotation = m[1];
    const path = m[2];
    let method = 'ALL';
    if (annotation === 'GetMapping') method = 'GET';
    else if (annotation === 'PostMapping') method = 'POST';
    else if (annotation === 'PutMapping') method = 'PUT';
    else if (annotation === 'DeleteMapping') method = 'DELETE';
    else if (annotation === 'PatchMapping') method = 'PATCH';
    routes.push({ method, path, functionName: '[handler]' });
  }

  // JAX-RS: @GET @Path("/path") / @POST @Path("/path")
  const jaxrsPattern = /@(GET|POST|PUT|DELETE|PATCH)\s*[\s\S]{0,100}?@Path\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = jaxrsPattern.exec(content)) !== null) {
    routes.push({ method: m[1], path: m[2], functionName: '[handler]' });
  }

  const seen = new Set();
  return routes.filter(r => {
    const key = `${r.method}::${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Models (JPA entities) ────────────────────────────────────────────────────

function extractJavaModels(content) {
  const models = [];

  // @Entity class UserEntity { ... }
  const entityPattern = /@Entity[\s\S]{0,200}?(?:public\s+)?class\s+(\w+)/g;
  let m;
  while ((m = entityPattern.exec(content)) !== null) {
    const className = m[1];
    const fields = [];
    // @Column private String name;
    const fieldPattern = /(?:private|protected|public)\s+([\w<>[\],\s]+)\s+(\w+)\s*;/g;
    let fm;
    while ((fm = fieldPattern.exec(content)) !== null) {
      fields.push({ name: fm[2], type: fm[1].trim() });
    }
    models.push({ className, fields, kind: 'jpa-entity' });
  }

  // Record classes (Java 16+): public record User(String name, int age) {}
  const recordPattern = /(?:public\s+)?record\s+(\w+)\s*\(([^)]*)\)/g;
  while ((m = recordPattern.exec(content)) !== null) {
    const className = m[1];
    const paramStr = m[2];
    const fields = [];
    const paramPattern = /([\w<>[\],\s]+)\s+(\w+)/g;
    let pm;
    while ((pm = paramPattern.exec(paramStr)) !== null) {
      fields.push({ name: pm[2], type: pm[1].trim() });
    }
    models.push({ className, fields, kind: 'java-record' });
  }

  return models;
}

// ─── Env vars ─────────────────────────────────────────────────────────────────

function extractJavaEnvVars(content) {
  const vars = new Set();
  // System.getenv("VAR") / System.getenv().get("VAR")
  const pattern = /System\.getenv\s*\(\s*"([^"]+)"/g;
  let m;
  while ((m = pattern.exec(content)) !== null) vars.add(m[1]);
  // @Value("${VAR_NAME}") — Spring
  const valuePattern = /@Value\s*\(\s*"\$\{([^}]+)\}"/g;
  while ((m = valuePattern.exec(content)) !== null) vars.add(m[1]);
  return [...vars];
}
