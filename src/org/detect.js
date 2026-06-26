'use strict';

/**
 * Seven cross-repo edge detection methods.
 *
 *   1. npm scope          — `@company/*` in package.json + import statements
 *   2. PyPI               — internal-pypi-prefix from pyproject.toml imports
 *   3. go-mod             — `go.mod` `require` blocks (private module prefix)
 *   4. Maven group ID     — `pom.xml` <groupId> prefix
 *   5. gRPC               — `.proto` files importing other `.proto` files
 *   6. OpenAPI            — `openapi.yaml` / `swagger.json` schema sharing
 *   7. Shared DB tables   — same table names across SQL migration files
 *
 * Each detector returns Array<{ edge_kind, from_file?, target, to_repo?, detail }>.
 * `to_repo` is left null when we can't resolve the producer repo from the
 * target alone; the org-sync step does a second pass to fill it in
 * (target → repo lookup via npm name, pypi name, and so on).
 */

const fs = require('fs');
const path = require('path');

const CODE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py']);

/**
 * scanRepo({ repoRoot, scopes }) → Array<edge>
 *
 * `scopes` is the runtime config: known internal npm scopes, pypi
 * prefixes, go module prefixes, maven group prefixes. The detector
 * filters to edges that match those scopes.
 *
 *   scopes = {
 *     npm: ['@mycompany'],
 *     pypi: ['mycompany-'],
 *     go: ['github.com/mycompany'],
 *     maven: ['com.mycompany'],
 *   }
 */
function scanRepo({ repoRoot, scopes = {} }) {
  if (!repoRoot) return [];
  const out = [];
  out.push(...detectNpm(repoRoot, scopes.npm || []));
  out.push(...detectPython(repoRoot, scopes.pypi || []));
  out.push(...detectGo(repoRoot, scopes.go || []));
  out.push(...detectMaven(repoRoot, scopes.maven || []));
  out.push(...detectProto(repoRoot));
  out.push(...detectOpenApi(repoRoot));
  out.push(...detectSqlMigrations(repoRoot));
  return out;
}

// ── 1. npm ────────────────────────────────────────────────────────
function detectNpm(repoRoot, scopes) {
  const out = [];
  if (scopes.length === 0) return out;

  // From package.json deps + devDeps.
  const pkgPath = path.join(repoRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      for (const name of Object.keys(all)) {
        if (scopes.some(sc => name.startsWith(sc + '/') || name === sc)) {
          out.push({ edge_kind: 'npm', from_file: 'package.json', target: name, detail: { version: all[name] } });
        }
      }
    } catch {}
  }
  // From import statements in source files (deeper than package.json).
  walkSource(repoRoot, (rel, content) => {
    const ext = path.extname(rel);
    if (!['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) return;
    // import x from '@scope/y' / require('@scope/y')
    const re = /(?:from|require)\s*\(?\s*['"]([@\w][^'"]*)['"]/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const spec = m[1];
      if (scopes.some(sc => spec === sc || spec.startsWith(sc + '/'))) {
        // Normalize target: @scope/pkg or @scope/pkg/sub → @scope/pkg
        const parts = spec.split('/');
        const target = parts[0].startsWith('@') ? `${parts[0]}/${parts[1] || ''}` : parts[0];
        out.push({ edge_kind: 'npm', from_file: rel, target });
      }
    }
  });
  return dedupe(out);
}

// ── 2. PyPI ──────────────────────────────────────────────────────
function detectPython(repoRoot, prefixes) {
  const out = [];
  if (prefixes.length === 0) return out;

  // pyproject.toml dependencies
  const pyproject = path.join(repoRoot, 'pyproject.toml');
  if (fs.existsSync(pyproject)) {
    try {
      const text = fs.readFileSync(pyproject, 'utf-8');
      // Match `name = "..."` lines under [tool.poetry.dependencies] or [project.dependencies]
      const re = /^\s*([a-zA-Z][\w\-]+)\s*=\s*["']([^"']+)["']/gm;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (prefixes.some(p => m[1].startsWith(p))) {
          out.push({ edge_kind: 'pypi', from_file: 'pyproject.toml', target: m[1], detail: { version: m[2] } });
        }
      }
    } catch {}
  }
  // Source files: from <prefix>foo import ...
  walkSource(repoRoot, (rel, content) => {
    if (!rel.endsWith('.py')) return;
    const re = /^(?:import\s+|from\s+)([A-Za-z][\w.]+)/gm;
    let m;
    while ((m = re.exec(content)) !== null) {
      const mod = m[1];
      const topLevel = mod.split('.')[0];
      if (prefixes.some(p => topLevel.startsWith(p))) {
        out.push({ edge_kind: 'pypi', from_file: rel, target: topLevel });
      }
    }
  });
  return dedupe(out);
}

// ── 3. Go ────────────────────────────────────────────────────────
function detectGo(repoRoot, prefixes) {
  const out = [];
  if (prefixes.length === 0) return out;
  const gomod = path.join(repoRoot, 'go.mod');
  if (fs.existsSync(gomod)) {
    try {
      const text = fs.readFileSync(gomod, 'utf-8');
      const block = /require\s*\(([^)]*)\)/m.exec(text);
      const lines = block ? block[1].split('\n') : text.split('\n');
      for (const line of lines) {
        const m = /^\s*([\w./\-]+)\s+(\S+)/.exec(line);
        if (m && prefixes.some(p => m[1].startsWith(p))) {
          out.push({ edge_kind: 'go-mod', from_file: 'go.mod', target: m[1], detail: { version: m[2] } });
        }
      }
    } catch {}
  }
  return dedupe(out);
}

// ── 4. Maven ─────────────────────────────────────────────────────
function detectMaven(repoRoot, prefixes) {
  const out = [];
  if (prefixes.length === 0) return out;
  const pom = path.join(repoRoot, 'pom.xml');
  if (fs.existsSync(pom)) {
    try {
      const text = fs.readFileSync(pom, 'utf-8');
      const re = /<dependency>[\s\S]*?<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>(?:\s*<version>([^<]+)<\/version>)?/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (prefixes.some(p => m[1].startsWith(p))) {
          out.push({
            edge_kind: 'maven',
            from_file: 'pom.xml',
            target: `${m[1]}:${m[2]}`,
            detail: { version: m[3] || null },
          });
        }
      }
    } catch {}
  }
  return dedupe(out);
}

// ── 5. gRPC / .proto ─────────────────────────────────────────────
function detectProto(repoRoot) {
  const out = [];
  walkSource(repoRoot, (rel, content) => {
    if (!rel.endsWith('.proto')) return;
    const re = /^\s*import\s+["']([^"']+)["']/gm;
    let m;
    while ((m = re.exec(content)) !== null) {
      out.push({ edge_kind: 'grpc', from_file: rel, target: m[1] });
    }
  });
  return dedupe(out);
}

// ── 6. OpenAPI / Swagger ────────────────────────────────────────
function detectOpenApi(repoRoot) {
  const out = [];
  walkSource(repoRoot, (rel, content) => {
    const lower = rel.toLowerCase();
    if (!/openapi\.(ya?ml|json)$|swagger\.(ya?ml|json)$/.test(lower)) return;
    // Best-effort: capture `$ref: '...'` external refs.
    const re = /\$ref\s*:\s*['"]([^'"#]+)(?:#[^'"]*)?['"]/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      if (m[1].startsWith('http') || m[1].startsWith('../')) {
        out.push({ edge_kind: 'openapi', from_file: rel, target: m[1] });
      }
    }
    // Also surface the file itself as a schema-producer (for cross-repo
    // consumption detection in the second pass).
    out.push({ edge_kind: 'openapi', from_file: rel, target: rel, detail: { kind: 'producer' } });
  });
  return dedupe(out);
}

// ── 7. Shared SQL tables ───────────────────────────────────────
function detectSqlMigrations(repoRoot) {
  const out = [];
  walkSource(repoRoot, (rel, content) => {
    const lower = rel.toLowerCase();
    if (!lower.endsWith('.sql')) return;
    if (!/migration|migrate/.test(lower)) return;
    const re = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi;
    let m;
    while ((m = re.exec(content)) !== null) {
      out.push({ edge_kind: 'db-table', from_file: rel, target: m[1] });
    }
  });
  return dedupe(out);
}

// ── helpers ────────────────────────────────────────────────────
function walkSource(repoRoot, visit) {
  const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', 'coverage', 'vendor']);
  const walk = (dir) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.proto') continue;
      if (IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const rel = path.relative(repoRoot, full).replace(/\\/g, '/');
        let content;
        try {
          const stat = fs.statSync(full);
          if (stat.size > 4 * 1024 * 1024) return; // skip huge files
          content = fs.readFileSync(full, 'utf-8');
        } catch { continue; }
        visit(rel, content);
      }
    }
  };
  walk(repoRoot);
}

function dedupe(edges) {
  const seen = new Set();
  return edges.filter(e => {
    const key = `${e.edge_kind}::${e.from_file || ''}::${e.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  scanRepo,
  detectNpm, detectPython, detectGo, detectMaven,
  detectProto, detectOpenApi, detectSqlMigrations,
};
