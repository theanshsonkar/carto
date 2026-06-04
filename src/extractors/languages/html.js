const { extractFrontend } = require('../frontend');

module.exports = {
  name: 'html',
  extensions: ['.html'],
  extract(content, filename) {
    try {
      const { fetches, storageKeys } = extractFrontend(content);
      return { routes: [], models: [], functions: [], envVars: [], dbTables: [], fetches, storageKeys };
    } catch (err) {
      console.warn(`[CARTO] html plugin error on ${filename}: ${err.message}`);
      return {
        routes: [], models: [], functions: [], envVars: [], dbTables: [], fetches: [], storageKeys: [],
        _errors: [{ phase: 'extract', message: err.message || String(err) }],
      };
    }
  }
};
