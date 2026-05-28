'use strict';

/**
 * C# extractor — tree-sitter for imports (using directives) + symbols.
 * Regex for ASP.NET Core route extraction and EF Core model detection.
 */
const tsParser = require('../tree-sitter-parser');

module.exports = {
  name: 'csharp',
  extensions: ['.cs'],
  extract(content, filename) {
    const { imports: tsImports, symbols: tsSymbols } = tsParser.isAvailable()
      ? tsParser.extractAll(content, '.cs')
      : { imports: [], symbols: [] };

    return {
      routes:     extractCSharpRoutes(content),
      models:     extractCSharpModels(content),
      functions:  tsSymbols.filter(s => s.kind === 'method' || s.kind === 'function')
                           .map(s => ({ name: s.name, params: '—', returnType: '—' })),
      envVars:    extractCSharpEnvVars(content),
      dbTables:   [],
      fetches:    [],
      storageKeys: [],
      _tsImports: tsImports,
      _tsSymbols: tsSymbols,
    };
  }
};

// ─── Routes ───────────────────────────────────────────────────────────────────

function extractCSharpRoutes(content) {
  const routes = [];

  // ASP.NET Core attribute routing: [HttpGet("/path")] / [HttpGet] (no path)
  const httpPattern = /\[(HttpGet|HttpPost|HttpPut|HttpDelete|HttpPatch)(?:\s*\(\s*["']([^"']*?)["']\s*\))?\]/g;
  let m;
  while ((m = httpPattern.exec(content)) !== null) {
    const methodMap = { HttpGet: 'GET', HttpPost: 'POST', HttpPut: 'PUT', HttpDelete: 'DELETE', HttpPatch: 'PATCH' };
    const routePath = m[2] || '';
    routes.push({ method: methodMap[m[1]] || 'ALL', path: routePath || '/', functionName: '[handler]' });
  }

  // [Route("api/[controller]")] on controller class
  const routePattern = /\[Route\s*\(\s*["']([^"']+)["']\s*\)\]/g;
  while ((m = routePattern.exec(content)) !== null) {
    routes.push({ method: 'ALL', path: m[1], functionName: '[controller]' });
  }

  // Minimal API: app.MapGet("/path", handler) / app.MapPost("/path", handler)
  const mapPattern = /app\.Map(Get|Post|Put|Delete|Patch)\s*\(\s*["']([^"']+)["']/g;
  while ((m = mapPattern.exec(content)) !== null) {
    routes.push({ method: m[1].toUpperCase(), path: m[2], functionName: '[handler]' });
  }

  const seen = new Set();
  return routes.filter(r => {
    const key = `${r.method}::${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Models (EF Core entities) ────────────────────────────────────────────────

function extractCSharpModels(content) {
  const models = [];

  // [Table("users")] or DbSet<User> — EF Core entities
  // Simple heuristic: public class X with public properties
  const classPattern = /public\s+(?:partial\s+)?class\s+(\w+)(?:\s*:\s*[^{]*)?\s*\{([^}]{0,2000})\}/g;
  let m;
  while ((m = classPattern.exec(content)) !== null) {
    const className = m[1];
    const body = m[2];
    // Only extract if it looks like a model (has public properties)
    const propPattern = /public\s+([\w<>[\],?\s]+)\s+(\w+)\s*\{\s*get/g;
    const fields = [];
    let pm;
    while ((pm = propPattern.exec(body)) !== null) {
      fields.push({ name: pm[2], type: pm[1].trim() });
    }
    if (fields.length >= 2) {
      models.push({ className, fields, kind: 'csharp-class' });
    }
  }

  // Record types: public record User(string Name, int Age);
  const recordPattern = /public\s+record\s+(\w+)\s*\(([^)]*)\)/g;
  while ((m = recordPattern.exec(content)) !== null) {
    const className = m[1];
    const paramStr = m[2];
    const fields = [];
    const paramPattern = /([\w<>[\],?\s]+)\s+(\w+)/g;
    let pm;
    while ((pm = paramPattern.exec(paramStr)) !== null) {
      fields.push({ name: pm[2], type: pm[1].trim() });
    }
    if (fields.length > 0) {
      models.push({ className, fields, kind: 'csharp-record' });
    }
  }

  return models;
}

// ─── Env vars ─────────────────────────────────────────────────────────────────

function extractCSharpEnvVars(content) {
  const vars = new Set();
  // Environment.GetEnvironmentVariable("VAR")
  const pattern = /Environment\.GetEnvironmentVariable\s*\(\s*"([^"]+)"/g;
  let m;
  while ((m = pattern.exec(content)) !== null) vars.add(m[1]);
  // Configuration["VAR"] / config["VAR"] / _config["VAR"]
  const configPattern = /(?:Configuration|config|_config|_configuration)\s*\[\s*"([^"]+)"\s*\]/g;
  while ((m = configPattern.exec(content)) !== null) vars.add(m[1]);
  return [...vars];
}
