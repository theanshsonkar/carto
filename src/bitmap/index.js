'use strict';

/**
 * Bitmap engine orchestrator — freshness, persistence, and process-lifetime cache.
 *
 * Wraps `sidecar.js` with a simple lifecycle: SQLite is the durable
 * source of truth, the bitmap layer is derived + disposable, and a
 * stale or corrupt bitmap.bin must never be a correctness problem —
 * we just rebuild.
 *
 * Public surface:
 *   ensureBitmapFresh(cartoDir, store) → sidecar object
 *     Returns a fresh sidecar suitable for the bitmap query tools. If
 *     `.carto/bitmap.bin` is missing, older than `.carto/carto.db`, or
 *     fails to load (corrupt / version mismatch), rebuilds from `store`
 *     and re-persists.
 *
 *   invalidate(cartoDir?) → void
 *     Clears the in-memory cache. If `cartoDir` is given, also deletes
 *     the on-disk bitmap.bin so a follow-up `ensureBitmapFresh` from a
 *     different process triggers a rebuild even if the carto.db mtime
 *     didn't bump (e.g. write within the same mtime granularity).
 *
 *   _resetForTests() → void
 *     Test-only escape hatch — drops the cache without filesystem side
 *     effects. The leading underscore signals "do not use in production."
 */

const fs = require('fs');
const path = require('path');
const {
  buildFromStore,
  saveToDisk,
  loadFromDisk,
  BITMAP_FILENAME,
} = require('./sidecar');

// Process-lifetime cache. The MCP server is one Node process per repo,
// so a singleton matches the lifecycle correctly. `cartoDir` is part of
// the key so the (rare) case where one process serves multiple repos
// — e.g. tests that spin up several MCP servers in sequence — doesn't
// hand a stale sidecar to the wrong project.
let cached = null;

/**
 * Returns true if `bitmapPath` exists and is at least as fresh as `dbPath`.
 * Files with identical mtimes are treated as fresh — the bitmap was almost
 * certainly written immediately after the DB row that triggered the rebuild.
 */
function bitmapIsFresh(cartoDir) {
  const dbPath = path.join(cartoDir, 'carto.db');
  const bitmapPath = path.join(cartoDir, BITMAP_FILENAME);
  let bitmapStat, dbStat;
  try { bitmapStat = fs.statSync(bitmapPath); } catch { return false; }
  try { dbStat = fs.statSync(dbPath); } catch { return false; }
  return bitmapStat.mtimeMs >= dbStat.mtimeMs;
}

/**
 * ensureBitmapFresh(cartoDir, store) → sidecar
 *
 * Best-effort cache lookup → disk load → rebuild. Throws only if the
 * SQLite store itself is unusable (no `.db`). Callers that can fall back
 * to SQLite query paths should wrap this in try/catch.
 */
function ensureBitmapFresh(cartoDir, store) {
  // 1. In-memory cache hit (and still fresh).
  if (cached && cached.cartoDir === cartoDir) {
    if (bitmapIsFresh(cartoDir)) return cached.sidecar;
    // Cache is stale w.r.t. on-disk DB — fall through and rebuild.
    cached = null;
  }

  // 2. Try loading from disk if the file is fresh.
  if (bitmapIsFresh(cartoDir)) {
    const loaded = loadFromDisk(cartoDir);
    if (loaded) {
      cached = { cartoDir, sidecar: loaded };
      return loaded;
    }
    // loadFromDisk returned null → corrupt or version mismatch. Rebuild.
  }

  // 3. Rebuild from the SQLite source of truth and re-persist.
  const sidecar = buildFromStore(store);
  try {
    saveToDisk(cartoDir, sidecar);
  } catch (err) {
    // Persistence failure (read-only FS, disk full, race with another
    // writer) is non-fatal — the in-memory sidecar still answers
    // queries correctly. Surface to stderr so it shows up in MCP host
    // logs without killing the request.
    process.stderr.write(
      `[CARTO bitmap] failed to persist sidecar to ${cartoDir}: ` +
      `${err && err.message ? err.message : err}\n`
    );
  }
  cached = { cartoDir, sidecar };
  return sidecar;
}

/**
 * invalidate(cartoDir?) — drop in-memory cache and (optionally) the
 * on-disk file. Called by `runSync` (full sync rebuilds, then we
 * re-prime the cache on next ensureBitmapFresh) and `syncFiles`
 * (partial sync — disk file is now stale).
 */
function invalidate(cartoDir) {
  cached = null;
  if (cartoDir) {
    const target = path.join(cartoDir, BITMAP_FILENAME);
    try { fs.unlinkSync(target); } catch {}
  }
}

/** Test-only: drop the in-memory cache without touching the filesystem. */
function _resetForTests() {
  cached = null;
}

module.exports = { ensureBitmapFresh, invalidate, _resetForTests };
