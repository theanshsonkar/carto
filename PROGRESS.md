# CARTO — Build Progress
> Last updated: May 1, 2026
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

**What gets added:**
- tree-sitter AST for JS/TS (regex breaks on complex JS — tree-sitter doesn't)
- Express extractor (routes)
- Prisma extractor (schema → models)
- Next.js extractor (API routes from `/app/api/` and `/pages/api/`)
- `fetch()` extraction from `.js` / `.ts` files (not just HTML)
- Each extractor = isolated module so community can add more

---

## PHASE 3 — Plugin Architecture + JS/TS Support ✅ DONE

**Goal:** Power users get real-time context injection on top of AGENTS.md.

**What gets added:**
- Local MCP server (`carto serve`)
- Real-time context injection per Claude request
- All edge cases from Phase 2 fixed
- `CONTRIBUTING.md` written — instructions for adding language/framework support
- README with before/after demo
- 60-second demo video (non-negotiable for launch)
- `npm publish` → `carto-agents` live on npm

---

## PHASE 4 — Launch (NOT STARTED)

**Goal:** Front page of Hacker News.

**The plan:**
- Hacker News Show HN — Tuesday 9am EST only
  - Title: `"Show HN: Carto — keeps your AGENTS.md always current automatically"`
- Product Hunt same day
- 60-second demo video: wrong framework hallucination before → correct after
- Dev Twitter thread
- Respond to every comment within 24 hours

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

## THE REAL VISION — Not yet built

**What Carto was always meant to be:**

Not just AGENTS.md sync. A visual codebase graph — like Emfirge's cartography feature but for code instead of AWS infrastructure.

Every file = a node.
Every import = an edge.
Every function call = a relationship.

```
routes/users.js → controllers/user.js → models/User.js → database.js
```

Exposed two ways:
1. Visual UI in the browser (vis.js graph, like Emfirge cartography)
2. AGENTS.md text export (what we have now — the foundation)

**What we built so far = 30% of the vision.**
The extraction layer works. The graph doesn't exist yet.

**What the real Carto needs:**
- Parse import statements across all files → build dependency edges
- Build a graph (nodes = files/functions, edges = imports/calls)
- Visual browser UI to explore the graph
- AI navigates the graph to understand the codebase
- AGENTS.md becomes the text export of the graph

**Why this matters:**
AGENTS.md sync → OpenAI can copy in a week.
A visual codebase graph that AI can navigate → genuinely defensible. Much harder to copy.

**This is the next big phase after current polish.**
