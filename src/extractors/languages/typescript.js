const parser = require('@babel/parser');
const path = require('path');
const jsPlugin = require('./javascript');

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
    let ast;
    try {
      ast = parser.parse(content, TS_PARSE_OPTIONS);
    } catch (err) {
      console.warn(`[CARTO] TS parse failed on ${filename}: ${err.message} — skipping`);
      return { routes: [], models: [], functions: [], envVars: [], dbTables: [], fetches: [], storageKeys: [] };
    }

    const routes = jsPlugin._extractExpressRoutes(ast, filename);

    // tRPC procedure extraction
    // Pattern 1: inside createTRPCRouter({ name: procedure.query/mutation/subscription })
    const trpcRouterPattern = /createTRPCRouter\s*\(\s*\{([\s\S]*?)\n\}\s*\)/g;
    let trpcMatch;
    while ((trpcMatch = trpcRouterPattern.exec(content)) !== null) {
      const routerBody = trpcMatch[1];
      // Match: procedureName: someProcedure.query/mutation/subscription
      const procPattern = /(\w+)\s*:\s*\w*[Pp]rocedure[\s\S]*?\.(query|mutation|subscription)\s*\(/g;
      let procMatch;
      while ((procMatch = procPattern.exec(routerBody)) !== null) {
        const name = procMatch[1];
        const type = procMatch[2];
        const method = type === 'query' ? 'GET' : type === 'mutation' ? 'POST' : 'SUBSCRIBE';
        routes.push({ method, path: `/trpc/${name}`, functionName: name });
      }
    }

    // Pattern 2: export const name = procedure.query/mutation/subscription
    const trpcExportPattern = /export\s+const\s+(\w+)\s*=\s*\w*[Pp]rocedure[\s\S]*?\.(query|mutation|subscription)\s*\(/g;
    let exportMatch;
    while ((exportMatch = trpcExportPattern.exec(content)) !== null) {
      const name = exportMatch[1];
      const type = exportMatch[2];
      const method = type === 'query' ? 'GET' : type === 'mutation' ? 'POST' : 'SUBSCRIBE';
      routes.push({ method, path: `/trpc/${name}`, functionName: name });
    }

    // Pattern 3: router({ name: procedure.query/mutation }) — cal.com / older tRPC style
    const trpcRouterAltPattern = /(?:=\s*|^)router\s*\(\s*\{([\s\S]*?)\n\}\s*\)/gm;
    let altMatch;
    while ((altMatch = trpcRouterAltPattern.exec(content)) !== null) {
      const routerBody = altMatch[1];
      const procPattern = /(\w+)\s*:\s*\w*[Pp]rocedure[\s\S]*?\.(query|mutation|subscription)\s*\(/g;
      let procMatch;
      while ((procMatch = procPattern.exec(routerBody)) !== null) {
        const name = procMatch[1];
        const type = procMatch[2];
        const method = type === 'query' ? 'GET' : type === 'mutation' ? 'POST' : 'SUBSCRIBE';
        routes.push({ method, path: `/trpc/${name}`, functionName: name });
      }
    }

    return {
      routes,
      models:      extractTSInterfaces(ast),
      functions:   extractTSFunctions(ast),
      envVars:     jsPlugin._extractProcessEnv(ast),
      dbTables:    [],
      fetches:     jsPlugin._extractJSFetches(ast),
      storageKeys: [],
    };
  }
};

// ---------------------------------------------------------------------------
// Next.js Pages Router route detection
// ---------------------------------------------------------------------------

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * Detects Next.js route patterns:
 *
 * Pages Router (pages/api/...):
 *   export default function handler(req, res) — treated as ALL methods
 *   export default async function handler(req, res)
 *
 * App Router (app/api/.../route.ts):
 *   export function GET/POST/PUT/DELETE/PATCH
 *   export async function GET/POST/PUT/DELETE/PATCH
 *   export const GET/POST = ...
 */
function extractNextJSPagesRoutes(ast, filename) {
  const routes = [];
  const normalizedPath = ('/' + filename).replace(/\\/g, '/');
  const isApiFile = normalizedPath.includes('/pages/api/') || normalizedPath.includes('/app/api/');

  if (!isApiFile) return routes;
  if (!ast.program || !ast.program.body) return routes;

  // Infer route path from filename
  // pages/api/users/[id].ts → /api/users/[id]
  // app/api/users/route.ts → /api/users
  let routePath = '[inferred]';
  const pagesMatch = normalizedPath.match(/\/pages(\/api\/.+)/);
  const appMatch = normalizedPath.match(/\/app(\/api\/.+)/);
  if (pagesMatch) {
    routePath = pagesMatch[1].replace(/\/[^/]+$/, '').replace(/\/index$/, '');
    if (!routePath || routePath === '/api') routePath = '/api';
  } else if (appMatch) {
    routePath = appMatch[1].replace(/\/[^/]+$/, '').replace(/\/route$/, '');
    if (!routePath || routePath === '/api') routePath = '/api';
  }

  for (const node of ast.program.body) {
    // export default function handler(req, res) — Pages Router pattern
    if (node.type === 'ExportDefaultDeclaration' && node.declaration) {
      const decl = node.declaration;
      if (decl.type === 'FunctionDeclaration' || decl.type === 'ArrowFunctionExpression' || decl.type === 'FunctionExpression') {
        const funcName = (decl.id && decl.id.name) || 'handler';

        // If the function name is an HTTP method, use it
        if (HTTP_METHODS.has(funcName.toUpperCase())) {
          routes.push({
            method: funcName.toUpperCase(),
            path: routePath,
            functionName: funcName
          });
        } else {
          // Pages Router default export — handles all methods
          routes.push({
            method: 'ALL',
            path: routePath,
            functionName: funcName
          });
        }
      }
    }

    // export function GET/POST/... or export const GET = ... — App Router pattern
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      const decl = node.declaration;

      if (decl.type === 'FunctionDeclaration' && decl.id && HTTP_METHODS.has(decl.id.name.toUpperCase())) {
        routes.push({
          method: decl.id.name.toUpperCase(),
          path: routePath,
          functionName: decl.id.name
        });
      }

      if (decl.type === 'VariableDeclaration') {
        for (const vDecl of decl.declarations) {
          if (vDecl.id && vDecl.id.name && HTTP_METHODS.has(vDecl.id.name.toUpperCase())) {
            routes.push({
              method: vDecl.id.name.toUpperCase(),
              path: routePath,
              functionName: vDecl.id.name
            });
          }
        }
      }
    }
  }

  return routes;
}

// ---------------------------------------------------------------------------
// AST traversal helper
// ---------------------------------------------------------------------------

function walk(node, visitor) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visitor);
    return;
  }
  if (node.type) {
    visitor(node);
  }
  for (const key of Object.keys(node)) {
    if (key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    const child = node[key];
    if (child && typeof child === 'object') {
      walk(child, visitor);
    }
  }
}

// ---------------------------------------------------------------------------
// TS function extraction (with return types)
// ---------------------------------------------------------------------------

function extractTSFunctions(ast) {
  const functions = [];

  if (!ast.program || !ast.program.body) return functions;

  for (const node of ast.program.body) {
    extractFuncFromNode(node, functions);
  }

  return functions;
}

function extractFuncFromNode(node, functions) {
  // FunctionDeclaration
  if (node.type === 'FunctionDeclaration' && node.id) {
    const name = node.id.name;
    if (shouldSkip(name, node.params)) return;
    functions.push({
      name,
      params: extractTSParams(node.params),
      returnType: extractReturnType(node)
    });
  }

  // VariableDeclaration
  if (node.type === 'VariableDeclaration') {
    for (const decl of node.declarations) {
      if (!decl.id || !decl.id.name || !decl.init) continue;
      if (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression') {
        const name = decl.id.name;
        if (shouldSkip(name, decl.init.params)) continue;
        functions.push({
          name,
          params: extractTSParams(decl.init.params),
          returnType: extractReturnType(decl.init)
        });
      }
    }
  }

  // ExportDefaultDeclaration
  if (node.type === 'ExportDefaultDeclaration' && node.declaration) {
    extractFuncFromNode(node.declaration, functions);
  }

  // ExportNamedDeclaration
  if (node.type === 'ExportNamedDeclaration' && node.declaration) {
    extractFuncFromNode(node.declaration, functions);
  }
}

function shouldSkip(name, params) {
  if (name.startsWith('_') && (!params || params.length === 0)) return true;
  return false;
}

function extractTSParams(params) {
  if (!params || params.length === 0) return '\u2014';
  const names = [];
  for (const p of params) {
    if (p.type === 'Identifier') {
      names.push(p.name);
    } else if (p.type === 'AssignmentPattern' && p.left && p.left.type === 'Identifier') {
      names.push(p.left.name);
    } else if (p.type === 'RestElement' && p.argument && p.argument.type === 'Identifier') {
      continue; // skip ...args
    } else if (p.type === 'ObjectPattern') {
      names.push('{...}');
    } else if (p.type === 'ArrayPattern') {
      names.push('[...]');
    }
  }
  return names.length > 0 ? names.join(', ') : '\u2014';
}

function extractReturnType(funcNode) {
  // Check for TSTypeAnnotation on the function's returnType
  if (funcNode.returnType && funcNode.returnType.typeAnnotation) {
    return typeToString(funcNode.returnType.typeAnnotation);
  }
  return '\u2014';
}

function typeToString(typeNode) {
  if (!typeNode) return '\u2014';

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
        const generics = typeNode.typeParameters
          ? `<${typeNode.typeParameters.params.map(typeToString).join(', ')}>`
          : '';
        return typeNode.typeName.name + generics;
      }
      return '\u2014';
    case 'TSArrayType':
      return typeToString(typeNode.elementType) + '[]';
    case 'TSUnionType':
      return typeNode.types.map(typeToString).join(' | ');
    case 'TSIntersectionType':
      return typeNode.types.map(typeToString).join(' & ');
    case 'TSTypeLiteral':
      return 'object';
    case 'TSFunctionType':
      return 'Function';
    default:
      return '\u2014';
  }
}

// ---------------------------------------------------------------------------
// TS interface/type extraction → same shape as Pydantic models
// ---------------------------------------------------------------------------

function extractTSInterfaces(ast) {
  const models = [];

  if (!ast.program || !ast.program.body) return models;

  for (const node of ast.program.body) {
    let target = node;
    // Unwrap exports
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      target = node.declaration;
    }

    // TSInterfaceDeclaration
    if (target.type === 'TSInterfaceDeclaration' && target.id) {
      const className = target.id.name;
      const fields = [];
      if (target.body && target.body.body) {
        for (const member of target.body.body) {
          if (member.type === 'TSPropertySignature' && member.key) {
            const name = member.key.name || member.key.value;
            const type = member.typeAnnotation
              ? typeToString(member.typeAnnotation.typeAnnotation)
              : '\u2014';
            if (name) fields.push({ name, type });
          }
        }
      }
      models.push({ className, fields });
    }

    // TSTypeAliasDeclaration with TSTypeLiteral
    if (target.type === 'TSTypeAliasDeclaration' && target.id && target.typeAnnotation) {
      if (target.typeAnnotation.type === 'TSTypeLiteral') {
        const className = target.id.name;
        const fields = [];
        for (const member of target.typeAnnotation.members) {
          if (member.type === 'TSPropertySignature' && member.key) {
            const name = member.key.name || member.key.value;
            const type = member.typeAnnotation
              ? typeToString(member.typeAnnotation.typeAnnotation)
              : '\u2014';
            if (name) fields.push({ name, type });
          }
        }
        models.push({ className, fields });
      }
    }
  }

  return models;
}
