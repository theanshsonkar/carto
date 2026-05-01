const fs = require('fs');
const path = require('path');

const IGNORE_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.idea', '.vscode', '.carto']);

// Priority order: lower index = higher priority
const PYTHON_PRIORITY = ['fastapi', 'django', 'flask', 'python-generic'];
const JS_PRIORITY = ['nextjs', 'express', 'react', 'node-generic'];

/**
 * detectFramework(projectRoot) → { framework, language, confidence, secondaryFramework?, secondaryLanguage? }
 *
 * Collects all matches from requirements.txt, package.json, pyproject.toml.
 * Picks the most specific Python and JS framework by priority.
 * If both a Python and JS framework are detected, returns both
 * (primary = highest priority overall, secondary = the other language).
 */
function detectFramework(projectRoot) {
  const candidates = findFile(projectRoot, ['requirements.txt', 'package.json', 'pyproject.toml'], 3);

  const pythonDetections = new Set();
  const jsDetections = new Set();

  // Check requirements.txt
  for (const f of candidates.filter(f => path.basename(f) === 'requirements.txt')) {
    const results = detectAllFromPythonDeps(f);
    for (const r of results) pythonDetections.add(r);
  }

  // Check pyproject.toml
  for (const f of candidates.filter(f => path.basename(f) === 'pyproject.toml')) {
    const results = detectAllFromPythonDeps(f);
    for (const r of results) pythonDetections.add(r);
  }

  // Check package.json
  for (const f of candidates.filter(f => path.basename(f) === 'package.json')) {
    const results = detectAllFromPackageJson(f);
    for (const r of results) jsDetections.add(r);
  }

  // Pick best Python framework by priority
  const bestPython = PYTHON_PRIORITY.find(fw => pythonDetections.has(fw)) || null;
  // Pick best JS framework by priority
  const bestJS = JS_PRIORITY.find(fw => jsDetections.has(fw)) || null;

  if (bestPython && bestJS) {
    // Both detected — Python is primary (higher priority in the global list)
    return {
      framework: bestPython,
      language: 'python',
      confidence: 'high',
      secondaryFramework: bestJS,
      secondaryLanguage: 'javascript'
    };
  }

  if (bestPython) {
    return { framework: bestPython, language: 'python', confidence: 'high' };
  }

  if (bestJS) {
    return { framework: bestJS, language: 'javascript', confidence: 'high' };
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

/**
 * Returns all matching Python frameworks from a deps file.
 */
function detectAllFromPythonDeps(filePath) {
  const detected = [];
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8').toLowerCase();
  } catch {
    return detected;
  }

  if (content.includes('fastapi')) detected.push('fastapi');
  if (content.includes('django')) detected.push('django');
  if (content.includes('flask')) detected.push('flask');
  if (content.includes('pydantic') && !detected.length) detected.push('python-generic');

  return detected;
}

/**
 * Returns all matching JS frameworks from a package.json.
 */
function detectAllFromPackageJson(filePath) {
  const detected = [];
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return detected;
  }

  const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});

  if (deps['next']) detected.push('nextjs');
  if (deps['express']) detected.push('express');
  if (deps['react'] && !deps['next']) detected.push('react');
  if (!detected.length) detected.push('node-generic');

  return detected;
}

module.exports = { detectFramework };
