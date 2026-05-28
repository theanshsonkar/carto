'use strict';

/**
 * Extracts Pydantic, SQLAlchemy, and Django model class definitions.
 */
function extractModels(content) {
  return [
    ...extractPydanticModels(content),
    ...extractSQLAlchemyModels(content),
    ...extractDjangoModels(content),
  ];
}

// ─── Pydantic ────────────────────────────────────────────────────────────────

function extractPydanticModels(content) {
  const models = [];
  const classPattern = /^class\s+(\w+)\s*\(.*BaseModel.*\)\s*:/gm;
  const fieldPattern = /^\s{4}(\w+)\s*:\s*(.+?)(?:\s*=.*)?$/;

  let classMatch;
  while ((classMatch = classPattern.exec(content)) !== null) {
    const className = classMatch[1];
    const classStart = classMatch.index + classMatch[0].length;
    const fields = [];

    const bodyLines = content.substring(classStart).split('\n');
    for (const line of bodyLines) {
      if (/^class\s/.test(line) || (/^\S/.test(line) && line.trim() !== '')) break;
      if (/^\s{4}def\s/.test(line)) continue;
      const fm = line.match(fieldPattern);
      if (fm) fields.push({ name: fm[1], type: fm[2].replace(/#.*$/, '').trim() });
    }
    models.push({ className, fields, kind: 'pydantic' });
  }
  return models;
}

// ─── SQLAlchemy ───────────────────────────────────────────────────────────────

function extractSQLAlchemyModels(content) {
  const models = [];
  // class User(Base): or class User(db.Model):
  const classPattern = /^class\s+(\w+)\s*\(\s*(?:\w+\.)?(?:Base|Model)\s*\)\s*:/gm;
  let classMatch;

  while ((classMatch = classPattern.exec(content)) !== null) {
    const className = classMatch[1];
    if (className === 'Base' || className === 'Model') continue;

    const classStart = classMatch.index + classMatch[0].length;
    const fields = [];
    let tableName = className.toLowerCase();

    const bodyLines = content.substring(classStart).split('\n');
    for (const line of bodyLines) {
      if (/^class\s/.test(line) || (/^\S/.test(line) && line.trim() !== '')) break;

      // __tablename__ = 'users'
      const tnMatch = line.match(/^\s+__tablename__\s*=\s*['"](\w+)['"]/);
      if (tnMatch) { tableName = tnMatch[1]; continue; }

      // id = Column(Integer, primary_key=True) / name = Column(String(100))
      const colMatch = line.match(/^\s+(\w+)\s*=\s*(?:mapped_column|Column)\s*\(\s*(\w+)/);
      if (colMatch) fields.push({ name: colMatch[1], type: colMatch[2] });

      // Mapped[str] style (SQLAlchemy 2.0)
      const mappedMatch = line.match(/^\s+(\w+)\s*:\s*Mapped\[([^\]]+)\]/);
      if (mappedMatch) fields.push({ name: mappedMatch[1], type: mappedMatch[2] });
    }

    models.push({ className, tableName, fields, kind: 'sqlalchemy' });
  }
  return models;
}

// ─── Django ───────────────────────────────────────────────────────────────────

function extractDjangoModels(content) {
  const models = [];
  // class User(models.Model): or class Post(AbstractModel):
  const classPattern = /^class\s+(\w+)\s*\(\s*(?:models\.Model|.*Model.*)\s*\)\s*:/gm;
  let classMatch;

  while ((classMatch = classPattern.exec(content)) !== null) {
    const className = classMatch[1];
    if (className === 'Model' || className === 'AbstractModel') continue;

    const classStart = classMatch.index + classMatch[0].length;
    const fields = [];

    const bodyLines = content.substring(classStart).split('\n');
    for (const line of bodyLines) {
      if (/^class\s/.test(line) || (/^\S/.test(line) && line.trim() !== '')) break;
      if (/^\s+def\s/.test(line)) continue;

      // name = models.CharField(...) / email = models.EmailField()
      const fieldMatch = line.match(/^\s+(\w+)\s*=\s*models\.(\w+)\s*\(/);
      if (fieldMatch) fields.push({ name: fieldMatch[1], type: fieldMatch[2] });
    }

    if (fields.length > 0) models.push({ className, fields, kind: 'django' });
  }
  return models;
}

module.exports = { extractModels };
