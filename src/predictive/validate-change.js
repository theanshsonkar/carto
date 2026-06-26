'use strict';

/**
 * validate_change — pre-write governance.
 *
 * `validateDiff` validates a unified diff after the edit. `validateChange`
 * is the pre-write counterpart: given a file path plus the full proposed
 * content, synthesize a minimal diff against current on-disk content and
 * run the same validation pipeline. This is the API an IDE extension
 * calls in `onWillSaveTextDocument`.
 *
 * Output: same shape as `validateDiff`.
 */

const fs = require('fs');
const path = require('path');
const { validateDiff } = require('../mcp/validate');

function validateChange({ store, projectRoot, file, content }) {
  if (!store || !file || typeof content !== 'string') {
    return { risk: 'SAFE', files_changed: [], violations: [], suggestions: [], reason: 'invalid_args' };
  }

  const full = path.resolve(projectRoot, file);
  let prior = '';
  try { prior = fs.readFileSync(full, 'utf-8'); } catch {}
  // If file already at this content: SAFE no-op.
  if (prior === content) {
    return { risk: 'SAFE', files_changed: [], violations: [], suggestions: [], reason: 'no_change' };
  }

  // Synthesize a unified diff. The diff parser only needs added imports
  // + line counts to compute risk; we don't need a fully-correct hunk header.
  const diff = synthesizeDiff(file, prior, content);
  return validateDiff({ store, diff });
}

/**
 * synthesizeDiff(relPath, before, after) — produces a unified diff that
 * `parseDiff` accepts. Hunk headers approximate the line counts.
 */
function synthesizeDiff(relPath, before, after) {
  const beforeLines = (before || '').split('\n');
  const afterLines = (after || '').split('\n');
  const lines = [];
  lines.push(`diff --git a/${relPath} b/${relPath}`);
  lines.push(`--- a/${relPath}`);
  lines.push(`+++ b/${relPath}`);
  lines.push(`@@ -1,${beforeLines.length} +1,${afterLines.length} @@`);
  for (const l of beforeLines) lines.push(`-${l}`);
  for (const l of afterLines) lines.push(`+${l}`);
  return lines.join('\n');
}

module.exports = { validateChange, synthesizeDiff };
