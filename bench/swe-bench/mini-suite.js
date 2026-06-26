'use strict';

/**
 * mini-suite — 5 synthetic SWE-bench-shaped tasks for CI.
 *
 * Each task has:
 *
 *   - id           : unique short string
 *   - kind         : 'single_file' | 'multi_file' | 'architectural'
 *   - description  : human-readable problem statement
 *   - repo         : filesystem tree (filename → content) the harness writes
 *                    into a tmp dir before the agent runs
 *   - expected     : { addedLines:Set<string>, requiredFiles:Set<string> }
 *                    used by `score.js` to grade the agent's diff
 *   - stubControl  : the diff a "Claude-without-Carto" stub would produce.
 *                    For single-file tasks: same as the expected diff
 *                    (control AI can handle these).
 *                    For multi-file tasks: incomplete — misses some
 *                    dependents (the failure mode CodeScaleBench
 *                    documented: agents lose track of multi-file scope).
 *   - stubCarto    : the diff a "Claude-with-Carto" stub would produce.
 *                    For multi-file tasks: complete, because the agent
 *                    queried `get_blast_radius` first and saw all
 *                    affected files.
 *
 * The stub*'s are what runs in CI (deterministic, no Anthropic API).
 * Real Anthropic runs replace them with the actual Claude outputs.
 *
 * The asymmetry between stubControl and stubCarto for multi-file tasks
 * is the *premise* of the benchmark — we want CI to verify that the
 * harness can detect the delta when it exists. It's not a fudge; if
 * real Claude+Carto doesn't outperform real Claude alone on these
 * shapes, the published delta will be 0pp and we ship that honestly.
 */

const TASKS = [
  // ─── single-file: rename a local function ─────────────────────────
  {
    id: 'mini-001',
    kind: 'single_file',
    description: 'Rename the function `oldName` to `newName` in src/utils.ts.',
    repo: {
      'src/utils.ts':
        'export function oldName(x: number): number {\n' +
        '  return x * 2;\n' +
        '}\n',
    },
    expected: {
      addedLines: new Set(['export function newName(x: number): number {']),
      removedLines: new Set(['export function oldName(x: number): number {']),
      requiredFiles: new Set(['src/utils.ts']),
    },
    stubControl: makeDiff('src/utils.ts',
      'export function oldName(x: number): number {',
      'export function newName(x: number): number {'),
    stubCarto: makeDiff('src/utils.ts',
      'export function oldName(x: number): number {',
      'export function newName(x: number): number {'),
  },

  // ─── single-file: add a parameter, no callers ─────────────────────
  {
    id: 'mini-002',
    kind: 'single_file',
    description: 'Add a `verbose: boolean = false` parameter to `logEvent` in src/log.ts.',
    repo: {
      'src/log.ts':
        'export function logEvent(name: string): void {\n' +
        '  console.log(name);\n' +
        '}\n',
    },
    expected: {
      addedLines: new Set(['export function logEvent(name: string, verbose: boolean = false): void {']),
      removedLines: new Set(['export function logEvent(name: string): void {']),
      requiredFiles: new Set(['src/log.ts']),
    },
    stubControl: makeDiff('src/log.ts',
      'export function logEvent(name: string): void {',
      'export function logEvent(name: string, verbose: boolean = false): void {'),
    stubCarto: makeDiff('src/log.ts',
      'export function logEvent(name: string): void {',
      'export function logEvent(name: string, verbose: boolean = false): void {'),
  },

  // ─── multi-file: rename across 5 importers ────────────────────────
  {
    id: 'mini-003',
    kind: 'multi_file',
    description: 'Rename the exported `fetchUser` to `getUser`. Used by 5 files.',
    repo: {
      'src/api.ts':           'export function fetchUser() { return {}; }\n',
      'src/handlers/a.ts':    'import { fetchUser } from "../api";\nfetchUser();\n',
      'src/handlers/b.ts':    'import { fetchUser } from "../api";\nfetchUser();\n',
      'src/handlers/c.ts':    'import { fetchUser } from "../api";\nfetchUser();\n',
      'src/handlers/d.ts':    'import { fetchUser } from "../api";\nfetchUser();\n',
      'src/handlers/e.ts':    'import { fetchUser } from "../api";\nfetchUser();\n',
    },
    expected: {
      addedLines: new Set([
        'export function getUser() { return {}; }',
        'import { getUser } from "../api";',
        'getUser();',
      ]),
      removedLines: new Set([
        'export function fetchUser() { return {}; }',
        'import { fetchUser } from "../api";',
        'fetchUser();',
      ]),
      requiredFiles: new Set([
        'src/api.ts',
        'src/handlers/a.ts', 'src/handlers/b.ts', 'src/handlers/c.ts',
        'src/handlers/d.ts', 'src/handlers/e.ts',
      ]),
    },
    // Control finds the definition + 3 of 5 callers (CodeScaleBench
    // "lost in codebase" failure mode — grep returns more matches than
    // the agent has context for).
    stubControl: [
      makeDiff('src/api.ts',
        'export function fetchUser() { return {}; }',
        'export function getUser() { return {}; }'),
      makeDiff('src/handlers/a.ts',
        'import { fetchUser } from "../api";',
        'import { getUser } from "../api";'),
      makeDiff('src/handlers/a.ts', 'fetchUser();', 'getUser();'),
      makeDiff('src/handlers/b.ts',
        'import { fetchUser } from "../api";',
        'import { getUser } from "../api";'),
      makeDiff('src/handlers/b.ts', 'fetchUser();', 'getUser();'),
      makeDiff('src/handlers/c.ts',
        'import { fetchUser } from "../api";',
        'import { getUser } from "../api";'),
      makeDiff('src/handlers/c.ts', 'fetchUser();', 'getUser();'),
      // Misses handlers/d.ts and handlers/e.ts entirely.
    ].join(''),
    // Carto-aware: queries get_blast_radius("src/api.ts") → returns
    // all 5 callers → edits all of them.
    stubCarto: [
      makeDiff('src/api.ts',
        'export function fetchUser() { return {}; }',
        'export function getUser() { return {}; }'),
      ...['a', 'b', 'c', 'd', 'e'].flatMap((id) => [
        makeDiff(`src/handlers/${id}.ts`,
          'import { fetchUser } from "../api";',
          'import { getUser } from "../api";'),
        makeDiff(`src/handlers/${id}.ts`, 'fetchUser();', 'getUser();'),
      ]),
    ].join(''),
  },

  // ─── multi-file: change an interface signature ────────────────────
  {
    id: 'mini-004',
    kind: 'multi_file',
    description: 'Add an optional `traceId` field to UserEvent interface; 3 callers must update.',
    repo: {
      'src/types.ts':         'export interface UserEvent { id: string; }\n',
      'src/svc/emit.ts':      'import { UserEvent } from "../types";\nexport function emit(e: UserEvent) { console.log(e); }\n',
      'src/svc/log.ts':       'import { UserEvent } from "../types";\nexport function log(e: UserEvent) { console.log(e); }\n',
      'src/svc/audit.ts':     'import { UserEvent } from "../types";\nexport function audit(e: UserEvent) { console.log(e); }\n',
    },
    expected: {
      addedLines: new Set(['export interface UserEvent { id: string; traceId?: string; }']),
      removedLines: new Set(['export interface UserEvent { id: string; }']),
      requiredFiles: new Set([
        'src/types.ts',
        'src/svc/emit.ts', 'src/svc/log.ts', 'src/svc/audit.ts',
      ]),
    },
    // Control: updates only the type definition + 1 of 3 callers (one
    // it happened to read first).
    stubControl: [
      makeDiff('src/types.ts',
        'export interface UserEvent { id: string; }',
        'export interface UserEvent { id: string; traceId?: string; }'),
      makeDiff('src/svc/emit.ts',
        'export function emit(e: UserEvent) { console.log(e); }',
        'export function emit(e: UserEvent) { console.log(e.id, e.traceId); }'),
    ].join(''),
    // Carto: queries blast radius → updates all 3 callers consistently.
    stubCarto: [
      makeDiff('src/types.ts',
        'export interface UserEvent { id: string; }',
        'export interface UserEvent { id: string; traceId?: string; }'),
      makeDiff('src/svc/emit.ts',
        'export function emit(e: UserEvent) { console.log(e); }',
        'export function emit(e: UserEvent) { console.log(e.id, e.traceId); }'),
      makeDiff('src/svc/log.ts',
        'export function log(e: UserEvent) { console.log(e); }',
        'export function log(e: UserEvent) { console.log(e.id, e.traceId); }'),
      makeDiff('src/svc/audit.ts',
        'export function audit(e: UserEvent) { console.log(e); }',
        'export function audit(e: UserEvent) { console.log(e.id, e.traceId); }'),
    ].join(''),
  },

  // ─── architectural: cross-domain refactor ─────────────────────────
  {
    id: 'mini-005',
    kind: 'architectural',
    description: 'Move shared validation helper to a CORE module; both AUTH and PAYMENTS import it.',
    repo: {
      'src/auth/login.ts':       'export function validate(s: string) { return s.length > 0; }\n',
      'src/payments/charge.ts':  'import { validate } from "../auth/login";\nexport function charge(s: string) { return validate(s); }\n',
    },
    expected: {
      addedLines: new Set([
        'export function validate(s: string) { return s.length > 0; }',
        'import { validate } from "../core/validate";',
      ]),
      removedLines: new Set([
        'export function validate(s: string) { return s.length > 0; }',
        'import { validate } from "../auth/login";',
      ]),
      requiredFiles: new Set([
        'src/core/validate.ts',     // new file
        'src/auth/login.ts',        // remove validate
        'src/payments/charge.ts',   // update import
      ]),
    },
    // Control: doesn't see the cross-domain violation; just inlines
    // the helper. Leaves the architectural smell intact.
    stubControl: makeDiff('src/payments/charge.ts',
      'import { validate } from "../auth/login";\nexport function charge(s: string) { return validate(s); }',
      'export function charge(s: string) { return s.length > 0; }'),
    // Carto: queries cross_domain, sees AUTH→PAYMENTS edge, creates
    // CORE module, both import from it.
    stubCarto: [
      makeAddDiff('src/core/validate.ts',
        'export function validate(s: string) { return s.length > 0; }\n'),
      makeDiff('src/auth/login.ts',
        'export function validate(s: string) { return s.length > 0; }',
        ''),
      makeDiff('src/payments/charge.ts',
        'import { validate } from "../auth/login";',
        'import { validate } from "../core/validate";'),
    ].join(''),
  },
];

/**
 * Build a tiny single-line replacement unified diff. Not minimal —
 * we don't need to optimize hunks for the scorer.
 */
function makeDiff(file, before, after) {
  return (
    `diff --git a/${file} b/${file}\n` +
    `--- a/${file}\n` +
    `+++ b/${file}\n` +
    `@@ -1,1 +1,1 @@\n` +
    `-${before}\n` +
    `+${after}\n`
  );
}

/**
 * Build an "add new file" unified diff.
 */
function makeAddDiff(file, content) {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return (
    `diff --git a/${file} b/${file}\n` +
    `new file mode 100644\n` +
    `--- /dev/null\n` +
    `+++ b/${file}\n` +
    `@@ -0,0 +1,${lines.length} @@\n` +
    lines.map((l) => `+${l}`).join('\n') + '\n'
  );
}

module.exports = { TASKS, makeDiff, makeAddDiff };
