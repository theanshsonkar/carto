'use strict';

/**
 * Go extractor — Gin, Echo, Chi, net/http routes + struct types as models.
 */
module.exports = {
  name: 'go',
  extensions: ['.go'],
  extract(content, filename) {
    return {
      routes:      extractGoRoutes(content),
      models:      extractGoStructs(content),
      functions:   extractGoFunctions(content),
      envVars:     extractGoEnvVars(content),
      dbTables:    [],
      fetches:     [],
      storageKeys: [],
      events:      [],
      jobs:        extractGoCron(content),
    };
  }
};

// ─── Routes ───────────────────────────────────────────────────────────────────

function extractGoRoutes(content) {
  const routes = [];

  // Gin: r.GET("/path", handler) / router.POST("/path", handler)
  // Echo: e.GET("/path", handler)
  // Chi: r.Get("/path", handler)
  const ginPattern = /(?:r|router|e|g|api|v\d+)\s*\.\s*(GET|POST|PUT|DELETE|PATCH|get|post|put|delete|patch)\s*\(\s*"([^"]+)"\s*,\s*(\w+)/g;
  let m;
  while ((m = ginPattern.exec(content)) !== null) {
    routes.push({
      method: m[1].toUpperCase(),
      path: m[2],
      functionName: m[3]
    });
  }

  // net/http: http.HandleFunc("/path", handler)
  const httpPattern = /http\.HandleFunc\s*\(\s*"([^"]+)"\s*,\s*(\w+)/g;
  while ((m = httpPattern.exec(content)) !== null) {
    routes.push({ method: 'ALL', path: m[1], functionName: m[2] });
  }

  // http.Handle("/path", handler)
  const handlePattern = /http\.Handle\s*\(\s*"([^"]+)"\s*,\s*(\w+)/g;
  while ((m = handlePattern.exec(content)) !== null) {
    routes.push({ method: 'ALL', path: m[1], functionName: m[2] });
  }

  return routes;
}

// ─── Struct types → models ────────────────────────────────────────────────────

function extractGoStructs(content) {
  const models = [];
  // type User struct { ID int `json:"id"` ... }
  const structPattern = /type\s+(\w+)\s+struct\s*\{([^}]*)\}/g;
  let m;
  while ((m = structPattern.exec(content)) !== null) {
    const name = m[1];
    const body = m[2];
    const fields = [];

    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;
      // FieldName Type `json:"field_name"`
      const fieldMatch = trimmed.match(/^(\w+)\s+(\*?[\w\[\]]+)/);
      if (fieldMatch && fieldMatch[1] !== 'struct') {
        fields.push({ name: fieldMatch[1], type: fieldMatch[2] });
      }
    }

    if (fields.length > 0) {
      models.push({ className: name, fields, kind: 'go-struct' });
    }
  }
  return models;
}

// ─── Functions ────────────────────────────────────────────────────────────────

function extractGoFunctions(content) {
  const functions = [];
  // func FunctionName(params) returnType {
  const funcPattern = /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(([^)]*)\)/gm;
  let m;
  while ((m = funcPattern.exec(content)) !== null) {
    const name = m[1];
    if (name === 'init' || name === 'main') continue;
    functions.push({ name, params: m[2].trim() || '—' });
  }
  return functions;
}

// ─── Env vars ─────────────────────────────────────────────────────────────────

function extractGoEnvVars(content) {
  const vars = new Set();
  // os.Getenv("VAR_NAME") / os.LookupEnv("VAR_NAME")
  const envPattern = /os\.(?:Getenv|LookupEnv)\s*\(\s*"([^"]+)"/g;
  let m;
  while ((m = envPattern.exec(content)) !== null) vars.add(m[1]);
  return [...vars];
}

// ─── Cron jobs ────────────────────────────────────────────────────────────────

function extractGoCron(content) {
  const jobs = [];
  // cron.AddFunc("@every 1h", handler) / c.AddFunc("0 * * * *", handler)
  const cronPattern = /\.AddFunc\s*\(\s*"([^"]+)"/g;
  let m;
  while ((m = cronPattern.exec(content)) !== null) {
    jobs.push({ type: 'cron', expression: m[1] });
  }
  return jobs;
}
