const fs = require('fs');
const path = require('path');

const IGNORE_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.idea', '.vscode', '.carto']);

/**
 * detectFramework(projectRoot) → { framework, language, confidence }
 *
 * Search order (recursive up to 3 levels deep):
 * 1. requirements.txt → fastapi / django / flask / python-generic
 * 2. package.json → nextjs / express / react / node-generic
 * 3. pyproject.toml → same logic as requirements.txt
 * 4. Nothing found → { framework: 'unknown', language: 'unknown' }
 *
 * Returns first match found. Does not combine multiple detections.
 */
function detectFramework(projectRoot) {
  // Search for files up to 3 levels deep
  const candidates = findFile(projectRoot, ['requirements.txt', 'package.json', 'pyproject.toml'], 3);

  // 1. Check requirements.txt
  const reqFile = candidates.find(f => path.basename(f) === 'requirements.txt');
  if (reqFile) {
    const result = detectFromPythonDeps(reqFile);
    if (result) return result;
  }

  // 2. Check package.json
  const pkgFile = candidates.find(f => path.basename(f) === 'package.json');
  if (pkgFile) {
    const result = detectFromPackageJson(pkgFile);
    if (result) return result;
  }

  // 3. Check pyproject.toml
  const pyprojectFile = candidates.find(f => path.basename(f) === 'pyproject.toml');
  if (pyprojectFile) {
    const result = detectFromPythonDeps(pyprojectFile);
    if (result) return result;
  }

  return { framework: 'unknown', language: 'unknown', confidence: 'none' };
}

/**
 * Recursively find files by name up to maxDepth levels.
 */
function findFile(dir, fileNames, maxDepth, currentDepth = 0) {
  const results = [];
  if (currentDepth > maxDepth) return results;

  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const item of items) {
    if (IGNORE_DIRS.has(item.name)) continue;

    const fullPath = path.join(dir, item.name);
    if (item.isFile() && fileNames.includes(item.name)) {
      results.push(fullPath);
    } else if (item.isDirectory() && currentDepth < maxDepth) {
      results.push(...findFile(fullPath, fileNames, maxDepth, currentDepth + 1));
    }
  }
  return results;
}

function detectFromPythonDeps(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8').toLowerCase();
  } catch {
    return null;
  }

  if (content.includes('fastapi')) {
    return { framework: 'fastapi', language: 'python', confidence: 'high' };
  }
  if (content.includes('django')) {
    return { framework: 'django', language: 'python', confidence: 'high' };
  }
  if (content.includes('flask')) {
    return { framework: 'flask', language: 'python', confidence: 'high' };
  }
  if (content.includes('pydantic')) {
    return { framework: 'python-generic', language: 'python', confidence: 'medium' };
  }
  return null;
}

function detectFromPackageJson(filePath) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }

  const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});

  if (deps['next']) {
    return { framework: 'nextjs', language: 'javascript', confidence: 'high' };
  }
  if (deps['express']) {
    return { framework: 'express', language: 'javascript', confidence: 'high' };
  }
  if (deps['react']) {
    return { framework: 'react', language: 'javascript', confidence: 'high' };
  }
  return { framework: 'node-generic', language: 'javascript', confidence: 'medium' };
}

module.exports = { detectFramework };
