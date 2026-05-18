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

const AI_TOOLING_DIRS = [
  '.claude', '.cursor', '.gemini', '.copilot', '.continue',
  '.aider', '.codeium', '.windsurf', '.serena', '.cody',
  '.tabnine', '.supermaven', '.qodo', '.codex', '.roo',
];

function writeAiIgnoreFile(projectRoot) {
  const ignoreFile = path.join(projectRoot, '.cartoignore');
  let existingContent = '';
  let existingLines = [];
  try {
    existingContent = fs.readFileSync(ignoreFile, 'utf-8');
    existingLines = existingContent.split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    // No existing file
  }

  const toAdd = AI_TOOLING_DIRS.filter(dir => !existingLines.includes(dir));
  if (toAdd.length === 0) return;

  const prefix = existingContent ? existingContent.trimEnd() + '\n\n' : '';
  fs.writeFileSync(
    ignoreFile,
    prefix + '# AI tooling directories\n' + toAdd.join('\n') + '\n',
    'utf-8'
  );
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

module.exports = { parseCartoIgnore, DEFAULT_IGNORE_PATTERNS, AI_TOOLING_DIRS, writeAiIgnoreFile };
