'use strict';

/**
 * carto-md — public module API
 *
 * Usage:
 *   const { Carto } = require('carto-md');
 *   const carto = new Carto();
 *   await carto.index('/path/to/project');
 *
 *   // Get everything Kepler needs for a file
 *   const ctx = carto.getContextForFile('src/auth/auth.service.ts');
 *
 *   // Listen for live updates
 *   carto.on('updated', ({ file, blastRadius }) => { ... });
 */

const { Carto } = require('./src/engine/carto');

module.exports = { Carto };
