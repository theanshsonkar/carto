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
 * Extracts HTTP routes from FastAPI and Django files.
 */
function extractRoutes(content) {
  return [
    ...extractFastAPIRoutes(content),
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
