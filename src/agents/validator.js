/**
 * validateExtracted(data) → cleaned data
 *
 * Runs after extraction, before formatting.
 * Drops anything that looks wrong. Never throws.
 */
function validateExtracted({ routes, models, functions, envVars, dbTables }) {
  return {
    routes:    validateRoutes(routes || []),
    models:    validateModels(models || []),
    functions: validateFunctions(functions || {}),
    envVars:   validateEnvVars(envVars || []),
    dbTables:  validateDBTables(dbTables || [])
  };
}

const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const VALID_HANDLER = /^[a-zA-Z_]\w*$|^\[anonymous\]$/;
const VALID_CLASS_NAME = /^[A-Z][a-zA-Z0-9]*$/;
const VALID_FIELD_NAME = /^[a-z_]\w*$/;
const VALID_FUNC_NAME = /^_?[a-zA-Z][a-zA-Z0-9_]*$/;
const VALID_ENV_VAR = /^[A-Z][A-Z0-9_]*$/;
const VALID_TABLE_NAME = /^[a-z][a-z0-9_]*$/;

function validateRoutes(routes) {
  return routes.filter(r => {
    if (!r.method || !VALID_METHODS.has(r.method)) return false;
    if (!r.path || (!r.path.startsWith('/') && r.path !== '[dynamic]' && r.path !== '[inferred]')) return false;
    if (!r.functionName || !VALID_HANDLER.test(r.functionName)) return false;
    return true;
  });
}

function validateModels(models) {
  return models
    .map(m => {
      if (!m.className || !VALID_CLASS_NAME.test(m.className)) return null;
      if (!Array.isArray(m.fields)) return null;

      const validFields = m.fields.filter(f => {
        if (!f.name || !VALID_FIELD_NAME.test(f.name)) return false;
        return true;
      });

      if (validFields.length === 0) return null;
      return { className: m.className, fields: validFields };
    })
    .filter(Boolean);
}

function validateFunctions(functionsMap) {
  const cleaned = {};

  for (const [filename, funcs] of Object.entries(functionsMap)) {
    const validFuncs = funcs.filter(f => {
      // Name must be a valid identifier
      if (!f.name || !VALID_FUNC_NAME.test(f.name)) return false;
      // Name must not contain spaces, brackets, commas
      if (/[\s\[\],]/.test(f.name)) return false;
      // Params must not contain parse artifacts
      if (f.params && (/\[\[/.test(f.params) || /\]\]/.test(f.params) || /Any\]\]/.test(f.params))) return false;
      return true;
    });

    if (validFuncs.length > 0) {
      cleaned[filename] = validFuncs;
    }
  }

  return cleaned;
}

function validateEnvVars(envVars) {
  return envVars.filter(v => {
    if (!v.name || !VALID_ENV_VAR.test(v.name)) return false;
    return true;
  });
}

function validateDBTables(dbTables) {
  return dbTables.filter(t => {
    if (!t.tableName || !VALID_TABLE_NAME.test(t.tableName)) return false;
    if (!t.modelName || !VALID_CLASS_NAME.test(t.modelName)) return false;
    return true;
  });
}

module.exports = { validateExtracted };
