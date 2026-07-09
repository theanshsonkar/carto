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
  const jsProd = new Set();
  const jsDev = new Set();
  let sawPackageJson = false;
  let sawBinPackage = false;
  const rDetections = new Set();

  for (const f of candidates.filter(f => path.basename(f) === 'requirements.txt')) {
    for (const r of detectAllFromPythonDeps(f)) pythonDetections.add(r);
  }

  for (const f of candidates.filter(f => path.basename(f) === 'pyproject.toml')) {
    for (const r of detectAllFromPythonDeps(f)) pythonDetections.add(r);
  }

  for (const f of candidates.filter(f => path.basename(f) === 'package.json')) {
    sawPackageJson = true;
    for (const r of detectAllFromPackageJson(f)) {
      if (r.hasBin) sawBinPackage = true;
      (r.dev ? jsDev : jsProd).add(r.framework);
    }
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

  // ── JS framework selection (CARTO-010) ──────────────────────────────
  // Weight prod deps over dev deps. A framework declared in `dependencies`
  // is a high-confidence app signal. A UI framework (react) seen ONLY in
  // `devDependencies` is a dev-tool/build-time signal, not the repo's app
  // framework — a library/CLI monorepo (prisma) must not report "react".
  const UI_DEV_ONLY_DOWNRANK = new Set(['react']);
  let bestJS = JS_PRIORITY.find(fw => jsProd.has(fw)) || null;
  let jsConfidence = bestJS ? 'high' : 'none';
  if (!bestJS) {
    const devFw = JS_PRIORITY.find(fw => jsDev.has(fw) && fw !== 'node-generic') || null;
    if (devFw && !UI_DEV_ONLY_DOWNRANK.has(devFw)) {
      // A non-UI framework (next/express) in devDeps only — unusual but a
      // real, if weak, signal. Report it low-confidence.
      bestJS = devFw;
      jsConfidence = 'low';
    } else if (sawPackageJson) {
      // Either only a dev-only UI framework (react in devDeps → library/CLI,
      // esp. when a `bin` is present), or a package.json with no framework
      // at all. Both resolve to the generic Node shape, low confidence.
      bestJS = 'node-generic';
      jsConfidence = 'low';
    }
  }
  void sawBinPackage; // library-vs-app hint; dev-only UI already routes here

  const bestR = R_PRIORITY.find(fw => rDetections.has(fw)) || null;
  const bestGo = GO_PRIORITY.find(fw => goDetections.has(fw)) || null;

  if (bestPython && bestJS) {
    return {
      framework: bestPython,
      language: 'python',
      confidence: 'high',
      secondaryFramework: bestJS,
      secondaryLanguage: deriveJsLanguage(projectRoot)
    };
  }

  if (bestPython) return { framework: bestPython, language: 'python', confidence: 'high' };
  if (bestJS)     return { framework: bestJS, language: deriveJsLanguage(projectRoot), confidence: jsConfidence };
  if (bestGo)     return { framework: bestGo, language: 'go', confidence: 'high' };
  if (bestR)      return { framework: bestR, language: 'r', confidence: 'high' };

  return { framework: 'unknown', language: 'unknown', confidence: 'none' };
}

/**
 * deriveJsLanguage(projectRoot) → 'typescript' | 'javascript'
 *
 * A JS "framework" detection says nothing about whether the repo is TS or
 * JS. Derive it from the file-extension majority (.ts/.tsx vs .js/.jsx) so
 * an overwhelmingly-TypeScript monorepo isn't mislabeled "javascript"
 * (CARTO-004). `.d.ts` declaration files are ignored — they're type stubs,
 * not authored source, and every JS repo with types ships them.
 */
function deriveJsLanguage(projectRoot) {
  let ts = 0, js = 0;
  const SKIP = new Set([...IGNORE_DIRS, 'dist', 'build', 'out', '.next', 'coverage']);
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.name.startsWith('.') || SKIP.has(it.name)) continue;
      if (it.isDirectory()) { walk(path.join(dir, it.name), depth + 1); continue; }
      const name = it.name.toLowerCase();
      if (name.endsWith('.d.ts')) continue;
      if (name.endsWith('.ts') || name.endsWith('.tsx')) ts++;
      else if (name.endsWith('.js') || name.endsWith('.jsx') ||
               name.endsWith('.mjs') || name.endsWith('.cjs')) js++;
    }
  };
  walk(projectRoot, 0);
  return ts > js ? 'typescript' : 'javascript';
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
 * Returns all matching JS frameworks from a package.json, tagged with the
 * dependency section they were found in.
 *
 * → [{ framework, dev, hasBin }, ...]
 *   - `dev`    true  ⇒ the signal came from `devDependencies` only
 *   - `hasBin` true  ⇒ this package declares a `bin` (CLI/library shape)
 *
 * CARTO-010: `dependencies` and `devDependencies` used to be merged into
 * one bag, so a UI framework declared *only* as a dev dependency (e.g.
 * prisma's `packages/cli` pulling `react` for a build/test tool) was
 * reported as the repo's primary framework. Keeping the section lets the
 * aggregator weight prod deps over dev deps and down-rank dev-only UI libs.
 */
function detectAllFromPackageJson(filePath) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }

  const prod = pkg.dependencies || {};
  const dev = pkg.devDependencies || {};
  const hasBin = !!pkg.bin;
  const out = [];

  const scan = (deps, isDev) => {
    const found = [];
    if (deps['next']) found.push('nextjs');
    if (deps['express']) found.push('express');
    if (deps['react'] && !deps['next']) found.push('react');
    for (const fw of found) out.push({ framework: fw, dev: isDev, hasBin });
    return found.length;
  };

  scan(prod, false);
  scan(dev, true);

  return out;
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
