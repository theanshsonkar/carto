#!/usr/bin/env node

// ============================================================================
// CARTO — Phase 0 Personal Script
// Watches source files → extracts structure → keeps AGENTS.md always current
// ============================================================================

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const CONFIG = {
  sources: {
    routes: '/Users/anshsonkar/emfirge/aws-risk-agent/app/main.py',
    models: '/Users/anshsonkar/emfirge/aws-risk-agent/app/models.py',
    frontend: '/Users/anshsonkar/emfirge/emfirge-frontend/dashboard.html',
    structure: '/Users/anshsonkar/emfirge/'
  },
  output: '/Users/anshsonkar/emfirge/AGENTS.md'
};

const IGNORE_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.idea', '.vscode']);
const START_MARKER = '<!-- CARTO:AUTO:START -->';
const END_MARKER = '<!-- CARTO:AUTO:END -->';

// ---------------------------------------------------------------------------
// SAFE FILE READ
// ---------------------------------------------------------------------------

async function safeReadFile(filePath, warnings) {
  try {
    return await fs.promises.readFile(filePath, 'utf-8');
  } catch (err) {
    warnings.push(`Could not read ${filePath} — ${err.code || err.message}`);
    console.warn(`[CARTO] Warning: Could not read ${filePath} — skipping`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// EXTRACTOR: Routes (FastAPI)
// ---------------------------------------------------------------------------

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
 * Handles @app.get/post/put/delete and @router.get/post/put/delete,
 * including multiline decorators.
 */
function extractRoutes(content) {
  const routes = [];
  const decoratorPattern = /@(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/gi;
  const funcPattern = /(?:async\s+)?def\s+(\w+)/;

  const collapsed = collapseMultilineDecorators(content);
  const lines = collapsed.split('\n');

  for (let i = 0; i < lines.length; i++) {
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

// ---------------------------------------------------------------------------
// EXTRACTOR: Models (Pydantic)
// ---------------------------------------------------------------------------

/**
 * Extracts Pydantic model class definitions — class name + fields with types.
 * Skips method definitions (def ...) to avoid false positives.
 */
function extractModels(content) {
  const models = [];
  const classPattern = /^class\s+(\w+)\s*\(.*BaseModel.*\)\s*:/gm;
  const fieldPattern = /^\s{4}(\w+)\s*:\s*(.+?)(?:\s*=.*)?$/;

  let classMatch;
  while ((classMatch = classPattern.exec(content)) !== null) {
    const className = classMatch[1];
    const classStart = classMatch.index + classMatch[0].length;
    const fields = [];

    const remaining = content.substring(classStart);
    const bodyLines = remaining.split('\n');

    for (const line of bodyLines) {
      // Stop at next top-level definition
      if (/^class\s/.test(line) || (/^\S/.test(line) && line.trim() !== '')) {
        break;
      }
      // Skip method definitions — prevents false-positive on `def validate_...(self):`
      if (/^\s{4}def\s/.test(line)) {
        continue;
      }
      const fieldMatch = line.match(fieldPattern);
      if (fieldMatch) {
        fields.push({ name: fieldMatch[1], type: fieldMatch[2].replace(/#.*$/, '').trim() });
      }
    }

    models.push({ className, fields });
  }
  return models;
}

// ---------------------------------------------------------------------------
// EXTRACTOR: Frontend (fetch + sessionStorage)
// ---------------------------------------------------------------------------

/**
 * Extracts fetch() calls and sessionStorage usage from HTML/JS content.
 * Strips newlines before fetch matching to handle multiline fetch options.
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

  // sessionStorage — original content is fine, these are single-line
  const storagePattern = /sessionStorage\.(getItem|setItem)\s*\(\s*["']([^"']+)["']/g;
  while ((match = storagePattern.exec(content)) !== null) {
    storageKeys.push({
      operation: match[1],
      key: match[2]
    });
  }

  return { fetches, storageKeys };
}

// ---------------------------------------------------------------------------
// SCANNER: Folder Structure
// ---------------------------------------------------------------------------

/**
 * Scans top-level folder structure (1 level deep).
 * Ignores node_modules, .git, __pycache__, etc.
 */
async function scanStructure(basePath) {
  const entries = [];
  try {
    const items = await fs.promises.readdir(basePath, { withFileTypes: true });
    for (const item of items) {
      if (IGNORE_DIRS.has(item.name)) continue;
      entries.push({
        name: item.name,
        type: item.isDirectory() ? 'dir' : 'file'
      });
    }
    entries.sort((a, b) => {
      // Directories first, then files, alphabetical within each group
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch (err) {
    console.warn(`[CARTO] Warning: Could not scan ${basePath} — skipping structure`);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// FORMATTER
// ---------------------------------------------------------------------------

/**
 * Converts extracted data into markdown sections for AGENTS.md.
 */
function formatSections({ routes, models, frontend, structure, warnings }) {
  const sections = [];

  // Project Structure
  sections.push('## Project Structure (auto)\n');
  if (structure.length > 0) {
    for (const entry of structure) {
      const icon = entry.type === 'dir' ? '📁' : '📄';
      const suffix = entry.type === 'dir' ? '/' : '';
      sections.push(`- ${icon} ${entry.name}${suffix}`);
    }
  } else {
    sections.push('_No structure data available._');
  }

  // API Routes
  sections.push('\n## API Routes (auto)\n');
  if (routes.length > 0) {
    sections.push('| Method | Path | Handler |');
    sections.push('|--------|------|---------|');
    for (const r of routes) {
      sections.push(`| ${r.method} | ${r.path} | ${r.functionName} |`);
    }
  } else {
    sections.push('_No routes found._');
  }

  // Models
  sections.push('\n## Models (auto)\n');
  if (models.length > 0) {
    for (const m of models) {
      sections.push(`### ${m.className}`);
      if (m.fields.length > 0) {
        sections.push('| Field | Type |');
        sections.push('|-------|------|');
        for (const f of m.fields) {
          sections.push(`| ${f.name} | ${f.type} |`);
        }
      } else {
        sections.push('_No fields._');
      }
      sections.push('');
    }
  } else {
    sections.push('_No models found._');
  }

  // Frontend API Calls
  sections.push('## Frontend API Calls (auto)\n');
  if (frontend.fetches.length > 0) {
    sections.push('| Method | URL |');
    sections.push('|--------|-----|');
    for (const f of frontend.fetches) {
      sections.push(`| ${f.method} | ${f.url} |`);
    }
  } else {
    sections.push('_No fetch calls found._');
  }

  // Frontend Storage Keys
  sections.push('\n## Frontend Storage Keys (auto)\n');
  if (frontend.storageKeys.length > 0) {
    sections.push('| Operation | Key |');
    sections.push('|-----------|-----|');
    for (const s of frontend.storageKeys) {
      sections.push(`| ${s.operation} | ${s.key} |`);
    }
  } else {
    sections.push('_No sessionStorage usage found._');
  }

  // Warnings (if any)
  if (warnings.length > 0) {
    sections.push('\n---');
    sections.push('_Some sources could not be read. Sections above may be incomplete._');
  }

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// MERGER (Critical Path)
// ---------------------------------------------------------------------------

/**
 * Safely writes auto-generated content into AGENTS.md between markers.
 * Never touches anything outside the markers.
 *
 * Cases:
 *   1. File does not exist → create with markers + content
 *   2. File exists, no markers → append markers + content at end
 *   3. File exists, markers reversed (END before START) → treat as corrupted, append
 *   4. File exists, valid markers → replace ONLY between markers
 */
function mergeIntoAgentsMd(agentsPath, autoContent) {
  const markerBlock = `${START_MARKER}\n${autoContent}\n${END_MARKER}`;

  // Case 1: File does not exist
  if (!fs.existsSync(agentsPath)) {
    const tmpPath = agentsPath + '.tmp';
    fs.writeFileSync(tmpPath, markerBlock + '\n', 'utf-8');
    fs.renameSync(tmpPath, agentsPath);
    return;
  }

  let existing;
  try {
    existing = fs.readFileSync(agentsPath, 'utf-8');
  } catch (err) {
    console.error(`[CARTO] Error reading AGENTS.md: ${err.message}`);
    return;
  }

  const startIdx = existing.indexOf(START_MARKER);
  const endIdx = existing.indexOf(END_MARKER);

  // Case 2: No markers found
  if (startIdx === -1 || endIdx === -1) {
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    const tmpPath = agentsPath + '.tmp';
    fs.writeFileSync(tmpPath, existing + separator + markerBlock + '\n', 'utf-8');
    fs.renameSync(tmpPath, agentsPath);
    return;
  }

  // Case 3: Markers reversed or overlapping — treat as corrupted
  if (startIdx >= endIdx) {
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    const tmpPath = agentsPath + '.tmp';
    fs.writeFileSync(tmpPath, existing + separator + markerBlock + '\n', 'utf-8');
    fs.renameSync(tmpPath, agentsPath);
    console.warn('[CARTO] Warning: markers were reversed/corrupted — appended fresh marker block');
    return;
  }

  // Case 4: Valid markers — replace between them
  const before = existing.substring(0, startIdx);
  const after = existing.substring(endIdx + END_MARKER.length);
  try {
    const tmpPath = agentsPath + '.tmp';
    fs.writeFileSync(tmpPath, before + markerBlock + after, 'utf-8');
    fs.renameSync(tmpPath, agentsPath);
  } catch (err) {
    console.error(`[CARTO] Error writing AGENTS.md: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// FULL SYNC
// ---------------------------------------------------------------------------

async function runFullSync(config) {
  const warnings = [];

  const routeContent = await safeReadFile(config.sources.routes, warnings);
  const modelContent = await safeReadFile(config.sources.models, warnings);
  const frontendContent = await safeReadFile(config.sources.frontend, warnings);

  const routes = routeContent ? extractRoutes(routeContent) : [];
  const models = modelContent ? extractModels(modelContent) : [];
  const frontend = frontendContent
    ? extractFrontend(frontendContent)
    : { fetches: [], storageKeys: [] };
  const structure = await scanStructure(config.sources.structure);

  const autoContent = formatSections({ routes, models, frontend, structure, warnings });
  mergeIntoAgentsMd(config.output, autoContent);
}

// ---------------------------------------------------------------------------
// WATCHER (with 300ms debounce)
// ---------------------------------------------------------------------------

function startWatcher(filePaths, onChange) {
  let debounceTimer = null;
  let lastChangedFile = null;

  const watcher = chokidar.watch(filePaths, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100 }
  });

  watcher.on('change', (filePath) => {
    lastChangedFile = filePath;

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      try {
        await onChange(lastChangedFile);
      } catch (err) {
        console.error(`[CARTO] Sync error: ${err.message}`);
      }
    }, 300);
  });

  watcher.on('error', (error) => {
    console.error(`[CARTO] Watcher error: ${error.message}`);
    setTimeout(() => {
      watcher.close();
      startWatcher(filePaths, onChange);
    }, 5000);
  });

  return watcher;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  console.log('[CARTO] Starting initial sync...');

  await runFullSync(CONFIG);
  console.log('[CARTO] Initial sync complete');

  const watchPaths = [
    CONFIG.sources.routes,
    CONFIG.sources.models,
    CONFIG.sources.frontend
  ];

  startWatcher(watchPaths, async (changedFile) => {
    await runFullSync(CONFIG);
    const timestamp = new Date().toISOString();
    const filename = path.basename(changedFile);
    console.log(`[CARTO] ${filename} updated → AGENTS.md synced — ${timestamp}`);
  });

  console.log('[CARTO] Watching files...');
  console.log(`  → ${CONFIG.sources.routes}`);
  console.log(`  → ${CONFIG.sources.models}`);
  console.log(`  → ${CONFIG.sources.frontend}`);
  console.log(`  → Output: ${CONFIG.output}`);
}

main().catch((err) => {
  console.error(`[CARTO] Fatal error: ${err.message}`);
  process.exit(1);
});
