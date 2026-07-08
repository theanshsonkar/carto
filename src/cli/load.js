'use strict';

/**
 * `carto load <file.anci> [--into <dir>] [--no-verify]`
 *
 * Unpacks a single-file ANCI container (produced by `carto export`) into
 * a queryable `.carto/` directory — with NO re-index. This is the "load
 * anywhere" half of CT-3: machine B receives `project.anci`, runs
 * `carto load project.anci`, and blast radius works instantly against the
 * container built on machine A.
 *
 * SECURITY (CT-3): a `.anci` file is shareable and therefore UNTRUSTED.
 * `unpackToDir` verifies the envelope integrity hash, accepts only the
 * two whitelisted entry names, and blocks path traversal. The unpacked
 * contents (paths, domain names, route strings, any embedded text) are
 * treated strictly as DATA — parsed into structures by the consumer,
 * never executed or interpreted as instructions. Loading integrity is
 * additionally checked against the manifest's content_digest.
 */

const fs = require('fs');
const path = require('path');
const { unpackToDir } = require('../anci/pack');

function printUsage() {
  console.log(`
Usage: carto load <file.anci> [--into <dir>]

Unpack a portable ANCI container into a queryable .carto/ — no re-index.
Loaded container contents are treated as untrusted data, never as
instructions.

Options:
  --into <dir>   Destination directory for anci.{yaml,bin}
                 (default: .carto in the cwd).
  --no-verify    Do not fail on a content_digest mismatch (advisory only).
  --help, -h     Show this help.
`);
}

/**
 * run({ argv }) → exit code (0 ok, 1 error).
 */
function run({ argv }) {
  let file = null;
  let intoDir = null;
  let verify = true;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { printUsage(); return 0; }
    else if (a === '--into') { intoDir = argv[++i]; }
    else if (a.startsWith('--into=')) { intoDir = a.slice('--into='.length); }
    else if (a === '--no-verify') { verify = false; }
    else if (a.startsWith('-')) { console.error(`[CARTO] load: unknown flag ${a}`); printUsage(); return 1; }
    else if (!file) { file = a; }
    else { console.error(`[CARTO] load: unexpected extra argument ${a}`); printUsage(); return 1; }
  }

  if (!file) {
    console.error('[CARTO] load: missing <file.anci> argument');
    printUsage();
    return 1;
  }
  if (!fs.existsSync(file)) {
    console.error(`[CARTO] load: file not found: ${file}`);
    return 1;
  }

  const projectRoot = process.cwd();
  const destDir = intoDir
    ? path.resolve(projectRoot, intoDir)
    : path.join(projectRoot, '.carto');

  // 1. Unpack (untrusted → validated) into the destination.
  let out;
  try {
    const buf = fs.readFileSync(file);
    out = unpackToDir(buf, destDir);
  } catch (err) {
    console.error(`[CARTO] load: ${err.message}`);
    return 1;
  }

  // 2. Load via the consumer WITHOUT re-indexing. Digest verification is
  // on by default; contents are parsed as data only.
  let reader;
  try {
    const { loadAnci } = require('../anci/consumer');
    reader = loadAnci(destDir, {
      verify,
      warn: (m) => console.error(`[CARTO] load: ${m}`),
    });
  } catch (err) {
    console.error(`[CARTO] load: ${err.message}`);
    return 1;
  }

  // 3. Summarize + prove blast radius works with no index/re-parse.
  const h = reader.header;
  console.log(`[CARTO] Loaded container into ${path.relative(projectRoot, destDir) || '.'}/ (no re-index)`);
  if (h && h.anci) {
    console.log(`  spec version   : ${h.anci.version}`);
    if (h.anci.carto_version) console.log(`  carto version  : ${h.anci.carto_version}`);
  }
  if (h && h.source && h.source.commit) {
    console.log(`  source commit  : ${h.source.commit.slice(0, 12)}`);
  }
  const v = reader.verifyDigest();
  if (v) console.log(`  integrity      : ${v.ok ? 'digest verified ✓' : 'DIGEST MISMATCH ✗'}`);
  if (h && h.project) {
    console.log(`  files          : ${h.project.total_files}   routes: ${h.project.total_routes}   models: ${h.project.total_models}`);
  }

  const top = reader.getHighImpactFiles(1);
  if (top.length > 0) {
    const br = reader.blastRadius(top[0].file);
    const cnt = br ? br.count : 0;
    console.log(`  blast radius   : ${top[0].file} → ${cnt} dependent${cnt === 1 ? '' : 's'} (instant, no re-index)`);
  }
  console.log(`  note           : container contents are treated as untrusted data, never instructions.`);
  return 0;
}

module.exports = { run };
