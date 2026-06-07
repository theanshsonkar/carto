'use strict';

/**
 * `carto anci` — ANCI subcommand dispatcher.
 *
 * Subcommands:
 *   publish              Re-emit `.carto/anci.{yaml,bin}` from the
 *                        existing index. Does NOT re-sync — assumes
 *                        the index is already populated.
 *   show                 Print a human-readable summary of the
 *                        published ANCI files.
 *   validate <dir>       Validate an external `anci.{yaml,bin}` pair
 *                        at <dir>. Exits 0 on valid, 1 on invalid.
 *
 * All paths in this module are anchored at `process.cwd()` unless an
 * explicit directory is passed.
 *
 * The `serve` MCP server is unaffected — ANCI is the *export* format,
 * not Carto's runtime format. SQLite + bitmap remain the runtime path.
 */

const fs = require('fs');
const path = require('path');

function printUsage() {
  console.log(`
Usage: carto anci <subcommand>

Subcommands:
  publish              Re-emit .carto/anci.{yaml,bin} from the existing
                       SQLite index + bitmap sidecar. No re-sync.
  show                 Print a summary of the published ANCI files.
  validate <dir>       Validate an external anci.{yaml,bin} pair at <dir>.
                       Exit 0 on valid, 1 on invalid.

Examples:
  carto anci publish
  carto anci show
  carto anci validate ./.carto
`);
}

/**
 * run({ argv }) → exit code (0 ok, 1 error).
 *
 * argv shape: array of args AFTER `carto anci` (e.g. `['publish']`,
 * `['validate', './.carto']`). The top-level `cli/index.js` slices the
 * full process.argv before passing it in.
 */
function run({ argv }) {
  const sub = argv[0];

  if (!sub || sub === '--help' || sub === '-h') {
    printUsage();
    return 0;
  }

  if (sub === 'publish') return runPublish(process.cwd());
  if (sub === 'show')    return runShow(process.cwd());
  if (sub === 'validate') {
    const dir = argv[1] || path.join(process.cwd(), '.carto');
    return runValidate(dir);
  }

  console.error(`[CARTO] Unknown anci subcommand: ${sub}`);
  printUsage();
  return 1;
}

/**
 * publish — Re-emit ANCI files from the existing index.
 *
 * Reads the SQLiteStore (read-write so a fresh sidecar can be persisted
 * if the on-disk one is stale) + bitmap sidecar, then writes
 * `anci.{yaml,bin}` atomically. Prints sizes and elapsed time.
 *
 * Exits 1 if no `.carto/carto.db` is present.
 */
function runPublish(projectRoot) {
  const cartoDir = path.join(projectRoot, '.carto');
  const dbPath = path.join(cartoDir, 'carto.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`[CARTO] No index found at ${dbPath}. Run \`carto init\` first.`);
    return 1;
  }

  const start = Date.now();
  const { SQLiteStore } = require('../store/sqlite-store');
  const { ensureBitmapFresh } = require('../bitmap/index');
  const { emitToCartoDir } = require('../anci/emit');

  const store = new SQLiteStore(projectRoot);
  store.open();
  try {
    const sidecar = ensureBitmapFresh(cartoDir, store);
    const { yamlPath, binPath, bodyBytes } = emitToCartoDir({
      cartoDir, sidecar, store,
    });
    const elapsed = Date.now() - start;
    const yamlBytes = fs.statSync(yamlPath).size;

    console.log(`[CARTO] Published ANCI v0.1 in ${elapsed}ms`);
    console.log(`  ${path.relative(projectRoot, yamlPath)} (${formatBytes(yamlBytes)})`);
    console.log(`  ${path.relative(projectRoot, binPath)} (${formatBytes(bodyBytes)})`);
    return 0;
  } finally {
    try { store.close(); } catch {}
  }
}

/**
 * show — Print a summary of the published ANCI files.
 *
 * Loads via the consumer library so this surface dogfoods the same
 * code path partner integrations will use. If either file is missing
 * or malformed, prints the error and exits 1.
 */
function runShow(projectRoot) {
  const cartoDir = path.join(projectRoot, '.carto');
  let reader;
  try {
    const { loadAnci } = require('../anci/consumer');
    reader = loadAnci(cartoDir);
  } catch (err) {
    console.error(`[CARTO] ${err.message}`);
    console.error(`[CARTO] Run \`carto anci publish\` to (re)generate.`);
    return 1;
  }

  const h = reader.header;
  const lines = [];
  lines.push('');
  lines.push('── ANCI ────────────────────────────────────────────────');
  lines.push('');
  lines.push(`  spec version    : ${h.anci.version}`);
  lines.push(`  generator       : ${h.anci.generator}`);
  lines.push(`  generated_at    : ${h.anci.generated_at}`);
  lines.push(`  body file       : ${h.anci.body.file} (${formatBytes(h.anci.body.bytes)})`);
  lines.push('');
  if (h.project) {
    lines.push('Project');
    lines.push(`  files           : ${h.project.total_files}`);
    lines.push(`  routes          : ${h.project.total_routes}`);
    lines.push(`  models          : ${h.project.total_models}`);
    lines.push(`  import edges    : ${h.project.total_import_edges}`);
    lines.push('');
  }
  if (reader.domains.length > 0) {
    lines.push(`Domains (${reader.domains.length})`);
    for (const d of reader.domains) {
      lines.push(`  ${d.name.padEnd(16)} ${String(d.file_count).padStart(5)} files  ` +
        `${String(d.route_count || 0).padStart(4)} routes  ` +
        `${String(d.model_count || 0).padStart(4)} models`);
    }
    lines.push('');
  }
  if (reader.high_impact && reader.high_impact.length > 0) {
    lines.push('Top impact (transitive dependents)');
    const topN = Math.min(10, reader.high_impact.length);
    for (let i = 0; i < topN; i++) {
      const e = reader.high_impact[i];
      lines.push(`  ${String(e.transitive_dependents).padStart(4)}  ${e.file}`);
    }
    lines.push('');
  }
  lines.push('────────────────────────────────────────────────────────');
  lines.push('');
  process.stdout.write(lines.join('\n'));
  return 0;
}

/**
 * validate <dir> — Validate an external ANCI pair.
 *
 * Cleanly distinguishes "structural problem with the file" (return 1
 * with message) from "this consumer can't handle this version"
 * (return 1 with message naming the version) from "all checks pass"
 * (return 0).
 */
function runValidate(dir) {
  const yaml = require('../anci/yaml');
  const { deserializeBody } = require('../anci/deserialize');
  const { ANCI_BIN_FILENAME, ANCI_YAML_FILENAME } = require('../anci/serialize');

  const yamlPath = path.join(dir, ANCI_YAML_FILENAME);
  const binPath = path.join(dir, ANCI_BIN_FILENAME);

  const errors = [];
  if (!fs.existsSync(yamlPath)) errors.push(`missing ${yamlPath}`);
  if (!fs.existsSync(binPath))  errors.push(`missing ${binPath}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`[CARTO] ${e}`);
    return 1;
  }

  let header;
  try {
    header = yaml.parse(fs.readFileSync(yamlPath, 'utf-8'));
  } catch (err) {
    console.error(`[CARTO] header parse failed: ${err.message}`);
    return 1;
  }
  if (!header || !header.anci || typeof header.anci.version !== 'string') {
    console.error('[CARTO] header missing required `anci.version`');
    return 1;
  }

  const bodyBuf = fs.readFileSync(binPath);
  const body = deserializeBody(bodyBuf);
  if (!body) {
    console.error('[CARTO] body failed to parse (corrupt magic, version, or section)');
    return 1;
  }

  // Optional cross-check: header.body.bytes vs actual file size.
  if (header.anci.body && typeof header.anci.body.bytes === 'number') {
    if (header.anci.body.bytes !== bodyBuf.length) {
      console.error(
        `[CARTO] header/body size mismatch: header says ${header.anci.body.bytes}, ` +
        `actual ${bodyBuf.length} bytes`
      );
      return 1;
    }
  }

  console.log(`[CARTO] ANCI valid: ${header.anci.version}, ${body.size} files indexed.`);
  return 0;
}

function formatBytes(n) {
  if (n === null || n === undefined) return 'n/a';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

module.exports = { run };
