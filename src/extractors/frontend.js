/**
 * Extracts fetch() calls and sessionStorage usage from HTML/JS content.
 * Strips newlines before fetch matching to handle multiline fetch options.
 * Also detects dynamic fetch calls where the URL is a variable.
 */
function extractFrontend(content) {
  const fetches = [];
  const storageKeys = [];

  // Strip newlines so [^}]* can cross what were originally separate lines
  const singleLineContent = content.replace(/\n/g, ' ');

  const fetchPattern = /fetch\s*\(\s*[`"']([^`"']+)[`"']\s*(?:,\s*\{[^}]*method\s*:\s*["'](\w+)["'][^}]*\})?/g;
  let match;
  while ((match = fetchPattern.exec(singleLineContent)) !== null) {
    fetches.push({
      url: match[1],
      method: match[2] ? match[2].toUpperCase() : 'GET'
    });
  }

  // Detect dynamic fetch calls — fetch(variable, ...) where variable is a bare identifier
  const dynamicFetchPattern = /fetch\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[,)]/g;
  const reserved = new Set(['true', 'false', 'null', 'undefined']);
  while ((match = dynamicFetchPattern.exec(singleLineContent)) !== null) {
    if (!reserved.has(match[1])) {
      fetches.push({ url: '[dynamic]', method: '[dynamic]' });
    }
  }

  // sessionStorage — original content is fine, these are single-line
  const storagePattern = /sessionStorage\.(getItem|setItem)\s*\(\s*["']([^"']+)["']/g;
  while ((match = storagePattern.exec(content)) !== null) {
    storageKeys.push({
      operation: match[1],
      key: match[2]
    });
  }

  // Collapse dynamic fetches into a single summary row
  const staticFetches = fetches.filter(f => f.url !== '[dynamic]');
  const dynamicCount = fetches.filter(f => f.url === '[dynamic]').length;
  if (dynamicCount > 0) {
    staticFetches.push({
      url: `[dynamic \u00d7${dynamicCount}]`,
      method: '\u2014'
    });
  }

  // Deduplicate storage keys — keep first occurrence only
  const seen = new Set();
  const dedupedStorageKeys = storageKeys.filter(({ operation, key }) => {
    const id = `${operation}::${key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  return { fetches: staticFetches, storageKeys: dedupedStorageKeys };
}

module.exports = { extractFrontend };
