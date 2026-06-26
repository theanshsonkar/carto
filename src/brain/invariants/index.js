'use strict';

/**
 * Semantic Memory — invariant inference.
 *
 * Mines invariants from the static graph and, when available, the temporal
 * store. An invariant is a rule that holds across the codebase. Examples:
 *
 *   - "Files in DATABASE never import from PRESENTATION."
 *   - "API route handlers always export a single default function."
 *   - "Files matching `*.service.ts` are always in the same domain as
 *      their sibling `*.controller.ts`."
 *
 * Each invariant has a confidence score in [0, 1] based on matching
 * evidence over total candidates. Only invariants with confidence >= 0.85
 * are returned by default; override via `carto.config.json` →
 * `brain.invariant_threshold`.
 *
 * Read-only against the SQLite store, so it can run alongside the temporal
 * tools without locking concerns.
 */

const DEFAULT_THRESHOLD = 0.85;
const MIN_EVIDENCE = 5;          // need at least 5 samples before claiming a rule

/**
 * inferInvariants(store, opts) → Array<invariant>
 *
 * Each invariant has shape:
 *   { id, kind, scope, rule, evidence_count, contradiction_count, confidence, examples }
 *
 * kinds:
 *   - 'no_cross_domain_import' — Domain X never imports from Domain Y.
 *   - 'export_pattern'         — Files in domain X always export N symbols.
 *   - 'domain_naming'          — Files in path/* always end up in Domain Y.
 */
function inferInvariants(store, { threshold = DEFAULT_THRESHOLD, domain = null } = {}) {
  if (!store || !store.db) return [];

  const results = [];

  // ── 1. no-cross-domain-import invariants ─────────────────────────
  results.push(...mineCrossDomainInvariants(store, { threshold, domain }));

  // ── 2. export-pattern invariants (per-domain) ────────────────────
  results.push(...mineExportPatternInvariants(store, { threshold, domain }));

  // ── 3. domain-naming invariants (path-prefix → domain) ───────────
  results.push(...mineDomainNamingInvariants(store, { threshold, domain }));

  return results.filter(r => r.confidence >= threshold);
}

function mineCrossDomainInvariants(store, { threshold, domain }) {
  // For every (fromDomain, toDomain) pair, count edges.
  // If a domain pair has zero edges → invariant "from never imports to".
  // We only declare it when both domains have non-trivial size (>= 5 files).
  const rows = store.db.prepare(`
    SELECT fd.name as from_domain, td.name as to_domain, COUNT(*) as cnt
    FROM imports i
    JOIN files f1 ON i.from_file_id = f1.id
    JOIN files f2 ON i.to_file_id = f2.id
    LEFT JOIN domains fd ON f1.domain_id = fd.id
    LEFT JOIN domains td ON f2.domain_id = td.id
    WHERE i.to_file_id IS NOT NULL AND fd.name IS NOT NULL AND td.name IS NOT NULL
    GROUP BY fd.name, td.name
  `).all();

  const presentPairs = new Map();
  for (const r of rows) presentPairs.set(`${r.from_domain}|${r.to_domain}`, r.cnt);

  const domainSizes = store.db.prepare(`
    SELECT d.name, COUNT(*) as size
    FROM domains d
    JOIN files f ON f.domain_id = d.id
    GROUP BY d.name
  `).all();

  const sizeMap = new Map(domainSizes.map(r => [r.name, r.size]));
  const out = [];

  for (const [dA] of sizeMap) {
    if (domain && dA !== domain) continue;
    for (const [dB] of sizeMap) {
      if (dA === dB) continue;
      if (sizeMap.get(dA) < 5 || sizeMap.get(dB) < 5) continue;
      const key = `${dA}|${dB}`;
      if (!presentPairs.has(key)) {
        const evidence = sizeMap.get(dA);
        const confidence = 1.0;
        out.push({
          id: `cross_domain_${dA}_${dB}`,
          kind: 'no_cross_domain_import',
          scope: dA,
          rule: `Files in ${dA} never import from ${dB}.`,
          evidence_count: evidence,
          contradiction_count: 0,
          confidence,
          examples: [],
        });
      }
    }
  }
  return out;
}

function mineExportPatternInvariants(store, { threshold, domain }) {
  // For each domain, compute the distribution of file→export-count.
  // If >=85% of files in domain D export exactly K symbols, that's an invariant.
  const rows = store.db.prepare(`
    SELECT f.id as file_id, d.name as domain_name,
           (SELECT COUNT(*) FROM symbols s WHERE s.file_id = f.id AND s.exported = 1) as export_count
    FROM files f
    LEFT JOIN domains d ON f.domain_id = d.id
    WHERE d.name IS NOT NULL
  `).all();

  const buckets = new Map(); // domain → Map<export_count, file_count>
  for (const r of rows) {
    if (domain && r.domain_name !== domain) continue;
    if (!buckets.has(r.domain_name)) buckets.set(r.domain_name, new Map());
    const b = buckets.get(r.domain_name);
    b.set(r.export_count, (b.get(r.export_count) || 0) + 1);
  }

  const out = [];
  for (const [d, counts] of buckets) {
    const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
    if (total < MIN_EVIDENCE) continue;
    for (const [exportCount, fileCount] of counts) {
      const conf = fileCount / total;
      if (conf >= threshold) {
        out.push({
          id: `export_pattern_${d}_${exportCount}`,
          kind: 'export_pattern',
          scope: d,
          rule: exportCount === 0
            ? `Files in ${d} typically have no exported symbols.`
            : `Files in ${d} typically export exactly ${exportCount} symbol${exportCount === 1 ? '' : 's'}.`,
          evidence_count: fileCount,
          contradiction_count: total - fileCount,
          confidence: Math.round(conf * 100) / 100,
          examples: [],
        });
      }
    }
  }
  return out;
}

function mineDomainNamingInvariants(store, { threshold, domain }) {
  // Path-prefix → domain mapping. For every directory `D` with >= 5 files,
  // if >=85% of them share the same domain → invariant.
  const rows = store.db.prepare(`
    SELECT f.path, d.name as domain_name
    FROM files f
    LEFT JOIN domains d ON f.domain_id = d.id
    WHERE d.name IS NOT NULL
  `).all();

  const dirBuckets = new Map(); // prefix → Map<domain, count>
  for (const r of rows) {
    if (domain && r.domain_name !== domain) continue;
    const parts = r.path.split('/');
    if (parts.length < 2) continue;
    // Use first two path segments (e.g. `src/auth`) as prefix.
    const prefix = parts.slice(0, 2).join('/');
    if (!dirBuckets.has(prefix)) dirBuckets.set(prefix, new Map());
    const b = dirBuckets.get(prefix);
    b.set(r.domain_name, (b.get(r.domain_name) || 0) + 1);
  }

  const out = [];
  for (const [prefix, counts] of dirBuckets) {
    const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
    if (total < MIN_EVIDENCE) continue;
    let topDomain = null, topCount = 0;
    for (const [d, c] of counts) {
      if (c > topCount) { topDomain = d; topCount = c; }
    }
    const conf = topCount / total;
    if (conf >= threshold) {
      out.push({
        id: `naming_${prefix}_${topDomain}`,
        kind: 'domain_naming',
        scope: prefix,
        rule: `Files under ${prefix}/ belong to domain ${topDomain}.`,
        evidence_count: topCount,
        contradiction_count: total - topCount,
        confidence: Math.round(conf * 100) / 100,
        examples: [],
      });
    }
  }
  return out;
}

/**
 * getCanonicalPattern(store, { pattern_type }) → { type, examples, confidence }
 *
 * Returns the canonical example of a high-level pattern. Used by
 * `scaffold_for_intent` to find templates the AI should copy.
 */
function getCanonicalPattern(store, { pattern_type, domain = null } = {}) {
  if (!store || !store.db || !pattern_type) return null;

  if (pattern_type === 'route_handler') {
    // Find the file with the most routes that also has high blast_radius
    // — that's likely the canonical handler.
    const row = store.db.prepare(`
      SELECT f.path, f.centrality, COUNT(r.id) as route_count
      FROM files f
      JOIN routes r ON r.file_id = f.id
      ${domain ? 'JOIN domains d ON f.domain_id = d.id WHERE d.name = ?' : ''}
      GROUP BY f.id
      ORDER BY route_count DESC, f.centrality DESC
      LIMIT 1
    `).get(...(domain ? [domain] : []));
    if (!row) return null;
    return {
      type: 'route_handler',
      file: row.path,
      route_count: row.route_count,
      blast_radius: row.centrality,
      confidence: 0.9,
    };
  }

  if (pattern_type === 'model_definition') {
    const row = store.db.prepare(`
      SELECT f.path, f.centrality, COUNT(m.id) as model_count
      FROM files f
      JOIN models m ON m.file_id = f.id
      ${domain ? 'JOIN domains d ON f.domain_id = d.id WHERE d.name = ?' : ''}
      GROUP BY f.id
      ORDER BY model_count DESC
      LIMIT 1
    `).get(...(domain ? [domain] : []));
    if (!row) return null;
    return {
      type: 'model_definition',
      file: row.path,
      model_count: row.model_count,
      blast_radius: row.centrality,
      confidence: 0.85,
    };
  }

  return null;
}

module.exports = { inferInvariants, getCanonicalPattern, DEFAULT_THRESHOLD };
