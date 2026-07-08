/**
 * schemas.js — content/regex-based model extractors shared by the
 * JavaScript and TypeScript plugins.
 *
 * These are deliberately regex-based (no Babel/AST) so they can run on the
 * fast, non-API-handler path for EVERY .js/.ts file. Most Zod schemas and
 * Drizzle tables live in plain validation/schema modules that are not API
 * route handlers — gating them behind the API-handler check (the old
 * behavior) made `get_models` return ~0 on real repos.
 */

/**
 * Extract Zod schemas: `const X = z.object({ ... })` / `export const X = z.object({...})`.
 * Only emits a model when the object has at least one `field: z.<type>` pair,
 * to avoid capturing empty/degenerate `z.object({})` calls.
 */
function extractZodSchemas(content) {
  const models = [];
  const pattern = /(?:export\s+)?const\s+(\w+)\s*=\s*z\.object\s*\(\s*\{([^}]*)\}/g;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    const name = m[1];
    const body = m[2];
    const fields = [];
    const fieldPattern = /(\w+)\s*:\s*z\.(\w+)/g;
    let fm;
    while ((fm = fieldPattern.exec(body)) !== null) {
      fields.push({ name: fm[1], type: `z.${fm[2]}` });
    }
    if (fields.length > 0) {
      models.push({ className: name, fields, kind: 'zod' });
    }
  }
  return models;
}

/**
 * Extract Drizzle tables: `pgTable('users', {...})` / `mysqlTable` / `sqliteTable`.
 */
function extractDrizzleTables(content) {
  const models = [];
  const tablePattern = /(?:pgTable|mysqlTable|sqliteTable|table)\s*\(\s*['"](\w+)['"]\s*,\s*\{([^}]*)\}/g;
  let m;
  while ((m = tablePattern.exec(content)) !== null) {
    const tableName = m[1];
    const body = m[2];
    const fields = [];
    const colPattern = /(\w+)\s*:\s*(\w+)\s*\(/g;
    let fm;
    while ((fm = colPattern.exec(body)) !== null) {
      fields.push({ name: fm[1], type: fm[2] });
    }
    if (fields.length > 0) {
      models.push({ className: tableName, name: tableName, fields, kind: 'drizzle' });
    }
  }
  return models;
}

module.exports = { extractZodSchemas, extractDrizzleTables };
