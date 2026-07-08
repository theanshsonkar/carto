'use strict';

/**
 * ANCI v0.1 — emit orchestrator.
 *
 * Glues serialize.js + yaml.js together and writes both files atomically
 * to `.carto/anci.{yaml,bin}`. Used by the runSync hook (called after
 * every full sync) and by `carto anci publish`.
 *
 * Atomic write: each file goes to `.tmp` first, then rename. Crash
 * mid-write leaves the previous pair intact (or absent — the consumer's
 * job is to refuse to load when the magic / version don't match).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('./yaml');
const {
  serializeBody,
  deriveBodyFromSidecar,
  buildHeader,
  ANCI_BIN_FILENAME,
  ANCI_YAML_FILENAME,
} = require('./serialize');
const { sourceIdentity } = require('./git-meta');

/**
 * emitToCartoDir({ cartoDir, sidecar, store, generator, generatedAt })
 *   → { yamlPath, binPath, bodyBytes }
 *
 * Required:
 *   cartoDir  — absolute path to `.carto/`. Will be created if missing.
 *   sidecar   — bitmap sidecar object (from `bitmap/sidecar.js`).
 *   store     — open SQLiteStore (any mode; used for header metadata).
 *
 * Optional:
 *   generator    — string, defaults to `carto-md@<version>`.
 *   generatedAt  — ISO-8601 string, defaults to `new Date().toISOString()`.
 *
 * Throws on filesystem failure (caller wraps in try/catch when
 * best-effort behavior is needed — see runSync hook).
 */
function emitToCartoDir({ cartoDir, sidecar, store, generator, generatedAt }) {
  fs.mkdirSync(cartoDir, { recursive: true });

  // 1. Body — derive from sidecar, serialize, atomic write.
  const body = serializeBody(deriveBodyFromSidecar(sidecar));
  const binPath = path.join(cartoDir, ANCI_BIN_FILENAME);
  const binTmp = binPath + '.tmp';
  fs.writeFileSync(binTmp, body);
  fs.renameSync(binTmp, binPath);

  // 1b. Content digest — sha256 over the exact bytes written to disk.
  // Prefixed with the algorithm so the manifest is self-describing and
  // future digests (e.g. sha512) can coexist. Consumers recompute this
  // to verify integrity (CT-1).
  const contentDigest = 'sha256:' + crypto.createHash('sha256').update(body).digest('hex');

  // 1c. Source identity — git commit/tree/branch of the repo being
  // packaged. `cartoDir` is `<projectRoot>/.carto`, so the project root
  // is its parent. Best-effort: all null on a non-git repo.
  const projectRoot = path.dirname(cartoDir);
  const source = sourceIdentity(projectRoot);

  // 2. Header — built with the body's actual on-disk byte count so the
  // header's `body.bytes` cross-check matches, plus the digest + source
  // identity computed above.
  const header = buildHeader({
    sidecar,
    store,
    generator: generator || resolveGenerator(),
    generatedAt: generatedAt || new Date().toISOString(),
    bodyBytes: body.length,
    contentDigest,
    source,
  });
  const yamlText = yaml.emit(header);
  const yamlPath = path.join(cartoDir, ANCI_YAML_FILENAME);
  const yamlTmp = yamlPath + '.tmp';
  fs.writeFileSync(yamlTmp, yamlText, 'utf-8');
  fs.renameSync(yamlTmp, yamlPath);

  return { yamlPath, binPath, bodyBytes: body.length };
}

/**
 * resolveGenerator() → "carto-md@<version>"
 *
 * Defensive: if package.json can't be read for any reason, fall back to
 * a stable opaque string rather than crash the publish.
 */
function resolveGenerator() {
  try {
    const pkg = require('../../package.json');
    return `${pkg.name}@${pkg.version}`;
  } catch {
    return 'carto-md@unknown';
  }
}

module.exports = { emitToCartoDir };
