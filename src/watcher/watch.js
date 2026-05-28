'use strict';

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

/**
 * startWatcher(filePaths, onChange, onAdd, onRemove)
 *
 * Watches files for changes. 300ms debounce on change events.
 * Calls:
 *   onChange(filePath)  — file modified
 *   onAdd(filePath)     — new file created (optional)
 *   onRemove(filePath)  — file deleted (optional)
 */
function startWatcher(filePaths, onChange, onAdd, onRemove) {
  let debounceTimer = null;
  let lastChangedFile = null;

  const watcher = chokidar.watch(filePaths, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100 }
  });

  watcher.on('change', (filePath) => {
    lastChangedFile = filePath;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      try {
        await onChange(lastChangedFile);
      } catch (err) {
        console.error(`[CARTO] Sync error: ${err.message}`);
      }
    }, 300);
  });

  watcher.on('add', async (filePath) => {
    if (onAdd) {
      try { await onAdd(filePath); } catch (err) {
        console.error(`[CARTO] Add error: ${err.message}`);
      }
    }
  });

  watcher.on('unlink', async (filePath) => {
    if (onRemove) {
      try { await onRemove(filePath); } catch (err) {
        console.error(`[CARTO] Remove error: ${err.message}`);
      }
    }
  });

  watcher.on('error', (error) => {
    console.error(`[CARTO] Watcher error: ${error.message}`);
    setTimeout(() => {
      watcher.close();
      startWatcher(filePaths, onChange, onAdd, onRemove);
    }, 5000);
  });

  return watcher;
}

module.exports = { startWatcher };
