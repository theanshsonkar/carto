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
const yaml = require('./yaml');
const {
  serializeBody,
  deriveBodyFromSidecar,
  buildHeader,
  ANCI_BIN_FILENAME,
  ANCI_YAML_FILENAME,
} = require('./serialize');

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

  // 2. Header — built with the body's actual on-disk byte count so the
  // header's `body.bytes` cross-check matches.
  const header = buildHeader({
    sidecar,
    store,
    generator: generator || resolveGenerator(),
    generatedAt: generatedAt || new Date().toISOString(),
    bodyBytes: body.length,
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
