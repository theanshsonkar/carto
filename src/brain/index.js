'use strict';

/**
 * Brain — four kinds of memory layered over the index.
 *
 *   episodic    ai_sessions / decisions / interventions tables; already wired
 *   semantic    invariants + conventions inferred from the import graph
 *   procedural  action patterns mined from commit history
 *   working     live state: uncommitted files, drift, open warnings
 *
 * This file is just a facade. Each sub-module stands on its own; the MCP
 * server composes them into the ten Brain tools.
 *
 * Everything in here reads the SQLite store. Writes (e.g. dismissing a
 * suggestion) go through `withWriter()` in the MCP server, the same path
 * episodic memory uses.
 */

const invariants = require('./invariants');
const conventions = require('./conventions');
const procedural = require('./procedural');
const working = require('./working');
const suggestions = require('./suggestions');

module.exports = {
  invariants,
  conventions,
  procedural,
  working,
  suggestions,
};
