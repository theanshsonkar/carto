# Guide: Adding a feature safely

> The workflow Carto makes possible. Add a feature without breaking five other files you didn't know existed.

## The before-Carto pattern

You're asked to *"add rate limiting to /api/users"*. You ask Cursor. Cursor:

1. Greps for `users` — finds 47 matches across 12 files
2. Picks the first one that looks like a route handler
3. Adds rate-limiting middleware to it
4. Confidently announces success

What got missed:

- The middleware was already declared in `src/auth/middleware.ts` — now you have two copies
- The route handler is one of three for `/api/users` (GET, POST, PATCH) — the AI updated GET only
- Three callers in tests still pass requests through the un-rate-limited path

You merge it. CI passes (tests didn't cover the new middleware). It ships. The next time someone hits POST /api/users from production they're not rate-limited and the AbusePrevention engineer wakes up at 2 AM.

## The with-Carto pattern

Same task. Open your AI tool — which is now wired to carto MCP — and ask the same question.

The AI calls `get_change_plan("add rate limiting to /api/users")`. Carto's response:

```
## Plan: add rate limiting to /api/users

### Relevant routes
- POST /api/users   src/api/users.ts:42   (no rate limit)
- GET  /api/users   src/api/users.ts:18   (no rate limit)
- PATCH /api/users  src/api/users.ts:67   (no rate limit)

### Files to touch
- src/api/users.ts        — primary (modify 3 route handlers)
- src/auth/middleware.ts  — rate-limit middleware already exists here, reuse it

### Similar patterns
- src/api/posts.ts        — already uses rateLimit() middleware (12 callers)
- src/api/billing.ts      — already uses rateLimit() middleware (4 callers)

### Blast radius
- src/api/users.ts has 8 direct dependents
- src/auth/middleware.ts has 23 transitive dependents — changes here
  ripple wide; do not modify the middleware signature

### Cross-domain check
- No new cross-domain edges introduced by reusing existing middleware
```

The AI now has every fact it needs. It writes the change correctly the first time.

## The literal step-by-step

```bash
# 1. Ask carto first
carto explain "add rate limiting to /api/users"
# (or do this implicitly via your AI tool — same call under the hood)

# 2. Read the existing pattern
carto why src/api/posts.ts        # see how rate limiting is already used

# 3. Make the change in your AI tool
#    (the AI references the plan from step 1)

# 4. Before committing, validate
git diff | carto validate --fail-on HIGH
# Exits 2 if the diff would be HIGH-risk → blocks the commit

# 5. Final check
carto diff
# Markdown impact report against HEAD
```

If you're using the [GitHub Action](./ci-integration.md), step 4 happens automatically on the PR. The local `carto validate` step is for catching issues earlier.

## What "safely" actually means

Three signals Carto surfaces that you wouldn't see otherwise:

1. **The right files.** `get_change_plan` ranks files by relevance to intent (IDF token scoring + route anchoring + graph expansion). The model's hit rate jumps from "pick the most plausible from 47 grep hits" to "use the 2–3 files Carto identified".

2. **Existing patterns.** `get_similar_patterns` finds files that already solve the same shape of problem in your codebase. The model copies your conventions instead of inventing new ones.

3. **The boundary it's about to cross.** If reusing the middleware works, no new cross-domain edge. If the AI tries to import auth utilities into the payments domain, `validate_diff` catches it before save.

## When to override

Carto's heuristics are statistical. Sometimes the right answer involves crossing a domain boundary, or modifying a high-blast-radius file. Don't refuse — *acknowledge*.

The MCP `did_we_discuss_this("auth-to-payments coupling")` tool lets the AI check whether the decision has already been made. If yes, it proceeds with cited context. If no, it asks you, then records the decision so future sessions don't re-litigate.

This is the episodic-memory layer in action: not a gate, but a continuity.

## Related

- [`docs/concepts/blast-radius.md`](../concepts/blast-radius.md)
- [`docs/concepts/domains.md`](../concepts/domains.md) (the cross-domain check)
- [`docs/guides/pre-merge-review.md`](./pre-merge-review.md) (the CI-gated version)
