/**
 * extractDBTables(content) → Array<{ tableName, modelName }>
 *
 * Supports two ORM patterns:
 *   1. SQLAlchemy: class Foo(Base): __tablename__ = 'foo'
 *   2. Django ORM: class Foo(models.Model): class Meta: db_table = 'foo'
 *      (falls back to snake_case of class name if no db_table)
 */
function extractDBTables(content) {
  const tables = [];
  const lines = content.split('\n');

  // Pattern 1 — SQLAlchemy
  const sqlaClassPattern = /^class\s+(\w+)\s*\(.*Base.*\)\s*:/gm;
  let classMatch;
  while ((classMatch = sqlaClassPattern.exec(content)) !== null) {
    const modelName = classMatch[1];
    const classEnd = classMatch.index + classMatch[0].length;

    // Find line index of this class
    const textBefore = content.substring(0, classEnd);
    const lineIndex = textBefore.split('\n').length - 1;

    // Look ahead up to 10 lines for __tablename__
    let found = false;
    for (let j = lineIndex + 1; j < Math.min(lineIndex + 11, lines.length); j++) {
      const tnMatch = lines[j].match(/^\s+__tablename__\s*=\s*['"]([^'"]+)['"]/);
      if (tnMatch) {
        tables.push({ tableName: tnMatch[1], modelName });
        found = true;
        break;
      }
      // Stop if we hit another class definition
      if (/^class\s/.test(lines[j])) break;
    }
    // If not found, skip — not a table-mapped model
  }

  // Pattern 2 — Django ORM
  const djangoClassPattern = /^class\s+(\w+)\s*\(.*models\.Model.*\)\s*:/gm;
  while ((classMatch = djangoClassPattern.exec(content)) !== null) {
    const modelName = classMatch[1];
    const classEnd = classMatch.index + classMatch[0].length;

    const textBefore = content.substring(0, classEnd);
    const lineIndex = textBefore.split('\n').length - 1;

    // Look ahead up to 15 lines for db_table
    let found = false;
    for (let j = lineIndex + 1; j < Math.min(lineIndex + 16, lines.length); j++) {
      const dtMatch = lines[j].match(/db_table\s*=\s*['"]([^'"]+)['"]/);
      if (dtMatch) {
        tables.push({ tableName: dtMatch[1], modelName });
        found = true;
        break;
      }
      if (/^class\s/.test(lines[j])) break;
    }

    // Django default: snake_case of class name
    if (!found) {
      tables.push({ tableName: toSnakeCase(modelName), modelName });
    }
  }

  return tables;
}

/**
 * Convert PascalCase to snake_case.
 * MyModel → my_model
 */
function toSnakeCase(str) {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

module.exports = { extractDBTables };
