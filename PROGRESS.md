# CARTO — Build Progress
> Last updated: May 3, 2026
> What's done, what's in progress, what's next.

---

## PHASE 0 — Personal Script ✅ DONE

**Goal:** Prove the core loop works on a real project before building anything generic.

**What was built:**
A single Node.js script (`carto.js`) hardcoded to the Emfirge project that:
- Reads `main.py` → extracts all FastAPI routes
- Reads `models.py` → extracts all Pydantic models with fields + types
- Reads `dashboard.html` → extracts `fetch()` calls + `sessionStorage` keys
- Scans the project root → generates a folder structure list
- Writes all of the above into `AGENTS.md` between markers
- Watches all 3 files with chokidar → re-syncs on every save

**The merger — the hardest problem — is proven correct:**
```
<!-- CARTO:AUTO:START -->
...auto-generated content...
<!-- CARTO:AUTO:END -->
```
Everything outside the markers = developer-owned. Carto never touches it.
4 cases handled: file missing, no markers, corrupted markers, valid markers.

**Tested live on Emfirge:**
- Ran all day on May 1, 2026
- Synced on every file save across multiple edit sessions
- Manual notes survived every sync — never overwritten
- Logs showed: `main.py updated → AGENTS.md synced` firing in real time

**Bugs found and fixed (carto-triple-bugfix):**
1. `@app.patch` routes were silently dropped — fixed by adding `patch` to the regex
2. `AGENTS.md` write was not atomic — fixed with write-to-`.tmp`-then-rename
3. Inline `#` comments leaked into field types — fixed with `.replace(/#.*$/, '').trim()`

**What Phase 0 proved:**
- The extraction pipeline works on messy real-world code
- The merger is safe — manual sections survive
- chokidar watcher is reliable
- Regex is sufficient for Python — no tree-sitter needed yet

**What Phase 0 cannot do:**
- Only works on one machine (hardcoded paths: `/Users/anshsonkar/emfirge/...`)
- Only watches 3 files — misses 10+ other relevant files in the project
- Cannot be installed by anyone else
- No project detection — requires manual config

---

## PHASE 1 — Proper CLI ✅ DONE

**Goal:** Anyone in the world can run `npm install -g carto-agents` and it works on their project.

**The one-liner unlock:**
```bash
cd their-project/
carto init     # detects their stack, finds their files, generates AGENTS.md
carto watch    # keeps AGENTS.md live forever
```

**What's being built:**

### Repo restructure
```
carto-ansh/
├── src/
│   ├── cli/          → index.js, init.js, watch.js, sync.js
│   ├── detector/     → framework.js, files.js
│   ├── extractors/   → routes.js, models.js, frontend.js
│   ├── agents/       → formatter.js, merger.js
│   ├── watcher/      → watch.js
│   └── security/     → ignore.js
├── carto.js          ← Phase 0 script (kept for reference)
└── package.json
```

### `carto init`
- Recursively searches for `requirements.txt`, `package.json`, `pyproject.toml`
- Detects framework: FastAPI / Django / Flask / Express / Next.js
- Discovers all relevant files to watch (up to 50 per category)
- Writes `.carto/config.json` with detected files (relative paths)
- Runs first sync → generates `AGENTS.md`

### `carto watch`
- Reads `.carto/config.json`
- Watches ALL discovered files (not just 3 hardcoded ones)
- Same merger + extractor pipeline as Phase 0

### `carto sync`
- One-shot sync, no watcher, exits after
- For CI pipelines and git hooks

### `.cartoignore`
- Default blocks: `.env`, `*secret*`, `*password*`, `*credential*`, `*.pem`, `*.key`
- User can add custom rules
- Excluded files never appear in AGENTS.md

### Frontend extractor upgrade
- `fetch(url, ...)` where `url` is a variable → shows as `[dynamic]` instead of silently dropped
- Previously: `/analyze` endpoint was invisible in AGENTS.md because it used `API_CONFIG.ENDPOINTS.ANALYZE`
- Now: honest output — `[dynamic]` tells the AI "a fetch call exists here but URL is resolved at runtime"

### What Phase 1 deliberately skips
- No tree-sitter (regex is proven, add tree-sitter when JS/TS lands in Phase 2)
- No MCP server (Phase 3)
- No Go / Ruby / Java / Rust extractors (community adds those)
- No npm publish yet (manual verification first)

---

## PHASE 2 — Framework Extractors ✅ DONE

**Goal:** Carto works accurately on the most popular stacks, not just FastAPI + plain HTML.

**What got added:**
- tree-sitter AST for JS/TS
- Express extractor (routes)
- Prisma extractor (schema → models)
- Next.js extractor (API routes from `/app/api/` and `/pages/api/`)
- `fetch()` extraction from `.js` / `.ts` files (not just HTML)
- Each extractor = isolated module so community can add more

---

## PHASE 3 — Import Graph ✅ DONE

**Goal:** AI knows not just what exists but how files connect.

**What got added:**
- `src/extractors/imports.js` — parses import statements from JS/TS and Python
- Resolves relative + package-relative paths against real filesystem
- Only includes dependencies that actually exist as files — no phantom links
- New "File Relationships (auto)" section in AGENTS.md
- Format: `routes/auth.js → controllers/auth.js, models/User.js`
- Auto-updates on file save via existing watcher — no changes needed to watch pipeline

**Verified live on Emfirge:**
- `main.py → aws_collector.py, cartography.py, database.py, drift_service.py, llm.py, models.py, rules.py, scoring.py, storage.py`
- All existing sections (routes, models, functions, env vars) untouched

**What this unlocks:**
AI navigates the codebase without you explaining structure every session. Knows which file to touch, which dependencies it affects. Works up to ~10k lines reliably.

---

## PHASE 3.6 — Bug Fixes + Smart File Selection (✅ DONE — May 2 2026)

**Bugs fixed:**
- `carto impact <file>` was analyzing wrong file on large repos — basename fallback matched wrong `route.ts` out of 40+. Fixed: if input contains `/`, only exact/suffix match, no basename fallback. Published as 1.0.13.
- Version bump no longer creates separate commit — manually edit `package.json` instead of `npm version patch`

**Smart file selection (1.0.14):**
- Old: first 50 files by score → all route files, zero models, zero utilities
- New: budget allocation — 20 route files + 10 model files + 20 most-imported utility files
- `.prisma` files now included in JS project discovery
- Cal.com stress test: imports 3 → 15, Prisma schema now picked up, no crashes on 4536 files
- Emfirge still works perfectly after change

**Cal.com stress test results (1.0.14):**
- 4536 files detected, top 50 selected by importance
- 15 import relationships (was 3)
- 18 routes extracted
- Prisma schema in file selection
- `carto impact` no longer silently matches wrong file

---

## PHASE 3.7 — Stress Test + Accuracy Fixes (✅ DONE — May 3 2026)

**Goal:** Find accuracy ceiling on real production codebases before launch.

**Cal.com stress test (5,018 files):**
- Ran full sync on Cal.com monorepo — 5,018 TS/JS files
- Found 3 critical bugs, all fixed and shipped as 1.0.15

**Bug 1 — Prisma model truncation (critical)**
- Regex `[^}]+` stopped at `}` inside `///` Zod annotation comments
- `EventType` showed 2 fields instead of 30+
- Fix: replaced regex with brace-counting parser. Field count: 2 → 27 for EventType
- Published: 1.0.15

**Bug 2 — Route budget too small for large monorepos**
- Hard cap of 20 route files missed 19/39 routes on Cal.com (46% coverage)
- Fix: dynamic budget — expands to 40 for large repos, total budget raised from 50 → 80
- Cal.com coverage: 18 routes → 34 routes (87%)
- Published: 1.0.15

**Bug 3 — Generated files polluting import graph**
- `apps.keys-schemas.generated.ts → 50 zod files` flooded File Relationships section
- Fix: skip `*.generated.ts/js` and `__generated__/**` in `buildImportGraph`
- Published: 1.0.15

**Accuracy results after fixes:**
| Dimension | Before | After |
|-----------|--------|-------|
| Prisma model fields | truncated (2/30+) | complete (100%) |
| Route coverage on Cal.com | 46% (18/39) | 87% (34/39) |
| Import graph noise | generated files everywhere | zero |
| Files tracked on Cal.com | 48 | 80 |

**Emfirge verification (post-fix):**
- Routes: 15/15 (100%)
- Import graph: exact match
- No generated files in output
- Original AGENTS.md untouched during test

**Known gaps remaining:**
- 5 routes still missed on Cal.com (budget ceiling, not a bug)
- `carto impact` shows all routes instead of only affected ones (wrong logic in impact.js)
- Frontend extraction near useless on modern TS/React (tRPC, React Query not supported)
- Django/Flask not supported

---

## PHASE 3.8 — Polish + Credibility (✅ DONE — May 3 2026)

**Test suite:**
- Added `test/test.js` — 20 tests, zero dependencies, Node built-in assert only
- 5 Python extractor tests (routes, models, @app.patch, field types, comment stripping)
- 5 Prisma extractor tests (model extraction, Zod annotation `}` bug, multiple models)
- 5 Merger tests (no markers, valid markers, content above markers, corrupted markers, empty input)
- 5 Import graph tests (resolve, no phantom links, require(), no imports, bare packages)
- All 20 pass. `npm test` works.

**Update check (1.0.16):**
- `carto watch` and `carto sync` now check npm registry on startup
- Non-blocking fire-and-forget — zero startup delay
- Prints one line to stderr if newer version exists: `[CARTO] Update available: X → Y  |  npm install -g carto-md`
- 3 second timeout, silently fails if offline
- Published: 1.0.16

**CONTRIBUTING.md fixes:**
- Wrong path `src/ast/languages/` → correct `src/extractors/languages/`
- Wrong path `src/ast/parser.js` → correct `src/extractors/loader.js`
- Wrong repo URL → correct `github.com/theanshsonkar/carto`
- Added `npm test` to PR checklist

**README update:**
- Added stress test results line: *"Stress tested on cal.com (5,018 files): 87% route coverage, 100% model field accuracy, import graph with zero phantom links."*
- New tagline: "Maps your codebase so AI stops guessing."

**npm status:** 1.0.16 live. ~1,228 weekly downloads organic (no launch yet). 6 GitHub stars.

**Distribution gap identified:**
- OpenAI subreddit post: 7k views, 3 upvotes, 1 downvote — wrong audience
- 1,228 weekly downloads with zero launch = organic word of mouth
- Right channels not hit yet: r/programming, r/webdev, HN, dev Twitter

---

## PHASE 3.5 — README + Positioning (✅ DONE — May 2 2026)

**What changed:**
- Restructured README: Problem → cal.com proof → carto impact → How it works → Commands
- Added "Make it a habit: run carto impact before touching any file" line
- Added install command at the very top (before the problem section)
- Added "Works with" language/framework table
- Removed weak "Tested on" section
- Removed redundant duplicate impact section

**Positioning locked:**
Carto is the memory layer between your codebase and every AI that touches it. Every new AI tool that launches makes Carto more valuable — not less. That's the undeniable reason to use it.

**npm status:** 1.0.10 live. ~1,228 weekly downloads organic (no launch yet).

---

## PHASE 4 — Launch (IN PROGRESS)

**Goal:** Front page of Hacker News.

**Revised story — lead with accuracy at scale, not AGENTS.md sync:**
> "AI that's actually accurate about your code. 100 lines or 1 million. No hallucinations on structure, routes, models. Free. Local. Open source."

**The plan:**
- Hacker News Show HN — Tuesday 9am EST only
  - Title: `"Show HN: Carto — your AI stops hallucinating your own codebase"`
- Product Hunt same day (need a hunter with audience)
- 60-second demo video (non-negotiable):
  - Before (30s): AI hallucinates wrong field name / wrong route on a 500-file project
  - After Carto (30s): AI gets it exactly right, first time
- Dev Twitter thread
- Respond to every comment within 24 hours

**Before launch checklist:**
- [x] README restructured around accuracy story
- [x] "Works with" language table added
- [x] npm published — `carto-md` live at 1.0.16
- [x] `carto impact` wrong file bug fixed (1.0.13)
- [x] Smart file selection — routes + models + utilities (1.0.14)
- [x] Prisma brace-counting fix (1.0.15)
- [x] Dynamic route budget — 87% coverage on Cal.com (1.0.15)
- [x] Generated files filtered from import graph (1.0.15)
- [x] 20-test suite passing
- [x] Non-blocking update check (1.0.16)
- [x] CONTRIBUTING.md fixed
- [ ] Demo video recorded ← BLOCKER
- [ ] HN post written
- [ ] Hunter identified for Product Hunt

**Known gaps to fix post-launch (prioritized):**
1. `carto impact` route filtering — shows all routes instead of only affected ones. Fix: store `sourceFile` on each route in map.json during extraction.
2. Django/Flask extractor — half of Python devs locked out
3. Git hook on `carto init` — auto-run `carto sync` on commit, zero discipline required
4. VS Code extension — get into the marketplace, zero-friction install
5. GitHub Action — `carto sync` on PRs, makes Carto infrastructure not just a CLI
6. Frontend extraction for tRPC/React Query — currently near zero on modern TS stacks
7. `carto impact` for directories — `carto impact src/api/`

---

## PHASE 5 — Community (NOT STARTED)

**Goal:** Carto survives beyond one maintainer.

**The plan:**
- Label every GitHub issue within 24hrs
- Merge framework/language PRs within 48hrs
- Find a regular contributor by month 2
- Give maintainer access by month 3
- You own: core engine, merger logic, MCP protocol
- Community owns: language extractors, framework extractors

---

## KEY DECISIONS — LOCKED

```
✅ MIT license — open source forever
✅ Free forever — no paid tiers, no monetization, ever
✅ AGENTS.md as output format (not a custom format)
✅ .carto/ as Carto's internal territory (config, map.json)
✅ No cloud infrastructure — local only, $0/month forever
✅ CLI first — nothing else until CLI is solid
✅ JS/TS + Python first, others by community demand
✅ No telemetry, no tracking, no servers
✅ Merger spec written before merger code (done in Phase 0)
✅ Personal script first, generic version second (done)
✅ Regex for Python, tree-sitter only when JS/TS lands
✅ [dynamic] for unresolvable fetch URLs — honesty over silence
✅ Demo video before launch, not after
✅ Hacker News launch on a Tuesday 9am EST
```

---

## WINDOW

OpenAI shipped the AGENTS.md standard in August 2025.
They will build the auto-generator next.
6-12 month window from then.
Ship Phase 3 before that window closes.

---

## THE REAL VISION — Post-launch (community builds this)

**The core product vision:**
AI is accurate about your codebase at any scale. 100 lines or 1 million lines. No hallucinations on structure, routes, models, field names. Saves tokens. Free forever.

**What's built = the extraction layer (nodes):**
- Routes, models, functions, fetch calls extracted correctly
- Merger proven safe — manual sections never overwritten
- Works on FastAPI, Express, Prisma, Next.js, JS/TS, Python

**What's missing = the relationship layer (edges):**
- Import graph: file A imports B, function X calls Y
- AI asks "what calls this function?" → gets exact answer, not 10,000 lines
- AGENTS.md becomes a compressed slice of the graph, not a flat dump
- Scales to 1M line codebases where flat AGENTS.md breaks down

**Why graph comes after launch, not before:**
- Current tool already solves the problem for small-medium projects
- Ship now, get real users, see if 1M line scale is actually requested
- Graph is the v2 story — "does it work on our 800k line monorepo?" → yes, here's how
- Community contributors who work on large codebases are the ones to build this

**Strategy:**
Ship the accuracy story. Demo the hallucination fix. Let the graph be the thing community asks for and builds.
