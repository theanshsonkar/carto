const fs = require('fs');
const path = require('path');

const IGNORE_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.idea', '.vscode', '.carto']);

// Priority order: lower index = higher priority
const PYTHON_PRIORITY = ['fastapi', 'django', 'flask', 'python-generic'];
const JS_PRIORITY = ['nextjs', 'express', 'react', 'node-generic'];
const R_PRIORITY = ['plumber', 'shiny', 'r-generic'];
const GO_PRIORITY = ['gin', 'echo', 'chi', 'fiber', 'go-generic'];

/**
 * detectFramework(projectRoot) → { framework, language, confidence, secondaryFramework?, secondaryLanguage? }
 *
 * Collects all matches from requirements.txt, package.json, pyproject.toml.
 * Picks the most specific Python and JS framework by priority.
 * If both a Python and JS framework are detected, returns both
 * (primary = highest priority overall, secondary = the other language).
 */
function detectFramework(projectRoot) {
  const candidates = findFile(projectRoot, ['requirements.txt', 'package.json', 'pyproject.toml', 'DESCRIPTION', 'go.mod'], 3);

  const pythonDetections = new Set();
  const jsDetections = new Set();
  const rDetections = new Set();

  for (const f of candidates.filter(f => path.basename(f) === 'requirements.txt')) {
    for (const r of detectAllFromPythonDeps(f)) pythonDetections.add(r);
  }

  for (const f of candidates.filter(f => path.basename(f) === 'pyproject.toml')) {
    for (const r of detectAllFromPythonDeps(f)) pythonDetections.add(r);
  }

  for (const f of candidates.filter(f => path.basename(f) === 'package.json')) {
    for (const r of detectAllFromPackageJson(f)) jsDetections.add(r);
  }

  for (const f of candidates.filter(f => path.basename(f) === 'DESCRIPTION')) {
    for (const r of detectAllFromRDescription(f)) rDetections.add(r);
  }

  if (rDetections.size === 0) {
    for (const r of detectAllFromRFiles(projectRoot)) rDetections.add(r);
  }

  const goDetections = new Set();
  for (const f of candidates.filter(f => path.basename(f) === 'go.mod')) {
    for (const r of detectAllFromGoMod(f)) goDetections.add(r);
  }

  const bestPython = PYTHON_PRIORITY.find(fw => pythonDetections.has(fw)) || null;
  const bestJS = JS_PRIORITY.find(fw => jsDetections.has(fw)) || null;
  const bestR = R_PRIORITY.find(fw => rDetections.has(fw)) || null;
  const bestGo = GO_PRIORITY.find(fw => goDetections.has(fw)) || null;

  if (bestPython && bestJS) {
    return {
      framework: bestPython,
      language: 'python',
      confidence: 'high',
      secondaryFramework: bestJS,
      secondaryLanguage: 'javascript'
    };
  }

  if (bestPython) return { framework: bestPython, language: 'python', confidence: 'high' };
  if (bestJS)     return { framework: bestJS, language: 'javascript', confidence: 'high' };
  if (bestGo)     return { framework: bestGo, language: 'go', confidence: 'high' };
  if (bestR)      return { framework: bestR, language: 'r', confidence: 'high' };

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

function detectAllFromGoMod(filePath) {
  const detected = [];
  let content;
  try { content = fs.readFileSync(filePath, 'utf-8').toLowerCase(); } catch { return detected; }
  if (content.includes('gin-gonic/gin'))   detected.push('gin');
  if (content.includes('labstack/echo'))   detected.push('echo');
  if (content.includes('go-chi/chi'))      detected.push('chi');
  if (content.includes('gofiber/fiber'))   detected.push('fiber');
  if (!detected.length)                    detected.push('go-generic');
  return detected;
}

function detectAllFromRDescription(filePath) {
  const detected = [];
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8').toLowerCase();
  } catch {
    return detected;
  }
  if (content.includes('plumber')) detected.push('plumber');
  if (content.includes('shiny')) detected.push('shiny');
  if (!detected.length) detected.push('r-generic');
  return detected;
}

function detectAllFromRFiles(projectRoot) {
  const detected = [];
  let files;
  try {
    files = fs.readdirSync(projectRoot).filter(f => f.endsWith('.R') || f.endsWith('.r'));
  } catch {
    return detected;
  }
  if (!files.length) return detected;

  for (const file of files.slice(0, 5)) {
    let content;
    try {
      content = fs.readFileSync(path.join(projectRoot, file), 'utf-8').toLowerCase();
    } catch {
      continue;
    }
    if (/library\s*\(\s*["']?plumber["']?\s*\)/.test(content)) detected.push('plumber');
    if (/library\s*\(\s*["']?shiny["']?\s*\)/.test(content)) detected.push('shiny');
  }

  if (!detected.length) detected.push('r-generic');
  return detected;
}

module.exports = { detectFramework };
