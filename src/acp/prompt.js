'use strict';

const SYSTEM_PROMPT_TEMPLATE = `You are Carto, an AI coding agent with deep architectural awareness.

You understand this project's structure before writing a single line:
- Every file's blast radius (what breaks if this changes)
- All API routes and which files define them
- Domain clusters (AUTH, PAYMENTS, DATABASE, etc.)
- The full import graph and cross-domain dependencies

RULES:
1. Always check blast radius before making changes to high-impact files
2. Reference real file names and routes — never hallucinate paths
3. Make minimal, focused changes — read first, then write
4. Warn the user if a change crosses domain boundaries
5. After changes, confirm what was changed and what it affects
6. Use existing patterns (check get_similar_patterns before writing new code)
7. If unsure, read the relevant files — don't guess

You have access to Carto tools that give you structural intelligence about this codebase. Use them proactively.

PROJECT CONTEXT:
{context}`;

/**
 * buildContextBlock(carto, workingDir)
 * Generates a structural context summary from the indexed project.
 */
function buildContextBlock(carto, workingDir) {
  if (!carto) return 'Project not yet indexed.';

  try {
    const lines = [];
    const structure = carto.getStructure();

    if (structure.stack && structure.stack.length > 0) {
      lines.push(`Stack: ${structure.stack.join(', ')}`);
    }

    if (structure.meta) {
      const m = structure.meta;
      lines.push(`Size: ${m.totalFiles || 0} files, ${m.totalRoutes || 0} routes, ${m.totalImportEdges || 0} import edges`);
    }

    const domains = carto.getDomainsList();
    if (domains.length > 0) {
      lines.push(`Domains: ${domains.map(d => `${d.name} (${d.fileCount} files)`).join(', ')}`);
    }

    const highImpact = carto.getHighImpactFiles(5);
    if (highImpact && highImpact.length > 0) {
      lines.push(`High-impact files: ${highImpact.map(f => f.file || f).join(', ')}`);
    }

    return lines.join('\n') || 'Project indexed but no structural data available.';
  } catch {
    return 'Project indexed.';
  }
}

/**
 * buildSystemPrompt(contextBlock)
 * Assembles the full system prompt with injected context.
 */
function buildSystemPrompt(contextBlock) {
  return SYSTEM_PROMPT_TEMPLATE.replace('{context}', contextBlock);
}

module.exports = { buildSystemPrompt, buildContextBlock };
