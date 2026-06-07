'use strict';

/**
 * ANCI v0.1 — binary body serializer.
 *
 * Format reference: docs/anci/v0.1-DRAFT.md §5.
 *
 * Wire format (little-endian throughout):
 *   header:        magic u32 = 0x49434E41 ("ANCI") · version u8 = 1 ·
 *                  reserved u8×3 · size_bits u32
 *   forward:       count u32 · count×{ fileId u32 · wordsLen u32 · words u32×wordsLen }
 *   reverse:       count u32 · same shape
 *   popcount:      count u32 · count×{ fileId u32 · count u32 }   (sorted DESC)
 *   paths:         count u32 · count×{ fileId u32 · pathLen u32 · UTF-8 bytes }
 *   file_domain:   count u32 · count×{ fileId u32 · domainId u32 }
 *   domain_names:  count u32 · count×{ domainId u32 · nameLen u32 · UTF-8 bytes }
 *
 * The body intentionally shares record-level layout with
 * `bitmap/sidecar.js` (Carto's internal cache) so the encoding helpers
 * can be visually paired across files. They are NOT the same file
 * format — distinct magics (`ANCI` vs `CBRT`), different section sets,
 * different versioning policies.
 */

const fs = require('fs');
const path = require('path');
const { Bitset } = require('../bitmap/bitset');

const MAGIC = 0x49434E41;        // "ANCI" little-endian: 'A','N','C','I'
const VERSION = 1;               // ANCI body wire-format version.
const HEADER_BYTES = 12;
const ANCI_BIN_FILENAME = 'anci.bin';
const ANCI_YAML_FILENAME = 'anci.yaml';

/**
 * encodeBitmap(id, bitmap) → Buffer of (id u32, wordsLen u32, words bytes).
 */
function encodeBitmap(id, bitmap) {
  const wordBytes = bitmap.words.byteLength;
  const buf = Buffer.allocUnsafe(8 + wordBytes);
  buf.writeUInt32LE(id, 0);
  buf.writeUInt32LE(bitmap.words.length, 4);
  Buffer.from(bitmap.words.buffer, bitmap.words.byteOffset, wordBytes).copy(buf, 8);
  return buf;
}

/**
 * Encode an Array<{fileId, count}> popcount index as a single Buffer.
 * Caller has already sorted DESC.
 */
function encodePopcountTable(entries) {
  if (entries.length === 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(entries.length * 8);
  let off = 0;
  for (const e of entries) {
    buf.writeUInt32LE(e.fileId, off);
    buf.writeUInt32LE(e.count, off + 4);
    off += 8;
  }
  return buf;
}

/**
 * Encode a Map<id, string> as length-prefixed UTF-8 records.
 */
function encodeStringTable(map) {
  const chunks = [];
  for (const [id, s] of map) {
    const bytes = Buffer.from(String(s), 'utf-8');
    const rec = Buffer.allocUnsafe(8 + bytes.length);
    rec.writeUInt32LE(id, 0);
    rec.writeUInt32LE(bytes.length, 4);
    bytes.copy(rec, 8);
    chunks.push(rec);
  }
  return Buffer.concat(chunks);
}

/**
 * Encode a Map<id, id> as fixed 8-byte records.
 */
function encodeIdMap(map) {
  if (map.size === 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(map.size * 8);
  let off = 0;
  for (const [k, v] of map) {
    buf.writeUInt32LE(k, off);
    buf.writeUInt32LE(v, off + 4);
    off += 8;
  }
  return buf;
}

/**
 * serializeBody(payload) → Buffer
 *
 * payload shape:
 *   {
 *     size: u32,
 *     forward:        Map<fileId, Bitset>,
 *     reverse:        Map<fileId, Bitset>,
 *     popcountIndex:  Array<{fileId, count}>  — sorted DESC by count
 *     fileIdToPath:   Map<fileId, string>,
 *     fileDomain:     Map<fileId, domainId>,
 *     domainIdToName: Map<domainId, string>,
 *   }
 */
function serializeBody(payload) {
  if (typeof payload.size !== 'number') {
    throw new Error('serializeBody: payload.size required (max fileId + 1)');
  }
  const chunks = [];

  // Fixed header
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt8(VERSION, 4);
  header.writeUInt8(0, 5);
  header.writeUInt8(0, 6);
  header.writeUInt8(0, 7);
  header.writeUInt32LE(payload.size, 8);
  chunks.push(header);

  // forward
  const fwdCount = Buffer.allocUnsafe(4);
  fwdCount.writeUInt32LE(payload.forward.size, 0);
  chunks.push(fwdCount);
  for (const [fid, bm] of payload.forward) chunks.push(encodeBitmap(fid, bm));

  // reverse
  const revCount = Buffer.allocUnsafe(4);
  revCount.writeUInt32LE(payload.reverse.size, 0);
  chunks.push(revCount);
  for (const [fid, bm] of payload.reverse) chunks.push(encodeBitmap(fid, bm));

  // popcount
  const popCount = Buffer.allocUnsafe(4);
  popCount.writeUInt32LE(payload.popcountIndex.length, 0);
  chunks.push(popCount);
  chunks.push(encodePopcountTable(payload.popcountIndex));

  // paths
  const pathCount = Buffer.allocUnsafe(4);
  pathCount.writeUInt32LE(payload.fileIdToPath.size, 0);
  chunks.push(pathCount);
  chunks.push(encodeStringTable(payload.fileIdToPath));

  // file_domain
  const fdCount = Buffer.allocUnsafe(4);
  fdCount.writeUInt32LE(payload.fileDomain.size, 0);
  chunks.push(fdCount);
  chunks.push(encodeIdMap(payload.fileDomain));

  // domain_names
  const dnCount = Buffer.allocUnsafe(4);
  dnCount.writeUInt32LE(payload.domainIdToName.size, 0);
  chunks.push(dnCount);
  chunks.push(encodeStringTable(payload.domainIdToName));

  return Buffer.concat(chunks);
}

/**
 * deriveBodyFromSidecar(sidecar) → payload accepted by serializeBody.
 *
 * Drops `crossForward` and `domainBitmaps` (internal optimizations not
 * part of the ANCI wire format — consumers re-derive on load).
 */
function deriveBodyFromSidecar(sidecar) {
  return {
    size: sidecar.size,
    forward: sidecar.forward,
    reverse: sidecar.reverse,
    popcountIndex: sidecar.popcountIndex,
    fileIdToPath: sidecar.fileIdToPath,
    fileDomain: sidecar.fileDomain,
    domainIdToName: sidecar.domainIdToName,
  };
}

/**
 * buildHeader(sidecar, store, opts?) → object suitable for yaml.emit().
 *
 * The full ANCI header. Pulls metadata from the SQLite `store`
 * (routes, models, domain counts) and architecture from the bitmap
 * `sidecar` (high-impact files). Both arguments are required because
 * the binary body alone does not carry route/model semantics.
 */
function buildHeader({ sidecar, store, generator, generatedAt, bodyBytes }) {
  // ── anci block ───────────────────────────────────────────────────
  const anciBlock = {
    version: '0.1.0-DRAFT',
    generator: generator || 'carto-md@unknown',
    generated_at: generatedAt || new Date().toISOString(),
    body: {
      file: ANCI_BIN_FILENAME,
      bytes: typeof bodyBytes === 'number' ? bodyBytes : 0,
    },
  };

  // ── project block ────────────────────────────────────────────────
  const structure = store.getStructure();
  const totalModels = store.db
    .prepare('SELECT COUNT(*) AS cnt FROM models').get().cnt;
  const project = {
    total_files: structure.meta.totalFiles,
    total_routes: structure.meta.totalRoutes,
    total_models: totalModels,
    total_import_edges: structure.meta.totalImportEdges,
  };

  // ── domains block ────────────────────────────────────────────────
  const domains = store.getDomainsList().map(d => ({
    name: d.name,
    file_count: d.fileCount,
    route_count: d.routeCount,
    model_count: d.modelCount,
  }));

  // ── high_impact (top 15 from popcount index, with hydrated paths) ─
  const high_impact = [];
  const N = Math.min(15, sidecar.popcountIndex.length);
  for (let i = 0; i < N; i++) {
    const e = sidecar.popcountIndex[i];
    const file = sidecar.fileIdToPath.get(e.fileId);
    if (file) high_impact.push({ file, transitive_dependents: e.count });
  }

  // ── routes ───────────────────────────────────────────────────────
  const routes = store.getRoutes().map(r => ({
    method: r.method,
    path: r.path,
    file: r.file,
    framework: r.framework || '',
    handler: r.handler_name || '',
  }));

  // ── models ───────────────────────────────────────────────────────
  const models = store.getModels().map(m => ({
    name: m.name,
    kind: m.kind,
    file: m.file,
  }));

  return {
    anci: anciBlock,
    project,
    domains,
    high_impact,
    routes,
    models,
  };
}

module.exports = {
  MAGIC,
  VERSION,
  HEADER_BYTES,
  ANCI_BIN_FILENAME,
  ANCI_YAML_FILENAME,
  serializeBody,
  deriveBodyFromSidecar,
  buildHeader,
};
