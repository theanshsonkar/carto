'use strict';

const parser = require('@babel/parser');
const path = require('path');
const jsPlugin = require('./javascript');
const tsParser = require('../tree-sitter-parser');
const { extractJsFrameworkRoutes } = require('../frameworks');

const TS_PARSE_OPTIONS = {
  sourceType: 'module',
  allowImportExportEverywhere: true,
  allowReturnOutsideFunction: true,
  plugins: ['typescript', 'jsx', 'decorators-legacy', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator']
};

module.exports = {
  name: 'typescript',
  extensions: ['.ts', '.tsx'],
  extract(content, filename) {
    // Fast path: tree-sitter for imports + symbols (runs on ALL TS files)
    const ext = path.extname(filename) || '.ts';
    const { imports: tsImports, symbols: tsSymbols } = tsParser.isAvailable()
      ? tsParser.extractAll(content, ext)
      : { imports: [], symbols: [] };

    // Convert tree-sitter symbols to legacy functions format
    const functions = tsSymbols
      .filter(s => s.kind === 'function' || s.kind === 'variable')
      .map(s => ({ name: s.name, params: '—', returnType: '—' }));

    // Check if this is an API handler file (needs deep Babel extraction)
    if (!jsPlugin._isApiHandlerFile(filename, tsImports, content)) {
      // Non-API file: tree-sitter only, no Babel.
      // We still run the regex-based long-tail framework extractor for
      // file-based routing (Remix / SvelteKit / Astro) — Babel isn't needed
      // for those, the path-shape comes from the filename.
      const fwRoutes = extractJsFrameworkRoutes(content, filename);
      return {
        routes:      fwRoutes,
        models:      [],
        functions,
        envVars:     _extractEnvVarsRegex(content),
        dbTables:    [],
        fetches:     [],
        storageKeys: [],
        events:      extractEventListeners(content),
        jobs:        extractQueueAndCron(content),
        _tsImports:  tsImports,
        _tsSymbols:  tsSymbols,
      };
    }

    // API handler file: run Babel for deep route/model/tRPC extraction
    let ast;
    try {
      ast = parser.parse(content, TS_PARSE_OPTIONS);
    } catch (err) {
      console.warn(`[CARTO] TS Babel parse failed on ${filename}: ${err.message} — using tree-sitter only`);
      return {
        routes:      [],
        models:      [],
        functions,
        envVars:     _extractEnvVarsRegex(content),
        dbTables:    [],
        fetches:     [],
        storageKeys: [],
        events:      extractEventListeners(content),
        jobs:        extractQueueAndCron(content),
        _tsImports:  tsImports,
        _tsSymbols:  tsSymbols,
        // Promote silent Babel failure to a breadcrumb.
        _errors:     [{ phase: 'parse', message: `Babel parse: ${err.message}` }],
      };
    }

    const routes = jsPlugin._extractExpressRoutes(ast, filename);
    extractTRPCRoutes(content, routes);
    // Long-tail framework routes (NestJS decorators, Remix/SvelteKit/Astro
    // file-based). Deduped against the Babel + tRPC output.
    const fwRoutes = extractJsFrameworkRoutes(content, filename);
    const seen = new Set(routes.map(r => `${r.method}::${r.path}`));
    for (const r of fwRoutes) {
      const key = `${r.method}::${r.path}`;
      if (!seen.has(key)) { routes.push(r); seen.add(key); }
    }

    return {
      routes,
      models:      [...extractTSInterfaces(ast), ...extractZodSchemas(content), ...extractDrizzleTables(content)],
      functions:   extractTSFunctions(ast),
      envVars:     jsPlugin._extractProcessEnv(ast),
      dbTables:    extractDrizzleTables(content).map(m => ({ tableName: m.name, modelName: m.name })),
      fetches:     jsPlugin._extractJSFetches(ast),
      storageKeys: [],
      events:      extractEventListeners(content),
      jobs:        extractQueueAndCron(content),
      _tsImports:  tsImports,
      _tsSymbols:  tsSymbols,
    };
  }
};

function _extractEnvVarsRegex(content) {
  const vars = new Set();
  const pattern = /process\.env\.([A-Z_][A-Z0-9_]*)|process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]]/g;
  let m;
  while ((m = pattern.exec(content)) !== null) vars.add(m[1] || m[2]);
  return [...vars].sort();
}

// ─── tRPC ────────────────────────────────────────────────────────────────────

function extractTRPCRoutes(content, routes) {
  // Pattern 1: createTRPCRouter({ name: procedure.query/mutation/subscription })
  const routerPattern = /createTRPCRouter\s*\(\s*\{([\s\S]*?)\n\}\s*\)/g;
  let m;
  while ((m = routerPattern.exec(content)) !== null) {
    parseTRPCBody(m[1], routes, content);
  }

  // Pattern 2: export const name = procedure.query/mutation/subscription
  const exportPattern = /export\s+const\s+(\w+)\s*=\s*\w*[Pp]rocedure([\s\S]*?)\.(query|mutation|subscription)\s*\(/g;
  while ((m = exportPattern.exec(content)) !== null) {
    const name = m[1];
    const type = m[3];
    const method = type === 'query' ? 'GET' : type === 'mutation' ? 'POST' : 'SUBSCRIBE';
    const input = extractTRPCInputSchema(m[2]);
    routes.push({ method, path: `/trpc/${name}`, functionName: name, inputSchema: input });
  }

  // Pattern 3: older router({}) style
  const altPattern = /(?:=\s*|^)router\s*\(\s*\{([\s\S]*?)\n\}\s*\)/gm;
  while ((m = altPattern.exec(content)) !== null) {
    parseTRPCBody(m[1], routes, content);
  }
}

function parseTRPCBody(body, routes, fullContent) {
  const procPattern = /(\w+)\s*:\s*\w*[Pp]rocedure([\s\S]*?)\.(query|mutation|subscription)\s*\(/g;
  let m;
  while ((m = procPattern.exec(body)) !== null) {
    const name = m[1];
    const type = m[3];
    const method = type === 'query' ? 'GET' : type === 'mutation' ? 'POST' : 'SUBSCRIBE';
    const input = extractTRPCInputSchema(m[2]);
    routes.push({ method, path: `/trpc/${name}`, functionName: name, inputSchema: input });
  }
}

function extractTRPCInputSchema(procedureChain) {
  // .input(z.object({...})) — inline schema
  if (/\.input\(\s*z\./.test(procedureChain)) return 'z.object(...)';
  // .input(SomeNamedSchema) — named reference
  const inputMatch = procedureChain.match(/\.input\(\s*([A-Z]\w+)/);
  if (inputMatch) return inputMatch[1];
  return null;
}

// ─── Zod schema extraction ────────────────────────────────────────────────────

function extractZodSchemas(content) {
  const models = [];
  // const UserSchema = z.object({ ... }) or export const UserSchema = z.object({...})
  const pattern = /(?:export\s+)?const\s+(\w+)\s*=\s*z\.object\s*\(\s*\{([^}]*)\}/g;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    const name = m[1];
    const body = m[2];
    const fields = [];
    // field: z.string() / field: z.number() / field: z.boolean() etc.
    const fieldPattern = /(\w+)\s*:\s*z\.(\w+)/g;
    let fm;
    while ((fm = fieldPattern.exec(body)) !== null) {
      fields.push({ name: fm[1], type: `z.${fm[2]}` });
    }
    if (fields.length > 0) {
      models.push({ className: name, fields, kind: 'zod' });
    }
  }
  return models;
}

// ─── Drizzle ORM table extraction ────────────────────────────────────────────

function extractDrizzleTables(content) {
  const models = [];
  // pgTable('users', {...}) / mysqlTable / sqliteTable
  const tablePattern = /(?:pgTable|mysqlTable|sqliteTable|table)\s*\(\s*['"](\w+)['"]\s*,\s*\{([^}]*)\}/g;
  let m;
  while ((m = tablePattern.exec(content)) !== null) {
    const tableName = m[1];
    const body = m[2];
    const fields = [];
    // id: serial('id') / name: text('name') / email: varchar('email', ...)
    const colPattern = /(\w+)\s*:\s*(\w+)\s*\(/g;
    let fm;
    while ((fm = colPattern.exec(body)) !== null) {
      fields.push({ name: fm[1], type: fm[2] });
    }
    if (fields.length > 0) {
      models.push({ className: tableName, name: tableName, fields, kind: 'drizzle' });
    }
  }
  return models;
}

// ─── Event / webhook listener extraction ────────────────────────────────────

function extractEventListeners(content) {
  const events = [];
  // emitter.on('event', handler) / eventBus.on('event') / ee.on('event')
  const onPattern = /\w+\.on\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = onPattern.exec(content)) !== null) {
    events.push({ type: 'listener', event: m[1] });
  }
  // emitter.emit('event', ...) / eventBus.emit('event')
  const emitPattern = /\w+\.emit\s*\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = emitPattern.exec(content)) !== null) {
    events.push({ type: 'emitter', event: m[1] });
  }
  // Stripe/webhook: app.post('/webhook', ...) already captured by routes
  // addEventListener('message', ...) — browser/worker patterns
  const addPattern = /addEventListener\s*\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = addPattern.exec(content)) !== null) {
    events.push({ type: 'listener', event: m[1] });
  }
  return events;
}

// ─── Queue / cron job extraction ──────────────────────────────────────────────

function extractQueueAndCron(content) {
  const jobs = [];

  // BullMQ / Bull: queue.add('job-name', data) / new Queue('queue-name')
  const queueAddPattern = /(?:queue|Queue)\s*\.add\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = queueAddPattern.exec(content)) !== null) {
    jobs.push({ type: 'queue', name: m[1] });
  }
  const newQueuePattern = /new\s+(?:Queue|Worker)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = newQueuePattern.exec(content)) !== null) {
    jobs.push({ type: 'queue', name: m[1] });
  }

  // node-cron / cron: cron.schedule('0 * * * *', ...) / new CronJob('* * * * *', ...)
  const cronPattern = /(?:cron\.schedule|new\s+CronJob)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = cronPattern.exec(content)) !== null) {
    jobs.push({ type: 'cron', expression: m[1] });
  }

  // setInterval used as cron-like
  const intervalPattern = /setInterval\s*\(.*?,\s*(\d+)\s*\*\s*\d+\s*\*\s*\d+/g;
  while ((m = intervalPattern.exec(content)) !== null) {
    jobs.push({ type: 'interval', ms: m[1] });
  }

  return jobs;
}

// ─── Next.js route detection (pages + app router) ────────────────────────────

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

function extractNextJSPagesRoutes(ast, filename) {
  const routes = [];
  const normalizedPath = ('/' + filename).replace(/\\/g, '/');
  const isApiFile = normalizedPath.includes('/pages/api/') || normalizedPath.includes('/app/api/');
  if (!isApiFile) return routes;
  if (!ast.program || !ast.program.body) return routes;

  let routePath = '[inferred]';
  const pagesMatch = normalizedPath.match(/\/pages(\/api\/.+)/);
  const appMatch = normalizedPath.match(/\/app(\/api\/.+)/);
  if (pagesMatch) {
    routePath = pagesMatch[1].replace(/\/[^/]+$/, '').replace(/\/index$/, '') || '/api';
  } else if (appMatch) {
    routePath = appMatch[1].replace(/\/[^/]+$/, '').replace(/\/route$/, '') || '/api';
  }

  for (const node of ast.program.body) {
    if (node.type === 'ExportDefaultDeclaration' && node.declaration) {
      const decl = node.declaration;
      if (decl.type === 'FunctionDeclaration' || decl.type === 'ArrowFunctionExpression' || decl.type === 'FunctionExpression') {
        const funcName = (decl.id && decl.id.name) || 'handler';
        routes.push({
          method: HTTP_METHODS.has(funcName.toUpperCase()) ? funcName.toUpperCase() : 'ALL',
          path: routePath,
          functionName: funcName
        });
      }
    }
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      const decl = node.declaration;
      if (decl.type === 'FunctionDeclaration' && decl.id && HTTP_METHODS.has(decl.id.name.toUpperCase())) {
        routes.push({ method: decl.id.name.toUpperCase(), path: routePath, functionName: decl.id.name });
      }
      if (decl.type === 'VariableDeclaration') {
        for (const vDecl of decl.declarations) {
          if (vDecl.id && vDecl.id.name && HTTP_METHODS.has(vDecl.id.name.toUpperCase())) {
            routes.push({ method: vDecl.id.name.toUpperCase(), path: routePath, functionName: vDecl.id.name });
          }
        }
      }
    }
  }
  return routes;
}

// ─── AST helpers ─────────────────────────────────────────────────────────────

function walk(node, visitor) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visitor); return; }
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    if (key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    const child = node[key];
    if (child && typeof child === 'object') walk(child, visitor);
  }
}

// ─── TS function extraction ───────────────────────────────────────────────────

function extractTSFunctions(ast) {
  const functions = [];
  if (!ast.program || !ast.program.body) return functions;
  for (const node of ast.program.body) extractFuncFromNode(node, functions);
  return functions;
}

function extractFuncFromNode(node, functions) {
  if (node.type === 'FunctionDeclaration' && node.id) {
    const name = node.id.name;
    if (shouldSkip(name, node.params)) return;
    functions.push({ name, params: extractTSParams(node.params), returnType: extractReturnType(node) });
  }
  if (node.type === 'VariableDeclaration') {
    for (const decl of node.declarations) {
      if (!decl.id || !decl.id.name || !decl.init) continue;
      if (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression') {
        const name = decl.id.name;
        if (shouldSkip(name, decl.init.params)) continue;
        functions.push({ name, params: extractTSParams(decl.init.params), returnType: extractReturnType(decl.init) });
      }
    }
  }
  if (node.type === 'ExportDefaultDeclaration' && node.declaration) extractFuncFromNode(node.declaration, functions);
  if (node.type === 'ExportNamedDeclaration' && node.declaration) extractFuncFromNode(node.declaration, functions);
}

function shouldSkip(name, params) {
  return name.startsWith('_') && (!params || params.length === 0);
}

function extractTSParams(params) {
  if (!params || params.length === 0) return '—';
  const names = [];
  for (const p of params) {
    if (p.type === 'Identifier') names.push(p.name);
    else if (p.type === 'AssignmentPattern' && p.left && p.left.type === 'Identifier') names.push(p.left.name);
    else if (p.type === 'ObjectPattern') names.push('{...}');
    else if (p.type === 'ArrayPattern') names.push('[...]');
  }
  return names.length > 0 ? names.join(', ') : '—';
}

function extractReturnType(funcNode) {
  if (funcNode.returnType && funcNode.returnType.typeAnnotation) return typeToString(funcNode.returnType.typeAnnotation);
  return '—';
}

function typeToString(typeNode) {
  if (!typeNode) return '—';
  switch (typeNode.type) {
    case 'TSStringKeyword': return 'string';
    case 'TSNumberKeyword': return 'number';
    case 'TSBooleanKeyword': return 'boolean';
    case 'TSVoidKeyword': return 'void';
    case 'TSAnyKeyword': return 'any';
    case 'TSNullKeyword': return 'null';
    case 'TSUndefinedKeyword': return 'undefined';
    case 'TSNeverKeyword': return 'never';
    case 'TSObjectKeyword': return 'object';
    case 'TSUnknownKeyword': return 'unknown';
    case 'TSTypeReference':
      if (typeNode.typeName && typeNode.typeName.name) {
        const generics = typeNode.typeParameters ? `<${typeNode.typeParameters.params.map(typeToString).join(', ')}>` : '';
        return typeNode.typeName.name + generics;
      }
      return '—';
    case 'TSArrayType': return typeToString(typeNode.elementType) + '[]';
    case 'TSUnionType': return typeNode.types.map(typeToString).join(' | ');
    case 'TSIntersectionType': return typeNode.types.map(typeToString).join(' & ');
    case 'TSTypeLiteral': return 'object';
    case 'TSFunctionType': return 'Function';
    default: return '—';
  }
}

// ─── TS interface / type alias extraction ────────────────────────────────────

function extractTSInterfaces(ast) {
  const models = [];
  if (!ast.program || !ast.program.body) return models;

  for (const node of ast.program.body) {
    let target = node;
    if (node.type === 'ExportNamedDeclaration' && node.declaration) target = node.declaration;

    if (target.type === 'TSInterfaceDeclaration' && target.id) {
      const className = target.id.name;
      const fields = [];
      if (target.body && target.body.body) {
        for (const member of target.body.body) {
          if (member.type === 'TSPropertySignature' && member.key) {
            const name = member.key.name || member.key.value;
            const type = member.typeAnnotation ? typeToString(member.typeAnnotation.typeAnnotation) : '—';
            if (name) fields.push({ name, type });
          }
        }
      }
      models.push({ className, fields, kind: 'interface' });
    }

    if (target.type === 'TSTypeAliasDeclaration' && target.id && target.typeAnnotation) {
      if (target.typeAnnotation.type === 'TSTypeLiteral') {
        const className = target.id.name;
        const fields = [];
        for (const member of target.typeAnnotation.members) {
          if (member.type === 'TSPropertySignature' && member.key) {
            const name = member.key.name || member.key.value;
            const type = member.typeAnnotation ? typeToString(member.typeAnnotation.typeAnnotation) : '—';
            if (name) fields.push({ name, type });
          }
        }
        models.push({ className, fields, kind: 'type' });
      }
    }
  }

  return models;
}
