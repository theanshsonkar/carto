'use strict';

/**
 * ANCI v0.1 — read-only consumer library.
 *
 * Format reference: docs/anci/v0.1-DRAFT.md.
 *
 * This module is the **public consumer API** for ANCI files. It is what
 * a Cursor / Cline / Continue / Windsurf / Claude Code plugin imports
 * to read a codebase's published architecture without indexing the
 * codebase itself.
 *
 * Any AI tool that calls `loadAnci(dir)` and uses its return value is
 * cooperating with Carto via the open ANCI format — no Carto runtime
 * required.
 *
 * Contract:
 *   loadAnci(dir, opts?) → {
 *     header,                    // parsed YAML metadata
 *     domains,                   // [{name, file_count, ...}]
 *     routes,                    // [{method, path, file, ...}]
 *     models,                    // [{name, kind, file}]
 *     blastRadius(file, opts?),  // 5-hop BFS from `reverse` bitmap
 *     simulateChangeImpact(files, opts?),
 *     getHighImpactFiles(n?),
 *     getDomainOf(file),
 *     close?(),                  // no-op for v0.1 (kept as forward-compat)
 *   }
 *
 * The shape mirrors Carto's MCP tool surface so existing test
 * fixtures port across with minimal change. Returns shapes match the
 * MCP tools' return shapes verbatim (file/hop_distance/count fields).
 *
 * Failure modes:
 *   - Missing files     → throws Error('ANCI not found at ...')
 *   - Bad version       → throws Error('ANCI version unsupported: ...')
 *   - Corrupt body      → throws Error('ANCI body failed to parse')
 *   - Missing header    → throws (the header is required)
 *
 * Zero runtime dependencies. Uses only Node built-ins, the bundled
 * Bitset class, and the YAML / deserialize modules in this directory.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('./yaml');
const { deserializeBody } = require('./deserialize');
const {
  ANCI_BIN_FILENAME,
  ANCI_YAML_FILENAME,
  VERSION,
} = require('./serialize');
const { Bitset } = require('../bitmap/bitset');

const ACCEPTED_VERSION_PREFIX = '0.1.';   // accept any 0.1.x version
const MAX_BFS_HOPS = 5;                   // matches Carto reference

/**
 * loadAnci(dir, opts?) → reader object.
 *
 * `dir` should be the directory containing `anci.yaml` and `anci.bin`
 * (typically `.carto/` of a repo, but the format does not constrain
 * location).
 */
function loadAnci(dir, opts = {}) {
  const yamlPath = path.join(dir, ANCI_YAML_FILENAME);
  const binPath = path.join(dir, ANCI_BIN_FILENAME);

  if (!fs.existsSync(yamlPath)) {
    throw new Error(`ANCI not found: ${yamlPath} does not exist`);
  }
  if (!fs.existsSync(binPath)) {
    throw new Error(`ANCI not found: ${binPath} does not exist`);
  }

  // 1. Parse the YAML header.
  let header;
  try {
    header = yaml.parse(fs.readFileSync(yamlPath, 'utf-8'));
  } catch (err) {
    throw new Error(`ANCI header parse failed: ${err.message}`);
  }
  if (!header || !header.anci || typeof header.anci.version !== 'string') {
    throw new Error('ANCI header missing required `anci.version`');
  }

  // 2. Reject unsupported versions early.
  if (!header.anci.version.startsWith(ACCEPTED_VERSION_PREFIX)) {
    throw new Error(
      `ANCI version unsupported: got ${JSON.stringify(header.anci.version)}, ` +
      `this consumer accepts ${ACCEPTED_VERSION_PREFIX}x`
    );
  }

  // 3. Cross-check body length when the header advertises one.
  const bodyBuf = fs.readFileSync(binPath);
  if (header.anci.body && typeof header.anci.body.bytes === 'number') {
    if (bodyBuf.length !== header.anci.body.bytes) {
      // Permissive: warn but don't fail (consumers SHOULD warn but continue).
      // Suppress by default — tests can opt in via opts.warn.
      if (opts.warn) {
        opts.warn(
          `ANCI body size mismatch: header says ${header.anci.body.bytes}, ` +
          `file is ${bodyBuf.length} bytes`
        );
      }
    }
  }

  // 4. Parse the binary body.
  const body = deserializeBody(bodyBuf);
  if (!body) {
    throw new Error('ANCI body failed to parse (corrupt magic, version, or section)');
  }

  // 5. Build the reader.
  return makeReader({ header, body });
}

function makeReader({ header, body }) {
  // ── Convenience flat projections ─────────────────────────────────
  const domains = header.domains || [];
  const routes = header.routes || [];
  const models = header.models || [];
  const high_impact = header.high_impact || [];

  // domain id → name and file → domain id are in the body; build a
  // quick path → domainName map for getDomainOf().
  const fileDomainName = new Map();
  for (const [fid, did] of body.fileDomain) {
    const file = body.fileIdToPath.get(fid);
    const name = body.domainIdToName.get(did);
    if (file && name) fileDomainName.set(file, name);
  }

  function getDomainOf(file) {
    return fileDomainName.get(file) || null;
  }

  /**
   * blastRadius(file, opts?) → { file, hops, count, files: [{file, hop_distance}] }
   *
   * 5-hop BFS over `reverse`. Same semantics as Carto's
   * bitmap blastRadius. Returns null if `file` is unknown.
   */
  function blastRadius(file, opts = {}) {
    const fid = body.pathToFileId.get(file);
    if (fid === undefined) return null;

    const maxHops = Math.min(MAX_BFS_HOPS, opts.maxHops || MAX_BFS_HOPS);
    const visited = new Bitset(body.size);
    const frontier = new Bitset(body.size);
    const next = new Bitset(body.size);

    const direct = body.reverse.get(fid);
    if (!direct) return { file, hops: 0, count: 0, files: [] };

    frontier.copyFrom(direct);
    visited.orInPlace(frontier);
    const hopOf = new Map();
    for (let h = 1; h <= maxHops; h++) {
      const fwords = frontier.words;
      next.setAll(0);
      for (let w = 0; w < fwords.length; w++) {
        let v = fwords[w];
        while (v) {
          const bit = v & -v;
          const dep = (w << 5) + (31 - Math.clz32(bit));
          v ^= bit;
          if (!hopOf.has(dep)) hopOf.set(dep, h);
          const deps = body.reverse.get(dep);
          if (deps) next.orInPlace(deps);
        }
      }
      next.andNotInPlace(visited);
      if (next.popcount() === 0) break;
      visited.orInPlace(next);
      frontier.copyFrom(next);
    }
    visited.clear(fid);
    hopOf.delete(fid);

    const files = [];
    for (const [dep, hop] of hopOf) {
      const p = body.fileIdToPath.get(dep);
      if (p) files.push({ file: p, hop_distance: hop });
    }
    files.sort((a, b) => a.hop_distance - b.hop_distance || a.file.localeCompare(b.file));
    return { file, hops: maxHops, count: files.length, files };
  }

  /**
   * simulateChangeImpact(files, opts?) → { count, files: [{file, hop_distance}] }
   *
   * Union of blast-radius BFSes seeded from each input file.
   * Sub-millisecond on 7K-file repos via OR-aggregation.
   */
  function simulateChangeImpact(files, opts = {}) {
    if (!Array.isArray(files) || files.length === 0) {
      return { count: 0, files: [] };
    }
    const seedIds = [];
    for (const f of files) {
      const fid = body.pathToFileId.get(f);
      if (fid !== undefined) seedIds.push(fid);
    }
    if (seedIds.length === 0) return { count: 0, files: [] };

    const maxHops = Math.min(MAX_BFS_HOPS, opts.maxHops || MAX_BFS_HOPS);
    const visited = new Bitset(body.size);
    const frontier = new Bitset(body.size);
    const next = new Bitset(body.size);
    const hopOf = new Map();

    // Seed: union of direct dependents of all input files.
    for (const fid of seedIds) {
      const deps = body.reverse.get(fid);
      if (deps) frontier.orInPlace(deps);
    }
    visited.orInPlace(frontier);
    {
      const fwords = frontier.words;
      for (let w = 0; w < fwords.length; w++) {
        let v = fwords[w];
        while (v) {
          const bit = v & -v;
          hopOf.set((w << 5) + (31 - Math.clz32(bit)), 1);
          v ^= bit;
        }
      }
    }
    for (let h = 2; h <= maxHops; h++) {
      const fwords = frontier.words;
      next.setAll(0);
      for (let w = 0; w < fwords.length; w++) {
        let v = fwords[w];
        while (v) {
          const bit = v & -v;
          const dep = (w << 5) + (31 - Math.clz32(bit));
          v ^= bit;
          const deps = body.reverse.get(dep);
          if (deps) next.orInPlace(deps);
        }
      }
      next.andNotInPlace(visited);
      if (next.popcount() === 0) break;
      // Record hop distances for newly-reached nodes.
      const nwords = next.words;
      for (let w = 0; w < nwords.length; w++) {
        let v = nwords[w];
        while (v) {
          const bit = v & -v;
          hopOf.set((w << 5) + (31 - Math.clz32(bit)), h);
          v ^= bit;
        }
      }
      visited.orInPlace(next);
      frontier.copyFrom(next);
    }

    // Drop the input set itself.
    for (const fid of seedIds) {
      visited.clear(fid);
      hopOf.delete(fid);
    }

    const result = [];
    for (const [dep, hop] of hopOf) {
      const p = body.fileIdToPath.get(dep);
      if (p) result.push({ file: p, hop_distance: hop });
    }
    result.sort((a, b) => a.hop_distance - b.hop_distance || a.file.localeCompare(b.file));
    return { count: result.length, files: result };
  }

  /**
   * getHighImpactFiles(n) → top N from popcount index, hydrated.
   * Mirrors Carto's MCP tool of the same name.
   */
  function getHighImpactFiles(n = 10) {
    const out = [];
    const limit = Math.min(n, body.popcountIndex.length);
    for (let i = 0; i < limit; i++) {
      const e = body.popcountIndex[i];
      const file = body.fileIdToPath.get(e.fileId);
      if (file) out.push({ file, transitive_dependents: e.count });
    }
    return out;
  }

  return {
    header,
    domains,
    routes,
    models,
    high_impact,
    blastRadius,
    simulateChangeImpact,
    getHighImpactFiles,
    getDomainOf,
    close() { /* no resources to release in v0.1 */ },
  };
}

module.exports = { loadAnci, ACCEPTED_VERSION_PREFIX };
