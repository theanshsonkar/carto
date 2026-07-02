'use strict';

/**
 * Rule registry.
 *
 * A plain, static array of rule modules. Order is stable — the engine
 * iterates it as-is, and gap output ordering (before severity ranking)
 * matches this order.
 *
 * Add a new rule:
 *   1. Create src/rules/rules/<rule-id>.js exporting the rule contract
 *      described in engine.js.
 *   2. `require` it here and append to the array.
 *   3. Write a concept file at src/rules/concepts/<concept>.md (see
 *      the rule's `concept` field) with the plain-English explainer.
 *   4. Add tests in test/test.js — one fixture per fires/doesn't-fire
 *      pair. Zero false positives on the clean fixtures is the ship
 *      gate.
 */

module.exports = [
  require('./rules/money-as-float'),
  require('./rules/auth-missing-on-mutating-route'),
];
