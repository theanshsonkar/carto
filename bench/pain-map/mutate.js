'use strict';
// Pain-map experiment: mutation-site discovery and application.
// Lists candidate mutation sites in a JS file (Babel AST) and applies one
// by splicing text at node offsets. CommonJS, Node >= 18, no new deps.

const fs = require('fs');
const crypto = require('crypto');
const { parse } = require('@babel/parser');

const SWAP = {
  '===': '!==', '!==': '===',
  '==': '!=', '!=': '==',
  '<': '>=', '>=': '<',
  '>': '<=', '<=': '>',
};
const LOGICAL = { '&&': '||', '||': '&&' };
const OP_CHARS = '=!<>&|';

function parseSource(src) {
  return parse(src, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    allowHashBang: true,
    errorRecovery: false,
    plugins: ['jsx'],
  });
}

// Find the operator token in the gap between left.end and right.start.
function findOpOffset(src, from, to, op) {
  const gap = src.slice(from, to);
  for (let i = 0; i + op.length <= gap.length; i++) {
    if (gap.substr(i, op.length) !== op) continue;
    const prev = gap[i - 1];
    const next = gap[i + op.length];
    if (prev && OP_CHARS.includes(prev)) continue;
    if (next && OP_CHARS.includes(next)) continue;
    return from + i;
  }
  return -1;
}

function keyName(key) {
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  if (key.type === 'NumericLiteral') return String(key.value);
  if (key.type === 'PrivateName') return '#' + key.id.name;
  return null;
}

function memberName(n) {
  if (!n) return null;
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'ThisExpression') return 'this';
  if (n.type === 'MemberExpression') {
    const o = memberName(n.object);
    const p = n.computed ? null : keyName(n.property);
    if (o && p) return `${o}.${p}`;
  }
  return null;
}

const FN_TYPES = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod',
]);

// Name a function node from itself or its parent; null if anonymous.
function functionName(node, parent, classStack) {
  const cls = classStack.length ? classStack[classStack.length - 1] : null;
  if (node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod') {
    const k = keyName(node.key);
    return k ? (cls ? `${cls}.${k}` : k) : null;
  }
  if (node.type === 'ObjectMethod') return keyName(node.key);
  if (node.id && node.id.name) return node.id.name;
  if (!parent) return null;
  if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
  if (parent.type === 'ObjectProperty' && parent.value === node) return keyName(parent.key);
  if (parent.type === 'AssignmentExpression' && parent.right === node) return memberName(parent.left);
  if ((parent.type === 'ClassProperty' || parent.type === 'ClassPrivateProperty') && parent.value === node) {
    const k = keyName(parent.key);
    return k ? (cls ? `${cls}.${k}` : k) : null;
  }
  return null;
}

/**
 * listSites(src) -> [{ id, op, start, end, original, replacement, line, fn }]
 * fn = nearest NAMED enclosing function; `<anon:Lnn>` if only inside an
 * anonymous function (nn = that function's start line); `<top>` otherwise.
 */
function listSites(src) {
  const ast = parseSource(src);
  const sites = [];
  const fnStack = []; // { name, anonLine }
  const classStack = [];

  function currentFn() {
    for (let i = fnStack.length - 1; i >= 0; i--) if (fnStack[i].name) return fnStack[i].name;
    if (fnStack.length) return `<anon:L${fnStack[fnStack.length - 1].line}>`;
    return '<top>';
  }

  function add(op, start, end, original, replacement, line) {
    sites.push({ op, start, end, original, replacement, line, fn: currentFn() });
  }

  function visit(node, parent) {
    if (!node || typeof node.type !== 'string') return;
    let pushedFn = false;
    let pushedCls = false;
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      let cname = node.id && node.id.name;
      if (!cname && parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') cname = parent.id.name;
      classStack.push(cname || '<class>');
      pushedCls = true;
    }
    if (FN_TYPES.has(node.type)) {
      fnStack.push({ name: functionName(node, parent, classStack), line: node.loc.start.line });
      pushedFn = true;
    }

    if (node.type === 'BinaryExpression' && SWAP[node.operator] && node.left.type !== 'PrivateName') {
      const off = findOpOffset(src, node.left.end, node.right.start, node.operator);
      if (off >= 0) {
        add(`${node.operator}->${SWAP[node.operator]}`, off, off + node.operator.length,
          node.operator, SWAP[node.operator], node.loc.start.line);
      }
    } else if (node.type === 'LogicalExpression' && LOGICAL[node.operator]) {
      const off = findOpOffset(src, node.left.end, node.right.start, node.operator);
      if (off >= 0) {
        add(`${node.operator}->${LOGICAL[node.operator]}`, off, off + node.operator.length,
          node.operator, LOGICAL[node.operator], node.loc.start.line);
      }
    } else if (node.type === 'BooleanLiteral') {
      const rep = node.value ? 'false' : 'true';
      add(`${node.value}->${rep}`, node.start, node.end, src.slice(node.start, node.end), rep, node.loc.start.line);
    }
    if (node.type === 'IfStatement') {
      const t = node.test;
      const alreadyFalse = t.type === 'BooleanLiteral' && t.value === false;
      if (!alreadyFalse) {
        add('if->false', t.start, t.end, src.slice(t.start, t.end), 'false', node.loc.start.line);
      }
    }

    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'extra') continue;
      const v = node[key];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') visit(c, node); }
      else if (v && typeof v.type === 'string') visit(v, node);
    }
    if (pushedFn) fnStack.pop();
    if (pushedCls) classStack.pop();
  }
  visit(ast.program, null);
  sites.sort((a, b) => a.start - b.start || a.end - b.end);
  sites.forEach((s, i) => { s.id = i; });
  return sites;
}

function applySite(src, site) {
  if (src.slice(site.start, site.end) !== site.original) {
    throw new Error(`site ${site.id} does not match source text`);
  }
  return src.slice(0, site.start) + site.replacement + src.slice(site.end);
}

// mulberry32 seeded PRNG
function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(str, base) {
  const h = crypto.createHash('sha256').update(`${base}:${str}`).digest();
  return h.readUInt32LE(0);
}

function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * chooseSites(sites, k, rnd): spread over functions. Shuffle the function
 * groups, then round-robin taking one random not-yet-chosen site per group
 * until k sites are chosen or sites run out.
 */
function chooseSites(sites, k, rnd) {
  const groups = new Map();
  for (const s of sites) {
    if (!groups.has(s.fn)) groups.set(s.fn, []);
    groups.get(s.fn).push(s);
  }
  const order = shuffle([...groups.keys()].sort(), rnd);
  const pools = new Map(order.map((g) => [g, shuffle(groups.get(g), rnd)]));
  const chosen = [];
  while (chosen.length < k) {
    let took = false;
    for (const g of order) {
      if (chosen.length >= k) break;
      const p = pools.get(g);
      if (p.length) { chosen.push(p.shift()); took = true; }
    }
    if (!took) break;
  }
  return chosen.sort((a, b) => a.id - b.id);
}

module.exports = { listSites, applySite, chooseSites, prng, seedFor, shuffle };

if (require.main === module) {
  const file = process.argv[2];
  const sites = listSites(fs.readFileSync(file, 'utf8'));
  for (const s of sites) console.log(`${s.id}\tL${s.line}\t${s.fn}\t${s.op}`);
  console.error(`${sites.length} sites`);
}
