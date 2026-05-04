function pathToIdentifier(routePath) {
  const segments = routePath.split('/').filter(Boolean);
  const last = segments[segments.length - 1] || 'handler';
  return last.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'handler';
}

function descToIdentifier(desc) {
  const words = desc.trim().split(/\s+/);
  if (words.length === 1 && /^[a-zA-Z_]\w*$/.test(words[0])) return words[0];
  return words
    .map((w, i) => i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join('')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .replace(/^(\d)/, '_$1') || null;
}

function extractRoutes(content) {
  const routes = [];
  const lines = content.split('\n');
  const routePattern = /^#\*\s+@(get|post|put|delete|patch|options|head)\s+(\S+)/i;
  const descPattern = /^#\*\s+(?!@)(.+)/;

  for (let i = 0; i < lines.length; i++) {
    const routeMatch = lines[i].match(routePattern);
    if (!routeMatch) continue;

    const method = routeMatch[1].toUpperCase();
    const routePath = routeMatch[2].trim();

    let functionName = pathToIdentifier(routePath);
    for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
      const line = lines[j].trim();
      if (!line.startsWith('#')) break;
      const descMatch = line.match(descPattern);
      if (descMatch) {
        const derived = descToIdentifier(descMatch[1]);
        if (derived) functionName = derived;
        break;
      }
    }

    routes.push({ method, path: routePath, functionName });
  }
  return routes;
}

function extractFunctions(content) {
  const functions = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\w+\s*<-\s*function\s*\(/.test(line)) continue;

    const nameMatch = line.match(/^(\w+)\s*<-\s*function\s*\(/);
    if (!nameMatch) continue;

    const name = nameMatch[1];
    if (name.startsWith('.')) continue;

    let combined = line;
    let depth = 0;
    for (const ch of line) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }

    let safety = 0;
    while (depth > 0 && safety < 15 && i + 1 < lines.length) {
      i++;
      safety++;
      const next = lines[i].trim();
      combined += ' ' + next;
      for (const ch of next) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
    }

    const paramMatch = combined.match(/function\s*\(([^)]*)\)/);
    if (!paramMatch) continue;

    const params = paramMatch[1]
      .split(',')
      .map(p => p.split('=')[0].trim())
      .filter(p => p.length > 0)
      .join(', ');

    functions.push({ name, params: params || '—', returnType: '—' });
  }
  return functions;
}

function collapseParens(content) {
  const lines = content.split('\n');
  const result = [];
  let i = 0;
  while (i < lines.length) {
    let depth = 0;
    for (const ch of lines[i]) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth <= 0) {
      result.push(lines[i]);
      i++;
      continue;
    }
    let combined = lines[i];
    let safety = 0;
    while (depth > 0 && safety < 20 && i + 1 < lines.length) {
      i++;
      safety++;
      const next = lines[i].trim();
      combined += ' ' + next;
      for (const ch of next) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
    }
    result.push(combined);
    i++;
  }
  return result.join('\n');
}

function findBalancedEnd(str, openPos) {
  let depth = 1;
  let pos = openPos + 1;
  while (depth > 0 && pos < str.length) {
    if (str[pos] === '(') depth++;
    else if (str[pos] === ')') depth--;
    pos++;
  }
  return pos - 1;
}

function extractModels(content) {
  const models = [];
  const collapsed = collapseParens(content);

  const setClassRe = /setClass\s*\(\s*["'](\w+)["']/g;
  let m;
  while ((m = setClassRe.exec(collapsed)) !== null) {
    const className = m[1];
    const slotsIdx = collapsed.indexOf('slots', m.index);
    if (slotsIdx === -1 || slotsIdx > m.index + 300) continue;
    const listIdx = collapsed.indexOf('list(', slotsIdx);
    if (listIdx === -1) continue;
    const openPos = listIdx + 4;
    const closePos = findBalancedEnd(collapsed, openPos);
    const slotsContent = collapsed.slice(openPos + 1, closePos);
    const fields = [];
    const slotRe = /(\w+)\s*=\s*["']([^"']+)["']/g;
    let sm;
    while ((sm = slotRe.exec(slotsContent)) !== null) {
      fields.push({ name: sm[1], type: sm[2] });
    }
    models.push({ className, fields });
  }

  const dfRe = /^(\w+)\s*<-\s*data\.frame\s*\(/gm;
  while ((m = dfRe.exec(collapsed)) !== null) {
    const className = m[1];
    const openPos = m.index + m[0].length - 1;
    const closePos = findBalancedEnd(collapsed, openPos);
    const innerContent = collapsed.slice(openPos + 1, closePos);
    const fields = [];
    const colRe = /\b(\w+)\s*=\s*(\w+)\s*\(/g;
    let cm;
    while ((cm = colRe.exec(innerContent)) !== null) {
      fields.push({ name: cm[1], type: cm[2] });
    }
    if (fields.length > 0) {
      models.push({ className, fields });
    }
  }

  const r6Re = /^(\w+)\s*<-\s*(?:R6::)?R6Class\s*\(\s*["'](\w+)["']/gm;
  while ((m = r6Re.exec(collapsed)) !== null) {
    const className = m[2];
    const publicIdx = collapsed.indexOf('public', m.index);
    if (publicIdx === -1 || publicIdx > m.index + 600) continue;
    const listIdx = collapsed.indexOf('list(', publicIdx);
    if (listIdx === -1) continue;
    const openPos = listIdx + 4;
    const closePos = findBalancedEnd(collapsed, openPos);
    const publicContent = collapsed.slice(openPos + 1, closePos);
    const fields = [];
    const fieldRe = /\b(\w+)\s*=\s*(?!function\s*\()(\w+|["'][^"']*["'])/g;
    let fm;
    while ((fm = fieldRe.exec(publicContent)) !== null) {
      const name = fm[1];
      const rawVal = fm[2].trim();
      let type = 'any';
      if (/^["']/.test(rawVal)) type = 'character';
      else if (/^\d/.test(rawVal)) type = 'numeric';
      else if (rawVal === 'TRUE' || rawVal === 'FALSE') type = 'logical';
      fields.push({ name, type });
    }
    models.push({ className, fields });
  }

  return models;
}

function extractEnvVars(content) {
  const vars = new Set();
  const re = /Sys\.getenv\s*\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    vars.add(m[1]);
  }
  return [...vars].sort();
}

module.exports = {
  name: 'r',
  extensions: ['.r', '.R'],
  extract(content, filename) {
    try {
      return {
        routes:      extractRoutes(content),
        models:      extractModels(content),
        functions:   extractFunctions(content),
        envVars:     extractEnvVars(content),
        dbTables:    [],
        fetches:     [],
        storageKeys: [],
      };
    } catch (err) {
      console.warn(`[CARTO] r plugin error on ${filename}: ${err.message}`);
      return { routes: [], models: [], functions: [], envVars: [], dbTables: [], fetches: [], storageKeys: [] };
    }
  }
};
