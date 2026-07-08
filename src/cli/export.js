'use strict';

/**
 * `carto export [--out <file.anci>]`
 *
 * Packs the project's ANCI pair (`.carto/anci.{yaml,bin}`) into ONE
 * portable single-file container (`project.anci` by default) that can be
 * copied to another machine and loaded with `carto load` — with NO
 * re-index. This is the "build once, load anywhere" half of CT-3.
 *
 * If the ANCI files don't exist yet but an index does, they are emitted
 * first (same code path as `carto anci publish`) so `carto export` works
 * immediately after `carto init` without a manual publish step.
 */

const fs = require('fs');
const path = require('path');
const { packFromCartoDir } = require('../anci/pack');
const { ANCI_BIN_FILENAME, ANCI_YAML_FILENAME } = require('../anci/serialize');

function printUsage() {
  console.log(`
Usage: carto export [--out <file.anci>]

Pack .carto/anci.{yaml,bin} into a single portable container file.
Copy the file to another machine and \`carto load\` it — no re-index.

Options:
  --out <file>   Output path (default: project.anci in the cwd).
  --help, -h     Show this help.
`);
}

/**
 * run({ argv }) → exit code (0 ok, 1 error).
 */
function run({ argv }) {
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { printUsage(); return 0; }
    else if (a === '--out' || a === '-o') { outPath = argv[++i]; }
    else if (a.startsWith('--out=')) { outPath = a.slice('--out='.length); }
    else { console.error(`[CARTO] export: unknown argument ${a}`); printUsage(); return 1; }
  }

  const projectRoot = process.cwd();
  const cartoDir = path.join(projectRoot, '.carto');
  const dbPath = path.join(cartoDir, 'carto.db');
  const yamlPath = path.join(cartoDir, ANCI_YAML_FILENAME);
  const binPath = path.join(cartoDir, ANCI_BIN_FILENAME);

  // Ensure ANCI files exist; emit them from the index if not.
  if (!fs.existsSync(yamlPath) || !fs.existsSync(binPath)) {
    if (!fs.existsSync(dbPath)) {
      console.error(`[CARTO] No index found at ${dbPath}. Run \`carto init\` first.`);
      return 1;
    }
    try {
      emitFromIndex(projectRoot, cartoDir);
    } catch (err) {
      console.error(`[CARTO] export: failed to emit ANCI from index: ${err.message}`);
      return 1;
    }
  }

  if (!outPath) outPath = path.join(projectRoot, 'project.anci');

  let packed;
  try {
    packed = packFromCartoDir(cartoDir);
  } catch (err) {
    console.error(`[CARTO] export: ${err.message}`);
    return 1;
  }

  try {
    const tmp = outPath + '.tmp';
    fs.writeFileSync(tmp, packed);
    fs.renameSync(tmp, outPath);
  } catch (err) {
    console.error(`[CARTO] export: failed to write ${outPath}: ${err.message}`);
    return 1;
  }

  // Report identity so the operator can verify the container.
  let digest = null, sourceCommit = null;
  try {
    const yaml = require('../anci/yaml');
    const header = yaml.parse(fs.readFileSync(yamlPath, 'utf-8'));
    digest = header && header.anci && header.anci.body && header.anci.body.content_digest;
    sourceCommit = header && header.source && header.source.commit;
  } catch { /* best-effort */ }

  console.log(`[CARTO] Exported container → ${path.relative(projectRoot, outPath)} (${formatBytes(packed.length)})`);
  if (digest) console.log(`  content digest : ${digest}`);
  if (sourceCommit) console.log(`  source commit  : ${sourceCommit.slice(0, 12)}`);
  console.log(`  load with      : carto load ${path.basename(outPath)}`);
  return 0;
}

/**
 * emitFromIndex(projectRoot, cartoDir) — re-emit anci.{yaml,bin} from the
 * existing SQLite index + bitmap sidecar. Mirrors `carto anci publish`.
 */
function emitFromIndex(projectRoot, cartoDir) {
  const { SQLiteStore } = require('../store/sqlite-store');
  const { ensureBitmapFresh } = require('../bitmap/index');
  const { emitToCartoDir } = require('../anci/emit');

  const store = new SQLiteStore(projectRoot);
  store.open();
  try {
    const sidecar = ensureBitmapFresh(cartoDir, store);
    emitToCartoDir({ cartoDir, sidecar, store });
  } finally {
    try { store.close(); } catch {}
  }
}

function formatBytes(n) {
  if (n === null || n === undefined) return 'n/a';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

module.exports = { run };
