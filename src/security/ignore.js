const fs = require('fs');
const path = require('path');

const DEFAULT_IGNORE_PATTERNS = [
  '.env',
  '.env.*',
  '*secret*',
  '*SECRET*',
  '*password*',
  '*PASSWORD*',
  '*credential*',
  '*CREDENTIAL*',
  '*private_key*',
  '*PRIVATE_KEY*',
  '*.pem',
  '*.key'
];

/**
 * parseCartoIgnore(projectRoot) → isIgnored(filePath) → boolean
 *
 * Reads .cartoignore from the project root (if it exists) and merges with defaults.
 * Returns a function that checks if a file path matches any ignore pattern.
 */
function parseCartoIgnore(projectRoot) {
  let userPatterns = [];

  const ignoreFile = path.join(projectRoot, '.cartoignore');
  try {
    const content = fs.readFileSync(ignoreFile, 'utf-8');
    userPatterns = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch {
    // No .cartoignore file — that's fine, use defaults only
  }

  const allPatterns = [...DEFAULT_IGNORE_PATTERNS, ...userPatterns];

  return function isIgnored(filePath) {
    const basename = path.basename(filePath);
    const relativePath = filePath; // can be absolute or relative

    for (const pattern of allPatterns) {
      if (matchPattern(basename, pattern) || matchPattern(relativePath, pattern)) {
        return true;
      }
    }
    return false;
  };
}

/**
 * Simple glob matching supporting * as wildcard.
 */
function matchPattern(str, pattern) {
  // Escape regex special chars except *
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const regex = new RegExp(`^${regexStr}$`, 'i');
  return regex.test(str);
}

module.exports = { parseCartoIgnore, DEFAULT_IGNORE_PATTERNS };
