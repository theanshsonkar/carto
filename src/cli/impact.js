'use strict';

const path = require('path');
const { Carto } = require('../../index.js');
const { checkForUpdate } = require('./update-check');

async function run(projectRoot, fileArg) {
  checkForUpdate(); // fire and forget
  if (!fileArg) {
    console.error('[CARTO] Usage: carto impact <file>');
    process.exit(1);
  }

  const carto = new Carto();
  try {
    await carto.index(projectRoot, { useWorkers: false });
  } catch (err) {
    console.error(`[CARTO] Error loading index: ${err.message}`);
    process.exit(1);
  }

  const br = carto.getBlastRadius(fileArg);
  if (!br) {
    console.error(`[CARTO] File not found in project graph: ${fileArg}`);
    process.exit(1);
  }

  console.log(`\nImpact analysis: ${br.file}\n`);

  const riskBadge = { HIGH: '🔴 HIGH', MEDIUM: '🟡 MEDIUM', LOW: '🟢 LOW', SAFE: '✅ SAFE' };
  console.log(`Risk: ${riskBadge[br.risk] || br.risk}`);
  console.log(`Directly affected: ${br.directlyAffected.files} files across ${br.directlyAffected.domains} domain(s)`);
  console.log(`Potentially affected: ${br.potentiallyAffected.files} files total\n`);

  if (br.domainsImpacted.length > 0) {
    console.log(`Domains impacted: ${br.domainsImpacted.join(', ')}\n`);
  }

  if (br.dependentFiles.length > 0) {
    console.log(`Files that depend on this (${br.dependentFiles.length}):`);
    for (const f of br.dependentFiles) console.log(`  → ${f}`);
    console.log('');
  } else {
    console.log('No files depend on this.\n');
  }

  if (br.routesImpacted.length > 0) {
    console.log(`Routes at risk (${br.routesImpacted.length}):`);
    for (const r of br.routesImpacted) {
      const badge = r.risk === 'HIGH' ? '🔴' : r.risk === 'MEDIUM' ? '🟡' : '🟢';
      console.log(`  ${badge} ${r.method} ${r.path}`);
    }
  } else {
    console.log('No routes directly traceable.');
  }

  console.log('');
  carto.terminate();
}

module.exports = { run };
