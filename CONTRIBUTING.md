# Contributing to Carto

Carto is free, open source, and community-maintained. The core team owns the merger logic, MCP server, graph clustering, and CLI. The community owns language and framework extractors.

---

## What to contribute

### Tier 1 — Languages (safe to add, easy to review)

New language support lives in `src/extractors/languages/`. Each language is an isolated module.

Currently supported: JavaScript/TypeScript, Python, R.

Wanted: Go, Rust, Ruby, Java, PHP, C#.

### Tier 2 — Framework extractors (safe to add, easy to review)

Framework-specific route and model extraction lives in `src/extractors/`. Each framework is an isolated module.

Currently supported: FastAPI, Express, Next.js App Router, Prisma, tRPC, HTML fetch(), Plumber, Shiny.

Wanted: Django, Rails, Laravel, NestJS, Hono, Gin, Spring.

### Tier 3 — Core (review carefully before merging)

- `src/agents/merger.js` — merger logic. One bad merge = developer loses manual notes = project dies.
- `src/agents/domains.js` — graph-based domain clustering. Wrong clusters = wrong context files.
- `src/mcp/server.js` — MCP server tools. Breaking changes affect Kiro/Cursor/Claude integration.
- `src/detector/` — framework detection logic.
- `src/cli/` — CLI commands.

---

## How to add a language

1. Create `src/extractors/languages/yourlanguage.js`
2. Export a plugin object:
```js
module.exports = {
  name: 'yourlanguage',
  extensions: ['.ext'],
  extract(content, relPath) {
    return {
      routes: [{ method, path, functionName }],
      models: [{ className, fields: [{ name, type }] }],
      functions: [{ name, params, returnType }],
      envVars: ['VAR_NAME'],
      dbTables: [{ tableName, modelName }],
      fetches: [],
      storageKeys: []
    };
  }
};
```
3. The loader auto-discovers it — no changes to `loader.js` needed
4. Test on at least 3 real open-source projects
5. Open a PR with before/after AGENTS.md examples

---

## How to add a framework extractor

1. Add detection to `src/detector/framework.js`
2. Add route/model patterns to the relevant language plugin or create a new extractor in `src/extractors/`
3. Test on at least 2 real projects using that framework
4. Open a PR with before/after AGENTS.md examples

---

## How to add a domain keyword

Domain clustering lives in `src/agents/domains.js`. The `DOMAIN_MAP` array maps keywords to domain names. If your framework creates a new domain category, add it:

```js
{ keywords: ['graphql', 'resolver', 'mutation'], domain: 'GRAPHQL' },
```

---

## Ground rules

- **Never break the merger.** Manual sections in AGENTS.md are sacred. If your change could corrupt them, it needs a full merger test suite pass.
- **Wrong output is worse than no output.** If your extractor produces incorrect routes or models, AI gets confident with wrong facts. Only ship when accurate on real projects.
- **Test on unknown repos.** Don't just test on projects you wrote. Find a real open-source repo using the framework and verify the output is correct.
- **No cloud, no telemetry, no tracking.** Carto is local only. Forever. Don't add any network calls except the existing npm update check.
- **No paid features.** Free forever. MIT. Don't propose monetization.

---

## Development setup

```bash
git clone https://github.com/theanshsonkar/carto
cd carto
npm install
node src/cli/index.js init   # test in any project
node src/cli/index.js serve  # test MCP server
npm test                     # run test suite
```

---

## PR checklist

- [ ] Tested on at least 2-3 real open-source projects
- [ ] Before/after AGENTS.md included in PR description
- [ ] No changes to merger logic (unless explicitly fixing a merger bug)
- [ ] No network calls added
- [ ] `carto --version` still works
- [ ] `npm test` passes

---

## Issues

- **Bug**: Open an issue with the project type, command run, and what AGENTS.md or domain files produced vs what you expected.
- **Language request**: Open an issue titled "Language: [name]"
- **Framework request**: Open an issue titled "Framework: [name]"
- **Domain keyword**: Open an issue titled "Domain: [name]" if your codebase doesn't cluster correctly

All issues acknowledged within 24 hours.
