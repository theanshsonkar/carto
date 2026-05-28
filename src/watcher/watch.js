'use strict';

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { parseCartoIgnore } = require('../security/ignore');

// Supported extensions — events for other extensions are suppressed
const SUPPORTED_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs',
  '.ts', '.tsx',
  '.py',
  '.go',
  '.rs',
  '.prisma',
  '.html',
  '.r',
]);

// Default ignore directories — always suppressed without needing .cartoignore
const DEFAULT_IGNORE_DIRS = [
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo',
  'coverage', 'out', '.cache', 'generated', '__generated__',
  'storybook-static', 'public', 'static', '__pycache__', '.venv',
  'venv', 'migrations', '.carto', 'packrat', 'renv', 'playwright',
  'e2e', '__tests__', 'fixtures', 'mocks', '__mocks__', 'cypress',
];

// Burst mode threshold: >20 distinct paths in 100ms window
const BURST_THRESHOLD = 20;
const BURST_WINDOW_MS = 100;

// Debounce window: 50ms quiet period before emitting batch
const DEBOUNCE_MS = 50;

/**
 * startWatcher(projectRoot, callbacks, options)
 *
 * Replaces the old per-file chokidar watcher with a single recursive
 * directory watch. Uses <20 file descriptors regardless of repo size.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @param {object} callbacks
 *   onChange(filePath)  — file modified (debounced + batched)
 *   onAdd(filePath)     — new file created
 *   onRemove(filePath)  — file deleted
 * @param {object} [options]
 *   debounceMs  — debounce window in ms (default: 50)
 *   onBurst     — called when burst mode activates (optional)
 *
 * @returns {object} watcher handle with .close() method
 */
function startWatcher(projectRoot, callbacks, options = {}) {
  const { onChange, onAdd, onRemove } = callbacks;
  const debounceMs = options.debounceMs || DEBOUNCE_MS;

  // Load .cartoignore patterns
  let isIgnored = () => false;
  try {
    isIgnored = parseCartoIgnore(projectRoot);
  } catch (err) {
    // .cartoignore missing is fine
  }

  // Build chokidar ignored function
  const ignoredFn = (filePath) => {
    const rel = path.relative(projectRoot, filePath);
    const parts = rel.split(path.sep);

    // Check default ignore dirs
    if (parts.some(p => DEFAULT_IGNORE_DIRS.includes(p))) return true;

    // Check .cartoignore patterns
    if (isIgnored(rel) || isIgnored(filePath)) return true;

    return false;
  };

  const watcher = chokidar.watch(projectRoot, {
    persistent: true,
    ignoreInitial: true,
    ignored: ignoredFn,
    // Use native recursive watching (FSEvents on macOS, inotify on Linux)
    // This keeps fd usage to <20 regardless of file count
    usePolling: false,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 50 },
  });

  // ─── Burst detection state ─────────────────────────────────────────────────
  let burstWindowStart = null;
  let burstWindowPaths = new Set();
  let inBurstMode = false;
  let burstTimer = null;

  // ─── Debounce state ────────────────────────────────────────────────────────
  let debounceTimer = null;
  // Map: filePath → 'change' | 'add' | 'remove'
  const pendingBatch = new Map();

  function scheduleFlush() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushBatch, debounceMs);
  }

  function flushBatch() {
    debounceTimer = null;
    if (pendingBatch.size === 0) return;

    const batch = new Map(pendingBatch);
    pendingBatch.clear();

    for (const [filePath, eventType] of batch) {
      try {
        if (eventType === 'change' && onChange) onChange(filePath);
        else if (eventType === 'add' && onAdd) onAdd(filePath);
        else if (eventType === 'remove' && onRemove) onRemove(filePath);
      } catch (err) {
        console.error(`[CARTO] Watcher callback error for ${filePath}: ${err.message}`);
      }
    }
  }

  function handleEvent(eventType, filePath) {
    // Filter unsupported extensions
    const ext = path.extname(filePath).toLowerCase();
    if (ext && !SUPPORTED_EXTENSIONS.has(ext)) return;

    // Burst detection
    const now = Date.now();
    if (!burstWindowStart || now - burstWindowStart > BURST_WINDOW_MS) {
      burstWindowStart = now;
      burstWindowPaths = new Set();
    }
    burstWindowPaths.add(filePath);

    if (!inBurstMode && burstWindowPaths.size > BURST_THRESHOLD) {
      inBurstMode = true;
      console.log(`[CARTO] Burst mode activated (${burstWindowPaths.size} files in ${BURST_WINDOW_MS}ms) — switching to stat-diff`);
      if (options.onBurst) options.onBurst(projectRoot);

      // Clear debounce — burst handler takes over
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      pendingBatch.clear();

      // Schedule burst processing after a short settle period
      if (burstTimer) clearTimeout(burstTimer);
      burstTimer = setTimeout(() => {
        inBurstMode = false;
        burstWindowPaths.clear();
        burstWindowStart = null;
        burstTimer = null;
        console.log('[CARTO] Burst mode complete — resuming normal debounce');
      }, 500);
      return;
    }

    if (inBurstMode) return; // Burst handler is running, skip individual events

    // Normal debounce path — last event type for a path wins
    pendingBatch.set(filePath, eventType);
    scheduleFlush();
  }

  watcher.on('change', (filePath) => handleEvent('change', filePath));
  watcher.on('add',    (filePath) => handleEvent('add', filePath));
  watcher.on('unlink', (filePath) => handleEvent('remove', filePath));

  watcher.on('error', (error) => {
    console.error(`[CARTO] Watcher error: ${error.message}`);
    // Attempt restart after 5 seconds
    setTimeout(() => {
      watcher.close().catch(() => {});
      startWatcher(projectRoot, callbacks, options);
    }, 5000);
  });

  return {
    close() {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (burstTimer) clearTimeout(burstTimer);
      return watcher.close();
    }
  };
}

/**
 * Legacy compatibility shim.
 *
 * Old callers pass an array of file paths. We detect this and watch the
 * common ancestor directory instead, filtering to the original paths.
 * This keeps backward compatibility with src/cli/watch.js and sync.js.
 */
function startWatcherLegacy(filePaths, onChange, onAdd, onRemove) {
  if (!filePaths || filePaths.length === 0) return { close: () => {} };

  // Find common root
  const roots = filePaths.map(p => path.dirname(p));
  const projectRoot = roots.reduce((common, dir) => {
    const commonParts = common.split(path.sep);
    const dirParts = dir.split(path.sep);
    const shared = [];
    for (let i = 0; i < Math.min(commonParts.length, dirParts.length); i++) {
      if (commonParts[i] === dirParts[i]) shared.push(commonParts[i]);
      else break;
    }
    return shared.join(path.sep) || path.sep;
  });

  const fileSet = new Set(filePaths.map(p => path.resolve(p)));

  return startWatcher(projectRoot, {
    onChange: (fp) => { if (fileSet.has(fp) && onChange) onChange(fp); },
    onAdd:    (fp) => { if (onAdd) onAdd(fp); },
    onRemove: (fp) => { if (onRemove) onRemove(fp); },
  });
}

module.exports = { startWatcher, startWatcherLegacy };
