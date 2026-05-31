# Contributing to Carto

Carto is free, open source, and community-maintained. The core team owns the SQLite store, MCP server, graph clustering, and CLI. The community owns language and framework extractors.

---

## What to contribute

### Tier 1 — Languages (safe to add, easy to review)

New language support lives in `src/extractors/languages/`. Each language is an isolated module.

**Currently supported:** JavaScript/TypeScript, Python, Go, Rust, Ruby, Java, C/C++, C#, R, Prisma, HTML

**Wanted:** PHP, Swift, Kotlin, Elixir, Scala, Haskell, Zig

### Tier 2 — Framework extractors (safe to add, easy to review)

Framework-specific route and model extraction lives inside the language plugins.

**Currently supported:**
- **JS/TS**: Express, Next.js (App + Pages Router), tRPC, React Router, Drizzle, Zod, TypeScript interfaces
- **Python**: FastAPI, Flask, Pydantic, SQLAlchemy, Django (models + URLs)
- **Go**: Gin, Echo, Chi, net/http — routes, structs, import graph
- **Rust**: Actix-web, Axum, Rocket — routes, structs
- **Java**: Spring MVC/Boot, JAX-RS — routes, JPA entities, records
- **C#**: ASP.NET Core (attribute routing + minimal API), EF Core classes, records
- **Ruby**: Rails routes.rb, Sinatra, ActiveRecord models
- **Schema**: Prisma
- **Frontend**: HTML fetch()
- **R**: Plumber, Shiny, R6, S7

**Wanted:** NestJS, Hono, Fastify, Laravel, Django REST Framework, Ktor, Vapor

### Tier 3 — Core (review carefully before merging)

- `src/agents/merger.js` — merger logic. One bad merge = developer loses manual notes.
- `src/agents/leiden.js` — Leiden+CPM graph clustering. Wrong clusters = wrong domain context.
- `src/store/sqlite-store.js` — SQLite persistence layer.
- `src/mcp/server-v2.js` — MCP server tools. Breaking changes affect Kiro/Cursor/Claude.
- `src/store/sync-v2.js` — full sync pipeline.
- `src/cli/watch.js` — incremental update pipeline.
- `src/extractors/imports.js` — import resolution for all languages.

---

## How to add a language (V2 pattern — tree-sitter based)

V2 uses tree-sitter for import and symbol extraction. Babel is only used for deep JS/TS route/model extraction on API handler files.

### Step 1: Install the grammar

```bash
npm install tree-sitter-yourlanguage --save-exact
```

### Step 2: Add grammar definition to `src/extractors/tree-sitter-parser.js`

Add an entry to the `GRAMMAR_DEFS` array:

```js
{
  name: 'yourlanguage',
  extensions: ['.ext'],
  loadGrammar: () => require('tree-sitter-yourlanguage'),
  importQuery: `
    (import_statement source: (string) @src)
  `,
  symbolQuery: `
    (function_declaration name: (identifier) @name)
    (class_declaration name: (identifier) @name)
  `,
},
```

The queries use tree-sitter S-expression syntax. Run `node -e "const P = require('tree-sitter'); const L = require('tree-sitter-yourlanguage'); const p = new P(); p.setLanguage(L); console.log(p.parse('your code').rootNode.toString())"` to see the node types.

### Step 3: Create `src/extractors/languages/yourlanguage.js`

```js
'use strict';

const tsParser = require('../tree-sitter-parser');

module.exports = {
  name: 'yourlanguage',
  extensions: ['.ext'],
  extract(content, filename) {
    // Fast path: tree-sitter for imports + symbols (runs on ALL files)
    const { imports: tsImports, symbols: tsSymbols } = tsParser.isAvailable()
      ? tsParser.extractAll(content, '.ext')
      : { imports: [], symbols: [] };

    return {
      routes:      extractRoutes(content),        // framework-specific, regex
      models:      extractModels(content),        // ORM/schema models, regex
      functions:   tsSymbols
                     .filter(s => s.kind === 'function')
                     .map(s => ({ name: s.name, params: '—', returnType: '—' })),
      envVars:     extractEnvVars(content),       // env var references
      dbTables:    [],
      fetches:     [],
      storageKeys: [],
      _tsImports:  tsImports,   // raw import paths (for import graph)
      _tsSymbols:  tsSymbols,   // all symbols (for get_file_summary)
    };
  }
};

function extractRoutes(content) { return []; }
function extractModels(content) { return []; }
function extractEnvVars(content) { return []; }
```

### Step 4: Add import resolution to `src/extractors/imports.js`

If your language has resolvable local imports (not just package names), add a case in `extractImports()`:

```js
} else if (ext === '.ext') {
  return extractYourLanguageImports(content, filePath, projectRoot);
}
```

Then implement `extractYourLanguageImports()` at the bottom of the file. It should return an array of relative file paths (from project root) that actually exist on disk.

### Step 5: Add to `CODE_EXTS` in `src/store/sync-v2.js`

```js
const CODE_EXTS = new Set([
  // ... existing ...
  '.ext',
]);
```

### Step 6: Add to `detectLanguage()` in `src/store/sync-v2.js`

```js
'.ext': 'yourlanguage',
```

### Step 7: Test

```bash
# Test extraction on a real file
node -e "
const { loadLanguagePlugins, getPluginForFile } = require('./src/extractors/loader');
const plugins = loadLanguagePlugins();
const plugin = getPluginForFile(plugins, 'test.ext');
const result = plugin.extract('your code here', 'test.ext');
console.log(JSON.stringify(result, null, 2));
"

# Run correctness tests
node test/correctness.js

# Run full test suite
npm test
```

---

## How to add a framework extractor

Framework-specific extraction (routes, models) lives inside the language plugin. Add regex patterns to the relevant `extractRoutes()` or `extractModels()` function.

Example — adding Hono routes to the JS plugin:

```js
// In src/extractors/languages/javascript.js, inside extractExpressRoutes():

// Hono: app.get('/path', handler) — same pattern as Express, already covered
// Hono with chaining: app.route('/api', apiRouter) — add if needed
```

Test on at least 2 real open-source projects using the framework.

---

## How domain clustering works (V2)

Domain detection uses **Leiden+CPM graph clustering** (`src/agents/leiden.js`). Files that import each other heavily cluster together. Domain names are inferred from path tokens, with keyword hints for well-known patterns.

For non-SaaS repos, users can define custom domains in `carto.config.json`:

```json
{
  "domains": {
    "EDITOR": ["editor", "monaco", "text"],
    "PLATFORM": ["platform", "service", "registry"]
  }
}
```

The keyword seeds in `src/store/sync-v2.js` (the `keywordSeeds` object) can be extended for new domain types.

---

## Ground rules

- **Never break the merger.** Manual sections in AGENTS.md are sacred. If your change could corrupt them, it needs a full merger test suite pass.
- **Wrong output is worse than no output.** If your extractor produces incorrect routes or models, AI gets confident with wrong facts. Only ship when accurate on real projects.
- **Test on unknown repos.** Don't just test on projects you wrote. Find a real open-source repo using the framework and verify the output is correct.
- **No cloud, no telemetry, no tracking.** Carto is local only. Forever. Don't add any network calls except the existing npm update check.
- **No paid features.** Free forever. MIT. Don't propose monetization.
- **tree-sitter first.** For new languages, always use tree-sitter for imports and symbols. Only use regex for framework-specific patterns (routes, models) that tree-sitter queries can't easily express.

---

## Development setup

```bash
git clone https://github.com/theanshsonkar/carto
cd carto
npm install
node src/cli/index.js init   # test in any project
node src/cli/index.js serve  # test MCP server
npm test                     # run test suite (35 tests)
node test/correctness.js     # run correctness tests (31 tests)
node test/benchmark.js       # run benchmarks against real repos
```

---

## PR checklist

- [ ] Tested on at least 2-3 real open-source projects
- [ ] Before/after AGENTS.md or `get_architecture` output included in PR description
- [ ] Plugin uses tree-sitter for imports/symbols (not Babel or regex for the hot path)
- [ ] Plugin returns all fields including `_tsImports` and `_tsSymbols`
- [ ] Import resolution added to `src/extractors/imports.js` if language has local imports
- [ ] Extension added to `CODE_EXTS` and `detectLanguage()` in `sync-v2.js`
- [ ] No changes to merger logic (unless explicitly fixing a merger bug)
- [ ] No network calls added
- [ ] `npm test` passes (35/35)
- [ ] `node test/correctness.js` passes (31/31)

---

## Issues

- **Bug**: Open an issue with the project type, command run, and what output was produced vs expected.
- **Language request**: Open an issue titled "Language: [name]"
- **Framework request**: Open an issue titled "Framework: [name]"
- **Domain clustering issue**: Open an issue titled "Domains: [repo name]" with the repo URL and what domains were detected vs what you expected.

All issues acknowledged within 24 hours.
