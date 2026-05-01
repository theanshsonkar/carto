const fs = require('fs');
const path = require('path');

/**
 * loadLanguagePlugins() → Array<plugin>
 *
 * Auto-discovers all .js files in src/extractors/languages/
 * Validates each has: name (string), extensions (array), extract (function)
 * Logs a warning and skips any plugin that fails validation or throws on require()
 */
function loadLanguagePlugins() {
  const pluginsDir = path.join(__dirname, 'languages');
  const plugins = [];

  let files;
  try {
    files = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js'));
  } catch (err) {
    console.warn(`[CARTO] Warning: Could not read plugins directory: ${err.message}`);
    return plugins;
  }

  for (const file of files) {
    const fullPath = path.join(pluginsDir, file);
    try {
      const plugin = require(fullPath);

      // Validate plugin shape
      if (typeof plugin.name !== 'string') {
        console.warn(`[CARTO] Warning: Plugin ${file} missing 'name' (string) — skipping`);
        continue;
      }
      if (!Array.isArray(plugin.extensions)) {
        console.warn(`[CARTO] Warning: Plugin ${file} missing 'extensions' (array) — skipping`);
        continue;
      }
      if (typeof plugin.extract !== 'function') {
        console.warn(`[CARTO] Warning: Plugin ${file} missing 'extract' (function) — skipping`);
        continue;
      }

      plugins.push(plugin);
    } catch (err) {
      console.warn(`[CARTO] Warning: Failed to load plugin ${file}: ${err.message} — skipping`);
    }
  }

  return plugins;
}

/**
 * getPluginForFile(plugins, filePath) → plugin | null
 *
 * Returns the first plugin whose extensions array includes the file's extension.
 * Returns null if no plugin handles this file type.
 */
function getPluginForFile(plugins, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  for (const plugin of plugins) {
    if (plugin.extensions.includes(ext)) {
      return plugin;
    }
  }
  return null;
}

module.exports = { loadLanguagePlugins, getPluginForFile };
