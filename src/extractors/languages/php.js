'use strict';

/**
 * PHP extractor — regex-based.
 *
 * Tree-sitter-php exists but is heavy and not yet in Carto's optional-deps
 * matrix. Regex coverage is sufficient for Carto's needs: routes + models +
 * env vars + namespace imports.
 *
 * Frameworks supported:
 *   - Laravel: `Route::get('/path', ...)`, controller method annotations
 *   - Symfony: `#[Route('/path', methods: ['GET'])]` attribute syntax
 *   - Standard PHP namespaces and `use` imports
 */

module.exports = {
  name: 'php',
  extensions: ['.php'],
  extract(content, filename) {
    return {
      routes:     extractPhpRoutes(content),
      models:     extractPhpModels(content),
      functions:  extractPhpFunctions(content),
      envVars:    extractPhpEnvVars(content),
      dbTables:   [],
      fetches:    [],
      storageKeys: [],
      _tsImports: extractPhpImports(content),
      _tsSymbols: extractPhpSymbols(content),
    };
  },
};

// ── Routes ───────────────────────────────────────────────────────────
function extractPhpRoutes(content) {
  const routes = [];

  // Laravel: Route::get('/path', ...) — also match, post, put, patch, delete, any
  const laravelPattern = /Route::(get|post|put|patch|delete|any|match|options)\s*\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = laravelPattern.exec(content)) !== null) {
    const method = m[1].toUpperCase();
    routes.push({ method: method === 'ANY' ? 'ALL' : method, path: m[2], functionName: '[laravel]' });
  }

  // Laravel resource: Route::resource('users', UserController::class)
  const laravelResource = /Route::resource\s*\(\s*['"]([^'"]+)['"]/g;
  while ((m = laravelResource.exec(content)) !== null) {
    const r = m[1].startsWith('/') ? m[1] : `/${m[1]}`;
    routes.push(
      { method: 'GET', path: r, functionName: 'index' },
      { method: 'POST', path: r, functionName: 'store' },
      { method: 'GET', path: `${r}/{id}`, functionName: 'show' },
      { method: 'PUT', path: `${r}/{id}`, functionName: 'update' },
      { method: 'DELETE', path: `${r}/{id}`, functionName: 'destroy' },
    );
  }

  // Symfony attribute routes: #[Route('/path', methods: ['GET', 'POST'])]
  const symfonyAttr = /#\[Route\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*methods\s*:\s*\[([^\]]+)\])?/g;
  while ((m = symfonyAttr.exec(content)) !== null) {
    const path_ = m[1];
    const methodsList = m[2] || "'GET'";
    const methods = methodsList.match(/'(\w+)'|"(\w+)"/g) || [];
    if (methods.length === 0) {
      routes.push({ method: 'GET', path: path_, functionName: '[symfony]' });
    } else {
      for (const mt of methods) {
        const cleaned = mt.replace(/['"]/g, '').toUpperCase();
        routes.push({ method: cleaned, path: path_, functionName: '[symfony]' });
      }
    }
  }

  // Symfony annotation routes (older style): @Route("/path", methods={"GET"})
  const symfonyAnn = /@Route\s*\(\s*"([^"]+)"(?:\s*,\s*methods\s*=\s*\{([^}]+)\})?/g;
  while ((m = symfonyAnn.exec(content)) !== null) {
    const path_ = m[1];
    const methodsList = m[2] || '"GET"';
    const methods = methodsList.match(/"(\w+)"/g) || [];
    if (methods.length === 0) {
      routes.push({ method: 'GET', path: path_, functionName: '[symfony-ann]' });
    } else {
      for (const mt of methods) {
        routes.push({ method: mt.replace(/"/g, '').toUpperCase(), path: path_, functionName: '[symfony-ann]' });
      }
    }
  }

  const seen = new Set();
  return routes.filter(r => {
    const key = `${r.method}::${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Models (Eloquent + Doctrine) ───────────────────────────────────
function extractPhpModels(content) {
  const models = [];

  // Eloquent: class X extends Model
  const eloquent = /class\s+(\w+)\s+extends\s+(?:Model|Authenticatable)\b/g;
  let m;
  while ((m = eloquent.exec(content)) !== null) {
    const fields = [];
    // protected $fillable = ['name', 'email']
    const fillable = new RegExp(`class\\s+${m[1]}[\\s\\S]{0,2000}?\\$fillable\\s*=\\s*\\[([^\\]]+)\\]`).exec(content);
    if (fillable) {
      const names = fillable[1].match(/'(\w+)'|"(\w+)"/g) || [];
      for (const n of names) {
        fields.push({ name: n.replace(/['"]/g, ''), type: 'attr' });
      }
    }
    models.push({ className: m[1], fields, kind: 'eloquent' });
  }

  // Doctrine: #[ORM\Entity] or @ORM\Entity then class X
  const doctrine = /(?:#\[ORM\\Entity[^\]]*\]|@ORM\\Entity)[\s\S]{0,300}?class\s+(\w+)/g;
  while ((m = doctrine.exec(content)) !== null) {
    models.push({ className: m[1], fields: [], kind: 'doctrine' });
  }

  return models;
}

// ── Functions ──────────────────────────────────────────────────────
function extractPhpFunctions(content) {
  const out = [];
  const pattern = /(?:public|private|protected)?\s*(?:static\s+)?function\s+(\w+)\s*\(/g;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    out.push({ name: m[1], params: '—', returnType: '—' });
  }
  // Top-level `function foo()` (no visibility keyword)
  const top = /^function\s+(\w+)\s*\(/gm;
  while ((m = top.exec(content)) !== null) {
    if (!out.some(f => f.name === m[1])) {
      out.push({ name: m[1], params: '—', returnType: '—' });
    }
  }
  return out;
}

// ── Env vars ───────────────────────────────────────────────────────
function extractPhpEnvVars(content) {
  const vars = new Set();
  // env('VAR') — Laravel helper
  const env = /\benv\s*\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g;
  let m;
  while ((m = env.exec(content)) !== null) vars.add(m[1]);
  // $_ENV['VAR'] / getenv('VAR')
  const dollar = /\$_ENV\s*\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]|getenv\s*\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g;
  while ((m = dollar.exec(content)) !== null) vars.add(m[1] || m[2]);
  return [...vars];
}

// ── Imports (use Namespace\Class) ──────────────────────────────────
function extractPhpImports(content) {
  const out = [];
  const pattern = /^use\s+([\w\\]+)(?:\s+as\s+\w+)?;/gm;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    out.push({ from: m[1], symbols: [] });
  }
  // require/include statements
  const req = /(?:require|require_once|include|include_once)\s*\(?\s*['"]([^'"]+)['"]/g;
  while ((m = req.exec(content)) !== null) {
    out.push({ from: m[1], symbols: [] });
  }
  return out;
}

// ── Symbols ────────────────────────────────────────────────────────
function extractPhpSymbols(content) {
  const out = [];
  // Classes
  const classes = /class\s+(\w+)/g;
  let m;
  while ((m = classes.exec(content)) !== null) {
    out.push({ name: m[1], kind: 'class', exported: true });
  }
  // Interfaces / traits
  const others = /(?:interface|trait)\s+(\w+)/g;
  while ((m = others.exec(content)) !== null) {
    out.push({ name: m[1], kind: 'interface', exported: true });
  }
  // Top-level functions
  const fns = /^function\s+(\w+)\s*\(/gm;
  while ((m = fns.exec(content)) !== null) {
    out.push({ name: m[1], kind: 'function', exported: true });
  }
  return out;
}
