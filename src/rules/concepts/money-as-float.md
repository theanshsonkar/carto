---
version: '0.1'
concept: money-as-float
difficulty: easy
reversibility: moderate
related:
  - auth-middleware
---

# Money must not be stored as float

## The one-paragraph version

Floating-point numbers can't represent most decimal fractions
exactly. `0.1 + 0.2 !== 0.3`. Store money as `Float`, `number`, or
`double precision` and every arithmetic operation — pricing rules,
tax calculations, refund splits, currency conversion — accumulates
rounding error. At small scale it looks like a curiosity ("the
subtotal is $12.30000000000000004"). At real scale it becomes a
compliance problem: an accounting ledger that doesn't balance, a
tax filing that's off by cents, a payout batch that's short by
dollars. Fixed-point arithmetic (Decimal, or integers of minor
units) is the standard fix everywhere in the accounting ecosystem.

## The canonical example (Next.js + Supabase)

**Wrong** — `prisma/schema.prisma`:

```prisma
model Order {
  id     String @id
  amount Float           // ← precision-losing
  status String
}
```

**Right** — use `Decimal` and specify precision explicitly:

```prisma
model Order {
  id     String  @id
  amount Decimal @db.Decimal(12, 2)   // 12 total digits, 2 after decimal
  status String
}
```

If your Postgres extension set doesn't allow `Decimal`, use minor
units — an integer where `1299` means `$12.99`:

```prisma
model Order {
  id           String @id
  amount_cents Int              // always integer, always exact
  status       String
}
```

Do the display-formatting conversion (`amount_cents / 100`) once, at
the UI boundary. Never in the ledger.

## Why the rule is conservative

The rule fires only when BOTH conditions hold:

1. The field name is a money term (`price`, `amount`, `total`,
   `balance`, `fee`, `subtotal`, `tax`, `discount`, `refund`,
   `payout`, `salary`, `wage`, `revenue`, `profit`, `charge`,
   `cost`).
2. The declared type is a floating-point type (`Float`, `number`,
   `Double`, `Real`).

A field like `quantity: number` never fires — that's not money. A
field like `Decimal amount` never fires — that's already correct.
The rule is designed to have zero false positives — if it fires,
the citation is real.

## Related concepts

- `auth-middleware` — the other landmine you'll hit early: routes
  without an auth check.
