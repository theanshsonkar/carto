'use strict';

/**
 * ANCI single-file container envelope (CT-3).
 *
 * `carto export` packs the two on-disk ANCI files (`anci.yaml` +
 * `anci.bin`) into ONE portable file — `project.anci` — so a container
 * built on machine A can be handed to machine B and loaded with no
 * re-index. `carto load` unpacks it back into a queryable `.carto/`.
 *
 * ── Envelope wire format (little-endian) ──────────────────────────
 *
 *   magic        u32  = 0x50434E41  ("ANCP", i.e. 'A','N','C','P' LE)
 *   version      u8   = 1
 *   reserved     u8×3 = 0
 *   entry_count  u32
 *   entry_count × {
 *     name_len   u32
 *     name       name_len UTF-8 bytes   (a bare basename — see below)
 *     data_len   u32
 *     data       data_len bytes
 *   }
 *   trailer      32 bytes = sha256(all preceding bytes)
 *
 * The envelope has its OWN magic (`ANCP`) — distinct from the ANCI body
 * magic (`ANCI` = 0x49434E41) and the internal bitmap cache (`CBRT`).
 * A consumer MUST NOT confuse the three.
 *
 * ── Reproducibility ───────────────────────────────────────────────
 * Entries are written in a fixed (name-sorted) order, so packing the
 * same input bytes twice yields byte-identical envelopes. Note that
 * `anci.yaml` embeds a `generated_at` timestamp, so the *envelope* is
 * only byte-stable for a fixed input pair; the reproducible identity of
 * a container is its `anci.bin` `content_digest` (CT-4), which the
 * envelope carries verbatim inside the packed `anci.yaml`.
 *
 * ── Security (CT-3) ───────────────────────────────────────────────
 * A `.anci` file is shareable, therefore UNTRUSTED. On unpack we:
 *   1. Verify the trailer sha256 over the whole payload (detects
 *      truncation / corruption / tampering of the envelope itself).
 *   2. Accept ONLY whitelisted entry names (`anci.yaml`, `anci.bin`).
 *   3. Reject any name that is not a bare basename — no path separators,
 *      no `..`, no absolute paths, no NUL — so unpacking can never write
 *      outside the destination directory (zip-slip / path traversal).
 *   4. Bound entry count and per-entry size so a hostile header can't
 *      trigger an unbounded allocation.
 * The *contents* of the unpacked files are still treated as data, never
 * instructions — the consumer (`loadAnci`) only parses them into data
 * structures; nothing in a container is ever executed or interpreted as
 * a command.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  ANCI_BIN_FILENAME,
  ANCI_YAML_FILENAME,
} = require('./serialize');

const PACK_MAGIC = 0x50434E41;   // "ANCP" little-endian ('A','N','C','P')
const PACK_VERSION = 1;
const PACK_HEADER_BYTES = 12;    // magic u32 + version u8 + reserved u8×3 + entry_count u32
const TRAILER_BYTES = 32;        // sha256 digest length

// Only these entry names may appear in a container. Anything else is a
// malformed or hostile file and is rejected on unpack.
const ALLOWED_ENTRY_NAMES = new Set([ANCI_YAML_FILENAME, ANCI_BIN_FILENAME]);

// Defensive bounds. A legitimate container has exactly two entries; the
// per-entry cap (1 GiB) is far above any real ANCI body yet well below
// the u32 max, so a corrupt/hostile length field fails fast instead of
// attempting a multi-GB allocation.
const MAX_ENTRIES = 16;
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;

/**
 * isSafeEntryName(name) → boolean
 *
 * True only for a bare basename on the whitelist. This is the
 * path-traversal guard: rejects separators, `..`, absolute paths, NUL,
 * and any name whose basename differs from itself (which would smuggle
 * a directory component).
 */
function isSafeEntryName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (!ALLOWED_ENTRY_NAMES.has(name)) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.includes('\0')) return false;
  if (name === '.' || name === '..') return false;
  if (path.isAbsolute(name)) return false;
  // basename identity — no directory component may hide in the name.
  if (path.basename(name) !== name) return false;
  return true;
}

/**
 * packContainer(entries) → Buffer
 *
 * `entries`: object mapping name → Buffer|string. Only whitelisted names
 * are packed; others throw (a producer bug, not untrusted input). Entries
 * are serialized in name-sorted order for reproducibility.
 */
function packContainer(entries) {
  const names = Object.keys(entries).sort();
  const chunks = [];

  const header = Buffer.allocUnsafe(PACK_HEADER_BYTES);
  header.writeUInt32LE(PACK_MAGIC, 0);
  header.writeUInt8(PACK_VERSION, 4);
  header.writeUInt8(0, 5);
  header.writeUInt8(0, 6);
  header.writeUInt8(0, 7);
  header.writeUInt32LE(names.length, 8);
  chunks.push(header);

  for (const name of names) {
    if (!isSafeEntryName(name)) {
      throw new Error(`packContainer: refusing to pack unsafe/unknown entry name: ${JSON.stringify(name)}`);
    }
    const nameBytes = Buffer.from(name, 'utf-8');
    const raw = entries[name];
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf-8');

    const rec = Buffer.allocUnsafe(4 + nameBytes.length + 4);
    rec.writeUInt32LE(nameBytes.length, 0);
    nameBytes.copy(rec, 4);
    rec.writeUInt32LE(data.length, 4 + nameBytes.length);
    chunks.push(rec);
    chunks.push(data);
  }

  const payload = Buffer.concat(chunks);
  const trailer = crypto.createHash('sha256').update(payload).digest();
  return Buffer.concat([payload, trailer]);
}

/**
 * packFromCartoDir(cartoDir) → Buffer
 *
 * Reads `<cartoDir>/anci.yaml` + `<cartoDir>/anci.bin` and packs them.
 * Throws with an actionable message if either is missing.
 */
function packFromCartoDir(cartoDir) {
  const yamlPath = path.join(cartoDir, ANCI_YAML_FILENAME);
  const binPath = path.join(cartoDir, ANCI_BIN_FILENAME);
  if (!fs.existsSync(yamlPath) || !fs.existsSync(binPath)) {
    throw new Error(
      `ANCI files not found in ${cartoDir} (need ${ANCI_YAML_FILENAME} + ${ANCI_BIN_FILENAME}). ` +
      `Run \`carto anci publish\` (or \`carto init\`) first.`
    );
  }
  return packContainer({
    [ANCI_YAML_FILENAME]: fs.readFileSync(yamlPath),
    [ANCI_BIN_FILENAME]: fs.readFileSync(binPath),
  });
}

/**
 * unpackContainer(buf) → { entries: Map<name, Buffer> }
 *
 * Strictly validates an UNTRUSTED envelope. Throws on any structural
 * problem (bad magic/version, truncation, oversized/duplicate/unsafe
 * entry, trailer mismatch). On success, `entries` is guaranteed to
 * contain only safe, whitelisted names.
 */
function unpackContainer(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new Error('unpackContainer: expected a Buffer');
  }
  if (buf.length < PACK_HEADER_BYTES + TRAILER_BYTES) {
    throw new Error('unpackContainer: file too small to be an ANCI container');
  }
  if (buf.readUInt32LE(0) !== PACK_MAGIC) {
    throw new Error('unpackContainer: bad magic — not an ANCI container (.anci) file');
  }
  const version = buf.readUInt8(4);
  if (version !== PACK_VERSION) {
    throw new Error(`unpackContainer: unsupported container version ${version} (this build reads v${PACK_VERSION})`);
  }

  // Trailer integrity: recompute sha256 over everything before the last
  // 32 bytes and compare. Do this BEFORE trusting any length field so a
  // corrupt/hostile file is rejected up front.
  const payloadEnd = buf.length - TRAILER_BYTES;
  const declaredTrailer = buf.slice(payloadEnd);
  const actualTrailer = crypto.createHash('sha256').update(buf.slice(0, payloadEnd)).digest();
  if (!crypto.timingSafeEqual(declaredTrailer, actualTrailer)) {
    throw new Error('unpackContainer: integrity check failed — container is corrupt or truncated');
  }

  const entryCount = buf.readUInt32LE(8);
  if (entryCount > MAX_ENTRIES) {
    throw new Error(`unpackContainer: entry_count ${entryCount} exceeds cap ${MAX_ENTRIES}`);
  }

  const entries = new Map();
  let off = PACK_HEADER_BYTES;
  for (let i = 0; i < entryCount; i++) {
    if (off + 4 > payloadEnd) throw new Error('unpackContainer: truncated entry (name length)');
    const nameLen = buf.readUInt32LE(off); off += 4;
    if (nameLen === 0 || nameLen > 255 || off + nameLen > payloadEnd) {
      throw new Error('unpackContainer: invalid entry name length');
    }
    const name = buf.slice(off, off + nameLen).toString('utf-8'); off += nameLen;

    if (off + 4 > payloadEnd) throw new Error('unpackContainer: truncated entry (data length)');
    const dataLen = buf.readUInt32LE(off); off += 4;
    if (dataLen > MAX_ENTRY_BYTES) {
      throw new Error(`unpackContainer: entry ${JSON.stringify(name)} size ${dataLen} exceeds cap ${MAX_ENTRY_BYTES}`);
    }
    if (off + dataLen > payloadEnd) throw new Error('unpackContainer: truncated entry (data)');
    const data = buf.slice(off, off + dataLen); off += dataLen;

    // SECURITY: reject unsafe/unknown names — path-traversal guard.
    if (!isSafeEntryName(name)) {
      throw new Error(
        `unpackContainer: refusing unsafe entry name ${JSON.stringify(name)} ` +
        `(path traversal / unknown entry) — container rejected`
      );
    }
    if (entries.has(name)) {
      throw new Error(`unpackContainer: duplicate entry ${JSON.stringify(name)}`);
    }
    entries.set(name, data);
  }

  if (off !== payloadEnd) {
    throw new Error('unpackContainer: trailing bytes after last entry — malformed container');
  }
  // A valid container must carry both ANCI files.
  if (!entries.has(ANCI_YAML_FILENAME) || !entries.has(ANCI_BIN_FILENAME)) {
    throw new Error(
      `unpackContainer: container missing required entries ` +
      `(${ANCI_YAML_FILENAME} + ${ANCI_BIN_FILENAME})`
    );
  }
  return { entries };
}

/**
 * unpackToDir(buf, destDir) → { yamlPath, binPath, dir }
 *
 * Unpacks an UNTRUSTED envelope and writes the ANCI pair into `destDir`
 * (created if missing). Uses ONLY the sanitized basename joined to
 * `destDir`, so a hostile name can never escape the destination even if
 * validation somehow let one through (defense in depth). Writes atomically
 * via `.tmp` + rename.
 */
function unpackToDir(buf, destDir) {
  const { entries } = unpackContainer(buf);
  fs.mkdirSync(destDir, { recursive: true });

  const written = {};
  for (const [name, data] of entries) {
    // Defense in depth: re-derive the basename and confirm containment.
    const safeName = path.basename(name);
    const target = path.join(destDir, safeName);
    const resolvedDest = path.resolve(destDir);
    const resolvedTarget = path.resolve(target);
    if (resolvedTarget !== path.join(resolvedDest, safeName)) {
      throw new Error(`unpackToDir: refusing to write outside destination: ${name}`);
    }
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
    written[safeName] = target;
  }

  return {
    dir: destDir,
    yamlPath: written[ANCI_YAML_FILENAME],
    binPath: written[ANCI_BIN_FILENAME],
  };
}

module.exports = {
  PACK_MAGIC,
  PACK_VERSION,
  PACK_HEADER_BYTES,
  TRAILER_BYTES,
  ALLOWED_ENTRY_NAMES,
  isSafeEntryName,
  packContainer,
  packFromCartoDir,
  unpackContainer,
  unpackToDir,
};
