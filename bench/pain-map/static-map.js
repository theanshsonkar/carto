'use strict';
// Static predictors for the pain-map experiment.
//
//  - Carto import graph: read from a Carto index (.carto/carto.db) built in a
//    scratch copy via the programmatic path (src/store/sync.js runSync).
//  - suiteModules(testFile): Babel scan of test/test.js mapping each
//    test()/asyncTest() suite to the modules whose require-bindings are
//    referenced inside its callbacks (plus require() calls inside them).

const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');

function loadGraph(idxRoot) {
  const Database = require(path.join(idxRoot, 'node_modules', 'better-sqlite3'));
  const db = new Database(path.join(idxRoot, '.carto', 'carto.db'), { readonly: true });
  const files = db.prepare('SELECT id, path FROM files').all();
  const byId = new Map(files.map((f) => [f.id, f.path]));
  const edges = db.prepare('SELECT from_file_id, to_file_id, to_path, resolved FROM imports').all();
  const dependents = new Map(); // file -> Set(files importing it)
  for (const e of edges) {
    if (e.to_file_id == null) continue;
    const to = byId.get(e.to_file_id);
    const from = byId.get(e.from_file_id);
    if (!dependents.has(to)) dependents.set(to, new Set());
    dependents.get(to).add(from);
  }
  // Carto-native blast radius (reverse_deps, the table getBlastRadius reads; maxHops 5)
  const rd = db.prepare(`SELECT f.path AS file, d.path AS dep, rd.hop_distance AS hop
    FROM reverse_deps rd JOIN files f ON f.id = rd.file_id JOIN files d ON d.id = rd.dependent_file_id`).all();
  const blast5 = new Map();
  for (const r of rd) {
    if (r.hop > 5) continue;
    if (!blast5.has(r.file)) blast5.set(r.file, new Set());
    blast5.get(r.file).add(r.dep);
  }
  const relEdges = edges.filter((e) => /^\.\.?\//.test(e.to_path || ''));
  const stats = {
    files: files.length,
    edges: edges.length,
    resolvedEdges: edges.filter((e) => e.to_file_id != null).length,
    relativeEdges: relEdges.length,
    relativeResolved: relEdges.filter((e) => e.to_file_id != null).length,
  };
  db.close();
  return { files: files.map((f) => f.path), dependents, blast5, stats };
}

// Unbounded transitive dependents of f (not including f).
function closure(graph, f) {
  const seen = new Set();
  const stack = [f];
  while (stack.length) {
    const x = stack.pop();
    for (const d of graph.dependents.get(x) || []) {
      if (!seen.has(d) && d !== f) { seen.add(d); stack.push(d); }
    }
  }
  return seen;
}

const SCOPE_TYPES = new Set(['Program', 'BlockStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
  'SwitchStatement', 'CatchClause', 'StaticBlock']);
const FN_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod']);

function walk(node, parent, anc, cb) {
  if (!node || typeof node.type !== 'string') return;
  cb(node, parent, anc);
  anc.push(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key.endsWith('Comments') || key === 'extra') continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c, node, anc, cb); }
    else if (v && typeof v.type === 'string') walk(v, node, anc, cb);
  }
  anc.pop();
}

function patternNames(p, out = []) {
  if (!p) return out;
  if (p.type === 'Identifier') out.push(p.name);
  else if (p.type === 'ObjectPattern') for (const pr of p.properties) patternNames(pr.type === 'RestElement' ? pr.argument : pr.value, out);
  else if (p.type === 'ArrayPattern') for (const el of p.elements) patternNames(el, out);
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
  else if (p.type === 'RestElement') patternNames(p.argument, out);
  return out;
}

// require('x'), require('x').a.b, await import is ignored
function requireSpec(node) {
  let n = node;
  while (n && (n.type === 'MemberExpression' || n.type === 'AwaitExpression')) n = n.type === 'MemberExpression' ? n.object : n.argument;
  if (n && n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require' &&
    n.arguments.length === 1 && n.arguments[0].type === 'StringLiteral') return n.arguments[0].value;
  return null;
}

function resolveModule(testFile, repoRoot, spec, known) {
  if (!/^\.\.?\//.test(spec)) return null;
  const base = path.resolve(path.dirname(testFile), spec);
  for (const c of [base, base + '.js', path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      const rel = path.relative(repoRoot, c).split(path.sep).join('/');
      return known.has(rel) ? rel : null;
    }
  }
  return null;
}

function suiteModules(testFile, repoRoot, knownFiles) {
  const src = fs.readFileSync(testFile, 'utf8');
  const ast = parse(src, { sourceType: 'script', allowReturnOutsideFunction: true });
  const known = new Set(knownFiles);
  const decls = []; // { name, start, end, modules:Set, str }
  const scopeOf = (anc, kind) => {
    for (let i = anc.length - 1; i >= 0; i--) {
      const a = anc[i];
      if (kind === 'var' ? (FN_TYPES.has(a.type) || a.type === 'Program') : (SCOPE_TYPES.has(a.type) || FN_TYPES.has(a.type))) return a;
    }
    return ast.program;
  };
  const lookup = (name, pos) => {
    let best = null;
    for (const d of decls) {
      if (d.name === name && d.start <= pos && pos < d.end && (!best || d.end - d.start < best.end - best.start)) best = d;
    }
    return best;
  };
  // Pass 1: declarations (variables, params)
  walk(ast.program, null, [], (node, parent, anc) => {
    if (node.type === 'VariableDeclarator') {
      const declKind = parent.kind;
      const sc = scopeOf(anc, declKind === 'var' ? 'var' : 'let');
      const spec = node.init ? requireSpec(node.init) : null;
      const mod = spec ? resolveModule(testFile, repoRoot, spec, known) : null;
      const str = node.init && node.init.type === 'StringLiteral' && node.id.type === 'Identifier' ? node.init.value : null;
      for (const name of patternNames(node.id)) {
        decls.push({ name, start: sc.start, end: sc.end, modules: new Set(mod ? [mod] : []), str });
      }
    } else if (FN_TYPES.has(node.type)) {
      for (const p of node.params) for (const name of patternNames(p)) decls.push({ name, start: node.start, end: node.end, modules: new Set(), str: null });
    }
  });
  // Pass 2: `x = require('...')` assignments attach to x's declaration
  walk(ast.program, null, [], (node) => {
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
      const spec = requireSpec(node.right);
      const mod = spec ? resolveModule(testFile, repoRoot, spec, known) : null;
      if (mod) { const d = lookup(node.left.name, node.start); if (d) d.modules.add(mod); }
    }
  });
  // Pass 3: test()/asyncTest() calls
  const suites = new Map();
  let unresolvedNames = 0;
  let nonInlineCallbacks = 0;
  walk(ast.program, null, [], (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' ||
      !['test', 'asyncTest'].includes(node.callee.name) || node.arguments.length < 3) return;
    const a0 = node.arguments[0];
    let suite = null;
    if (a0.type === 'StringLiteral') suite = a0.value;
    else if (a0.type === 'Identifier') { const d = lookup(a0.name, node.start); suite = d && d.str; }
    if (!suite) { unresolvedNames++; return; }
    if (!suites.has(suite)) suites.set(suite, { modules: new Set(), tests: 0 });
    const s = suites.get(suite);
    s.tests++;
    const fn = node.arguments[2];
    if (!FN_TYPES.has(fn.type)) { nonInlineCallbacks++; return; }
    walk(fn, null, [], (n, p) => {
      const spec = requireSpec(n);
      if (spec && n.type === 'CallExpression') {
        const mod = resolveModule(testFile, repoRoot, spec, known);
        if (mod) s.modules.add(mod);
      }
      if (n.type !== 'Identifier' || !p) return;
      if (p.type === 'MemberExpression' && p.property === n && !p.computed) return;
      if (p.type === 'OptionalMemberExpression' && p.property === n && !p.computed) return;
      if (p.type === 'ObjectProperty' && p.key === n && !p.computed && !p.shorthand) return;
      const d = lookup(n.name, node.start);
      if (d) for (const m of d.modules) s.modules.add(m);
    });
  });
  return { suites, unresolvedNames, nonInlineCallbacks };
}

module.exports = { loadGraph, closure, suiteModules };
