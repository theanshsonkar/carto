'use strict';

/**
 * Dart extractor — regex-based.
 *
 * Frameworks:
 *   - Flutter: widget classes surfaced as models of kind `flutter-widget`
 *   - Shelf / Aqueduct: backend Dart routing libraries
 *   - HTTP routes via Shelf Router: `router.get('/path', handler)`
 */

module.exports = {
  name: 'dart',
  extensions: ['.dart'],
  extract(content, filename) {
    return {
      routes:     extractDartRoutes(content),
      models:     extractDartModels(content),
      functions:  extractDartFunctions(content),
      envVars:    extractDartEnvVars(content),
      dbTables:   [],
      fetches:    [],
      storageKeys: [],
      _tsImports: extractDartImports(content),
      _tsSymbols: extractDartSymbols(content),
    };
  },
};

// ── Routes ───────────────────────────────────────────────────────────
function extractDartRoutes(content) {
  const routes = [];

  // Shelf Router: router.get('/path', handler)
  const shelf = /\brouter\.(get|post|put|delete|patch|head|options)\s*\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = shelf.exec(content)) !== null) {
    routes.push({ method: m[1].toUpperCase(), path: m[2], functionName: '[shelf]' });
  }

  // Aqueduct/Conduit: route('/path').link(...) — coarse capture
  const aqueduct = /\.route\s*\(\s*['"]([^'"]+)['"]/g;
  while ((m = aqueduct.exec(content)) !== null) {
    routes.push({ method: 'ALL', path: m[1], functionName: '[aqueduct]' });
  }

  // Flutter Navigator routes table: '/home': (ctx) => HomeScreen()
  const navRoute = /['"]\/([^'"]*)['"]\s*:\s*\([^)]*\)\s*=>/g;
  while ((m = navRoute.exec(content)) !== null) {
    routes.push({ method: 'NAV', path: `/${m[1]}`, functionName: '[flutter-route]' });
  }

  const seen = new Set();
  return routes.filter(r => {
    const key = `${r.method}::${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Models (Flutter widgets + plain Dart classes) ──────────────────
function extractDartModels(content) {
  const models = [];
  let m;

  // class X extends StatelessWidget / StatefulWidget
  const widget = /class\s+(\w+)\s+extends\s+(StatelessWidget|StatefulWidget|State<\w+>)/g;
  while ((m = widget.exec(content)) !== null) {
    models.push({ className: m[1], fields: [], kind: 'flutter-widget' });
  }

  // class X { final String name; ... }
  const klass = /class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[^{]+)?\s*\{([^}]{0,2000})\}/g;
  while ((m = klass.exec(content)) !== null) {
    if (!models.some(x => x.className === m[1])) {
      const body = m[2];
      const fields = [];
      const fieldPattern = /(?:final|var|late)\s+(\w[\w<>?]*)\s+(\w+)\s*[;=]/g;
      let fm;
      while ((fm = fieldPattern.exec(body)) !== null && fields.length < 30) {
        fields.push({ name: fm[2], type: fm[1] });
      }
      models.push({ className: m[1], fields, kind: 'dart-class' });
    }
  }

  return models;
}

// ── Functions ──────────────────────────────────────────────────────
function extractDartFunctions(content) {
  const out = [];
  // top-level + class methods: returnType name(...)  or  async / Future<...> name(...)
  const pattern = /(?:^|\n)\s*(?:Future<[^>]*>|void|String|int|double|bool|[A-Z]\w*)\s+(\w+)\s*\(/g;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    out.push({ name: m[1], params: '—', returnType: '—' });
  }
  return out;
}

// ── Env vars ───────────────────────────────────────────────────────
function extractDartEnvVars(content) {
  const vars = new Set();
  // Platform.environment['VAR']
  const platform = /Platform\.environment\s*\[\s*['"]([A-Z_][A-Z0-9_]+)['"]\s*\]/g;
  let m;
  while ((m = platform.exec(content)) !== null) vars.add(m[1]);
  return [...vars];
}

// ── Imports ────────────────────────────────────────────────────────
function extractDartImports(content) {
  const out = [];
  // import 'package:flutter/material.dart';
  const pattern = /^import\s+['"]([^'"]+)['"](?:\s+as\s+\w+)?\s*;/gm;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    out.push({ from: m[1], symbols: [] });
  }
  return out;
}

// ── Symbols ────────────────────────────────────────────────────────
function extractDartSymbols(content) {
  const out = [];
  let m;
  const klass = /class\s+(\w+)/g;
  while ((m = klass.exec(content)) !== null) {
    out.push({ name: m[1], kind: 'class', exported: true });
  }
  const mixin = /\bmixin\s+(\w+)/g;
  while ((m = mixin.exec(content)) !== null) {
    out.push({ name: m[1], kind: 'mixin', exported: true });
  }
  return out;
}
