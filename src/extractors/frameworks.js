'use strict';

/**
 * Long-tail framework extractors.
 *
 * The mainstream frameworks (Express, Next.js, FastAPI, Flask, Gin, tRPC,
 * Rails) live inside their language plugins. This module covers the
 * long tail — frameworks that share a language with one of the above
 * but use a different API surface.
 *
 * JS/TS:
 *   - NestJS         — `@Controller`, `@Get/@Post/...` decorators
 *   - Remix          — file-based routes/$id.tsx, loader/action exports
 *   - SvelteKit      — +page.svelte / +server.ts file-based routes
 *   - Astro          — pages/*.astro file-based routes
 *
 * Python:
 *   - Quart          — `@app.route('/path')` async-flask
 *   - Sanic          — `@app.get('/path')`
 *   - Tornado        — `RequestHandler` subclasses + URLSpec maps
 *
 * Go:
 *   - Fiber          — `app.Get("/path", handler)`
 *   - Iris           — `app.Get("/path", handler)` (similar shape)
 *
 * Each extractor returns an array of `{ method, path, functionName }`.
 * The language plugins decide whether to call us; routes are merged + deduped
 * against the plugin's primary output.
 */

const path = require('path');

/**
 * extractJsFrameworkRoutes(content, filename) → Route[]
 *
 * Covers NestJS + Remix + SvelteKit + Astro.
 */
function extractJsFrameworkRoutes(content, filename) {
  // Cheap pre-guard: bail if the file has neither a hint for NestJS
  // decorators nor a filename that looks like a file-routed framework
  // location (Remix/SvelteKit/Astro). This skips the bulk of source
  // files (which are not framework-routed) without paying any regex
  // walk cost.
  if (typeof content !== 'string') return [];
  const hasNestHint = content.indexOf('@Controller') !== -1;
  const fname = (filename || '').toLowerCase().replace(/\\/g, '/');
  const looksFileRouted = /\b(?:app\/)?routes\//.test(fname) || /\/routes\//.test(fname) || /\/pages\//.test(fname);
  if (!hasNestHint && !looksFileRouted) return [];

  const out = [];
  if (hasNestHint) out.push(...extractNestJsRoutes(content));
  if (looksFileRouted) {
    out.push(...extractRemixRoutes(content, filename));
    out.push(...extractSvelteKitRoutes(content, filename));
    out.push(...extractAstroRoutes(content, filename));
  }
  return dedupe(out);
}

function extractNestJsRoutes(content) {
  // Cheap pre-guard: NestJS files always contain `@Controller(` near the
  // top. Without this guard every JS/TS file pays a regex walk; with it
  // only NestJS files (a tiny fraction in any real repo) pay the cost.
  if (typeof content !== 'string' || content.indexOf('@Controller') === -1) return [];
  const out = [];
  // First find @Controller('prefix') decorator if present.
  let controllerPrefix = '';
  const controllerMatch = /@Controller\s*\(\s*['"]([^'"]+)['"]/.exec(content);
  if (controllerMatch) controllerPrefix = controllerMatch[1];
  // Strip leading slash for clean join.
  const prefix = controllerPrefix.startsWith('/') ? controllerPrefix : (controllerPrefix ? '/' + controllerPrefix : '');

  // Method decorators: @Get('/x') / @Post() / @Put('id') / ...
  const pattern = /@(Get|Post|Put|Delete|Patch|Options|Head|All)\s*\(\s*(?:['"]([^'"]*)['"])?\s*\)/g;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    const method = m[1] === 'All' ? 'ALL' : m[1].toUpperCase();
    let routePath = m[2] || '';
    if (routePath && !routePath.startsWith('/')) routePath = '/' + routePath;
    const fullPath = (prefix + routePath) || '/';
    out.push({ method, path: fullPath, functionName: '[nestjs]' });
  }
  return out;
}

function extractRemixRoutes(content, filename) {
  // Remix routes live at routes/*.tsx or app/routes/*.tsx and export
  // `loader` / `action` functions. We treat the file as a route if it
  // exports one of those.
  const out = [];
  const lower = (filename || '').toLowerCase().replace(/\\/g, '/');
  if (!/\b(?:app\/)?routes\//.test(lower)) return out;
  const hasLoader = /\bexport\s+(?:async\s+)?(?:function|const)\s+loader\b/.test(content);
  const hasAction = /\bexport\s+(?:async\s+)?(?:function|const)\s+action\b/.test(content);
  if (!hasLoader && !hasAction) return out;

  // Derive the URL path from the filename.
  //   routes/users.$id.tsx  → /users/:id
  // Dots split segments, `$param` becomes `:param`, and `_index` / `index`
  // collapse to the trailing slash.
  const base = path.posix.basename(lower).replace(/\.[a-z]+$/, '');
  const segments = base.split('.')
    .filter(s => s && s !== '_index' && s !== 'index')
    .map(s => s.startsWith('$') ? ':' + s.slice(1) : s);
  const urlPath = '/' + segments.join('/');

  if (hasLoader) out.push({ method: 'GET', path: urlPath, functionName: 'loader' });
  if (hasAction) out.push({ method: 'POST', path: urlPath, functionName: 'action' });
  return out;
}

function extractSvelteKitRoutes(content, filename) {
  // SvelteKit: src/routes/foo/+page.svelte or +server.ts
  const out = [];
  const lower = (filename || '').toLowerCase().replace(/\\/g, '/');
  if (!/\/routes\//.test(lower)) return out;
  const base = path.posix.basename(lower);
  if (base !== '+page.svelte' && base !== '+page.ts' && base !== '+server.ts' && base !== '+server.js') return out;

  // Convert path: src/routes/users/[id]/+server.ts → /users/:id
  const dir = path.posix.dirname(lower).replace(/^.*\/routes/, '');
  const urlPath = (dir || '/').replace(/\[([^\]]+)\]/g, ':$1') || '/';

  if (base.startsWith('+server')) {
    // Look for exported GET, POST, etc.
    const httpExports = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    for (const verb of httpExports) {
      const re = new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|const)\\s+${verb}\\b`);
      if (re.test(content)) out.push({ method: verb, path: urlPath, functionName: `[sveltekit/${verb}]` });
    }
  } else {
    out.push({ method: 'GET', path: urlPath, functionName: '[sveltekit/page]' });
  }
  return out;
}

function extractAstroRoutes(content, filename) {
  // Astro pages live at src/pages/*.astro. The URL is the filename.
  const out = [];
  const lower = (filename || '').toLowerCase().replace(/\\/g, '/');
  if (!/\/pages\/.*\.astro$/.test(lower) && !/\/pages\/.*\.(js|ts)$/.test(lower)) return out;
  const rel = lower.split('/pages/').pop() || '';
  const ext = path.posix.extname(rel);
  const base = rel.slice(0, rel.length - ext.length);
  const segments = base.split('/').filter(s => s && s !== 'index');
  const urlPath = '/' + segments.map(s => s.replace(/\[([^\]]+)\]/g, ':$1')).join('/');
  out.push({ method: 'GET', path: urlPath || '/', functionName: '[astro]' });
  // Astro API endpoints export GET, POST, etc.
  if (ext === '.js' || ext === '.ts') {
    const httpExports = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    for (const verb of httpExports) {
      const re = new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|const)\\s+${verb}\\b`);
      if (re.test(content) && !out.some(r => r.method === verb && r.path === urlPath)) {
        out.push({ method: verb, path: urlPath || '/', functionName: `[astro/${verb}]` });
      }
    }
  }
  return out;
}

/**
 * extractPythonFrameworkRoutes(content) — Quart, Sanic, Tornado.
 */
function extractPythonFrameworkRoutes(content) {
  const out = [];
  let m;
  // Cheap pre-guard: skip files that obviously don't use Sanic or Tornado.
  const looksSanic = content.indexOf('sanic') !== -1 || content.indexOf('@app.') !== -1 || content.indexOf('@blueprint.') !== -1;
  const looksTornado = content.indexOf('tornado') !== -1;
  if (!looksSanic && !looksTornado) return out;

  // Quart: @app.route('/path', methods=['GET', 'POST']) — same shape as Flask
  // (covered by python.js's flask extractor). Sanic uses similar decorators.
  // Sanic: @app.get('/path') / @app.post(...) etc.
  if (looksSanic) {
    const sanic = /@(?:app|blueprint)\.(get|post|put|delete|patch|head|options)\s*\(\s*['"]([^'"]+)['"]/g;
    while ((m = sanic.exec(content)) !== null) {
      out.push({ method: m[1].toUpperCase(), path: m[2], functionName: '[sanic/quart]' });
    }
  }
  // Tornado: app = Application([(r"/path", HandlerClass), ...])
  if (looksTornado) {
    const tornado = /\(\s*r?["']([^"']+)["']\s*,\s*(\w+)\s*\)/g;
    while ((m = tornado.exec(content)) !== null) {
      // Heuristic: only count if HandlerClass name suggests it's a Tornado
      // handler (ends with Handler/View) and the file imports tornado.
      if ((m[2].endsWith('Handler') || m[2].endsWith('View')) && /import\s+tornado|from\s+tornado/.test(content)) {
        out.push({ method: 'ALL', path: m[1], functionName: m[2] });
      }
    }
  }
  return dedupe(out);
}

/**
 * extractGoFrameworkRoutes(content) — Fiber + Iris.
 *
 * Fiber and Iris share the receiver-method pattern with Gin (app.Get,
 * app.Post, ...). They're detected because of imports. We're lenient:
 * any `*.Get("...", handler)` pattern qualifies as long as `gofiber/fiber`
 * or `kataras/iris` appears in imports.
 */
function extractGoFrameworkRoutes(content) {
  const out = [];
  const isFiber = /gofiber\/fiber/.test(content);
  const isIris = /kataras\/iris/.test(content);
  if (!isFiber && !isIris) return out;
  const pattern = /\b\w+\.(Get|Post|Put|Delete|Patch|Head|Options|All)\s*\(\s*["']([^"']+)["']/g;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    const tag = isFiber ? '[fiber]' : '[iris]';
    out.push({ method: m[1].toUpperCase() === 'ALL' ? 'ALL' : m[1].toUpperCase(), path: m[2], functionName: tag });
  }
  return dedupe(out);
}

function dedupe(routes) {
  const seen = new Set();
  return routes.filter(r => {
    const key = `${r.method}::${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  extractJsFrameworkRoutes,
  extractPythonFrameworkRoutes,
  extractGoFrameworkRoutes,
  // for unit tests:
  extractNestJsRoutes,
  extractRemixRoutes,
  extractSvelteKitRoutes,
  extractAstroRoutes,
};
