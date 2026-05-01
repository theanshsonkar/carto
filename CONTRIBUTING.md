# Contributing to Carto

Carto is free, open source, and community-maintained. The core team owns the merger logic, AST engine, and CLI. The community owns language and framework extractors.

---

## What to contribute

### Tier 1 — Languages (safe to add, easy to review)

New language support lives in `src/ast/languages/`. Each language is an isolated module.

Currently supported: JavaScript/TypeScript, Python.

Wanted: Go, Rust, Ruby, Java, PHP, C#.

### Tier 2 — Framework extractors (safe to add, easy to review)

Framework-specific route and model extraction lives in `src/extractors/`. Each framework is an isolated module.

Currently supported: FastAPI, Express, Next.js App Router, Prisma, HTML fetch().

Wanted: Django, Rails, Laravel, NestJS, Hono, Gin, Spring.

### Tier 3 — Core (review carefully before merging)

- `src/agents/merger.js` — merger logic. One bad merge = developer loses manual notes = project dies. Changes here need strong justification and full test coverage.
- `src/ast/` — AST engine. Wrong extraction = wrong AGENTS.md = AI gets confident with wrong facts. Worse than no AGENTS.md.
- `src/detector/` — framework detection logic.
- `src/cli/` — CLI commands.

---

## How to add a language

1. Create `src/ast/languages/yourlanguage.js`
2. Export a single function: `extractFromFile(filePath, fileContent)`
3. Return:
```js
{
  functions: [{ name, params, returns }],
  classes: [{ name, fields }],
  imports: [{ from, symbols }],
  exports: [{ name }]
}
```
4. Add it to `src/ast/parser.js` language map
5. Test on at least 3 real open-source projects
6. Open a PR with before/after AGENTS.md examples

---

## How to add a framework extractor

1. Create `src/extractors/yourframework.js`
2. Export:
```js
{
  detect(projectRoot, files) → boolean,
  extractRoutes(filePath, fileContent) → [{ method, path, functionName }],
  extractModels(filePath, fileContent) → [{ name, fields: [{ name, type }] }]
}
```
3. Add detection logic to `src/detector/framework.js`
4. Test on at least 2 real projects using that framework
5. Open a PR with before/after AGENTS.md examples

---

## Ground rules

- **Never break the merger.** Manual sections in AGENTS.md are sacred. If your change could corrupt them, it needs a full merger test suite pass.
- **Wrong output is worse than no output.** If your extractor produces incorrect routes or models, AI gets confident with wrong facts. Only ship when accurate on real projects.
- **Test on unknown repos.** Don't just test on projects you wrote. Find a real open-source repo using the framework and verify the output is correct.
- **No cloud, no telemetry, no tracking.** Carto is local only. Forever. Don't add any network calls.
- **No paid features.** Free forever. MIT. Don't propose monetization.

---

## Development setup

```bash
git clone https://github.com/anshsonkar/carto-ansh
cd carto-ansh
npm install
node src/cli/index.js init   # test in any project
```

---

## PR checklist

- [ ] Tested on at least 2-3 real open-source projects
- [ ] Before/after AGENTS.md included in PR description
- [ ] No changes to merger logic (unless explicitly fixing a merger bug)
- [ ] No network calls added
- [ ] `carto --version` still works
- [ ] Existing tests pass

---

## Issues

- **Bug**: Open an issue with the project type, command run, and what AGENTS.md produced vs what you expected.
- **Language request**: Open an issue titled "Language: [name]" — someone from the community will pick it up.
- **Framework request**: Open an issue titled "Framework: [name]".

All issues acknowledged within 24 hours.
