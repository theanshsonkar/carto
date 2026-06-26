'use strict';

/**
 * Validation API.
 *
 * Composes the diff parser, the bitmap engine, and the SQLite store into
 * a single `validateDiff(store, sidecar, diffText, opts)` call that
 * returns:
 *
 *   {
 *     diff:        [{path, kind, addedCount, removedCount}],   // summary
 *     blast_radius: { perFile: {file: count}, union: number },
 *     violations:  [{kind, severity, file, message, ...details}],
 *     suggestions: [{kind, file, message, ...details}],
 *     risk:        'SAFE' | 'LOW' | 'MEDIUM' | 'HIGH',
 *   }
 *
 * Performance contract: sub-15ms p99 on a 7K-file repo with a 20-line
 * diff. The bitmap engine handles every blast-radius query in
 * microseconds; the budget is for diff parsing + result aggregation.
 *
 * Persistence: `recordSideEffects` is a separate function so
 * the read-only MCP `getStore()` path stays read-only — server opens
 * a brief writer connection, calls validateDiff first (read-only), then
 * recordSideEffects, then closes. Tests can pass a writer directly as
 * `opts.writer` to inspect the rows produced.
 *
 * Risk thresholds (defaults — overridable via `opts`):
 *   - HIGH if any cross-domain violation lands in AUTH/PAYMENTS, OR any
 *     blast_radius > 50.
 *   - MEDIUM if any blast_radius > 20 OR any non-sensitive cross-domain
 *     violation.
 *   - LOW if any violation but none of the above.
 *   - SAFE if no violations AND union blast_radius < 5.
 */

const path = require('path');
const crypto = require('crypto');
const bitmapTools = require('../bitmap/tools');
const { parseDiff, extractAddedImports } = require('./diff-parser');

const SENSITIVE_DOMAINS = new Set(['AUTH', 'PAYMENTS', 'PAYMENT', 'BILLING', 'SECURITY']);

const DEFAULTS = {
  highBlastThreshold: 50,
  mediumBlastThreshold: 20,
  safeBlastThreshold: 5,
};

function severityRank(s) {
  switch (s) {
    case 'HIGH': return 3;
    case 'MEDIUM': return 2;
    case 'LOW': return 1;
    default: return 0;
  }
}

/**
 * resolveImportTarget(spec, fromFile, sidecar) → toFileId | null
 *
 * Best-effort: resolve a relative import specifier (./foo, ../bar/baz)
 * against the importing file's directory and look it up in the path
 * map. Returns null for bare module names or unresolved paths — same
 * heuristic as `extractors/imports.js` uses (we don't need full
 * resolution here; bare modules are external and never trigger
 * cross-domain).
 */
function resolveImportTarget(spec, fromFile, sidecar) {
  if (!spec || typeof spec !== 'string') return null;
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  const dir = path.posix.dirname(fromFile);
  let resolved = path.posix.normalize(path.posix.join(dir, spec));
  if (resolved.startsWith('./')) resolved = resolved.slice(2);
  if (sidecar.pathToFileId.has(resolved)) return sidecar.pathToFileId.get(resolved);
  // Try common extension fallbacks.
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']) {
    const candidate = resolved + ext;
    if (sidecar.pathToFileId.has(candidate)) return sidecar.pathToFileId.get(candidate);
    const indexCandidate = resolved + '/index' + ext;
    if (sidecar.pathToFileId.has(indexCandidate)) return sidecar.pathToFileId.get(indexCandidate);
  }
  return null;
}

/**
 * validateDiff(store, sidecar, diffText, opts) → result
 *
 * Pure read function — does NOT write to the store. Side-effect
 * persistence is handled by `recordSideEffects` (separate call so the
 * read-only MCP store stays read-only).
 */
function validateDiff(store, sidecar, diffText, opts = {}) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const parsedFiles = parseDiff(diffText);

  const result = {
    diff: parsedFiles.map((f) => ({
      path: f.path,
      kind: f.kind,
      addedCount: f.added.length,
      removedCount: f.removed.length,
      oldPath: f.oldPath || null,
    })),
    blast_radius: { perFile: {}, union: 0 },
    violations: [],
    suggestions: [],
    risk: 'SAFE',
  };

  if (parsedFiles.length === 0) return result;

  // Pre-compute blast radius per touched file (skip pure adds — they
  // can't have dependents yet) and the union via simulate_change_impact.
  const seedPaths = [];
  for (const f of parsedFiles) {
    if (!sidecar) continue;
    if (f.kind === 'add') {
      result.blast_radius.perFile[f.path] = 0;
      continue;
    }
    const deps = bitmapTools.blastRadius(sidecar, f.path);
    if (deps === null) {
      // File not in index — likely new (rename target) or path mismatch.
      result.blast_radius.perFile[f.path] = 0;
      continue;
    }
    result.blast_radius.perFile[f.path] = deps.length;
    if (sidecar.pathToFileId.has(f.path)) seedPaths.push(f.path);
  }

  if (sidecar && seedPaths.length > 0) {
    const sim = bitmapTools.simulateChangeImpact(sidecar, seedPaths);
    result.blast_radius.union = sim.count;
  }

  // Domain lookup helper.
  const getDomain = (file) => {
    if (!sidecar) return null;
    const fid = sidecar.pathToFileId.get(file);
    if (fid === undefined) return null;
    const did = sidecar.fileDomainArr ? sidecar.fileDomainArr[fid] : -1;
    if (did < 0) return null;
    return sidecar.domainNameArr ? sidecar.domainNameArr[did] : null;
  };

  // Index existing imports per file id so we don't re-flag pre-existing
  // cross-domain edges. The store is the source of truth here — bitmap
  // doesn't track edge existence per (from,to), only the bitsets.
  const importExistsCache = new Map();
  const getExistingImportTargets = (fromFileId) => {
    if (importExistsCache.has(fromFileId)) return importExistsCache.get(fromFileId);
    let set;
    try {
      const rows = store.db
        .prepare('SELECT to_file_id FROM imports WHERE from_file_id = ? AND to_file_id IS NOT NULL')
        .all(fromFileId);
      set = new Set(rows.map((r) => r.to_file_id));
    } catch {
      set = new Set();
    }
    importExistsCache.set(fromFileId, set);
    return set;
  };

  for (const f of parsedFiles) {
    if (f.kind === 'delete') continue;
    const fromDomain = getDomain(f.path);
    const fromFileId = sidecar ? sidecar.pathToFileId.get(f.path) : undefined;
    const blast = result.blast_radius.perFile[f.path] || 0;

    // ─── high_blast violation ──────────────────────────────────────
    if (blast > cfg.highBlastThreshold) {
      result.violations.push({
        kind: 'high_blast',
        severity: 'HIGH',
        file: f.path,
        message: `Modifying ${f.path} affects ${blast} transitive dependents (>${cfg.highBlastThreshold}).`,
        blast_radius: blast,
      });
    } else if (blast > cfg.mediumBlastThreshold) {
      result.violations.push({
        kind: 'high_blast',
        severity: 'MEDIUM',
        file: f.path,
        message: `Modifying ${f.path} affects ${blast} transitive dependents (>${cfg.mediumBlastThreshold}).`,
        blast_radius: blast,
      });
      // Suggestion: split files with high blast that are growing.
      if (f.added.length > 50) {
        result.suggestions.push({
          kind: 'split_file',
          file: f.path,
          message: `Consider splitting ${f.path} — ${blast} dependents and +${f.added.length} new lines suggests this file is doing too much.`,
        });
      }
    }

    // ─── cross_domain violation on added imports ───────────────────
    if (sidecar && fromDomain) {
      const specs = extractAddedImports(f);
      const existing = fromFileId !== undefined ? getExistingImportTargets(fromFileId) : new Set();
      const seenTargets = new Set();
      for (const spec of specs) {
        const toFileId = resolveImportTarget(spec, f.path, sidecar);
        if (toFileId === null) continue;
        if (existing.has(toFileId)) continue; // already connected
        if (seenTargets.has(toFileId)) continue;
        seenTargets.add(toFileId);
        const toDomain =
          sidecar.domainNameArr[sidecar.fileDomainArr[toFileId]] || null;
        if (!toDomain || toDomain === fromDomain) continue;
        const toPath = sidecar.filePathArr[toFileId];
        const sensitive = SENSITIVE_DOMAINS.has(toDomain) || SENSITIVE_DOMAINS.has(fromDomain);
        const severity = sensitive ? 'HIGH' : 'MEDIUM';
        result.violations.push({
          kind: 'cross_domain',
          severity,
          file: f.path,
          message: `New import ${f.path} → ${toPath} crosses domain ${fromDomain} → ${toDomain}.`,
          fromDomain,
          toDomain,
          toFile: toPath,
          spec,
        });
        if (sensitive) {
          result.suggestions.push({
            kind: 'add_interface',
            file: f.path,
            message: `Adding a direct dependency on ${toDomain} is high-risk. Consider routing through an interface or service module instead.`,
            toFile: toPath,
            toDomain,
          });
        }
      }
    }
  }

  // ─── risk roll-up ────────────────────────────────────────────────
  let maxSev = 0;
  for (const v of result.violations) {
    const r = severityRank(v.severity);
    if (r > maxSev) maxSev = r;
  }
  if (maxSev === 0) {
    result.risk = result.blast_radius.union < cfg.safeBlastThreshold ? 'SAFE' : 'LOW';
  } else if (maxSev === 1) {
    result.risk = 'LOW';
  } else if (maxSev === 2) {
    result.risk = 'MEDIUM';
  } else {
    result.risk = 'HIGH';
  }

  return result;
}

/**
 * recordSideEffects(writer, sessionId, diffText, result) → { decisionId, interventionIds }
 *
 * Persists one `decisions` row + one `interventions` row per violation.
 * Uses the supplied writable store. Caller is responsible for the
 * connection lifecycle. Returns the row ids for traceability/tests.
 */
function recordSideEffects(writer, sessionId, diffText, result) {
  if (!writer) return { decisionId: null, interventionIds: [] };
  const diffHash = crypto
    .createHash('sha256')
    .update(diffText || '')
    .digest('hex')
    .slice(0, 16);

  const summary = {
    diffHash,
    risk: result.risk,
    violationCount: result.violations.length,
    blastUnion: result.blast_radius.union,
    files: result.diff.map((d) => d.path),
    suggestions: result.suggestions.map((s) => ({ kind: s.kind, file: s.file })),
  };
  // Pick a representative file so `did_we_discuss_this("auth.ts")` is
  // useful; if multiple files, leave null.
  const repFile = result.diff.length === 1 ? result.diff[0].path : null;
  const decisionId = writer.recordDecision({
    sessionId,
    kind: 'validation',
    file: repFile,
    payload: summary,
  });
  const interventionIds = [];
  for (const v of result.violations) {
    const id = writer.recordIntervention({
      sessionId,
      kind: v.kind,
      file: v.file,
      severity: v.severity,
      message: v.message,
    });
    interventionIds.push(id);
  }
  return { decisionId, interventionIds };
}

module.exports = { validateDiff, recordSideEffects, SENSITIVE_DOMAINS };
