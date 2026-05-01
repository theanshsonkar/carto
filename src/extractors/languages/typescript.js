const parser = require('@babel/parser');
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

    return {
      routes:      jsPlugin._extractExpressRoutes(ast, filename),
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
