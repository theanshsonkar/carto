# CARTO — BRAIN
> Give this file to any new Claude session. Claude reads this = instantly knows everything.
> Last updated: May 2026
> IMPORTANT: Carto is fully free. Open source forever. MIT license. No monetization. Ever.

---

## HOW TO WORK WITH ME

```
I am the builder. You = brain. Kiro = writes code.
Don't suggest paid features. Ever.
Don't suggest cloud infrastructure with costs.
Don't over-explain basics. I know my stack.
Short sentences. No filler. Direct.
If my idea is bad, say so. Don't agree to be nice.
When I ask to build → give exact Kiro instructions.
When I ask strategy → think deeply, give direct answer.
```

---

## WHAT CARTO IS — ONE LINE

**The tool that auto-generates and auto-maintains your AGENTS.md. Your code changes. AGENTS.md updates. Every AI always knows. Free forever.**

---

## CONTEXT: AGENTS.md

OpenAI shipped AGENTS.md in August 2025. "A README for agents." A markdown file in project root that gives AI coding agents project-specific guidance.

Already read natively by: Cursor, GitHub Copilot, VS Code, Codex, Devin, Gemini CLI, Jules.

**What AGENTS.md does NOT do:**
```
→ Does NOT auto-generate itself
→ Does NOT watch your files
→ Does NOT extract routes from code
→ Does NOT update when you change code

AGENTS.md = static file. You write it. You update it. Manually.
Always slightly stale. Always behind your actual code.
```

**The gap Carto fills:**
```
AGENTS.md = the standard that won (static)
Carto     = the tool that keeps it alive (dynamic)

You don't compete with AGENTS.md.
You make AGENTS.md actually work.
```

---

## THE PROBLEM

AI tools are blind to your actual project. Every session = zero. Every tool = separate silo.

```
Daily pains:
→ AI hallucinates schema, field names, routes
→ Rebuild context every session manually
→ File changes → AI still thinks old version exists
→ 10,000 line files → Claude gets confused
→ Every AI tool = separate brain, never coordinated
→ ~1500 tokens wasted per session on setup
→ ~75 min/day lost to context overhead
```

---

## THE SOLUTION

```
Your project files change
      ↓ file watcher (chokidar)
  AST engine (tree-sitter)
      ↓ extracts real structure
  AGENTS.md auto-updated
      ↓ standard file every AI reads natively
Cursor + Codex + Claude + Copilot + Kiro
— all read same current truth
— automatically
— zero cost
```

---

## WHAT CARTO GENERATES

### AGENTS.md — primary output (lives in project root)

Auto-generates + auto-updates on every file save. In the exact format every AI tool already reads.

**What auto-generates:**
- Project folder structure
- API routes (from FastAPI decorators, Express, Django, Rails)
- Data models (Pydantic, Prisma, Mongoose, SQLAlchemy)
- Function signatures (AST extraction)
- Dependencies (package.json / requirements.txt)
- Environment variable names (never values)
- Frontend API calls (from fetch() parsing)
- Test commands + build commands

**What stays manual (developer writes directly into AGENTS.md):**
- Active bugs
- Pending decisions
- Architecture decisions + why
- Business rules AI must follow
- Things AI must never do
- Coding conventions

Manual sections = institutional memory. Carto never touches them on update. That's the switching cost moat.

### map.json — internal only

```json
{
  "models": {
    "User": ["id", "name", "email"],
    "Post": ["id", "userId", "content"]
  },
  "routes": ["GET /api/feed", "POST /api/auth/login"],
  "dependencies": { "prisma": "5.0.0" }
}
```

Used internally by Carto. Not exposed to AI directly.

---

## WHAT CARTO ACTUALLY FIXES (BE PRECISE)

Carto fixes **factual hallucination about your own project**:
- AI guessing wrong DB → fixed
- AI guessing wrong field names → fixed
- AI guessing wrong routes → fixed
- AI assuming wrong framework → fixed

**What Carto does NOT fix:**
```
→ AI reasoning badly → not fixed
→ AI giving wrong implementation logic → not fixed
→ AI misunderstanding what you want → not fixed
→ AI bad at the actual coding task → not fixed
```

**The only correct claim:**
```
Carto makes AI ACCURATE about your project.
NOT smarter. ACCURATE.
Different thing. Say this clearly in the README.
Otherwise = disappointed users.
```

---

## AST — WHY 10K LINE FILES AREN'T A PROBLEM

```
UserService.js = 10,000 lines
        ↓ tree-sitter AST
{
  functions: [
    "createUser(id, email)",
    "deleteUser(id)",
    "getFriends(userId)"
  ]
}
        ↓ written to AGENTS.md
Claude reads 8 lines. Not 10,000.
```

**Extraction levels:**
- Level 1: signatures only (default, always in AGENTS.md)
- Level 2: + return types + key calls
- Level 3: + full function body (on demand)
- Level 4: + dependency graph (architecture planning)

---

## HOW IT CONNECTS TO AI TOOLS

### Path 1: Via AGENTS.md (primary — zero setup)
```
carto init + carto watch
→ AGENTS.md generated in project root
→ Every AI tool reads it automatically
→ Zero configuration needed
```

### Path 2: Via MCP (secondary — power users)
```json
// ~/.claude/claude_desktop_config.json
{
  "mcpServers": {
    "carto": {
      "command": "carto",
      "args": ["serve"],
      "cwd": "/path/to/your/project"
    }
  }
}
```
Adds real-time context injection on top of AGENTS.md. For Claude Desktop users.

---

## THE THREE HARD ENGINEERING PROBLEMS

These are where Carto wins or fails. Everything else is easy.

### 1. Detection (second hardest)
Given a random stranger's unknown project — figure out what it is without them telling you.

```
carto init must:
→ read package.json → identify Express / Next.js / React
→ read requirements.txt → identify FastAPI / Django / Flask
→ scan folder structure → find routes/, models/, src/
→ read file extensions → determine languages
→ generate correct AGENTS.md without any user input
```

Naive detection breaks on: monorepos, mixed stacks, unconventional folder structures, generated code.

### 2. AST extraction accuracy (medium-hard)
Real codebases are messy. Decorators split across lines, dynamic routes, circular imports, generated files.

The 90% case is easy. The 10% produces wrong AGENTS.md. Wrong AGENTS.md is worse than no AGENTS.md — AI gets confident with wrong facts.

Start JS/TS + Python only. Expand by demand. Don't overextend v1.

### 3. Merger logic (hardest — most critical)

A markdown file that two parties write to simultaneously:
- Carto writes auto-generated sections on every file save
- Developer writes manual sections by hand

Carto must update auto sections without ever touching manual sections. One bad merge = developer loses their architecture notes = they never trust Carto again = project dies.

**This needs its own design doc before any code gets written.**

Core questions merger must answer:
- How does it mark where auto sections start/end?
- What happens if developer edits inside an auto section?
- What happens on conflicts?
- What if the format of an auto section changes between versions?

---

## HOW IT'S DIFFERENT FROM EVERYTHING ELSE

| Tool | What They Do | Carto Difference |
|------|-------------|-----------------|
| AGENTS.md | Standard format for AI context | Static. Manual. Carto = auto-generates it |
| Mem0 / Zep | Conversation memory | Backward looking. Carto = present reality |
| LangChain | AI workflow | They build workflows. Carto = context layer |
| Cursor Index | Codebase index for Cursor only | Cursor-locked. Carto = every AI via AGENTS.md |
| GitHub Copilot | Context in VS Code only | Single-AI silo. Carto = AI agnostic |
| Anthropic MCP | Protocol only | MCP = road. Carto = GPS on it |
| Claude Code | Files on-demand per session | Manual, session-only, Claude-only |

**The real distinction:**
- Memory tools → AI remembers past conversations
- RAG tools → AI searches documents
- **Carto → AI sees present reality**

**Unique property:** More AI tools that launch = bigger Carto's value. Every new tool = one more silo that reads the same AGENTS.md Carto generates. Carto gets stronger as AI tool competition increases.

---

## TECHNICAL STACK — ALL FREE

```
CLI runtime:    Node.js        (free, devs already have it)
AST parsing:    tree-sitter    (free, 40+ languages, battle-tested)
File watching:  chokidar       (free, used by Webpack/Vite)
MCP server:     Anthropic SDK  (free, open standard)
Output format:  AGENTS.md      (free, open standard)
Distribution:   npm + GitHub   (free)
Hosting:        none needed    (local CLI, no servers)

Total infrastructure cost: $0/month forever
```

---

## FILE STRUCTURE

```
carto/
├── src/
│   ├── ast/                     ← Core engine
│   │   ├── parser.js            → tree-sitter runner
│   │   ├── extractor.js         → pulls structure from tree
│   │   └── languages/           → js.js · python.js · go.js
│   ├── watcher/                 ← Live monitoring
│   │   ├── watch.js             → chokidar watcher
│   │   └── delta.js             → updates changed parts only
│   ├── extractors/              ← Framework-specific extractors
│   │   ├── fastapi.js           → FastAPI route + model extractor
│   │   ├── express.js           → Express route extractor
│   │   ├── django.js            → Django URL + model extractor
│   │   ├── prisma.js            → Prisma schema extractor
│   │   └── html.js              → fetch() + DOM extractor
│   ├── detector/                ← Project detection (hard problem #1)
│   │   ├── framework.js         → detects framework from package.json / requirements.txt
│   │   ├── structure.js         → finds key files from folder scan
│   │   └── language.js          → determines languages used
│   ├── agents/                  ← AGENTS.md generator (CORE)
│   │   ├── generator.js         → builds AGENTS.md from extractions
│   │   ├── formatter.js         → formats to AGENTS.md standard
│   │   ├── merger.js            → merges auto + manual sections (CRITICAL — design first)
│   │   └── validator.js         → validates AGENTS.md format
│   ├── mcp/                     ← MCP server (optional power layer)
│   │   ├── server.js            → local MCP server
│   │   ├── handlers.js          → tool call handlers
│   │   └── injector.js          → context injection per request
│   ├── security/                ← Data protection
│   │   ├── ignore.js            → .cartoignore parser
│   │   └── sanitizer.js         → strips secrets/keys/.env values
│   └── cli/                     ← Interface
│       ├── index.js             → entry point
│       ├── commands/            → init · watch · connect · status
│       └── ui.js                → terminal output
├── .cartoignore                 ← blocks secrets like .gitignore
├── CONTRIBUTING.md              ← how to add language/framework support
├── ROADMAP.md                   ← public roadmap
└── package.json

Generated in user's project:
├── AGENTS.md                    ← THE LIVING BRAIN (standard format, project root)
└── .carto/
    ├── map.json                 ← internal machine-readable map
    └── config.json              ← settings
```

---

## SECURITY

```
.cartoignore blocks by default:
→ .env files
→ *secret* files
→ *key* files
→ *password* files
→ *credential* files

Sanitizer strips from extracted code:
→ API key patterns
→ Token patterns
→ Password strings
→ Private key blocks

Carto NEVER sends code to any server.
Local only. No telemetry. No tracking.
Your code stays on your machine.
This is not just ethics — it's the only way
security-conscious devs will trust a context tool.
```

---

## RISKS

### Existential threats
| Threat | Probability | Response |
|--------|-------------|----------|
| OpenAI ships AGENTS.md auto-generator | High | Ship before them. Community moat. |
| Cursor builds native auto-generation | Medium | Cursor-only. Carto = all tools. |
| GitHub Copilot auto-generates AGENTS.md | Medium | GitHub-only. Carto = editor agnostic. |
| You burn out maintaining solo | Medium | Find maintainer by month 3, not month 6 |

### Technical risks
| Risk | Mitigation |
|------|-----------|
| Merger logic corrupts manual sections | Design merger spec before writing any code |
| AST breaks on edge cases | Start JS/TS only. Never overextend v1. |
| Detection fails on unusual project structures | Fallback: prompt user for framework on init |
| Watcher misses events | Fallback rescan every 60s |
| Secrets leak into AGENTS.md | .cartoignore + sanitizer on by default, not opt-in |

### Time window
```
Window = 6-12 months
OpenAI saw the problem. They solved the standard.
They will build the auto-generator next.
Ship before that.
```

---

## BUILD PLAN — SEQUENCED CORRECTLY

### Phase 0: Personal script (now — 1 day)
Before building anything generic, build for one project. Proves extraction works. Finds merger edge cases on real data.

Kiro instructions:
```
Build a Node.js script called carto.js

On run:
1. Read aws-risk-agent/app/main.py
   → extract all @app.get @app.post @app.put @app.delete routes

2. Read aws-risk-agent/app/models.py
   → extract all Pydantic class names + fields

3. Read emfirge-frontend/dashboard.html
   → extract all fetch() calls
   → extract sessionStorage references

4. Generate/update AGENTS.md in project root:
   <!-- CARTO:AUTO:START -->
   ## Project Structure (auto)
   ## API Routes (auto)
   ## Models (auto)
   ## Frontend Calls (auto)
   <!-- CARTO:AUTO:END -->
   [leave everything outside those markers untouched]

5. Watch all above files with chokidar, re-run on save.

Use chokidar, fs, regex only. No tree-sitter yet.
```

**Use it for 2 weeks on a real project before writing the generic version.**

### Phase 1: Proper CLI (Summer Week 1-2)
```
→ npm package
→ tree-sitter AST — JS/TS + Python only
→ carto init + carto watch
→ Generates valid AGENTS.md
→ Merger logic spec written first, then coded
→ .cartoignore works
→ Detection: package.json + requirements.txt + folder scan
```

### Phase 2: Framework extractors (Summer Week 3-4)
```
→ FastAPI extractor (routes + Pydantic models)
→ Express extractor (routes)
→ Prisma extractor (schema)
→ HTML fetch() extractor
→ Each as isolated module (community adds more)
```

### Phase 3: Polish + MCP (Summer Week 5-6)
```
→ MCP server (optional power layer)
→ All edge cases fixed
→ CONTRIBUTING.md written
→ README with before/after demo
→ 60-second video recorded (non-negotiable for launch)
→ npm publish
→ GitHub public (MIT)
```

### Phase 4: Launch (Summer Week 7)
```
→ Hacker News Show HN — Tuesday 9am EST only
  "Show HN: Carto — keeps your AGENTS.md always current automatically"
→ Product Hunt
→ Dev Twitter thread
→ Respond to everything within 24hrs
```

### Phase 5: Community (Month 2+)
```
→ Label every issue within 24hrs (acknowledgment, not fix)
→ Merge framework/language PRs within 48hrs
→ Find regular contributor by month 2
→ Give maintainer access by month 3
→ You own core + merger logic. Community owns extractors.
```

---

## LAUNCH STRATEGY

Three things that actually work:

**1. Hacker News Show HN**
Tuesday-Thursday 9am EST only. Front page = 50K-200K views in 24 hours.

**2. 60-second demo video (non-negotiable)**
```
Before (30 sec):
"Claude, add auth to my app"
→ Claude generates for wrong framework, wrong fields. Useless.

After Carto (30 sec):
"Claude, add auth"
→ Claude reads AGENTS.md
→ Correct stack, correct fields. Works first time.
```
Text doesn't go viral. Demos do.

**3. One right person**
Senior dev with audience who complained about re-explaining project context to AI. One tweet from them = 500 stars.

---

## WHERE CARTO GENUINELY HELPS

| Situation | Value | Why |
|-----------|-------|-----|
| Solo dev using 3+ AI tools | High | Exact daily pain solved |
| Freelancer switching between projects | High | Context rebuild eliminated |
| Small team, AI-native | High | Shared AGENTS.md = coordination |
| Developing world devs (limited token budget) | High | Token waste eliminated |
| Legacy code with no documentation | Medium | AI can navigate structure |
| Solo dev using Claude Code only | Low | Claude Code already reads files on demand |
| Non-developer AI users | None | Not for them |
| Empty new project | None | Nothing to extract yet |

---

## CONTRIBUTION STRUCTURE

```
.github/
├── ISSUE_TEMPLATE/
│   ├── bug_report.md
│   ├── language_request.md    ← most common issue type
│   └── framework_request.md
└── PULL_REQUEST_TEMPLATE.md
CONTRIBUTING.md
ROADMAP.md
```

**Contribution tiers:**
```
Tier 1 (community):
→ languages/ruby.js · rust.js · java.js · go.js
→ Each = isolated, safe to merge

Tier 2 (community):
→ frameworks/django.js · rails.js · nextjs.js · laravel.js

Tier 3 (you review carefully):
→ Core AST engine
→ Merger logic
→ MCP protocol
→ Detection logic
```

---

## SCORECARD

| Dimension | Score | Notes |
|-----------|-------|-------|
| Problem clarity | 10/10 | Daily pain, every AI developer |
| Market timing | 10/10 | AGENTS.md won = need auto-gen NOW |
| Technical feasibility | 7/10 | tree-sitter exists. Solved tech. |
| Distribution solved | 10/10 | Every tool reads AGENTS.md already |
| Originality | 7/10 | AGENTS.md exists, auto-gen doesn't yet |
| Competition risk | 7/10 | OpenAI will build this. Ship fast. |
| Impact (free for all) | 10/10 | Developing world benefit especially |
| Future relevance | 10/10 | AGENTS.md standard growing |
| Overall | 9/10 | Right idea. Right time. Ship before window closes. |

---

## KEY DECISIONS — FINAL

```
✅ MIT license — open source forever
✅ Free forever — no paid tiers ever
✅ AGENTS.md as output format (not custom format)
✅ No cloud infrastructure — local only
✅ CLI first — nothing else until CLI is solid
✅ JS/TS + Python first, others by community demand
✅ No telemetry, no tracking, no servers
✅ Merger spec written before merger code
✅ Personal script first, generic version second
✅ Demo video before launch, not after
✅ Hacker News launch on a Tuesday 9am EST
✅ Respond to every issue within 24 hours
```

---

## THE MISSION

```
HTTP was free. The internet happened.
Linux was free. Modern computing happened.
Markdown was free. Documentation changed.
AGENTS.md is free. AI context standard won.

Carto will be free.
The tool that keeps that standard alive.
Automatically. For every developer.
Regardless of budget, country, resources.

Not a startup. Not an acquisition.
Infrastructure. For everyone.
Build it this summer.
Window is shorter now.
```
