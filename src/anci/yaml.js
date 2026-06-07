'use strict';

/**
 * Minimal YAML emit + parse for the ANCI v0.1 strict subset.
 *
 * What the strict subset is:
 *   - 2-space indentation
 *   - `key: value` pairs only (no flow style {} / [])
 *   - All string values double-quoted (`"..."`)
 *   - Numbers and booleans bare (`123`, `true`, `false`, `null`)
 *   - Lists use `- ` prefix at the indent of their parent key, then the
 *     item's own content indented one further level.
 *   - No multi-line strings, no anchors/aliases/tags, no doc separators.
 *
 * What the subset is NOT:
 *   - A general YAML implementation. We hand-roll exactly what ANCI
 *     v0.1 needs because pulling `js-yaml` (≈100 KB) for a fixed,
 *     well-shaped file is overkill.
 *   - Tolerant of arbitrary YAML inputs. Anything outside the subset
 *     either parses garbled or throws — which is fine because the
 *     reference implementation only emits the subset, and consumers
 *     pin to the reference until v1.0.
 *
 * Round-trip property: parse(emit(obj)) deepEquals obj for any object
 * whose leaf values are all string / number / boolean / null and whose
 * shape is plain object | array of plain objects | array of leaves.
 */

// ── EMIT ───────────────────────────────────────────────────────────

function emitScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new Error(`yaml.emit: cannot serialize non-finite number: ${v}`);
    }
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') {
    // Double-quoted string. Escape backslash, double-quote, and control
    // chars. Newlines as `\n`, tabs as `\t`. Everything else passes
    // through as UTF-8 since the file is UTF-8.
    let out = '"';
    for (let i = 0; i < v.length; i++) {
      const ch = v.charCodeAt(i);
      const c = v[i];
      if (c === '\\' || c === '"') { out += '\\' + c; }
      else if (ch === 0x0A) { out += '\\n'; }
      else if (ch === 0x0D) { out += '\\r'; }
      else if (ch === 0x09) { out += '\\t'; }
      else if (ch < 0x20) { out += '\\u' + ch.toString(16).padStart(4, '0'); }
      else { out += c; }
    }
    out += '"';
    return out;
  }
  throw new Error(`yaml.emit: unsupported scalar type: ${typeof v}`);
}

function isLeaf(v) {
  return v === null || typeof v !== 'object';
}

function emitNode(value, indent) {
  const pad = '  '.repeat(indent);
  const lines = [];

  if (Array.isArray(value)) {
    if (value.length === 0) {
      // An empty list at top level needs to be expressed somehow. We use
      // YAML flow `[]` for empties only — it's still strict enough that
      // a hand-written parser handles it deterministically.
      // Callers that emit a list under a key write `key: []` directly
      // (see emitObject); this branch is reached only for nested arrays
      // of arrays, which the ANCI schema does not contain.
      lines.push(`${pad}[]`);
      return lines;
    }
    for (const item of value) {
      if (isLeaf(item)) {
        lines.push(`${pad}- ${emitScalar(item)}`);
      } else if (Array.isArray(item)) {
        throw new Error('yaml.emit: nested arrays are not in the ANCI subset');
      } else {
        // Object item: emit `- key: value` for first key, then indent the
        // rest at indent+1 with two-space prefix to align under the dash.
        const keys = Object.keys(item);
        if (keys.length === 0) {
          lines.push(`${pad}- {}`);
          continue;
        }
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          const v = item[k];
          const prefix = i === 0 ? `${pad}- ` : `${pad}  `;
          if (isLeaf(v)) {
            lines.push(`${prefix}${k}: ${emitScalar(v)}`);
          } else if (Array.isArray(v) && v.length === 0) {
            lines.push(`${prefix}${k}: []`);
          } else {
            lines.push(`${prefix}${k}:`);
            const inner = emitNode(v, indent + 2);
            for (const ln of inner) lines.push(ln);
          }
        }
      }
    }
    return lines;
  }

  // Plain object
  const keys = Object.keys(value);
  for (const k of keys) {
    const v = value[k];
    if (isLeaf(v)) {
      lines.push(`${pad}${k}: ${emitScalar(v)}`);
    } else if (Array.isArray(v) && v.length === 0) {
      lines.push(`${pad}${k}: []`);
    } else {
      lines.push(`${pad}${k}:`);
      const inner = emitNode(v, indent + 1);
      for (const ln of inner) lines.push(ln);
    }
  }
  return lines;
}

/**
 * emit(obj) → string
 *
 * Produces a UTF-8 YAML document conforming to the ANCI v0.1 strict
 * subset. Trailing newline included.
 */
function emit(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('yaml.emit: top-level value must be a plain object');
  }
  const lines = emitNode(obj, 0);
  return lines.join('\n') + '\n';
}

// ── PARSE ──────────────────────────────────────────────────────────

function parseScalar(s, ctx) {
  const t = s.trim();
  if (t === '' || t === 'null' || t === '~') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === '[]') return [];
  if (t === '{}') return {};
  // Quoted string
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    return parseQuotedString(t, ctx);
  }
  // Number — integer or float
  if (/^-?\d+$/.test(t)) {
    const n = parseInt(t, 10);
    if (Number.isSafeInteger(n)) return n;
    return Number(t); // fall back to float repr for very large ints
  }
  if (/^-?\d+\.\d+([eE][+-]?\d+)?$/.test(t)) return parseFloat(t);
  throw new Error(
    `yaml.parse: line ${ctx.lineNo}: scalar must be quoted, numeric, ` +
    `boolean, or null (got: ${JSON.stringify(t)})`
  );
}

function parseQuotedString(s, ctx) {
  // Caller guarantees s starts and ends with ".
  let out = '';
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i];
    if (c === '\\') {
      const next = s[i + 1];
      if (next === undefined) {
        throw new Error(`yaml.parse: line ${ctx.lineNo}: trailing backslash`);
      }
      if (next === 'n') { out += '\n'; i++; }
      else if (next === 't') { out += '\t'; i++; }
      else if (next === 'r') { out += '\r'; i++; }
      else if (next === '\\') { out += '\\'; i++; }
      else if (next === '"') { out += '"'; i++; }
      else if (next === 'u') {
        const hex = s.substr(i + 2, 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new Error(`yaml.parse: line ${ctx.lineNo}: invalid \\u escape`);
        }
        out += String.fromCharCode(parseInt(hex, 16));
        i += 5;
      } else {
        throw new Error(`yaml.parse: line ${ctx.lineNo}: bad escape \\${next}`);
      }
    } else {
      out += c;
    }
  }
  return out;
}

function indentOf(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i % 2 !== 0) {
    // ANCI strict subset uses 2-space indent; any odd column is malformed.
    // Exception: the `  ` continuation under a list dash is at indent+2,
    // which is even — so pure 2-space indent always lands on even cols.
    throw new Error(`yaml.parse: indent must be a multiple of 2 (got ${i})`);
  }
  return i / 2;
}

/**
 * Tokenize: produce one record per non-empty, non-comment line:
 *   { lineNo, indent, kind: 'item' | 'pair' | 'item-with-pair', key?, value? }
 *
 * - 'item'           : `- "x"` or `- 42`  (plain scalar list item)
 * - 'pair'           : `key: value`        (object pair; value may be empty)
 * - 'item-with-pair' : `- key: value`      (object item; first key)
 *
 * Empty lines and lines with only whitespace are dropped. We do not
 * support YAML comments since ANCI emit never produces them and we
 * do not want to be lenient enough to silently swallow malformed
 * content as a "comment."
 */
function tokenize(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*$/.test(raw)) continue;
    // Strip inline comments? The strict emit never produces them. We
    // refuse silently-tolerated comments to keep the parser deterministic.
    const indent = indentOf(raw);
    const body = raw.slice(indent * 2);
    const lineNo = i + 1;

    if (body.startsWith('- ')) {
      const after = body.slice(2);
      // List item: either `- scalar` or `- key: value`
      const firstColon = findUnquotedColon(after);
      if (firstColon >= 0) {
        const key = after.slice(0, firstColon).trim();
        const value = after.slice(firstColon + 1).trim();
        out.push({ lineNo, indent, kind: 'item-with-pair', key, value });
      } else {
        out.push({ lineNo, indent, kind: 'item', value: after.trim() });
      }
    } else {
      const firstColon = findUnquotedColon(body);
      if (firstColon < 0) {
        throw new Error(`yaml.parse: line ${lineNo}: expected 'key: value' or '- ...'`);
      }
      const key = body.slice(0, firstColon).trim();
      const value = body.slice(firstColon + 1).trim();
      out.push({ lineNo, indent, kind: 'pair', key, value });
    }
  }
  return out;
}

/**
 * findUnquotedColon — return the index of the first `:` that is not
 * inside a double-quoted string, or -1 if none.
 *
 * Required because key names are bare but values may be quoted strings
 * that themselves contain colons (e.g. `path: "https://example.com:8080"`).
 */
function findUnquotedColon(s) {
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && inQuote) { i++; continue; }
    if (c === '"') { inQuote = !inQuote; continue; }
    if (c === ':' && !inQuote) return i;
  }
  return -1;
}

/**
 * Parse a token stream starting at `start` at indent level `level`.
 * Returns [value, nextIndex]. Used recursively by parseObject and
 * parseList.
 *
 * Decision rule: peek at the first token at or after `start` whose
 * indent === level. If it's a 'pair', we're parsing an object. If
 * it's an 'item' or 'item-with-pair', we're parsing an array.
 */
function parseValueAtLevel(tokens, start, level) {
  if (start >= tokens.length || tokens[start].indent !== level) {
    // Empty container — caller should have handled this case.
    return [null, start];
  }
  const first = tokens[start];
  if (first.kind === 'pair') return parseObject(tokens, start, level);
  return parseList(tokens, start, level);
}

function parseObject(tokens, start, level) {
  const obj = {};
  let i = start;
  while (i < tokens.length && tokens[i].indent === level) {
    const t = tokens[i];
    if (t.kind !== 'pair') {
      throw new Error(`yaml.parse: line ${t.lineNo}: expected key:value at indent ${level}`);
    }
    if (t.value === '') {
      // Nested container under this key.
      const childLevel = level + 1;
      if (i + 1 >= tokens.length || tokens[i + 1].indent !== childLevel) {
        // Empty nested container — represent as null.
        obj[t.key] = null;
        i++;
        continue;
      }
      const [val, next] = parseValueAtLevel(tokens, i + 1, childLevel);
      obj[t.key] = val;
      i = next;
    } else {
      obj[t.key] = parseScalar(t.value, t);
      i++;
    }
  }
  return [obj, i];
}

function parseList(tokens, start, level) {
  const list = [];
  let i = start;
  while (i < tokens.length && tokens[i].indent === level) {
    const t = tokens[i];
    if (t.kind === 'item') {
      list.push(parseScalar(t.value, t));
      i++;
    } else if (t.kind === 'item-with-pair') {
      // Object item. Collect the first pair, then keep absorbing pairs
      // at indent === level + 1 (the `- ` plus 2-space continuation).
      const item = {};
      if (t.value === '') {
        // `- key:`  — value is a nested container at level + 2
        const childLevel = level + 2;
        if (i + 1 < tokens.length && tokens[i + 1].indent === childLevel) {
          const [val, next] = parseValueAtLevel(tokens, i + 1, childLevel);
          item[t.key] = val;
          i = next;
        } else {
          item[t.key] = null;
          i++;
        }
      } else {
        item[t.key] = parseScalar(t.value, t);
        i++;
      }
      // Absorb subsequent pair lines at level + 1 (continuation lines).
      while (i < tokens.length && tokens[i].indent === level + 1 && tokens[i].kind === 'pair') {
        const cp = tokens[i];
        if (cp.value === '') {
          const childLevel = level + 2;
          if (i + 1 < tokens.length && tokens[i + 1].indent === childLevel) {
            const [val, next] = parseValueAtLevel(tokens, i + 1, childLevel);
            item[cp.key] = val;
            i = next;
          } else {
            item[cp.key] = null;
            i++;
          }
        } else {
          item[cp.key] = parseScalar(cp.value, cp);
          i++;
        }
      }
      list.push(item);
    } else {
      // A 'pair' at this level inside what we thought was a list — bail.
      throw new Error(`yaml.parse: line ${t.lineNo}: unexpected pair inside list at indent ${level}`);
    }
  }
  return [list, i];
}

/**
 * parse(text) → object
 *
 * Parses a YAML document conforming to the ANCI v0.1 strict subset.
 * Throws on any input outside the subset (no silent tolerance — see
 * file header for rationale).
 */
function parse(text) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return {};
  if (tokens[0].indent !== 0) {
    throw new Error(`yaml.parse: line ${tokens[0].lineNo}: first token must be at indent 0`);
  }
  const [val, next] = parseValueAtLevel(tokens, 0, 0);
  if (next !== tokens.length) {
    throw new Error(`yaml.parse: line ${tokens[next].lineNo}: unexpected trailing content`);
  }
  return val == null ? {} : val;
}

module.exports = { emit, parse };
