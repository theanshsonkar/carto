const fs = require('fs');

/**
 * Joins multiline decorator expressions into single lines.
 * Scans for lines starting with @ and, if parentheses are unbalanced,
 * appends subsequent lines until they balance.
 */
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
 * Extracts HTTP route definitions from FastAPI Python files.
 * Handles @app.get/post/put/delete/patch and @router.get/post/put/delete/patch,
 * including multiline decorators.
 */
function extractRoutes(content) {
  const routes = [];
  const decoratorPattern = /@(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/gi;
  const funcPattern = /(?:async\s+)?def\s+(\w+)/;

  const collapsed = collapseMultilineDecorators(content);
  const lines = collapsed.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i])) { decoratorPattern.lastIndex = 0; continue; }
    const match = decoratorPattern.exec(lines[i]);
    if (match) {
      // Look ahead up to 5 lines for the function definition
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const funcMatch = lines[j].match(funcPattern);
        if (funcMatch) {
          routes.push({
            method: match[1].toUpperCase(),
            path: match[2],
            functionName: funcMatch[1]
          });
          break;
        }
      }
    }
    decoratorPattern.lastIndex = 0;
  }
  return routes;
}

module.exports = { extractRoutes, collapseMultilineDecorators };
