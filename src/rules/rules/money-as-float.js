'use strict';

/**
 * money-as-float
 *
 * Money fields (`price`, `amount`, `total`, `balance`, `fee`, ...)
 * should never be stored in a floating-point type. Floats lose
 * precision at scale — a checkout total that ends in
 * `0.30000000000000004` is the friendly version; the ugly version is
 * an accounting ledger that doesn't balance. Use fixed-point instead:
 * Prisma's `Decimal`, Postgres `numeric(12,2)`, or minor-units integers.
 *
 * This rule reads the `models` table (specifically the `fields_json`
 * blob) and fires per bad field — one gap per (model, field) pair,
 * not one per model. `line` is left null; the extractor doesn't
 * currently record per-field line numbers and we don't fabricate one.
 *
 * The rule stays conservative so we don't burn trust:
 *   - Only Prisma / Zod / TS-interface / Pydantic / Drizzle /
 *     SQLAlchemy models. Generic Go/Rust structs stay silent —
 *     `float64 Balance` in a physics sim is a legitimate use.
 *   - Both predicates must hold: a money-shaped field name AND a
 *     floating-point type. `amount_cents Int` never fires.
 *   - `Decimal` and `numeric(...)` types are treated as safe.
 *   - Names match as whole tokens, never as substrings — `sprinkler`
 *     doesn't collide with `price`.
 */

// Money field names → matched as whole-word tokens.
// Keep this list conservative. Adding a name here means every
// Float/Number model field with that name will fire — false positives
// destroy trust permanently, so err on the side of missing a case.
const MONEY_TOKENS = new Set([
  'price',
  'amount',
  'total',
  'subtotal',
  'balance',
  'fee',
  'cost',
  'tax',
  'discount',
  'refund',
  'payout',
  'salary',
  'wage',
  'revenue',
  'profit',
  'charge',
]);

// Field kinds this rule looks at. Skipping unrestricted struct kinds
// keeps FP rate at zero for repos that mix domain code with numeric
// / scientific work.
const APPLICABLE_KINDS = new Set([
  'prisma',
  'zod',
  'typescript',
  'ts-interface',
  'pydantic',
  'drizzle',
  'sqlalchemy',
]);

// Floating-point-ish types across the model kinds we look at.
// Match is case-insensitive and takes whichever cleaned type token
// appears first in the field's declared type.
const FLOAT_TYPES = new Set([
  'float',
  'double',
  'number',
  'real',
  'floating',
  // Prisma-specific:
  'float32',
  'float64',
]);

function tokenize(name) {
  if (!name || typeof name !== 'string') return [];
  // Split camelCase, snake_case, kebab-case → lowercase tokens.
  return name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function looksLikeMoney(fieldName) {
  const tokens = tokenize(fieldName);
  for (const t of tokens) {
    if (MONEY_TOKENS.has(t)) return t;
  }
  return null;
}

function cleanType(raw) {
  if (!raw || typeof raw !== 'string') return '';
  // Strip Prisma modifiers: `Float?`, `Float[]`, `Decimal(10, 2)`
  // Strip TS generics/unions: `number | null`
  const first = raw.trim().split(/[\s|<[\(]/)[0];
  return first.replace(/[?!]$/, '').toLowerCase();
}

function isFloating(rawType) {
  return FLOAT_TYPES.has(cleanType(rawType));
}

function parseFieldsJson(row) {
  if (!row || !row.fields_json) return [];
  try {
    const arr = JSON.parse(row.fields_json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

module.exports = {
  id: 'money-as-float',
  severity: 'HIGH',
  reversibility: 'moderate',
  concept: 'money-as-float',
  description: 'A model field whose name means money is declared as a floating-point type. Money must use fixed-point (Decimal / minor-units BigInt).',

  appliesWhen(intent) {
    return intent && intent.product_type === 'saas-with-auth';
  },

  run({ store }) {
    if (!store) return [];
    let rows = [];
    try {
      rows = store.db
        .prepare(
          `SELECT m.name AS model_name, m.kind AS model_kind, m.fields_json,
                  f.path AS file
           FROM models m JOIN files f ON m.file_id = f.id`
        )
        .all();
    } catch {
      return [];
    }

    const gaps = [];
    for (const row of rows) {
      const kind = (row.model_kind || '').toLowerCase();
      if (!APPLICABLE_KINDS.has(kind)) continue;

      const fields = parseFieldsJson(row);
      for (const field of fields) {
        if (!field || typeof field !== 'object') continue;
        const moneyToken = looksLikeMoney(field.name);
        if (!moneyToken) continue;
        if (!isFloating(field.type)) continue;

        gaps.push({
          file: row.file,
          line: null,
          evidence: `Model ${row.model_name}.${field.name} is declared as ${field.type} — money-named field on a floating-point type. Use Decimal (or minor-units integer) to avoid precision loss.`,
        });
      }
    }
    return gaps;
  },
};
