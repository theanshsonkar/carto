const chokidar = require('chokidar');

/**
 * Starts a file watcher with 300ms debounce.
 * On change, calls onChange(filePath).
 * On error, restarts after 5 seconds.
 */
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

module.exports = { startWatcher };
