#!/usr/bin/env node
'use strict';

/**
 * `carto explain <intent>` — natural-language intent → architectural
 * explanation. Thin wrapper over the MCP `get_change_plan` tool —
 * same engine, same heuristics, same output.
 *
 * Example:
 *   $ carto explain "add rate limiting to /api/users"
 *
 *   ## Plan: add rate limiting to /api/users
 *
 *   ...routes/files/blast radius/domains/conventions...
 */

const path = require('path');
const { SQLiteStore } = require('../store/sqlite-store');
const { planChange, formatPlanMarkdown } = require('../mcp/change-plan');

function collect(projectRoot, intent) {
  const store = new SQLiteStore(projectRoot);
  store.open({ readonly: true });
  try {
    return planChange(store, intent || '');
  } finally {
    try { store.close(); } catch {}
  }
}

function run({ argv, stdout, stderr, projectRoot } = {}) {
  argv = argv || process.argv.slice(3);
  stdout = stdout || process.stdout;
  stderr = stderr || process.stderr;
  projectRoot = projectRoot || process.cwd();

  const json = argv.includes('--json');
  const help = argv.includes('--help') || argv.includes('-h');
  // Treat everything that isn't a flag as part of the intent — operators
  // shouldn't need quotes for `carto explain add rate limiting`.
  const intentParts = argv.filter((a) => !a.startsWith('--'));
  const intent = intentParts.join(' ').trim();

  if (help || !intent) {
    stdout.write('\nUsage: carto explain <intent> [--json]\n\nNatural-language change request → architectural plan.\nExample: carto explain "add rate limiting to /api/users"\n\n');
    return intent ? 0 : 1;
  }

  let plan;
  try { plan = collect(projectRoot, intent); }
  catch (err) {
    stderr.write(`[CARTO] ${err.message}\n`);
    return 1;
  }
  if (json) stdout.write(JSON.stringify(plan, null, 2) + '\n');
  else stdout.write(formatPlanMarkdown(plan) + '\n');
  return 0;
}

module.exports = { run, collect };
if (require.main === module) process.exit(run());
