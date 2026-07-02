---
version: '0.1'
concept: auth-middleware
difficulty: moderate
reversibility: moderate
related:
  - money-as-float
---

# Mutating routes need auth

## The one-paragraph version

Any HTTP endpoint that changes server-side state — creates,
updates, deletes — must first verify who the caller is. Without
that check, anyone on the internet with your URL can hit the
endpoint. The AI writing the handler doesn't know your project's
auth story unless the check is visible in the file or in something
the file imports. This rule fires when a `POST`, `PUT`, `PATCH`, or
`DELETE` route has no auth-provider signal in the route file or
anywhere three import-hops upstream. `GET` routes are excluded on
purpose — read endpoints are risky too, but the mutating routes are
the ones where a missing check produces immediate, unauthorised
writes.

## The canonical example (Next.js + Supabase)

**Wrong** — `app/api/trades/route.ts`:

```ts
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  const body = await req.json();
  // ← anyone can call this; there is no auth check anywhere
  await db.trade.create({ data: body });
  return NextResponse.json({ ok: true });
}
```

**Right (option A — auth check inside the handler)**:

```ts
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  await db.trade.create({ data: { ...body, userId: user.id } });
  return NextResponse.json({ ok: true });
}
```

**Right (option B — project-root middleware)**:

Create `middleware.ts` at the project root (or `src/middleware.ts`):

```ts
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(req: NextRequest) {
  const supabase = createServerClient(/* … */);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/login', req.url));
  return NextResponse.next();
}

export const config = { matcher: ['/api/:path*'] };
```

The rule treats the presence of `middleware.ts` at project root as
a global auth signal — every route in the project is considered
covered.

## What the rule looks for

The rule counts any of these as a valid auth signal:

- A symbol name matching `withAuth`, `requireAuth`, `authGuard`,
  `authMiddleware`, `getServerSession`, `getAuth`, `currentUser`,
  `authorize`, `authenticate`, `verifySession`, and similar
  patterns.
- An import from a known auth provider: `@supabase/*`, `@clerk/*`,
  `next-auth`, `lucia`, `iron-session`, `jose`, `jsonwebtoken`,
  `@auth/core`, `@auth/nextjs`.
- An import whose path suggests a local auth helper:
  `@/lib/auth`, `@/lib/session`, `@/utils/auth`, `@/server/auth`,
  a relative import to `middleware`, or anything under an `auth/`
  directory.
- A `middleware.ts` or `middleware.js` at the project root.

If none of these appears in the route file OR up to three
import-hops upstream from it, the rule fires.

## Why the rule is conservative

Any single hit anywhere in the upstream import closure suppresses
the gap. The rule is designed to prefer false negatives (miss a
real missing-auth case) over false positives (yell about a route
that's already protected). If the rule fires, the citation is
real.

## Related concepts

- `money-as-float` — the other landmine you'll hit early: money
  fields declared as floating-point.
