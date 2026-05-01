/**
 * extractFunctions(content, filename) → Array<{ name, params, returnType }>
 *
 * Handles both single-line and multiline function signatures.
 * Only extracts TOP-LEVEL functions (lines starting at column 0).
 * Skips dunder methods (__name__).
 * Includes private functions (_name).
 */
function extractFunctions(content, filename) {
  const functions = [];
  const lines = content.split('\n');

  // Step 1: Collapse multiline signatures
  const collapsed = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only match top-level function defs (column 0)
    if (/^(async\s+)?def\s+\w+\s*\(/.test(line)) {
      let combined = line;
      // If no closing paren, keep appending (up to 10 lines safety limit)
      let safety = 0;
      while (!combined.includes(')') && safety < 10 && i + 1 < lines.length) {
        i++;
        safety++;
        combined += ' ' + lines[i].trim();
      }
      collapsed.push(combined);
    }
  }

  // Step 2: Extract from collapsed lines
  const defPattern = /^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*(.+?))?\s*:/;

  for (const line of collapsed) {
    const match = line.match(defPattern);
    if (!match) continue;

    const name = match[2];

    // Skip dunder methods
    if (name.startsWith('__')) continue;

    const rawParams = match[3];
    const returnType = match[4] ? match[4].trim() : '\u2014';

    // Step 3: Clean params
    const skipParams = new Set(['self', '*args', '**kwargs', '*', '']);
    const params = rawParams
      .split(',')
      .map(p => {
        // Strip type annotation (everything after first ":")
        let cleaned = p.split(':')[0];
        // Strip default value (everything after first "=")
        cleaned = cleaned.split('=')[0];
        return cleaned.trim();
      })
      .filter(p => !skipParams.has(p));

    functions.push({
      name,
      params: params.length > 0 ? params.join(', ') : '\u2014',
      returnType
    });
  }

  return functions;
}

module.exports = { extractFunctions };
