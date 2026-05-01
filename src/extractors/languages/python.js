const { extractRoutes } = require('../routes');
const { extractModels } = require('../models');
const { extractFunctions } = require('../functions');
const { extractEnvVars } = require('../envvars');
const { extractDBTables } = require('../dbtables');

module.exports = {
  name: 'python',
  extensions: ['.py'],
  extract(content, filename) {
    try {
      return {
        routes:      extractRoutes(content),
        models:      extractModels(content),
        functions:   extractFunctions(content, filename),
        envVars:     extractEnvVars(content),
        dbTables:    extractDBTables(content),
        fetches:     [],
        storageKeys: [],
      };
    } catch (err) {
      console.warn(`[CARTO] python plugin error on ${filename}: ${err.message}`);
      return { routes: [], models: [], functions: [], envVars: [], dbTables: [], fetches: [], storageKeys: [] };
    }
  }
};
