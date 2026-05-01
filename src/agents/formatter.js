/**
 * Converts extracted data into markdown sections for AGENTS.md.
 *
 * Section order:
 *   1. Project Structure (auto)
 *   2. File Map (auto)
 *   3. API Routes (auto)
 *   4. Models (auto)
 *   5. Functions (auto)
 *   6. Database Tables (auto)
 *   7. Environment Variables (auto)
 *   8. File Relationships (auto)
 *   9. Frontend API Calls (auto)
 *   10. Frontend Storage Keys (auto)
 */
function formatSections({ routes, models, frontend, structure, warnings, fileMap, functions, dbTables, envVars, importGraph }) {
  const sections = [];

  // 1. Project Structure
  sections.push('## Project Structure (auto)\n');
  if (structure.length > 0) {
    for (const entry of structure) {
      const icon = entry.type === 'dir' ? '📁' : '📄';
      const suffix = entry.type === 'dir' ? '/' : '';
      sections.push(`- ${icon} ${entry.name}${suffix}`);
    }
  } else {
    sections.push('_No structure data available._');
  }

  // 2. File Map
  sections.push('\n## File Map (auto)\n');
  if (fileMap && fileMap.length > 0) {
    sections.push('| File | Responsibility |');
    sections.push('|------|----------------|');
    for (const entry of fileMap) {
      sections.push(`| ${entry.file} | ${entry.responsibility} |`);
    }
  } else {
    sections.push('_No file map data available._');
  }

  // 3. API Routes
  sections.push('\n## API Routes (auto)\n');
  if (routes.length > 0) {
    sections.push('| Method | Path | Handler |');
    sections.push('|--------|------|---------|');
    for (const r of routes) {
      sections.push(`| ${r.method} | ${r.path} | ${r.functionName} |`);
    }
  } else {
    sections.push('_No routes found._');
  }

  // 4. Models
  sections.push('\n## Models (auto)\n');
  if (models.length > 0) {
    for (const m of models) {
      sections.push(`### ${m.className}`);
      if (m.fields.length > 0) {
        sections.push('| Field | Type |');
        sections.push('|-------|------|');
        for (const f of m.fields) {
          sections.push(`| ${f.name} | ${f.type} |`);
        }
      } else {
        sections.push('_No fields._');
      }
      sections.push('');
    }
  } else {
    sections.push('_No models found._');
  }

  // 5. Functions
  sections.push('## Functions (auto)\n');
  if (functions && Object.keys(functions).length > 0) {
    const sortedFiles = Object.keys(functions).sort();
    for (const filename of sortedFiles) {
      const funcs = functions[filename];
      if (funcs.length === 0) continue;
      sections.push(`### ${filename}`);
      sections.push('| Function | Params | Returns |');
      sections.push('|----------|--------|---------|');
      for (const f of funcs) {
        sections.push(`| ${f.name} | ${f.params} | ${f.returnType} |`);
      }
      sections.push('');
    }
  } else {
    sections.push('_No functions found._');
  }

  // 6. Database Tables
  sections.push('## Database Tables (auto)\n');
  if (dbTables && dbTables.length > 0) {
    sections.push('| Table | Model | File |');
    sections.push('|-------|-------|------|');
    for (const t of dbTables) {
      sections.push(`| ${t.tableName} | ${t.modelName} | ${t.file} |`);
    }
  } else {
    sections.push('_No database tables detected._');
  }

  // 7. Environment Variables
  sections.push('\n## Environment Variables (auto)\n');
  if (envVars && envVars.length > 0) {
    sections.push('| Variable | Used In |');
    sections.push('|----------|---------|');
    for (const v of envVars) {
      sections.push(`| ${v.name} | ${v.files.join(', ')} |`);
    }
  } else {
    sections.push('_No environment variables detected._');
  }

  // 8. File Relationships
  sections.push('\n## File Relationships (auto)\n');
  if (importGraph && Object.keys(importGraph).length > 0) {
    const sortedFiles = Object.keys(importGraph).sort();
    for (const file of sortedFiles) {
      const deps = importGraph[file];
      if (deps.length > 0) {
        sections.push(`${file} \u2192 ${deps.join(', ')}`);
      }
    }
  } else {
    sections.push('_No file relationships detected._');
  }

  // 9. Frontend API Calls
  sections.push('\n## Frontend API Calls (auto)\n');
  if (frontend.fetches.length > 0) {
    sections.push('| Method | URL |');
    sections.push('|--------|-----|');
    for (const f of frontend.fetches) {
      sections.push(`| ${f.method} | ${f.url} |`);
    }
  } else {
    sections.push('_No fetch calls found._');
  }

  // 10. Frontend Storage Keys
  sections.push('\n## Frontend Storage Keys (auto)\n');
  if (frontend.storageKeys.length > 0) {
    sections.push('| Operation | Key |');
    sections.push('|-----------|-----|');
    for (const s of frontend.storageKeys) {
      sections.push(`| ${s.operation} | ${s.key} |`);
    }
  } else {
    sections.push('_No sessionStorage usage found._');
  }

  // Warnings (if any)
  if (warnings.length > 0) {
    sections.push('\n---');
    sections.push('_Some sources could not be read. Sections above may be incomplete._');
  }

  return sections.join('\n');
}

module.exports = { formatSections };
