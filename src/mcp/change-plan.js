'use strict';

/**
 * change-plan.js — pure module backing the `get_change_plan` MCP tool.
 *
 * Replaces the prior substring-grep implementation with a structural
 * pipeline that uses the real SQLite graph:
 *
 *   tokenize(intent) ──► tokens { content, verbs, paths }
 *                  └──► IDF over indexed corpus (basenames + symbol names)
 *                  └──► 4-tier anchor selection
 *                          A. route path/method        (searchRoutes)
 *                          B. file path tokens         (pathTokens × IDF)
 *                          C. exported symbol names    (camelTokens × IDF)
 *                          D. domain name match        (domain assignments)
 *                  └──► graph expansion
 *                          forward 1-hop imports       (getNeighbors)
 *                          backward 1-hop imports
 *                          transitive blast radius     (getBlastRadius)
 *                          cross-domain edges
 *                          conventions (same-domain peers)
 *                  └──► structured plan
 *
 * formatPlanMarkdown(plan) renders the plan with the historical section
 * headers preserved (`## Relevant Routes`, `## Files to Touch`,
 * `## Affected Domains`, `## Blast Radius`, `## Similar Patterns to Follow`)
 * plus new optional sections `## Files to Review (Callers)` and
 * `## Cross-Domain Edges` when non-empty.
 */

// ─── Tokenization ─────────────────────────────────────────────────────

// Common English/dev prose stopwords that flood matches if kept.
// Note: deliberately does NOT contain meaningful 3-char dev tokens like
// "log", "url", "csv", "jwt", "ssl", "mcp", "sql", "api", "git", "env".
// Filter those out via IDF, not by length.
const STOPWORDS = new Set([
  'the','and','for','with','from','into','that','this','your','you','have',
  'will','would','should','could','can','add','fix','make','use','using',
  'when','then','want','need','get','set','put','let','what','how',
  'why','who','where','these','those','some','also','only','just',
  'every','each','any','all','they','their','them','our','its','it','to',
  'in','on','of','as','at','is','an','be','do','if','or','no','not','but',
  'by','via','about','around','my','me','we','us','was','were','been',
  'so','such','than','too','very','more','most','less','least'
]);

const HTTP_VERBS = ['get','post','put','patch','delete','head','options'];
const VERB_RE = new RegExp(`\\b(${HTTP_VERBS.join('|')})\\b`, 'g');
const PATH_RE = /\/[a-z0-9_\-\/{}:]+/g;

// Known dev abbreviations of length 3 that participate in prefix matching
// against longer pathTokens. Length-4+ tokens always prefix-match.
// Without this allowlist, "sit" would prefix-match "sitter" in
// "tree-sitter-parser.js" and cause false-positive anchors.
const ABBREV3 = new Set([
  'sql', 'jwt', 'mcp', 'csv', 'ssl', 'api', 'env', 'orm',
  'dns', 'jpa', 'tcp', 'udp', 'xml', 'oop', 'cli', 'cdn',
  'aws', 'gcp', 'kms', 'iam', 's3', 'rpc', 'dao', 'dto'
]);

const MAX_CONTENT_TOKENS = 50;

function tokenize(intent) {
  if (!intent || typeof intent !== 'string') {
    return { content: [], verbs: [], paths: [] };
  }
  const lower = intent.toLowerCase();

  // 1. URL-path-like tokens (captured first so we can strip them
  //    before verb extraction — avoids "post" inside "/api/post"
  //    being mis-detected as the HTTP verb).
  const paths = [...new Set(lower.match(PATH_RE) || [])];
  const stripped = lower.replace(PATH_RE, ' ');

  // 2. HTTP verb detection over the path-stripped text.
  const verbMatches = stripped.match(VERB_RE) || [];
  const verbs = [...new Set(verbMatches.map(v => v.toUpperCase()))];

  // 3. Content tokens. Two sources, merged & deduped:
  //    a) the path-stripped intent split on non-alphanumerics
  //    b) the inner segments of each captured path
  //    Stopwords are dropped, length ≥ 2 is kept (so `log`, `mcp`,
  //    `sql`, `jwt`, `csv`, `api` survive — they're meaningful).
  const seen = new Set();
  const content = [];
  function pushToken(t) {
    if (!t || t.length < 2) return;
    if (STOPWORDS.has(t)) return;
    if (seen.has(t)) return;
    seen.add(t);
    content.push(t);
  }
  for (const t of stripped.split(/[^a-z0-9]+/)) {
    if (content.length >= MAX_CONTENT_TOKENS) break;
    pushToken(t);
  }
  for (const p of paths) {
    if (content.length >= MAX_CONTENT_TOKENS) break;
    for (const seg of p.split(/[^a-z0-9]+/)) {
      if (content.length >= MAX_CONTENT_TOKENS) break;
      pushToken(seg);
    }
  }

  return { content, verbs, paths };
}

// ─── Path / symbol token extraction ──────────────────────────────────

function pathTokens(filePath) {
  if (!filePath) return [];
  const lower = filePath.toLowerCase();
  // Split on path separators, dots, dashes, underscores; then split
  // each segment on camelCase boundaries (using the original-case form)
  // so e.g. "rateLimitMiddleware.ts" → rate, limit, middleware, ts.
  const segments = filePath.split(/[\/\.\-_]/);
  const out = new Set();
  for (const seg of segments) {
    if (!seg) continue;
    // Split camelCase: insert space before uppercase that follows lowercase
    const camelParts = seg.split(/(?<=[a-z0-9])(?=[A-Z])/);
    for (const p of camelParts) {
      const t = p.toLowerCase();
      if (t) out.add(t);
    }
  }
  // Also include each lowercased segment as-is so plain "store" still
  // matches even if the segment has no camel boundary.
  for (const seg of lower.split(/[\/\.\-_]/)) {
    if (seg) out.add(seg);
  }
  return [...out];
}

function camelTokens(name) {
  if (!name) return [];
  // Split on camelCase boundaries plus _ and -
  const parts = name.split(/(?<=[a-z0-9])(?=[A-Z])|[_\-]/);
  const out = new Set();
  for (const p of parts) {
    const t = p.toLowerCase();
    if (t) out.add(t);
  }
  // Also include the full lowercased name (for snake_case names that
  // matched as one segment after the split above).
  const full = name.toLowerCase();
  if (full && !/[_\-]/.test(name) && !/[a-z][A-Z]/.test(name)) out.add(full);
  return [...out];
}

// ─── IDF over indexed corpus ─────────────────────────────────────────

/**
 * Compute IDF weights over file basenames + path tokens + exported
 * symbol names. Common tokens like "src", "store", "file", "index" get
 * low weight; rare tokens like "rate", "throttle", "jwt" get high weight.
 *
 * Returns Map<token, weight>. Unknown tokens default to 1 at lookup time.
 */
function computeIdf(store) {
  const built = buildCorpusIndex(store);
  return built.idf;
}

/**
 * buildCorpusIndex(store)
 *   → { idf, files: [{ id, path, language, tokenSet }],
 *       symbols: [{ name, path, tokenSet }] }
 *
 * Memoized on the store object. On a 5K-file repo this saves ~30ms per
 * `planChange` call (without it, p95 on cal.com sat at 60ms — over the
 * spec's 50ms target). Re-indexing creates a new store instance, so
 * the cache lives only as long as the index it was built from.
 */
const CACHE_KEY = '__cartoChangePlanCache';

function buildCorpusIndex(store) {
  if (!store) return { idf: new Map(), files: [], symbols: [] };
  // Use the schema_version + last_full_sync as a coarse cache key —
  // when the index is rebuilt, last_full_sync changes, busting the cache.
  let stamp = '';
  try { stamp = (store.getMeta && store.getMeta('last_full_sync')) || ''; } catch {}

  if (store[CACHE_KEY] && store[CACHE_KEY].stamp === stamp) {
    return store[CACHE_KEY].value;
  }

  const docs = [];
  const files = [];
  let allFiles = [];
  try { allFiles = store.getAllFiles(); } catch { allFiles = []; }
  for (const f of allFiles) {
    if (!f || !f.path) continue;
    const tokens = pathTokens(f.path);
    const tokenSet = new Set(tokens);
    files.push({ id: f.id, path: f.path, language: f.language, tokens, tokenSet });
    docs.push(tokens);
  }

  const symbols = [];
  let symRows = [];
  try {
    if (store.db) {
      symRows = store.db.prepare(`
        SELECT s.name, f.path
        FROM symbols s JOIN files f ON s.file_id = f.id
        WHERE s.exported = 1
      `).all();
    }
  } catch { symRows = []; }
  for (const s of symRows) {
    if (!s || !s.name) continue;
    const tokens = camelTokens(s.name);
    symbols.push({ name: s.name, path: s.path, tokenSet: new Set(tokens) });
    docs.push(tokens);
  }

  const df = new Map();
  for (const tokens of docs) {
    for (const t of new Set(tokens)) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const N = docs.length || 1;
  const idf = new Map();
  for (const [t, n] of df) {
    idf.set(t, Math.log((N + 1) / (n + 1)) + 1);
  }

  const value = { idf, files, symbols };
  // Stash the cache on the store. Non-enumerable so it doesn't leak
  // through Object.keys / JSON.stringify if the store is serialized.
  try {
    Object.defineProperty(store, CACHE_KEY, {
      value: { stamp, value },
      writable: true, configurable: true, enumerable: false
    });
  } catch {}
  return value;
}

function idfWeight(idf, token) {
  if (!idf || !idf.has(token)) return 1;
  return idf.get(token);
}

// ─── Anchor selection ────────────────────────────────────────────────

/**
 * Build anchors from four signal sources, dedupe by file (keeping the
 * highest-scoring kind per file but recording all reasons), and return
 * up to `maxAnchors` entries sorted by score descending.
 */
function selectAnchors(store, tokens, idf, maxAnchors = 8) {
  const anchors = [];
  // Reuse the cached corpus index — saves ~30ms p95 on cal.com.
  const corpus = buildCorpusIndex(store);

  // ── Tier A — route path/method ────────────────────────────────────
  // Use searchRoutes for each detected URL-path-like token. Filter by
  // verb when one was extracted.
  const routesSeen = new Set();
  for (const p of tokens.paths) {
    let routes = [];
    try { routes = store.searchRoutes(p) || []; } catch { routes = []; }
    for (const r of routes) {
      const key = `${r.method} ${r.path} ${r.file}`;
      if (routesSeen.has(key)) continue;
      routesSeen.add(key);
      const methodOk = tokens.verbs.length === 0 || tokens.verbs.includes(r.method);
      if (!methodOk) continue;
      anchors.push({
        kind: 'route',
        value: `${r.method} ${r.path}`,
        file: r.file,
        score: 100,
        reason: `route path matches "${p}"`
      });
    }
  }

  // Also try matching each content token against route paths — catches
  // intents like "users endpoint" that don't carry a "/path".
  if (tokens.paths.length === 0 && tokens.content.length > 0) {
    for (const t of tokens.content) {
      if (t.length < 3) continue; // avoid 2-char route flooding
      let routes = [];
      try { routes = store.searchRoutes(t) || []; } catch { routes = []; }
      for (const r of routes) {
        const key = `${r.method} ${r.path} ${r.file}`;
        if (routesSeen.has(key)) continue;
        routesSeen.add(key);
        const methodOk = tokens.verbs.length === 0 || tokens.verbs.includes(r.method);
        if (!methodOk) continue;
        anchors.push({
          kind: 'route',
          value: `${r.method} ${r.path}`,
          file: r.file,
          score: 60 * idfWeight(idf, t),
          reason: `route path contains "${t}"`
        });
      }
    }
  }

  // ── Tier B — file path tokens (IDF-weighted) ──────────────────────
  for (const f of corpus.files) {
    let score = 0;
    const hits = [];
    const partialHits = [];
    for (const t of tokens.content) {
      if (f.tokenSet.has(t)) {
        score += 30 * idfWeight(idf, t);
        hits.push(t);
      } else if (t.length >= 4 || (t.length === 3 && ABBREV3.has(t))) {
        // Prefix-match fallback — e.g. "sql" ⊂ "sqlite",
        // "auth" ⊂ "authentication". Score weakly. 3-char tokens
        // must be on the dev-abbreviation allowlist to avoid noise
        // (e.g. "sit" should NOT match "sitter").
        const matched = f.tokens.find(pt => pt.length > t.length && pt.startsWith(t));
        if (matched) {
          score += 10 * idfWeight(idf, t);
          partialHits.push(`${t}~${matched}`);
        }
      }
    }
    if (score > 0) {
      const reasonParts = [];
      if (hits.length) reasonParts.push(`path tokens match: ${hits.join(', ')}`);
      if (partialHits.length) reasonParts.push(`prefix match: ${partialHits.join(', ')}`);
      anchors.push({
        kind: 'file',
        value: f.path,
        file: f.path,
        score,
        reason: reasonParts.join('; ')
      });
    }
  }

  // ── Tier C — exported symbol names (camelCase split + IDF) ────────
  for (const s of corpus.symbols) {
    let score = 0;
    const hits = [];
    for (const t of tokens.content) {
      if (s.tokenSet.has(t)) {
        score += 25 * idfWeight(idf, t);
        hits.push(t);
      }
    }
    if (score > 0) {
      anchors.push({
        kind: 'symbol',
        value: s.name,
        file: s.path,
        score,
        reason: `symbol "${s.name}" contains: ${hits.join(', ')}`
      });
    }
  }

  // ── Tier D — domain name match ────────────────────────────────────
  let domains = [];
  try { domains = store.getDomainsList() || []; } catch { domains = []; }
  for (const d of domains) {
    const dlow = (d.name || '').toLowerCase();
    if (!dlow) continue;
    const matches = tokens.content.filter(t => dlow === t || dlow.includes(t) || t.includes(dlow));
    if (matches.length === 0) continue;
    let domainData = null;
    try { domainData = store.getDomain(d.name); } catch { domainData = null; }
    if (!domainData) continue;
    for (const file of (domainData.files || []).slice(0, 3)) {
      anchors.push({
        kind: 'domain',
        value: d.name,
        file,
        score: 15,
        reason: `domain "${d.name}" matches: ${matches.join(', ')}`
      });
    }
  }

  // ── Dedupe by file: keep highest-scoring entry, accumulate reasons ─
  const byFile = new Map();
  anchors.sort((a, b) => b.score - a.score);
  for (const a of anchors) {
    const cur = byFile.get(a.file);
    if (!cur) {
      byFile.set(a.file, { ...a, reasons: [a.reason] });
    } else if (!cur.reasons.includes(a.reason)) {
      cur.reasons.push(a.reason);
    }
  }
  const out = [...byFile.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxAnchors);
  // Project a single 'reason' string for backward-compat with tests/log
  for (const a of out) {
    a.reason = a.reasons.join(' | ');
  }
  return out;
}

// ─── Graph expansion ─────────────────────────────────────────────────

function expandGraph(store, anchors, opts = {}) {
  const maxBlast = opts.maxBlast || 25;
  const maxBlastHops = opts.maxBlastHops || 5;
  const anchorFiles = anchors.map(a => a.file);
  const anchorSet = new Set(anchorFiles);

  // Forward 1-hop — files anchors import
  const forwardDeps = new Set();
  // Backward 1-hop — files that import anchors
  const backwardDeps = new Set();
  // Cross-domain edges introduced when walking the 1-hop neighborhood
  const crossDomainEdges = [];

  for (const af of anchorFiles) {
    let neighbors = { nodes: [], edges: [] };
    try { neighbors = store.getNeighbors(af, 1) || neighbors; } catch {}
    let aDomain = null;
    try { aDomain = store.getDomainForFile(af); } catch {}

    for (const e of neighbors.edges) {
      if (e.source === af && e.target !== af) forwardDeps.add(e.target);
      if (e.target === af && e.source !== af) backwardDeps.add(e.source);
    }
    // Cross-domain detection
    if (aDomain) {
      for (const n of neighbors.nodes) {
        if (n.id === af) continue;
        const nDomain = n.domain;
        if (nDomain && nDomain !== aDomain) {
          crossDomainEdges.push({
            from: af,
            to: n.id,
            fromDomain: aDomain,
            toDomain: nDomain
          });
        }
      }
    }
  }

  // Transitive blast radius — merge per-anchor results
  const blastByFile = new Map();
  for (const af of anchorFiles.slice(0, 5)) {
    let radius = [];
    try { radius = store.getBlastRadius(af, maxBlastHops) || []; } catch {}
    for (const r of radius) {
      if (anchorSet.has(r.file)) continue; // anchors aren't blast targets
      const cur = blastByFile.get(r.file);
      if (cur === undefined || r.hop_distance < cur) {
        blastByFile.set(r.file, r.hop_distance);
      }
    }
  }
  const blastRadius = [...blastByFile.entries()]
    .map(([file, hop]) => ({ file, hop }))
    .sort((a, b) => a.hop - b.hop || a.file.localeCompare(b.file))
    .slice(0, maxBlast);

  // Affected domains — anchors + 1-hop neighborhood
  const affectedDomains = new Set();
  const allInScope = new Set([...anchorFiles, ...forwardDeps, ...backwardDeps]);
  for (const af of allInScope) {
    let d = null;
    try { d = store.getDomainForFile(af); } catch {}
    if (d) affectedDomains.add(d);
  }

  // Conventions — same-domain peers with similar import/route count
  const conventions = findConventions(store, anchorFiles, [...affectedDomains]);

  // Dedupe cross-domain edges
  const cdSeen = new Set();
  const crossDomainDedup = [];
  for (const e of crossDomainEdges) {
    const k = `${e.from}->${e.to}`;
    if (cdSeen.has(k)) continue;
    cdSeen.add(k);
    crossDomainDedup.push(e);
  }

  return {
    forwardDeps: [...forwardDeps].sort(),
    backwardDeps: [...backwardDeps].sort(),
    blastRadius,
    affectedDomains: [...affectedDomains].sort(),
    crossDomainEdges: crossDomainDedup,
    conventions
  };
}

/**
 * findConventions — same-domain peer files with comparable shape.
 * Returns up to 5 files. Mirrors small bits of get_similar_patterns.
 */
function findConventions(store, anchorFiles, domains) {
  if (!store || !store.db || !anchorFiles.length || !domains.length) return [];
  const anchorSet = new Set(anchorFiles);
  const out = [];
  const seen = new Set();

  for (const domain of domains.slice(0, 3)) {
    let rows = [];
    try {
      rows = store.db.prepare(`
        SELECT f.path, f.language,
          (SELECT COUNT(*) FROM imports WHERE from_file_id = f.id) as import_count,
          (SELECT COUNT(*) FROM routes WHERE file_id = f.id) as route_count
        FROM files f
        JOIN domain_assignments da ON da.file_id = f.id
        JOIN domains d ON da.domain_id = d.id
        WHERE d.name = ?
        ORDER BY (route_count > 0) DESC, import_count DESC
        LIMIT 8
      `).all(domain);
    } catch { rows = []; }
    for (const r of rows) {
      if (anchorSet.has(r.path) || seen.has(r.path)) continue;
      seen.add(r.path);
      out.push({
        file: r.path,
        domain,
        imports: r.import_count,
        routes: r.route_count
      });
      if (out.length >= 5) return out;
    }
  }
  return out;
}

// ─── Top-level entry: planChange ─────────────────────────────────────

function planChange(store, intentRaw) {
  const intent = String(intentRaw || '').trim();
  const tokens = tokenize(intent);

  // Empty corpus / cold start — bail out cleanly
  let fileCount = 0;
  try { fileCount = store && store.getFileCount ? store.getFileCount() : 0; }
  catch { fileCount = 0; }
  if (fileCount === 0) {
    return {
      intent,
      tokens,
      anchors: [],
      filesToTouch: [],
      filesToReview: [],
      blastRadius: [],
      affectedDomains: [],
      crossDomainEdges: [],
      conventions: [],
      guidance: 'Index is empty. Run `carto sync` first.'
    };
  }

  if (tokens.content.length === 0 && tokens.paths.length === 0) {
    return {
      intent,
      tokens,
      anchors: [],
      filesToTouch: [],
      filesToReview: [],
      blastRadius: [],
      affectedDomains: [],
      crossDomainEdges: [],
      conventions: [],
      guidance: 'No searchable tokens in intent. Try a more specific phrase, or use `get_routes` / `get_domains_list` / `get_high_impact_files` to browse.'
    };
  }

  const idf = computeIdf(store);
  const anchors = selectAnchors(store, tokens, idf);

  if (anchors.length === 0) {
    return {
      intent,
      tokens,
      anchors: [],
      filesToTouch: [],
      filesToReview: [],
      blastRadius: [],
      affectedDomains: [],
      crossDomainEdges: [],
      conventions: [],
      guidance: 'No anchor matched. Try `get_routes` to browse routes, `get_domains_list` to explore domains, or `get_high_impact_files` to see central files.'
    };
  }

  const expansion = expandGraph(store, anchors);

  const filesToTouch = [
    ...new Set([
      ...anchors.map(a => a.file),
      ...expansion.forwardDeps
    ])
  ].sort();

  return {
    intent,
    tokens,
    anchors,
    filesToTouch,
    filesToReview: expansion.backwardDeps,
    blastRadius: expansion.blastRadius,
    affectedDomains: expansion.affectedDomains,
    crossDomainEdges: expansion.crossDomainEdges,
    conventions: expansion.conventions,
    guidance: null
  };
}

// ─── Markdown formatter ──────────────────────────────────────────────

function formatPlanMarkdown(plan) {
  const lines = [`# Change Plan: "${plan.intent}"\n`];

  // Empty / fallback case
  if (!plan.anchors || plan.anchors.length === 0) {
    if (plan.guidance) {
      lines.push(plan.guidance);
    } else {
      lines.push('_No matching routes or files found for this intent._');
      lines.push('Try `get_routes` to browse all routes, or `get_domains_list` to explore by domain.');
    }
    return lines.join('\n');
  }

  // ── Relevant Routes ───────────────────────────────────────────────
  const routeAnchors = plan.anchors.filter(a => a.kind === 'route');
  if (routeAnchors.length > 0) {
    lines.push('## Relevant Routes\n');
    lines.push('| Method | Path | File | Why |');
    lines.push('|--------|------|------|-----|');
    for (const a of routeAnchors.slice(0, 8)) {
      // value = "METHOD /path"
      const space = a.value.indexOf(' ');
      const method = space > 0 ? a.value.slice(0, space) : '';
      const p = space > 0 ? a.value.slice(space + 1) : a.value;
      lines.push(`| ${method} | ${p} | \`${a.file}\` | ${a.reason} |`);
    }
    lines.push('');
  }

  // Symbol anchors get their own subsection so users see WHY a file was
  // chosen even when it has no route.
  const symbolAnchors = plan.anchors.filter(a => a.kind === 'symbol');
  if (symbolAnchors.length > 0) {
    lines.push('## Relevant Symbols\n');
    lines.push('| Symbol | File | Why |');
    lines.push('|--------|------|-----|');
    for (const a of symbolAnchors.slice(0, 8)) {
      lines.push(`| \`${a.value}\` | \`${a.file}\` | ${a.reason} |`);
    }
    lines.push('');
  }

  // ── Files to Touch (anchors + forward 1-hop) ──────────────────────
  if (plan.filesToTouch && plan.filesToTouch.length > 0) {
    lines.push('## Files to Touch\n');
    const anchorFiles = new Set(plan.anchors.map(a => a.file));
    for (const f of plan.filesToTouch) {
      const tag = anchorFiles.has(f) ? ' _(anchor)_' : ' _(forward import)_';
      lines.push(`- \`${f}\`${tag}`);
    }
    lines.push('');
  }

  // ── Files to Review (Callers) — only when non-empty ───────────────
  if (plan.filesToReview && plan.filesToReview.length > 0) {
    lines.push('## Files to Review (Callers)\n');
    lines.push('_These files import an anchor — verify their behavior after the change:_\n');
    for (const f of plan.filesToReview) lines.push(`- \`${f}\``);
    lines.push('');
  }

  // ── Affected Domains ──────────────────────────────────────────────
  if (plan.affectedDomains && plan.affectedDomains.length > 0) {
    lines.push('## Affected Domains\n');
    lines.push(plan.affectedDomains.map(d => `**${d}**`).join(', '));
    lines.push('');
  }

  // ── Blast Radius ──────────────────────────────────────────────────
  if (plan.blastRadius && plan.blastRadius.length > 0) {
    lines.push('## Blast Radius (files that may break)\n');
    lines.push('| File | Hops |');
    lines.push('|------|------|');
    for (const b of plan.blastRadius) {
      lines.push(`| \`${b.file}\` | ${b.hop} |`);
    }
    lines.push('');
  }

  // ── Cross-Domain Edges — only when non-empty ──────────────────────
  if (plan.crossDomainEdges && plan.crossDomainEdges.length > 0) {
    lines.push('## Cross-Domain Edges\n');
    lines.push('_Anchors touch files across domain boundaries. Audit these carefully:_\n');
    lines.push('| From | From Domain | To | To Domain |');
    lines.push('|------|-------------|-----|----------|');
    for (const e of plan.crossDomainEdges) {
      lines.push(`| \`${e.from}\` | ${e.fromDomain} | \`${e.to}\` | ${e.toDomain} |`);
    }
    lines.push('');
  }

  // ── Similar Patterns to Follow ────────────────────────────────────
  if (plan.conventions && plan.conventions.length > 0) {
    lines.push('## Similar Patterns to Follow\n');
    lines.push('_Same-domain peers — use these as conventions:_\n');
    for (const c of plan.conventions) {
      lines.push(`- \`${c.file}\` _(${c.domain}, ${c.imports} imports, ${c.routes} routes)_`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

module.exports = {
  planChange,
  formatPlanMarkdown,
  // Exposed for unit tests
  tokenize,
  pathTokens,
  camelTokens,
  computeIdf,
  selectAnchors,
  expandGraph,
  STOPWORDS
};
