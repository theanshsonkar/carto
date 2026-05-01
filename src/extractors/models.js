/**
 * Extracts Pydantic model class definitions — class name + fields with types.
 * Skips method definitions (def ...) to avoid false positives.
 * Strips inline # comments from field types.
 */
function extractModels(content) {
  const models = [];
  const classPattern = /^class\s+(\w+)\s*\(.*BaseModel.*\)\s*:/gm;
  const fieldPattern = /^\s{4}(\w+)\s*:\s*(.+?)(?:\s*=.*)?$/;

  let classMatch;
  while ((classMatch = classPattern.exec(content)) !== null) {
    const className = classMatch[1];
    const classStart = classMatch.index + classMatch[0].length;
    const fields = [];

    const remaining = content.substring(classStart);
    const bodyLines = remaining.split('\n');

    for (const line of bodyLines) {
      // Stop at next top-level definition
      if (/^class\s/.test(line) || (/^\S/.test(line) && line.trim() !== '')) {
        break;
      }
      // Skip method definitions — prevents false-positive on `def validate_...(self):`
      if (/^\s{4}def\s/.test(line)) {
        continue;
      }
      const fieldMatch = line.match(fieldPattern);
      if (fieldMatch) {
        fields.push({ name: fieldMatch[1], type: fieldMatch[2].replace(/#.*$/, '').trim() });
      }
    }

    models.push({ className, fields });
  }
  return models;
}

module.exports = { extractModels };
