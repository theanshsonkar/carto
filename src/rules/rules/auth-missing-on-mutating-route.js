'use strict';

/**
 * auth-missing-on-mutating-route
 *
 * Every route that mutates state (POST / PUT / PATCH / DELETE) needs
 * an auth check. Missing auth on a mutating route is the canonical
 * SaaS security landmine — the AI writes a handler that looks right,
 * nothing complains, and now any anonymous request can write to your
 * database.
 *
 * The rule pulls every mutating route out of the `routes` table,
 * then does a bounded walk through the `imports` graph — up to
 * AUTH_HOP_LIMIT hops from the route's file — looking for any of:
 *
 *   1. A symbol whose name matches a known auth pattern
 *      (`withAuth`, `requireAuth`, `getServerSession`, `getAuth`,
 *      `currentUser`, `authorize`, `verifySession`, …).
 *   2. An import specifier pointing at a recognized auth provider
 *      (`@supabase/*`, `@clerk/*`, `next-auth`, `lucia`,
 *      `iron-session`, `jose`, `jsonwebtoken`) or a local
 *      auth helper path (`@/lib/auth`, `/server/auth`, `/middleware`).
 *   3. A `middleware.ts` at the project root — Next.js treats that
 *      as a global request gate, so every route is considered
 *      covered without needing an explicit import edge.
 *
 * If none of those signals shows up within the hop budget, the rule
 * fires. Any single hit anywhere in the upstream closure suppresses
 * it — that's the trade-off we want. We'd rather miss a real
 * missing-auth case (false negative) than yell at a route that's
 * already protected (false positive). The ship gate is zero-FP, not
 * full recall.
 */

const AUTH_HOP_LIMIT = 3;

// Symbol name patterns. Match against `symbols.name` (case-insensitive
// substring match on lowercased name).
const AUTH_SYMBOL_PATTERNS = [
  'withauth',
  'requireauth',
  'requiresession',
  'authguard',
  'authmiddleware',
  'ensureauth',
  'checkauth',
  'verifyauth',
  'verifytoken',
  'verifysession',
  'authorize',
  'authenticate',
  'authenticated',
  'protect',
  'getserversession',        // NextAuth / Auth.js
  'getauth',                 // Clerk
  'currentuser',             // Clerk
  'auth',                    // liberal — matches `auth()` from Clerk / Auth.js
  'sessionfromrequest',
  'usersession',
];

// Import specifier patterns. Match against `imports.to_path` — the raw
// specifier as written in the source, e.g. `@supabase/supabase-js`,
// `@/lib/auth`, `../middleware`.
const AUTH_IMPORT_PATTERNS = [
  '@supabase/auth-helpers',
  '@supabase/auth-helpers-nextjs',
  '@supabase/ssr',
  '@supabase/supabase-js',   // supabase client — always mediates auth
  '@clerk/nextjs',
  '@clerk/clerk-sdk-node',
  '@clerk/backend',
  'clerk',
  'next-auth',
  'nextauth',
  '@auth/core',
  '@auth/nextjs',
  'lucia-auth',
  'lucia',
  'iron-session',
  'jose',                     // JWT verification
  'jsonwebtoken',             // JWT verification
  '/middleware',              // relative import of a middleware file
  '/lib/auth',
  '/lib/session',
  '/utils/auth',
  '/utils/session',
  '/server/auth',
  '/auth/',
];

// File-path patterns for routes that live under a Next.js-style
// project-root middleware. If Carto sees a `middleware.ts` at project
// root, every route file transitively "inherits" the middleware —
// treat it as an auth-signal without needing an import edge.
const AUTH_ROOT_MIDDLEWARE_PATHS = [
  'middleware.ts',
  'middleware.js',
  'src/middleware.ts',
  'src/middleware.js',
];

function lower(s) {
  return typeof s === 'string' ? s.toLowerCase() : '';
}

function symbolIsAuthSignal(name) {
  const n = lower(name);
  if (!n) return false;
  for (const pat of AUTH_SYMBOL_PATTERNS) {
    if (n.includes(pat)) return true;
  }
  return false;
}

function importIsAuthSignal(spec) {
  const s = lower(spec);
  if (!s) return false;
  for (const pat of AUTH_IMPORT_PATTERNS) {
    if (s.includes(pat)) return true;
  }
  return false;
}

function rootMiddlewareExists(store) {
  try {
    const stmt = store.db.prepare('SELECT 1 FROM files WHERE path = ? LIMIT 1');
    for (const p of AUTH_ROOT_MIDDLEWARE_PATHS) {
      if (stmt.get(p)) return true;
    }
  } catch { /* fall through */ }
  return false;
}

/**
 * fileHasAuthSignal(store, fileId) → boolean
 *
 * A file "has an auth signal" if any of its symbols match a name
 * pattern, OR any of its imports (regardless of resolution) target a
 * known auth-provider specifier.
 */
function fileHasAuthSignal(store, fileId) {
  try {
    const symRows = store.db
      .prepare('SELECT name FROM symbols WHERE file_id = ?')
      .all(fileId);
    for (const r of symRows) {
      if (symbolIsAuthSignal(r.name)) return true;
    }
  } catch { /* keep going */ }

  try {
    const impRows = store.db
      .prepare('SELECT to_path FROM imports WHERE from_file_id = ?')
      .all(fileId);
    for (const r of impRows) {
      if (importIsAuthSignal(r.to_path)) return true;
    }
  } catch { /* keep going */ }

  return false;
}

/**
 * upstreamHasAuthSignal(store, startFileId, maxHops) → boolean
 *
 * BFS over the `imports` graph starting at the route file, up to
 * `maxHops` levels. "Upstream" here means "files this file imports"
 * — auth middleware is typically imported INTO the handler, so we
 * walk the outgoing edges.
 *
 * Bounded and dedup-guarded. Returns as soon as any signal is found.
 */
function upstreamHasAuthSignal(store, startFileId, maxHops) {
  if (!startFileId) return false;

  const visited = new Set([startFileId]);
  let frontier = [startFileId];

  for (let hop = 0; hop <= maxHops; hop++) {
    for (const fid of frontier) {
      if (fileHasAuthSignal(store, fid)) return true;
    }
    if (hop === maxHops) break;
    const next = [];
    let rows = [];
    try {
      const placeholders = frontier.map(() => '?').join(',');
      rows = store.db
        .prepare(
          `SELECT DISTINCT to_file_id FROM imports
           WHERE from_file_id IN (${placeholders})
             AND to_file_id IS NOT NULL`
        )
        .all(...frontier);
    } catch { rows = []; }
    for (const r of rows) {
      if (r.to_file_id && !visited.has(r.to_file_id)) {
        visited.add(r.to_file_id);
        next.push(r.to_file_id);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return false;
}

module.exports = {
  id: 'auth-missing-on-mutating-route',
  severity: 'HIGH',
  reversibility: 'moderate',
  concept: 'auth-middleware',
  description: 'A POST/PUT/PATCH/DELETE route has no auth-middleware signal in the file or up to 3 hops upstream through imports.',

  appliesWhen(intent) {
    return intent && intent.product_type === 'saas-with-auth';
  },

  run({ store }) {
    if (!store) return [];

    // Project-root middleware is a global auth signal — if it exists,
    // no route in the project should fire this rule. This is the
    // Next.js "matcher-less middleware.ts" case where the middleware
    // gates every request via the framework, not via imports.
    if (rootMiddlewareExists(store)) return [];

    let routes = [];
    try {
      routes = store.db
        .prepare(
          `SELECT r.method, r.path AS route_path, r.handler_name,
                  f.id AS file_id, f.path AS file
           FROM routes r JOIN files f ON r.file_id = f.id
           WHERE r.method IN ('POST', 'PUT', 'PATCH', 'DELETE')`
        )
        .all();
    } catch {
      return [];
    }

    const gaps = [];
    for (const route of routes) {
      if (!route.file_id) continue;
      if (upstreamHasAuthSignal(store, route.file_id, AUTH_HOP_LIMIT)) continue;
      gaps.push({
        file: route.file,
        line: null,
        evidence: `${route.method} ${route.route_path} in ${route.file} — no auth-middleware symbol or auth-provider import found in this file or ${AUTH_HOP_LIMIT} hops upstream.`,
      });
    }
    return gaps;
  },
};
