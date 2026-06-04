'use strict';

/**
 * tree-sitter-parser.js
 *
 * Provides fast import + symbol extraction for all supported languages using
 * tree-sitter grammars. This is the hot path — runs on every file.
 *
 * Babel is NOT used here. Babel is only invoked by the JS/TS language plugins
 * for deep route/model extraction on API handler files.
 */

let Parser;
let treeSitterAvailable = false;

try {
  Parser = require('tree-sitter');
  treeSitterAvailable = true;
} catch (err) {
  console.warn(`[CARTO] tree-sitter native module failed to load: ${err.message} — falling back to Babel`);
}

// ─── Grammar registry ─────────────────────────────────────────────────────────

/**
 * Each entry: { extensions, loadGrammar, importQuery, symbolQuery }
 * loadGrammar is lazy — called once on first use, result cached.
 */
const GRAMMAR_DEFS = [
  {
    name: 'javascript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    loadGrammar: () => require('tree-sitter-javascript'),
    importQuery: `
      (import_statement source: (string (string_fragment) @src))
      (call_expression
        function: (identifier) @fn
        arguments: (arguments (string (string_fragment) @src))
        (#eq? @fn "require"))
      (call_expression
        function: (import) @_imp
        arguments: (arguments (string (string_fragment) @src)))
    `,
    symbolQuery: `
      (function_declaration name: (identifier) @name) @sym
      (class_declaration name: (identifier) @name) @sym
      (lexical_declaration
        (variable_declarator
          name: (identifier) @name
          value: [(arrow_function) (function_expression)]))
      (variable_declaration
        (variable_declarator
          name: (identifier) @name
          value: [(arrow_function) (function_expression)]))
      (export_statement declaration: (function_declaration name: (identifier) @name))
      (export_statement declaration: (class_declaration name: (identifier) @name))
      (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name)))
    `,
  },
  {
    name: 'typescript',
    extensions: ['.ts', '.tsx'],
    loadGrammar: () => require('tree-sitter-typescript').typescript,
    importQuery: `
      (import_statement source: (string (string_fragment) @src))
      (call_expression
        function: (identifier) @fn
        arguments: (arguments (string (string_fragment) @src))
        (#eq? @fn "require"))
    `,
    symbolQuery: `
      (function_declaration name: (identifier) @name)
      (class_declaration name: (type_identifier) @name)
      (interface_declaration name: (type_identifier) @name)
      (type_alias_declaration name: (type_identifier) @name)
      (enum_declaration name: (identifier) @name)
      (lexical_declaration
        (variable_declarator
          name: (identifier) @name
          value: [(arrow_function) (function_expression)]))
      (export_statement declaration: (function_declaration name: (identifier) @name))
      (export_statement declaration: (class_declaration name: (type_identifier) @name))
      (export_statement declaration: (interface_declaration name: (type_identifier) @name))
      (export_statement declaration: (type_alias_declaration name: (type_identifier) @name))
      (export_statement declaration: (enum_declaration name: (identifier) @name))
      (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name)))
    `,
  },
  {
    name: 'python',
    extensions: ['.py'],
    loadGrammar: () => require('tree-sitter-python'),
    importQuery: `
      (import_statement name: (dotted_name) @src)
      (import_from_statement module_name: (dotted_name) @src)
      (import_from_statement module_name: (relative_import) @src)
    `,
    symbolQuery: `
      (function_definition name: (identifier) @name)
      (class_definition name: (identifier) @name)
      (decorated_definition definition: (function_definition name: (identifier) @name))
      (decorated_definition definition: (class_definition name: (identifier) @name))
    `,
  },
  {
    name: 'go',
    extensions: ['.go'],
    loadGrammar: () => require('tree-sitter-go'),
    importQuery: `
      (import_spec path: (interpreted_string_literal (interpreted_string_literal_content) @src))
    `,
    symbolQuery: `
      (function_declaration name: (identifier) @name)
      (method_declaration name: (field_identifier) @name)
      (type_declaration (type_spec name: (type_identifier) @name))
    `,
  },
  {
    name: 'rust',
    extensions: ['.rs'],
    loadGrammar: () => require('tree-sitter-rust'),
    importQuery: `
      (use_declaration argument: (_) @src)
    `,
    symbolQuery: `
      (function_item name: (identifier) @name)
      (struct_item name: (type_identifier) @name)
      (enum_item name: (type_identifier) @name)
      (trait_item name: (type_identifier) @name)
      (impl_item type: (type_identifier) @name)
    `,
  },
  {
    name: 'java',
    extensions: ['.java'],
    loadGrammar: () => require('tree-sitter-java'),
    importQuery: `
      (import_declaration (scoped_identifier) @src)
    `,
    symbolQuery: `
      (class_declaration name: (identifier) @name)
      (interface_declaration name: (identifier) @name)
      (enum_declaration name: (identifier) @name)
      (method_declaration name: (identifier) @name)
      (constructor_declaration name: (identifier) @name)
    `,
  },
  {
    name: 'cpp',
    extensions: ['.cpp', '.cc', '.cxx', '.h', '.hpp'],
    loadGrammar: () => require('tree-sitter-cpp'),
    importQuery: `
      (preproc_include path: (system_lib_string) @src)
      (preproc_include path: (string_literal (string_content) @src))
    `,
    symbolQuery: `
      (function_definition declarator: (function_declarator declarator: (identifier) @name))
      (function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name)))
      (class_specifier name: (type_identifier) @name)
      (struct_specifier name: (type_identifier) @name)
      (enum_specifier name: (type_identifier) @name)
    `,
  },
  {
    name: 'csharp',
    extensions: ['.cs'],
    loadGrammar: () => require('tree-sitter-c-sharp'),
    importQuery: `
      (using_directive (identifier) @src)
      (using_directive (qualified_name) @src)
    `,
    symbolQuery: `
      (class_declaration name: (identifier) @name)
      (interface_declaration name: (identifier) @name)
      (enum_declaration name: (identifier) @name)
      (struct_declaration name: (identifier) @name)
      (method_declaration name: (identifier) @name)
      (constructor_declaration name: (identifier) @name)
    `,
  },
];

// ─── Compiled grammar cache ───────────────────────────────────────────────────

// Map: extension → { parser, importQuery, symbolQuery, name }
const _grammarCache = new Map();
// Map: extension → null  (grammar failed to load — skip silently)
const _failedGrammars = new Set();

function _getCompiledGrammar(ext) {
  if (_grammarCache.has(ext)) return _grammarCache.get(ext);
  if (_failedGrammars.has(ext)) return null;

  const def = GRAMMAR_DEFS.find(d => d.extensions.includes(ext));
  if (!def) {
    _failedGrammars.add(ext);
    return null;
  }

  try {
    const grammar = def.loadGrammar();
    const parser = new Parser();
    parser.setLanguage(grammar);

    const importQuery = new Parser.Query(grammar, def.importQuery);
    const symbolQuery = new Parser.Query(grammar, def.symbolQuery);

    const compiled = { parser, importQuery, symbolQuery, name: def.name };
    for (const e of def.extensions) {
      _grammarCache.set(e, compiled);
    }
    return compiled;
  } catch (err) {
    console.warn(`[CARTO] Failed to load tree-sitter grammar for ${def.name}: ${err.message}`);
    for (const e of def.extensions) {
      _failedGrammars.add(e);
    }
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * isAvailable() → boolean
 * Returns true if tree-sitter native module loaded successfully.
 */
function isAvailable() {
  return treeSitterAvailable;
}

/**
 * supportsExtension(ext) → boolean
 * Returns true if we have a grammar for this file extension.
 */
function supportsExtension(ext) {
  if (!treeSitterAvailable) return false;
  const lext = ext.toLowerCase();
  return GRAMMAR_DEFS.some(d => d.extensions.includes(lext));
}

/**
 * extractImports(content, ext) → string[]
 *
 * Returns an array of raw import path strings found in the file.
 * Strips surrounding quotes. Returns [] on any failure.
 */
function extractImports(content, ext) {
  if (!treeSitterAvailable) return [];
  const lext = ext.toLowerCase();
  const compiled = _getCompiledGrammar(lext);
  if (!compiled) return [];

  try {
    const tree = compiled.parser.parse(content);
    const matches = compiled.importQuery.matches(tree.rootNode);
    const paths = new Set();

    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.name === 'src' || capture.name === 'src2') {
          let text = capture.node.text;
          // Strip quotes for JS/TS (string_fragment nodes don't have quotes,
          // but Go interpreted_string_literal_content also doesn't)
          // For Python dotted_name and Rust use_declaration, keep as-is
          text = text.trim();
          if (text) paths.add(text);
        }
      }
    }

    return [...paths];
  } catch (err) {
    // Partial parse errors are fine — tree-sitter returns what it can
    return [];
  }
}

/**
 * extractSymbols(content, ext) → Array<{ name: string, kind: string }>
 *
 * Returns top-level exported symbols. kind is one of:
 * 'function' | 'class' | 'variable' | 'interface' | 'type' | 'enum' |
 * 'struct' | 'trait' | 'method'
 */
function extractSymbols(content, ext) {
  if (!treeSitterAvailable) return [];
  const lext = ext.toLowerCase();
  const compiled = _getCompiledGrammar(lext);
  if (!compiled) return [];

  try {
    const tree = compiled.parser.parse(content);
    const matches = compiled.symbolQuery.matches(tree.rootNode);
    const seen = new Set();
    const symbols = [];

    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.name === 'name') {
          const name = capture.node.text.trim();
          if (!name || seen.has(name)) continue;
          seen.add(name);
          symbols.push({ name, kind: _inferKind(capture.node, compiled.name) });
        }
      }
    }

    return symbols;
  } catch (err) {
    return [];
  }
}

/**
 * extractAll(content, ext) → { imports: string[], symbols: Array<{name, kind}> }
 *
 * Convenience wrapper — runs both queries in one parse.
 */
function extractAll(content, ext) {
  if (!treeSitterAvailable) return { imports: [], symbols: [] };
  const lext = ext.toLowerCase();
  const compiled = _getCompiledGrammar(lext);
  if (!compiled) return { imports: [], symbols: [] };

  try {
    const tree = compiled.parser.parse(content);

    // Imports
    const importMatches = compiled.importQuery.matches(tree.rootNode);
    const importPaths = new Set();
    for (const match of importMatches) {
      for (const capture of match.captures) {
        if (capture.name === 'src' || capture.name === 'src2') {
          const text = capture.node.text.trim();
          if (text) importPaths.add(text);
        }
      }
    }

    // Symbols
    const symbolMatches = compiled.symbolQuery.matches(tree.rootNode);
    const seen = new Set();
    const symbols = [];
    for (const match of symbolMatches) {
      for (const capture of match.captures) {
        if (capture.name === 'name') {
          const name = capture.node.text.trim();
          if (!name || seen.has(name)) continue;
          seen.add(name);
          symbols.push({ name, kind: _inferKind(capture.node, compiled.name) });
        }
      }
    }

    return { imports: [...importPaths], symbols };
  } catch (err) {
    return { imports: [], symbols: [] };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _inferKind(nameNode, langName) {
  // Walk up to the parent node to determine what kind of symbol this is
  const parent = nameNode.parent;
  if (!parent) return 'variable';

  const parentType = parent.type;

  if (parentType === 'function_declaration' || parentType === 'function_definition' ||
      parentType === 'function_item') return 'function';
  if (parentType === 'class_declaration' || parentType === 'class_definition') return 'class';
  if (parentType === 'interface_declaration') return 'interface';
  if (parentType === 'type_alias_declaration') return 'type';
  if (parentType === 'enum_declaration' || parentType === 'enum_item') return 'enum';
  if (parentType === 'struct_item') return 'struct';
  if (parentType === 'trait_item') return 'trait';
  if (parentType === 'method_declaration' || parentType === 'impl_item') return 'method';
  if (parentType === 'type_declaration' || parentType === 'type_spec') return 'type';
  if (parentType === 'variable_declarator') return 'variable';

  // For export_statement wrappers, check grandparent
  if (parentType === 'export_statement') {
    const decl = parent.childForFieldName('declaration');
    if (decl) {
      if (decl.type.includes('function')) return 'function';
      if (decl.type.includes('class')) return 'class';
      if (decl.type.includes('interface')) return 'interface';
      if (decl.type.includes('type_alias')) return 'type';
      if (decl.type.includes('enum')) return 'enum';
    }
  }

  return 'variable';
}

/**
 * getUnavailableLanguages() → string[]
 * Returns language names whose grammars failed to load (or tree-sitter itself unavailable).
 */
function getUnavailableLanguages() {
  if (!treeSitterAvailable) return GRAMMAR_DEFS.map(d => d.name);
  const unavailable = [];
  for (const def of GRAMMAR_DEFS) {
    const ext = def.extensions[0];
    if (!_getCompiledGrammar(ext)) unavailable.push(def.name);
  }
  return unavailable;
}

module.exports = {
  isAvailable,
  supportsExtension,
  extractImports,
  extractSymbols,
  extractAll,
  getUnavailableLanguages,
  GRAMMAR_DEFS,
};
