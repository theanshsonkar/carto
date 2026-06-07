'use strict';

/**
 * ANCI v0.1 — binary body deserializer.
 *
 * Format reference: docs/anci/v0.1-DRAFT.md §5.
 *
 * Symmetric with serialize.js. Validates magic + version up front, then
 * stream-parses each section in declared order.
 *
 * Returns null for malformed inputs (corrupt magic, unsupported version,
 * truncated section). The reference consumer's contract: malformed ANCI
 * is a degraded — not catastrophic — situation. Callers that need a
 * strict error throw should check the return value.
 */

const fs = require('fs');
const path = require('path');
const { Bitset } = require('../bitmap/bitset');
const {
  MAGIC,
  VERSION,
  HEADER_BYTES,
  ANCI_BIN_FILENAME,
} = require('./serialize');

/**
 * decodeBitmap(buf, off, size) → { id, bitmap, nextOff }
 */
function decodeBitmap(buf, off, size) {
  const id = buf.readUInt32LE(off);
  const wordsLen = buf.readUInt32LE(off + 4);
  const wordBytes = wordsLen * 4;
  const bitmap = new Bitset(size);
  if (bitmap.words.length !== wordsLen) {
    throw new Error(
      `decodeBitmap: word-length mismatch (header size=${size} → ${bitmap.words.length} words, ` +
      `record claims ${wordsLen} words)`
    );
  }
  const u8 = new Uint8Array(bitmap.words.buffer, bitmap.words.byteOffset, wordBytes);
  for (let i = 0; i < wordBytes; i++) u8[i] = buf[off + 8 + i];
  return { id, bitmap, nextOff: off + 8 + wordBytes };
}

/**
 * deserializeBody(buf) → payload object | null on malformed input.
 *
 * Returned shape mirrors `serializeBody`'s input plus a
 * `pathToFileId` inverse map for consumer convenience:
 *
 *   {
 *     size,
 *     forward, reverse,
 *     popcountIndex,
 *     fileIdToPath, pathToFileId,
 *     fileDomain, domainIdToName,
 *   }
 */
function deserializeBody(buf) {
  try {
    if (!Buffer.isBuffer(buf)) return null;
    if (buf.length < HEADER_BYTES) return null;
    if (buf.readUInt32LE(0) !== MAGIC) return null;
    const version = buf.readUInt8(4);
    if (version !== VERSION) return null;
    const size = buf.readUInt32LE(8);

    let off = HEADER_BYTES;

    // forward
    const forward = new Map();
    const fwdCount = buf.readUInt32LE(off); off += 4;
    for (let i = 0; i < fwdCount; i++) {
      const dec = decodeBitmap(buf, off, size);
      forward.set(dec.id, dec.bitmap);
      off = dec.nextOff;
    }

    // reverse
    const reverse = new Map();
    const revCount = buf.readUInt32LE(off); off += 4;
    for (let i = 0; i < revCount; i++) {
      const dec = decodeBitmap(buf, off, size);
      reverse.set(dec.id, dec.bitmap);
      off = dec.nextOff;
    }

    // popcount
    const popLen = buf.readUInt32LE(off); off += 4;
    const popcountIndex = new Array(popLen);
    for (let i = 0; i < popLen; i++) {
      popcountIndex[i] = {
        fileId: buf.readUInt32LE(off),
        count: buf.readUInt32LE(off + 4),
      };
      off += 8;
    }

    // paths
    const fileIdToPath = new Map();
    const pathToFileId = new Map();
    const pathCount = buf.readUInt32LE(off); off += 4;
    for (let i = 0; i < pathCount; i++) {
      const fid = buf.readUInt32LE(off);
      const pLen = buf.readUInt32LE(off + 4);
      const p = buf.slice(off + 8, off + 8 + pLen).toString('utf-8');
      fileIdToPath.set(fid, p);
      pathToFileId.set(p, fid);
      off += 8 + pLen;
    }

    // file_domain
    const fileDomain = new Map();
    const fdCount = buf.readUInt32LE(off); off += 4;
    for (let i = 0; i < fdCount; i++) {
      fileDomain.set(buf.readUInt32LE(off), buf.readUInt32LE(off + 4));
      off += 8;
    }

    // domain_names
    const domainIdToName = new Map();
    const dnCount = buf.readUInt32LE(off); off += 4;
    for (let i = 0; i < dnCount; i++) {
      const did = buf.readUInt32LE(off);
      const nLen = buf.readUInt32LE(off + 4);
      const name = buf.slice(off + 8, off + 8 + nLen).toString('utf-8');
      domainIdToName.set(did, name);
      off += 8 + nLen;
    }

    return {
      size,
      forward,
      reverse,
      popcountIndex,
      fileIdToPath,
      pathToFileId,
      fileDomain,
      domainIdToName,
    };
  } catch {
    return null;
  }
}

/**
 * loadBodyFromDisk(cartoDir) → payload | null
 */
function loadBodyFromDisk(cartoDir) {
  const target = path.join(cartoDir, ANCI_BIN_FILENAME);
  let buf;
  try { buf = fs.readFileSync(target); } catch { return null; }
  return deserializeBody(buf);
}

module.exports = {
  deserializeBody,
  loadBodyFromDisk,
};
