'use strict';

const fs = require('fs');

function collapseMultilineDecorators(content) {
  const lines = content.split('\n');
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*@/.test(lines[i])) {
      let combined = lines[i];
      let openParens = (combined.match(/\(/g) || []).length;
      let closeParens = (combined.match(/\)/g) || []).length;
      while (openParens > closeParens && i + 1 < lines.length) {
        i++;
        combined += ' ' + lines[i].trim();
        openParens = (combined.match(/\(/g) || []).length;
        closeParens = (combined.match(/\)/g) || []).length;
      }
      result.push(combined);
    } else {
      result.push(lines[i]);
    }
  }
  return result.join('\n');
}

/**
 * Extracts HTTP routes from FastAPI, Flask, and Django files.
 */
function extractRoutes(content) {
  return [
    ...extractFastAPIRoutes(content),
    ...extractFlaskRoutes(content),
    ...extractDjangoRoutes(content),
  ];
}

// ─── FastAPI ──────────────────────────────────────────────────────────────────

function extractFastAPIRoutes(content) {
  const routes = [];
  const decoratorPattern = /@(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/gi;
  const funcPattern = /(?:async\s+)?def\s+(\w+)/;

  const collapsed = collapseMultilineDecorators(content);
  const lines = collapsed.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i])) { decoratorPattern.lastIndex = 0; continue; }
    const match = decoratorPattern.exec(lines[i]);
    if (match) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const funcMatch = lines[j].match(funcPattern);
        if (funcMatch) {
          routes.push({ method: match[1].toUpperCase(), path: match[2], functionName: funcMatch[1] });
          break;
        }
      }
    }
    decoratorPattern.lastIndex = 0;
  }
  return routes;
}

// ─── Flask ───────────────────────────────────────────────────────────────────

function extractFlaskRoutes(content) {
  const routes = [];

  if (!content.includes('.route(') && !content.includes('from flask')) return routes;

  // @app.route('/path') or @bp.route('/path', methods=['GET', 'POST'])
  // Also handles: @api.route, @blueprint.route, any @x.route pattern
  const decoratorRe = /@\w+\.route\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*methods\s*=\s*\[([^\]]+)\])?\s*\)/g;
  const funcRe = /(?:async\s+)?def\s+(\w+)/;

  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    decoratorRe.lastIndex = 0;
    const match = decoratorRe.exec(lines[i]);
    if (!match) continue;

    const routePath = match[1];
    const methodsRaw = match[2];
    const methods = methodsRaw
      ? methodsRaw.split(',').map(m => m.trim().replace(/['"]/g, '').toUpperCase()).filter(Boolean)
      : ['GET'];

    let functionName = '[anonymous]';
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const fm = lines[j].match(funcRe);
      if (fm) { functionName = fm[1]; break; }
    }

    for (const method of methods) {
      routes.push({ method, path: routePath, functionName });
    }
  }

  return routes;
}

// ─── Django ───────────────────────────────────────────────────────────────────

function extractDjangoRoutes(content) {
  const routes = [];

  // Only process files that look like Django URL configs
  if (!content.includes('urlpatterns') && !content.includes('from django')) return routes;

  // path('endpoint/', view_func) or path('endpoint/', ViewClass.as_view())
  const pathPattern = /(?:path|re_path)\s*\(\s*r?['"]([^'"]+)['"]\s*,\s*(?:views\.)?(\w+)/g;
  let m;
  while ((m = pathPattern.exec(content)) !== null) {
    const urlPath = '/' + m[1].replace(/\/$/, '');
    const viewName = m[2];
    // Infer method from view name convention
    const method = viewName.toLowerCase().includes('create') || viewName.toLowerCase().includes('post') ? 'POST'
                 : viewName.toLowerCase().includes('update') || viewName.toLowerCase().includes('put') ? 'PUT'
                 : viewName.toLowerCase().includes('delete') ? 'DELETE'
                 : 'GET';
    routes.push({ method, path: urlPath, functionName: viewName });
  }

  return routes;
}

module.exports = { extractRoutes, collapseMultilineDecorators };
