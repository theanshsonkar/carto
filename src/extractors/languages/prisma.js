/**
 * Prisma schema plugin — handles .prisma files.
 * Pure regex — Prisma schema is simple enough.
 */
module.exports = {
  name: 'prisma',
  extensions: ['.prisma'],
  extract(content, filename) {
    try {
      const models = extractPrismaModels(content);
      const dbTables = extractPrismaDBTables(content);
      return {
        routes:      [],
        models:      models,
        functions:   [],
        envVars:     [],
        dbTables:    dbTables,
        fetches:     [],
        storageKeys: [],
      };
    } catch (err) {
      console.warn(`[CARTO] prisma plugin error on ${filename}: ${err.message}`);
      return { routes: [], models: [], functions: [], envVars: [], dbTables: [], fetches: [], storageKeys: [] };
    }
  }
};

function extractPrismaModels(content) {
  const models = [];
  const modelPattern = /^model\s+(\w+)\s*\{([^}]+)\}/gm;

  let match;
  while ((match = modelPattern.exec(content)) !== null) {
    const className = match[1];
    const body = match[2];
    const fields = [];

    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip empty lines, comments, and @@directives
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue;

      const fieldMatch = trimmed.match(/^(\w+)\s+(\w+[\[\]?]*)/);
      if (fieldMatch) {
        fields.push({ name: fieldMatch[1], type: fieldMatch[2] });
      }
    }

    models.push({ className, fields });
  }

  return models;
}

function extractPrismaDBTables(content) {
  const tables = [];
  const modelPattern = /^model\s+(\w+)\s*\{([^}]+)\}/gm;

  let match;
  while ((match = modelPattern.exec(content)) !== null) {
    const modelName = match[1];
    const body = match[2];

    // Check for @@map('table_name')
    const mapMatch = body.match(/@@map\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    const tableName = mapMatch ? mapMatch[1] : toSnakeCase(modelName);

    tables.push({ tableName, modelName });
  }

  return tables;
}

function toSnakeCase(str) {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}
