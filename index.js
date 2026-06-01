'use strict';

/**
 * carto-md — public module API
 *
 * Usage:
 *   const { StoreAdapter } = require('carto-md');
 *   const carto = new StoreAdapter();
 *   await carto.index('/path/to/project');
 *
 *   // Get everything an editor agent needs for a file
 *   const ctx = carto.getContextForFile('src/auth/auth.service.ts');
 *
 *   // Read structural facts
 *   const routes = carto.getRoutes();
 *   const radius = carto.getBlastRadius('src/auth/auth.service.ts');
 *   carto.close();
 *
 * Back-compat: `Carto` is exported as an alias for `StoreAdapter`.
 * Existing programs that did `const { Carto } = require('carto-md')`
 * continue to work without changes. The alias (and the `terminate()`
 * method on StoreAdapter) will be removed in 3.0.0.
 */

const { StoreAdapter } = require('./src/store/store-adapter');

module.exports = {
  StoreAdapter,
  Carto: StoreAdapter, // deprecated alias, removed in 3.0.0
};
