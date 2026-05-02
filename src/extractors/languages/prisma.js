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
  const blocks = extractModelBlocks(content);

  for (const { name, body } of blocks) {
    const fields = [];
    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue;

      const fieldMatch = trimmed.match(/^(\w+)\s+(\w+[\[\]?]*)/);
      if (fieldMatch) {
        fields.push({ name: fieldMatch[1], type: fieldMatch[2] });
      }
    }
    models.push({ className: name, fields });
  }

  return models;
}

function extractPrismaDBTables(content) {
  const tables = [];
  const blocks = extractModelBlocks(content);

  for (const { name, body } of blocks) {
    const mapMatch = body.match(/@@map\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    const tableName = mapMatch ? mapMatch[1] : toSnakeCase(name);
    tables.push({ tableName, modelName: name });
  }

  return tables;
}

/**
 * Brace-counting approach to extract model blocks.
 * Handles } inside /// comments and @zod annotations.
 */
function extractModelBlocks(content) {
  const blocks = [];
  const modelStart = /^model\s+(\w+)\s*\{/gm;
  let match;

  while ((match = modelStart.exec(content)) !== null) {
    const name = match[1];
    const startIdx = match.index + match[0].length;
    let depth = 1;
    let i = startIdx;

    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      if (depth > 0) i++;
    }

    const body = content.substring(startIdx, i);
    blocks.push({ name, body });
  }

  return blocks;
}

function toSnakeCase(str) {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}
