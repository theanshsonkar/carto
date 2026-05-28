const parser = require('@babel/parser');
const path = require('path');

const PARSE_OPTIONS = {
  sourceType: 'module',
  allowImportExportEverywhere: true,
  allowReturnOutsideFunction: true,
  plugins: ['jsx', 'optionalChaining', 'nullishCoalescingOperator', 'classProperties', 'decorators-legacy']
};

// Known Express-like router object names
const ROUTER_NAMES = new Set(['app', 'router', 'server', 'api']);
// HTTP methods
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);

module.exports = {
  name: 'javascript',
  extensions: ['.js', '.jsx', '.mjs', '.cjs'],
  extract(content, filename) {
    let ast;
    try {
      ast = parser.parse(content, PARSE_OPTIONS);
    } catch (err) {
      console.warn(`[CARTO] JS parse failed on ${filename}: ${err.message} — skipping`);
      return { routes: [], models: [], functions: [], envVars: [], dbTables: [], fetches: [], storageKeys: [] };
    }

    return {
      routes:      extractExpressRoutes(ast, filename),
      models:      [],
      functions:   extractJSFunctions(ast),
      envVars:     extractProcessEnv(ast),
      dbTables:    [],
      fetches:     extractJSFetches(ast),
      storageKeys: [],
    };
  },

  // Expose internals for typescript.js to reuse
  _extractExpressRoutes: extractExpressRoutes,
  _extractReactRouterRoutes: extractReactRouterRoutes,
  _extractProcessEnv: extractProcessEnv,
  _extractJSFetches: extractJSFetches,
  _extractJSFunctions: extractJSFunctions,
  _PARSE_OPTIONS: PARSE_OPTIONS,
};

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
// Express route extraction
// ---------------------------------------------------------------------------

function extractExpressRoutes(ast, filename) {
  const routes = [];

  // Check for Next.js Pages/App Router patterns (pages/api/... or app/api/...)
  const nextRoutes = extractNextJSPagesRoutes(ast, filename);
  routes.push(...nextRoutes);

  // React Router (JSX <Route> + createBrowserRouter/createHashRouter/createMemoryRouter)
  const reactRoutes = extractReactRouterRoutes(ast);
  routes.push(...reactRoutes);

  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    if (!node.callee || node.callee.type !== 'MemberExpression') return;

    const obj = node.callee.object;
    const prop = node.callee.property;

    // Check: app.get(...), router.post(...), etc.
    if (!obj || !prop) return;
    const objName = obj.name || (obj.property && obj.property.name);
    const methodName = prop.name || (prop.value);

    if (!objName || !ROUTER_NAMES.has(objName)) return;
    if (!methodName || !HTTP_METHODS.has(methodName)) return;

    // First argument should be the path
    const args = node.arguments;
    if (!args || args.length === 0) return;

    let routePath;
    if (args[0].type === 'StringLiteral') {
      routePath = args[0].value;
    } else if (args[0].type === 'TemplateLiteral') {
      routePath = '[dynamic]';
    } else {
      return; // Can't determine path — skip
    }

    // Handler name: last argument
    const lastArg = args[args.length - 1];
    let handler = '[anonymous]';
    if (lastArg.type === 'Identifier') {
      handler = lastArg.name;
    } else if (lastArg.type === 'FunctionExpression' && lastArg.id) {
      handler = lastArg.id.name;
    } else if (lastArg.type === 'ArrowFunctionExpression') {
      // Arrow functions are anonymous, but check if assigned to a variable
      handler = '[anonymous]';
    }

    routes.push({
      method: methodName.toUpperCase(),
      path: routePath,
      functionName: handler
    });
  });

  // Deduplicate by method + path
  const seen = new Set();
  return routes.filter(r => {
    const key = `${r.method}::${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// React Router extraction
// ---------------------------------------------------------------------------

const REACT_ROUTER_CREATORS = new Set(['createBrowserRouter', 'createHashRouter', 'createMemoryRouter', 'useRoutes']);

function extractReactRouterRoutes(ast) {
  const routes = [];

  // 1. JSX <Route path="..." component={X} /> or element={<X />}
  walk(ast, (node) => {
    if (node.type !== 'JSXOpeningElement') return;
    if (!node.name || node.name.name !== 'Route') return;

    let routePath = null;
    let componentName = '[anonymous]';

    for (const attr of (node.attributes || [])) {
      if (attr.type !== 'JSXAttribute' || !attr.name) continue;
      const attrName = attr.name.name;

      if (attrName === 'path' && attr.value) {
        if (attr.value.type === 'StringLiteral') {
          routePath = attr.value.value;
        }
      }

      if ((attrName === 'component' || attrName === 'element') && attr.value) {
        if (attr.value.type === 'JSXExpressionContainer' && attr.value.expression) {
          const expr = attr.value.expression;
          if (expr.type === 'Identifier') {
            componentName = expr.name;
          } else if (expr.type === 'JSXElement' && expr.openingElement && expr.openingElement.name) {
            componentName = expr.openingElement.name.name || '[anonymous]';
          }
        }
      }
    }

    if (routePath !== null) {
      routes.push({ method: 'VIEW', path: routePath, functionName: componentName });
    }
  });

  // 2. createBrowserRouter / createHashRouter / createMemoryRouter / useRoutes
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (!callee) return;
    const calleeName = callee.type === 'Identifier' ? callee.name
      : (callee.type === 'MemberExpression' && callee.property) ? callee.property.name
      : null;
    if (!calleeName || !REACT_ROUTER_CREATORS.has(calleeName)) return;
    if (!node.arguments || node.arguments.length === 0) return;

    const firstArg = node.arguments[0];
    if (firstArg.type === 'ArrayExpression') {
      extractRoutesFromRouteArray(firstArg, routes);
    }
  });

  const seen = new Set();
  return routes.filter(r => {
    const key = `VIEW::${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractRoutesFromRouteArray(arrayNode, routes) {
  for (const element of (arrayNode.elements || [])) {
    if (!element || element.type !== 'ObjectExpression') continue;
    extractRouteFromRouteObject(element, routes);
  }
}

function extractRouteFromRouteObject(objNode, routes) {
  let routePath = null;
  let componentName = '[anonymous]';
  let childrenNode = null;

  for (const prop of (objNode.properties || [])) {
    if (prop.type !== 'ObjectProperty' && prop.type !== 'Property') continue;
    if (!prop.key) continue;
    const key = prop.key.name || prop.key.value;

    if (key === 'path' && prop.value && prop.value.type === 'StringLiteral') {
      routePath = prop.value.value;
    }

    if ((key === 'element' || key === 'component') && prop.value) {
      const val = prop.value;
      if (val.type === 'Identifier') {
        componentName = val.name;
      } else if (val.type === 'JSXElement' && val.openingElement && val.openingElement.name) {
        componentName = val.openingElement.name.name || '[anonymous]';
      }
    }

    if (key === 'children' && prop.value && prop.value.type === 'ArrayExpression') {
      childrenNode = prop.value;
    }
  }

  if (routePath !== null) {
    routes.push({ method: 'VIEW', path: routePath, functionName: componentName });
  }

  if (childrenNode) {
    extractRoutesFromRouteArray(childrenNode, routes);
  }
}

/**
 * Detects Next.js Pages Router pattern:
 *   export default function handler(req, res) in files under pages/api/
 *   Also handles App Router export default in app/api/ files
 */
function extractNextJSPagesRoutes(ast, filename) {
  const routes = [];
  const normalizedPath = ('/' + filename).replace(/\\/g, '/');
  const isApiFile = normalizedPath.includes('/pages/api/') || normalizedPath.includes('/app/api/');

  if (!isApiFile) return routes;
  if (!ast.program || !ast.program.body) return routes;

  const HTTP_METHODS_UPPER = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

  // Infer route path from filename
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
    // export default function handler(req, res)
    if (node.type === 'ExportDefaultDeclaration' && node.declaration) {
      const decl = node.declaration;
      if (decl.type === 'FunctionDeclaration' || decl.type === 'ArrowFunctionExpression' || decl.type === 'FunctionExpression') {
        const funcName = (decl.id && decl.id.name) || 'handler';
        if (HTTP_METHODS_UPPER.has(funcName.toUpperCase())) {
          routes.push({ method: funcName.toUpperCase(), path: routePath, functionName: funcName });
        } else {
          routes.push({ method: 'ALL', path: routePath, functionName: funcName });
        }
      }
    }

    // export function GET/POST/... (named exports in api files)
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      const decl = node.declaration;
      if (decl.type === 'FunctionDeclaration' && decl.id && HTTP_METHODS_UPPER.has(decl.id.name.toUpperCase())) {
        routes.push({ method: decl.id.name.toUpperCase(), path: routePath, functionName: decl.id.name });
      }
      if (decl.type === 'VariableDeclaration') {
        for (const vDecl of decl.declarations) {
          if (vDecl.id && vDecl.id.name && HTTP_METHODS_UPPER.has(vDecl.id.name.toUpperCase())) {
            routes.push({ method: vDecl.id.name.toUpperCase(), path: routePath, functionName: vDecl.id.name });
          }
        }
      }
    }
  }

  return routes;
}

// ---------------------------------------------------------------------------
// JS function extraction
// ---------------------------------------------------------------------------

function extractJSFunctions(ast) {
  const functions = [];

  if (!ast.program || !ast.program.body) return functions;

  for (const node of ast.program.body) {
    // 1. FunctionDeclaration at top level
    if (node.type === 'FunctionDeclaration' && node.id) {
      const name = node.id.name;
      if (shouldSkipJSFunction(name, node.params)) continue;
      functions.push({
        name,
        params: extractParams(node.params),
        returnType: '\u2014'
      });
    }

    // 2. VariableDeclaration at top level with arrow/function expression
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        if (!decl.id || !decl.id.name) continue;
        if (!decl.init) continue;
        if (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression') {
          const name = decl.id.name;
          if (shouldSkipJSFunction(name, decl.init.params)) continue;
          functions.push({
            name,
            params: extractParams(decl.init.params),
            returnType: '\u2014'
          });
        }
      }
    }

    // 3. ExportDefaultDeclaration wrapping a function
    if (node.type === 'ExportDefaultDeclaration' && node.declaration) {
      const decl = node.declaration;
      if (decl.type === 'FunctionDeclaration' && decl.id) {
        const name = decl.id.name;
        if (!shouldSkipJSFunction(name, decl.params)) {
          functions.push({
            name,
            params: extractParams(decl.params),
            returnType: '\u2014'
          });
        }
      }
    }

    // 4. ExportNamedDeclaration wrapping a function or variable
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      const decl = node.declaration;
      if (decl.type === 'FunctionDeclaration' && decl.id) {
        const name = decl.id.name;
        if (!shouldSkipJSFunction(name, decl.params)) {
          functions.push({
            name,
            params: extractParams(decl.params),
            returnType: '\u2014'
          });
        }
      }
      if (decl.type === 'VariableDeclaration') {
        for (const vDecl of decl.declarations) {
          if (!vDecl.id || !vDecl.id.name || !vDecl.init) continue;
          if (vDecl.init.type === 'ArrowFunctionExpression' || vDecl.init.type === 'FunctionExpression') {
            const name = vDecl.id.name;
            if (!shouldSkipJSFunction(name, vDecl.init.params)) {
              functions.push({
                name,
                params: extractParams(vDecl.init.params),
                returnType: '\u2014'
              });
            }
          }
        }
      }
    }
  }

  return functions;
}

function shouldSkipJSFunction(name, params) {
  // Skip _ prefixed functions only if they have 0 params (likely private utility)
  if (name.startsWith('_') && (!params || params.length === 0)) return true;
  return false;
}

function extractParams(params) {
  if (!params || params.length === 0) return '\u2014';
  const names = [];
  for (const p of params) {
    if (p.type === 'Identifier') {
      names.push(p.name);
    } else if (p.type === 'AssignmentPattern' && p.left && p.left.type === 'Identifier') {
      names.push(p.left.name);
    } else if (p.type === 'RestElement' && p.argument && p.argument.type === 'Identifier') {
      // ...args — skip like Python's *args
      continue;
    } else if (p.type === 'ObjectPattern') {
      names.push('{...}');
    } else if (p.type === 'ArrayPattern') {
      names.push('[...]');
    }
  }
  return names.length > 0 ? names.join(', ') : '\u2014';
}

// ---------------------------------------------------------------------------
// process.env extraction
// ---------------------------------------------------------------------------

function extractProcessEnv(ast) {
  const vars = new Set();

  walk(ast, (node) => {
    if (node.type !== 'MemberExpression') return;

    // Pattern 1: process.env.VAR_NAME
    if (
      node.object &&
      node.object.type === 'MemberExpression' &&
      node.object.object &&
      node.object.object.name === 'process' &&
      node.object.property &&
      node.object.property.name === 'env' &&
      node.property
    ) {
      if (!node.computed && node.property.name) {
        vars.add(node.property.name);
      }
      // Pattern 2: process.env['VAR_NAME']
      if (node.computed && node.property.type === 'StringLiteral') {
        vars.add(node.property.value);
      }
    }
  });

  return [...vars].sort();
}

// ---------------------------------------------------------------------------
// fetch() extraction
// ---------------------------------------------------------------------------

function extractJSFetches(ast) {
  const fetches = [];

  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;

    // fetch(...) or something.fetch(...)
    const isFetch =
      (node.callee.type === 'Identifier' && node.callee.name === 'fetch') ||
      (node.callee.type === 'MemberExpression' && node.callee.property && node.callee.property.name === 'fetch');

    if (!isFetch) return;
    if (!node.arguments || node.arguments.length === 0) return;

    const firstArg = node.arguments[0];
    let url = '[dynamic]';
    let method = '[dynamic]';

    if (firstArg.type === 'StringLiteral') {
      url = firstArg.value;
      method = 'GET'; // default
    } else if (firstArg.type === 'TemplateLiteral') {
      url = '[dynamic]';
      method = '[dynamic]';
    } else if (firstArg.type === 'Identifier') {
      url = '[dynamic]';
      method = '[dynamic]';
    } else {
      return;
    }

    // Check for method in second argument (options object)
    if (node.arguments.length > 1 && node.arguments[1].type === 'ObjectExpression') {
      for (const prop of node.arguments[1].properties) {
        if (
          prop.key &&
          (prop.key.name === 'method' || prop.key.value === 'method') &&
          prop.value &&
          prop.value.type === 'StringLiteral'
        ) {
          method = prop.value.value.toUpperCase();
        }
      }
    }

    fetches.push({ url, method });
  });

  return fetches;
}
