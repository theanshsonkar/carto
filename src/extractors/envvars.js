/**
 * extractEnvVars(content) → Array<string>
 *
 * Extracts environment variable NAMES ONLY. Never values. Never defaults.
 * Returns deduplicated, alphabetically sorted array.
 *
 * Supported patterns (Python only):
 *   os.getenv('VAR')
 *   os.getenv("VAR")
 *   os.environ.get('VAR')
 *   os.environ.get("VAR")
 *   os.environ['VAR']
 *   os.environ["VAR"]
 */
function extractEnvVars(content) {
  const vars = new Set();

  // os.getenv('VAR') or os.getenv("VAR")
  const getenvPattern = /os\.getenv\s*\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = getenvPattern.exec(content)) !== null) {
    vars.add(match[1]);
  }

  // os.environ.get('VAR') or os.environ.get("VAR")
  const environGetPattern = /os\.environ\.get\s*\(\s*['"]([^'"]+)['"]/g;
  while ((match = environGetPattern.exec(content)) !== null) {
    vars.add(match[1]);
  }

  // os.environ['VAR'] or os.environ["VAR"]
  const environBracketPattern = /os\.environ\s*\[\s*['"]([^'"]+)['"]\s*\]/g;
  while ((match = environBracketPattern.exec(content)) !== null) {
    vars.add(match[1]);
  }

  return [...vars].sort();
}

module.exports = { extractEnvVars };
