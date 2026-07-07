/**
 * Curated Carto reports for a handful of famous repos, plus a deterministic
 * generator that fabricates realistic-looking data for anything else. This
 * is what powers the /scan demo. Real Carto reads all of this from
 * `.carto/carto.db` on your machine.
 */

// ---- types ----------------------------------------------------------------

export type Phase = "idle" | "scanning" | "report";

export type Report = {
  repo: {
    name: string;
    url: string;
    indexedAt: string;
    primaryLang: string;
  };
  stats: {
    files: number;
    routes: number;
    edges: number;
    domains: number;
    firstIndexMs: number;
    reindexMs: number;
    dbSizeMb: number;
  };
  risk: {
    overall: number;
    label: string;
    categories: RiskCategory[];
  };
  highImpact: HighImpactFile[];
  domains: Domain[];
  hotspots: Hotspot[];
  blast: BlastEntry[];
  drift: DriftEvent[];
  crossDomain: CrossDomainViolation[];
  routes: RouteEntry[];
  models: ModelEntry[];
  invariants: Invariant[];
  conventions: Convention[];
  decisions: Decision[];
  deadCode: DeadEntry[];
};

export type RiskCategory = {
  label: string;
  score: number;
  note: string;
  weak?: boolean;
};

export type HighImpactFile = {
  path: string;
  deps: number;
  domain: string;
  lang: string;
};

export type Domain = {
  name: string;
  files: number;
  coupling: number; // 0..1
  stability: "stable" | "drifting" | "churning";
  note: string;
};

export type Hotspot = {
  path: string;
  risk: number; // 0..1
  churn: number;
  blast: number;
  coverage: number; // 0..1
};

export type BlastEntry = {
  file: string;
  hops: number;
  direct: number;
  total: number;
  downstream: string[];
};

export type DriftEvent = {
  when: string;
  kind: "growth" | "split" | "coupling" | "quiet";
  body: string;
  domain?: string;
};

export type CrossDomainViolation = {
  from: string;
  fromDomain: string;
  to: string;
  toDomain: string;
  kind: "layer" | "back-edge" | "leak";
  note: string;
};

export type RouteEntry = {
  method: string;
  path: string;
  file: string;
  framework: string;
};

export type ModelEntry = {
  name: string;
  kind: string;
  file: string;
  fields: number;
};

export type Invariant = {
  text: string;
  adherence: number;
  scope: string;
};

export type Convention = {
  text: string;
  example: string;
};

export type Decision = {
  q: string;
  verdict: string;
  when: string;
  files: number;
};

export type DeadEntry = {
  path: string;
  lines: number;
  confidence: number;
  reason: string;
};

// ---- curated -------------------------------------------------------------

const SUPABASE: Report = {
  repo: {
    name: "supabase/supabase",
    url: "github.com/supabase/supabase",
    indexedAt: "just now",
    primaryLang: "TypeScript",
  },
  stats: {
    files: 5974,
    routes: 86,
    edges: 4839,
    domains: 7,
    firstIndexMs: 5900,
    reindexMs: 967,
    dbSizeMb: 4.8,
  },
  risk: {
    overall: 68,
    label: "watch a few files",
    categories: [
      { label: "Blast radius", score: 61, note: "1 hotspot with 83 deps", weak: true },
      { label: "Churn", score: 74, note: "AUTH churning 3× baseline" },
      { label: "Cross-domain", score: 82, note: "2 layering violations" },
      { label: "Coverage", score: 70, note: "high-impact files at 62%" },
      { label: "Coupling", score: 55, note: "STUDIO leans on API-META", weak: true },
    ],
  },
  highImpact: [
    { path: "packages/pg-meta/src/pg-format/index.ts", deps: 83, domain: "API-META", lang: "ts" },
    { path: "apps/studio/lib/api-key/pg-meta.ts", deps: 71, domain: "STUDIO", lang: "ts" },
    { path: "packages/api-types/src/database/index.ts", deps: 64, domain: "TYPES", lang: "ts" },
    { path: "apps/studio/lib/constants.ts", deps: 58, domain: "STUDIO", lang: "ts" },
    { path: "packages/ui/src/lib/utils.ts", deps: 52, domain: "UI", lang: "ts" },
    { path: "apps/docs/lib/mdx/components.tsx", deps: 44, domain: "DOCS", lang: "tsx" },
    { path: "packages/config/hooks/useProjectContext.ts", deps: 41, domain: "STUDIO", lang: "ts" },
    { path: "apps/studio/pages/_app.tsx", deps: 39, domain: "STUDIO", lang: "tsx" },
    { path: "packages/pg-meta/src/query.ts", deps: 35, domain: "API-META", lang: "ts" },
    { path: "apps/studio/data/query-client.ts", deps: 31, domain: "STUDIO", lang: "ts" },
  ],
  domains: [
    { name: "STUDIO", files: 2413, coupling: 0.62, stability: "drifting", note: "grew 18 files this quarter" },
    { name: "API-META", files: 891, coupling: 0.71, stability: "churning", note: "highest coupling in repo" },
    { name: "UI", files: 743, coupling: 0.34, stability: "stable", note: "clean boundaries" },
    { name: "DOCS", files: 612, coupling: 0.28, stability: "stable", note: "MDX + shared components" },
    { name: "AUTH", files: 428, coupling: 0.48, stability: "churning", note: "3× normal commit rate" },
    { name: "TYPES", files: 517, coupling: 0.55, stability: "stable", note: "generated from schema" },
    { name: "TOOLS", files: 370, coupling: 0.22, stability: "stable", note: "scripts + codemods" },
  ],
  hotspots: [
    { path: "packages/pg-meta/src/pg-format/index.ts", risk: 0.87, churn: 34, blast: 83, coverage: 0.42 },
    { path: "apps/studio/lib/api-key/pg-meta.ts", risk: 0.72, churn: 19, blast: 71, coverage: 0.58 },
    { path: "apps/studio/lib/constants.ts", risk: 0.61, churn: 41, blast: 58, coverage: 0.31 },
    { path: "packages/ui/src/lib/utils.ts", risk: 0.44, churn: 12, blast: 52, coverage: 0.71 },
    { path: "packages/config/hooks/useProjectContext.ts", risk: 0.39, churn: 8, blast: 41, coverage: 0.66 },
    { path: "apps/studio/data/query-client.ts", risk: 0.33, churn: 15, blast: 31, coverage: 0.55 },
  ],
  blast: [
    {
      file: "packages/pg-meta/src/pg-format/index.ts",
      hops: 4,
      direct: 12,
      total: 83,
      downstream: [
        "apps/studio/lib/api-key/pg-meta.ts",
        "apps/studio/pages/project/[ref]/api.tsx",
        "packages/api-types/src/database/index.ts",
        "apps/studio/data/query-client.ts",
        "apps/studio/lib/constants.ts",
        "packages/pg-meta/src/query.ts",
        "apps/studio/hooks/useProjectApiSpec.ts",
        "apps/studio/components/interfaces/ApiPreview.tsx",
      ],
    },
  ],
  drift: [
    { when: "6 wks ago", kind: "growth", body: "STUDIO grew 18 files after the settings redesign.", domain: "STUDIO" },
    { when: "8 wks ago", kind: "coupling", body: "STUDIO started importing API-META directly, bypassing the types package.", domain: "STUDIO" },
    { when: "3 mo ago", kind: "split", body: "AUTH split OAuth handlers into a separate module — coupling dropped 24%.", domain: "AUTH" },
    { when: "5 mo ago", kind: "growth", body: "New pg-format engine added 41 files under packages/pg-meta.", domain: "API-META" },
  ],
  crossDomain: [
    {
      from: "apps/studio/lib/api-key/pg-meta.ts",
      fromDomain: "STUDIO",
      to: "packages/pg-meta/src/pg-format/index.ts",
      toDomain: "API-META",
      kind: "layer",
      note: "UI layer reaches directly into meta internals",
    },
    {
      from: "packages/ui/src/Dialog.tsx",
      fromDomain: "UI",
      to: "apps/studio/lib/constants.ts",
      toDomain: "STUDIO",
      kind: "back-edge",
      note: "shared lib depends on app constants",
    },
  ],
  routes: [
    { method: "GET",  path: "/api/platform/projects/[ref]", file: "apps/studio/pages/api/platform/projects/[ref].ts", framework: "Next.js" },
    { method: "POST", path: "/api/platform/projects", file: "apps/studio/pages/api/platform/projects.ts", framework: "Next.js" },
    { method: "GET",  path: "/api/props/project/[ref]/settings/general", file: "apps/studio/pages/api/props/project/[ref]/settings/general.ts", framework: "Next.js" },
    { method: "POST", path: "/api/get-utc-time", file: "apps/studio/pages/api/get-utc-time.ts", framework: "Next.js" },
    { method: "GET",  path: "/api/ai/sql/complete/[completionMetadata]", file: "apps/studio/pages/api/ai/sql/complete/[completionMetadata].ts", framework: "Next.js" },
  ],
  models: [
    { name: "Project", kind: "TS interface", file: "packages/api-types/src/database/index.ts", fields: 14 },
    { name: "ProjectApiSpec", kind: "TS interface", file: "packages/api-types/src/index.ts", fields: 11 },
    { name: "Organization", kind: "TS interface", file: "packages/api-types/src/database/index.ts", fields: 9 },
    { name: "AuthSession", kind: "TS interface", file: "packages/auth-helpers/src/types.ts", fields: 7 },
    { name: "DatabaseTable", kind: "TS interface", file: "packages/pg-meta/src/types.ts", fields: 12 },
  ],
  invariants: [
    { text: "snake_case for DB columns", adherence: 0.98, scope: "SQL / pg-meta" },
    { text: "camelCase for TS interfaces", adherence: 0.94, scope: "types" },
    { text: "hooks live in apps/studio/hooks/", adherence: 0.91, scope: "STUDIO" },
    { text: "no direct imports from apps/* into packages/*", adherence: 0.87, scope: "monorepo", },
  ],
  conventions: [
    { text: "Route files export a default handler function", example: "export default async function handler(req, res) { ... }" },
    { text: "Data queries live in apps/studio/data and use React Query keys", example: "export const projectKeys = { detail: (ref) => ['project', ref] }" },
    { text: "Add auth check middleware before hitting pg-meta", example: "await requireAuth(req); const client = await getMetaClient(...)" },
  ],
  decisions: [
    { q: "Should new routes use the pages/api or app/api directory?", verdict: "pages/api — legacy pattern still dominant in STUDIO.", when: "2 wks ago", files: 4 },
    { q: "Move pg-format into its own npm package?", verdict: "Yes — accepted, pending PR #23,411.", when: "3 wks ago", files: 41 },
    { q: "Which key format for API keys?", verdict: "sbp_ prefix + 40 char base62. Do not change.", when: "3 mo ago", files: 12 },
  ],
  deadCode: [
    { path: "apps/studio/lib/deprecated/pg-query-legacy.ts", lines: 214, confidence: 0.94, reason: "no imports · last touched 14 mo" },
    { path: "packages/ui/src/RadixToast.tsx", lines: 178, confidence: 0.88, reason: "superseded by sonner" },
    { path: "apps/docs/lib/oldMdx.ts", lines: 92, confidence: 0.79, reason: "no imports, but exported from index" },
  ],
};

const NEXTJS: Report = {
  repo: {
    name: "vercel/next.js",
    url: "github.com/vercel/next.js",
    indexedAt: "just now",
    primaryLang: "TypeScript",
  },
  stats: {
    files: 6193,
    routes: 42,
    edges: 5218,
    domains: 8,
    firstIndexMs: 6900,
    reindexMs: 978,
    dbSizeMb: 15.1,
  },
  risk: {
    overall: 74,
    label: "healthy · watch two",
    categories: [
      { label: "Blast radius", score: 63, note: "core exports have 200+ deps", weak: true },
      { label: "Churn", score: 71, note: "app-router hot" },
      { label: "Cross-domain", score: 88, note: "clean boundaries" },
      { label: "Coverage", score: 82, note: "excellent for a framework" },
      { label: "Coupling", score: 66, note: "server → shared → client normal" },
    ],
  },
  highImpact: [
    { path: "packages/next/src/server/base-server.ts", deps: 241, domain: "SERVER", lang: "ts" },
    { path: "packages/next/src/shared/lib/router/router.ts", deps: 189, domain: "ROUTER", lang: "ts" },
    { path: "packages/next/src/build/webpack-config.ts", deps: 174, domain: "BUILD", lang: "ts" },
    { path: "packages/next/src/server/render.tsx", deps: 156, domain: "SERVER", lang: "tsx" },
    { path: "packages/next/src/client/index.tsx", deps: 142, domain: "CLIENT", lang: "tsx" },
    { path: "packages/next/src/shared/lib/utils.ts", deps: 133, domain: "SHARED", lang: "ts" },
    { path: "packages/next/src/server/config.ts", deps: 118, domain: "SERVER", lang: "ts" },
    { path: "packages/next/src/lib/constants.ts", deps: 104, domain: "SHARED", lang: "ts" },
    { path: "packages/next/src/build/index.ts", deps: 96, domain: "BUILD", lang: "ts" },
    { path: "packages/next/src/server/app-render/app-render.tsx", deps: 88, domain: "SERVER", lang: "tsx" },
  ],
  domains: [
    { name: "SERVER", files: 1244, coupling: 0.58, stability: "churning", note: "app-router surface changes weekly" },
    { name: "CLIENT", files: 812, coupling: 0.44, stability: "drifting", note: "actions + streaming" },
    { name: "BUILD", files: 967, coupling: 0.51, stability: "stable", note: "webpack + turbopack" },
    { name: "ROUTER", files: 421, coupling: 0.62, stability: "drifting", note: "app + pages coexisting" },
    { name: "SHARED", files: 588, coupling: 0.36, stability: "stable", note: "utils + constants" },
    { name: "COMPILER", files: 743, coupling: 0.31, stability: "stable", note: "SWC bridge" },
    { name: "EXPERIMENTAL", files: 289, coupling: 0.4, stability: "churning", note: "PPR + turbopack flags" },
    { name: "DOCS", files: 1129, coupling: 0.14, stability: "stable", note: "MDX only" },
  ],
  hotspots: [
    { path: "packages/next/src/server/base-server.ts", risk: 0.79, churn: 52, blast: 241, coverage: 0.68 },
    { path: "packages/next/src/server/render.tsx", risk: 0.71, churn: 33, blast: 156, coverage: 0.62 },
    { path: "packages/next/src/server/app-render/app-render.tsx", risk: 0.68, churn: 47, blast: 88, coverage: 0.55 },
    { path: "packages/next/src/build/webpack-config.ts", risk: 0.54, churn: 21, blast: 174, coverage: 0.71 },
    { path: "packages/next/src/shared/lib/router/router.ts", risk: 0.46, churn: 14, blast: 189, coverage: 0.79 },
  ],
  blast: [
    {
      file: "packages/next/src/server/base-server.ts",
      hops: 5,
      direct: 24,
      total: 241,
      downstream: [
        "packages/next/src/server/next.ts",
        "packages/next/src/server/next-server.ts",
        "packages/next/src/server/dev/next-dev-server.ts",
        "packages/next/src/server/app-render/app-render.tsx",
        "packages/next/src/server/render.tsx",
        "packages/next/src/server/route-modules/pages/module.ts",
        "packages/next/src/server/lib/router-utils/router-server.ts",
      ],
    },
  ],
  drift: [
    { when: "2 wks ago", kind: "growth", body: "SERVER added 27 files for PPR streaming support.", domain: "SERVER" },
    { when: "6 wks ago", kind: "split", body: "app-render extracted from render.tsx — coupling in SERVER dropped 12%.", domain: "SERVER" },
    { when: "3 mo ago", kind: "coupling", body: "EXPERIMENTAL flags started leaking into CLIENT.", domain: "EXPERIMENTAL" },
  ],
  crossDomain: [
    {
      from: "packages/next/src/experimental/ppr-flags.ts",
      fromDomain: "EXPERIMENTAL",
      to: "packages/next/src/client/index.tsx",
      toDomain: "CLIENT",
      kind: "leak",
      note: "experimental flag imported by prod client",
    },
  ],
  routes: [
    { method: "GET",  path: "/", file: "packages/next/src/server/route-modules/pages/module.ts", framework: "Next.js" },
    { method: "GET",  path: "/api/*", file: "packages/next/src/server/route-modules/pages-api/module.ts", framework: "Next.js" },
    { method: "*",    path: "/app/*", file: "packages/next/src/server/app-render/app-render.tsx", framework: "Next.js" },
  ],
  models: [
    { name: "NextConfig", kind: "TS interface", file: "packages/next/src/server/config-shared.ts", fields: 43 },
    { name: "RouteDefinition", kind: "TS interface", file: "packages/next/src/server/route-definitions/route-definition.ts", fields: 8 },
    { name: "ServerRuntime", kind: "TS type", file: "packages/next/types/index.d.ts", fields: 4 },
  ],
  invariants: [
    { text: "server code never imports from client", adherence: 0.96, scope: "SERVER → CLIENT" },
    { text: "kebab-case for file names", adherence: 0.93, scope: "src/*" },
    { text: "public API exports only from packages/next/*.ts", adherence: 1.0, scope: "SDK" },
  ],
  conventions: [
    { text: "New route modules extend a RouteModule base class", example: "class MyRouteModule extends RouteModule { ... }" },
    { text: "Experimental features gate behind experimental.* config", example: "if (config.experimental.ppr) { ... }" },
  ],
  decisions: [
    { q: "Should PPR go behind a flag?", verdict: "Yes — experimental.ppr, off by default.", when: "5 mo ago", files: 27 },
    { q: "Deprecate pages router?", verdict: "No — parallel support through v17.", when: "8 mo ago", files: 421 },
  ],
  deadCode: [
    { path: "packages/next/src/deprecated/legacy-config.ts", lines: 189, confidence: 0.91, reason: "no imports · pre-app-router" },
    { path: "packages/next/src/experimental/removed/ppr-v1.ts", lines: 156, confidence: 0.84, reason: "replaced by ppr-v2" },
  ],
};

const VSCODE: Report = {
  repo: {
    name: "microsoft/vscode",
    url: "github.com/microsoft/vscode",
    indexedAt: "just now",
    primaryLang: "TypeScript",
  },
  stats: {
    files: 7567,
    routes: 0,
    edges: 6218,
    domains: 9,
    firstIndexMs: 8600,
    reindexMs: 1100,
    dbSizeMb: 14.3,
  },
  risk: {
    overall: 71,
    label: "watch the editor core",
    categories: [
      { label: "Blast radius", score: 58, note: "editor core has 300+ deps", weak: true },
      { label: "Churn", score: 76, note: "extensions surface hot" },
      { label: "Cross-domain", score: 84, note: "layering enforced" },
      { label: "Coverage", score: 78, note: "unit + integration solid" },
      { label: "Coupling", score: 61, note: "workbench → services → editor" },
    ],
  },
  highImpact: [
    { path: "src/vs/editor/browser/editorBrowser.ts", deps: 341, domain: "EDITOR", lang: "ts" },
    { path: "src/vs/editor/common/model.ts", deps: 287, domain: "EDITOR", lang: "ts" },
    { path: "src/vs/platform/instantiation/common/instantiation.ts", deps: 244, domain: "PLATFORM", lang: "ts" },
    { path: "src/vs/base/common/event.ts", deps: 218, domain: "BASE", lang: "ts" },
    { path: "src/vs/workbench/services/editor/common/editorService.ts", deps: 189, domain: "WORKBENCH", lang: "ts" },
    { path: "src/vs/base/common/lifecycle.ts", deps: 176, domain: "BASE", lang: "ts" },
    { path: "src/vs/workbench/common/editor.ts", deps: 148, domain: "WORKBENCH", lang: "ts" },
    { path: "src/vs/platform/registry/common/platform.ts", deps: 131, domain: "PLATFORM", lang: "ts" },
    { path: "src/vs/editor/common/languages.ts", deps: 122, domain: "EDITOR", lang: "ts" },
    { path: "src/vs/base/common/uri.ts", deps: 118, domain: "BASE", lang: "ts" },
  ],
  domains: [
    { name: "EDITOR", files: 1841, coupling: 0.61, stability: "churning", note: "Monaco surface changes weekly" },
    { name: "WORKBENCH", files: 2114, coupling: 0.72, stability: "drifting", note: "highest coupling in the tree" },
    { name: "PLATFORM", files: 1023, coupling: 0.44, stability: "stable", note: "DI + services" },
    { name: "BASE", files: 512, coupling: 0.28, stability: "stable", note: "utilities" },
    { name: "EXTENSIONS", files: 728, coupling: 0.51, stability: "churning", note: "hot API surface" },
    { name: "SERVER", files: 421, coupling: 0.39, stability: "stable", note: "remote + web" },
    { name: "CLI", files: 218, coupling: 0.22, stability: "stable", note: "code CLI" },
    { name: "TEST", files: 512, coupling: 0.31, stability: "stable", note: "integration + unit" },
    { name: "BUILD", files: 198, coupling: 0.18, stability: "stable", note: "gulp + esbuild" },
  ],
  hotspots: [
    { path: "src/vs/editor/browser/editorBrowser.ts", risk: 0.81, churn: 44, blast: 341, coverage: 0.72 },
    { path: "src/vs/workbench/services/editor/common/editorService.ts", risk: 0.74, churn: 51, blast: 189, coverage: 0.68 },
    { path: "src/vs/workbench/common/editor.ts", risk: 0.66, churn: 38, blast: 148, coverage: 0.61 },
    { path: "src/vs/editor/common/model.ts", risk: 0.55, churn: 22, blast: 287, coverage: 0.79 },
    { path: "src/vs/base/common/event.ts", risk: 0.31, churn: 8, blast: 218, coverage: 0.88 },
  ],
  blast: [
    {
      file: "src/vs/editor/browser/editorBrowser.ts",
      hops: 5,
      direct: 41,
      total: 341,
      downstream: [
        "src/vs/editor/browser/widget/codeEditorWidget.ts",
        "src/vs/editor/browser/view/viewImpl.ts",
        "src/vs/workbench/browser/parts/editor/textEditor.ts",
        "src/vs/workbench/services/editor/browser/editorService.ts",
        "src/vs/workbench/api/browser/mainThreadEditors.ts",
        "src/vs/editor/browser/services/codeEditorService.ts",
      ],
    },
  ],
  drift: [
    { when: "3 wks ago", kind: "growth", body: "EXTENSIONS surface added 12 API endpoints for chat participants.", domain: "EXTENSIONS" },
    { when: "8 wks ago", kind: "coupling", body: "WORKBENCH coupling rose 8% after editor part refactor.", domain: "WORKBENCH" },
    { when: "6 mo ago", kind: "split", body: "SERVER split into remote + web — coupling dropped 22%.", domain: "SERVER" },
  ],
  crossDomain: [
    {
      from: "src/vs/workbench/contrib/chat/browser/chatWidget.ts",
      fromDomain: "WORKBENCH",
      to: "src/vs/editor/browser/editorBrowser.ts",
      toDomain: "EDITOR",
      kind: "layer",
      note: "workbench contrib reaches editor internals",
    },
    {
      from: "src/vs/editor/browser/view/viewImpl.ts",
      fromDomain: "EDITOR",
      to: "src/vs/workbench/common/theme.ts",
      toDomain: "WORKBENCH",
      kind: "back-edge",
      note: "editor depending on workbench theme constants",
    },
  ],
  routes: [],
  models: [
    { name: "ITextModel", kind: "TS interface", file: "src/vs/editor/common/model.ts", fields: 34 },
    { name: "IEditorContribution", kind: "TS interface", file: "src/vs/editor/common/editorCommon.ts", fields: 5 },
    { name: "IServiceDescriptor", kind: "TS type", file: "src/vs/platform/instantiation/common/descriptors.ts", fields: 3 },
  ],
  invariants: [
    { text: "no cycles in domain layering (base → platform → editor → workbench)", adherence: 0.99, scope: "arch" },
    { text: "camelCase for TypeScript identifiers", adherence: 0.98, scope: "codebase" },
    { text: "one class per file, filename matches class", adherence: 0.94, scope: "editor" },
  ],
  conventions: [
    { text: "Contributions register via Registry.as(Extensions.WorkbenchContributions)", example: "Registry.as(Extensions.WorkbenchContributions).registerWorkbenchContribution(MyContribution)" },
    { text: "Services expose an interface + Symbol identifier", example: "export const IMyService = createDecorator<IMyService>('myService')" },
  ],
  decisions: [
    { q: "Should chat participants use tools framework?", verdict: "Yes — tools are the canonical extension surface.", when: "1 mo ago", files: 12 },
    { q: "Migrate off gulp?", verdict: "No — cost too high, revisit v2.", when: "5 mo ago", files: 42 },
  ],
  deadCode: [
    { path: "src/vs/workbench/contrib/experimental/legacy-remote.ts", lines: 244, confidence: 0.87, reason: "no imports · replaced by remote-agent" },
    { path: "src/vs/base/common/observableInternal/legacyObservables.ts", lines: 118, confidence: 0.72, reason: "used only by removed tests" },
  ],
};

const CALCOM: Report = {
  repo: {
    name: "calcom/cal.com",
    url: "github.com/calcom/cal.com",
    indexedAt: "just now",
    primaryLang: "TypeScript",
  },
  stats: {
    files: 4352,
    routes: 128,
    edges: 3891,
    domains: 6,
    firstIndexMs: 3900,
    reindexMs: 805,
    dbSizeMb: 3.1,
  },
  risk: {
    overall: 66,
    label: "watch the API surface",
    categories: [
      { label: "Blast radius", score: 57, note: "booking module has 140 deps", weak: true },
      { label: "Churn", score: 70, note: "app-store churning" },
      { label: "Cross-domain", score: 78, note: "3 layer breaks" },
      { label: "Coverage", score: 64, note: "trpc handlers 51%", weak: true },
      { label: "Coupling", score: 61, note: "features share too much state" },
    ],
  },
  highImpact: [
    { path: "packages/lib/CalendarService.ts", deps: 138, domain: "BOOKING", lang: "ts" },
    { path: "packages/prisma/client.ts", deps: 121, domain: "DATA", lang: "ts" },
    { path: "packages/trpc/server/routers/_app.ts", deps: 96, domain: "API", lang: "ts" },
    { path: "apps/web/lib/withAuthentication.ts", deps: 88, domain: "AUTH", lang: "ts" },
    { path: "packages/features/bookings/lib/handleNewBooking.ts", deps: 74, domain: "BOOKING", lang: "ts" },
    { path: "packages/ui/components/Button.tsx", deps: 62, domain: "UI", lang: "tsx" },
    { path: "packages/app-store/index.ts", deps: 51, domain: "APP-STORE", lang: "ts" },
    { path: "packages/lib/notEmpty.ts", deps: 41, domain: "SHARED", lang: "ts" },
  ],
  domains: [
    { name: "BOOKING", files: 917, coupling: 0.66, stability: "drifting", note: "core scheduling logic" },
    { name: "API", files: 812, coupling: 0.58, stability: "churning", note: "tRPC surface grows weekly" },
    { name: "APP-STORE", files: 794, coupling: 0.44, stability: "churning", note: "1 new integration/week" },
    { name: "AUTH", files: 218, coupling: 0.38, stability: "stable", note: "NextAuth-based" },
    { name: "UI", files: 512, coupling: 0.31, stability: "stable", note: "shared design system" },
    { name: "DATA", files: 271, coupling: 0.54, stability: "stable", note: "Prisma + zod" },
  ],
  hotspots: [
    { path: "packages/features/bookings/lib/handleNewBooking.ts", risk: 0.82, churn: 41, blast: 74, coverage: 0.48 },
    { path: "packages/lib/CalendarService.ts", risk: 0.71, churn: 24, blast: 138, coverage: 0.61 },
    { path: "packages/trpc/server/routers/viewer.tsx", risk: 0.64, churn: 33, blast: 58, coverage: 0.52 },
    { path: "apps/web/lib/withAuthentication.ts", risk: 0.44, churn: 9, blast: 88, coverage: 0.77 },
  ],
  blast: [
    {
      file: "packages/features/bookings/lib/handleNewBooking.ts",
      hops: 4,
      direct: 14,
      total: 74,
      downstream: [
        "packages/trpc/server/routers/viewer/bookings/create.handler.ts",
        "packages/features/bookings/components/BookingListItem.tsx",
        "packages/features/webhooks/lib/sendPayload.ts",
        "packages/lib/CalendarService.ts",
        "apps/web/pages/api/book/event.ts",
      ],
    },
  ],
  drift: [
    { when: "4 wks ago", kind: "growth", body: "APP-STORE added 6 integrations (Salesforce, HubSpot, ...).", domain: "APP-STORE" },
    { when: "10 wks ago", kind: "coupling", body: "BOOKING started calling app-store adapters directly.", domain: "BOOKING" },
  ],
  crossDomain: [
    {
      from: "packages/features/bookings/lib/handleNewBooking.ts",
      fromDomain: "BOOKING",
      to: "packages/app-store/salesforce/lib/CrmService.ts",
      toDomain: "APP-STORE",
      kind: "layer",
      note: "booking bypasses adapter interface",
    },
  ],
  routes: [
    { method: "POST", path: "/api/book/event", file: "apps/web/pages/api/book/event.ts", framework: "Next.js" },
    { method: "GET",  path: "/api/availability/user", file: "apps/web/pages/api/availability/user.ts", framework: "Next.js" },
    { method: "POST", path: "/api/trpc/[trpc]", file: "apps/web/pages/api/trpc/[trpc].ts", framework: "tRPC" },
  ],
  models: [
    { name: "Booking", kind: "Prisma", file: "packages/prisma/schema.prisma", fields: 24 },
    { name: "User", kind: "Prisma", file: "packages/prisma/schema.prisma", fields: 19 },
    { name: "EventType", kind: "Prisma", file: "packages/prisma/schema.prisma", fields: 32 },
  ],
  invariants: [
    { text: "handleNewBooking is the only entry point for creating a booking", adherence: 0.94, scope: "BOOKING" },
    { text: "tRPC handlers live in server/routers/", adherence: 0.98, scope: "API" },
  ],
  conventions: [
    { text: "App-store integrations expose a metadata.ts + index.ts pair", example: "packages/app-store/{integration}/{metadata.ts,index.ts}" },
    { text: "Zod for input validation on every mutation", example: "input: z.object({ eventTypeId: z.number(), ... })" },
  ],
  decisions: [
    { q: "Move CalendarService to a queue?", verdict: "Deferred — v2 candidate.", when: "6 wks ago", files: 18 },
    { q: "Standardize on tRPC v10?", verdict: "Yes — migration in progress.", when: "3 mo ago", files: 96 },
  ],
  deadCode: [
    { path: "packages/legacy/deprecated-availability.ts", lines: 178, confidence: 0.86, reason: "replaced by /lib/availability" },
  ],
};

const CURATED: Record<string, Report> = {
  "supabase/supabase": SUPABASE,
  "vercel/next.js": NEXTJS,
  "microsoft/vscode": VSCODE,
  "calcom/cal.com": CALCOM,
};

// ---- generator ------------------------------------------------------------

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function pick<T>(seed: number, arr: T[]): T {
  return arr[seed % arr.length];
}

function normalizeName(input: string): string {
  const clean = input
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const parts = clean.split("/").filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return clean || "your-repo";
}

const DOMAIN_POOL = [
  "AUTH", "API", "UI", "DATA", "SERVER", "WORKER", "PLATFORM", "TOOLS",
];

const FILE_POOL = [
  "src/auth/session.ts",
  "src/db/client.ts",
  "src/api/routes/users.ts",
  "src/components/Editor.tsx",
  "src/lib/constants.ts",
  "src/hooks/useProject.ts",
  "src/server/middleware/auth.ts",
  "src/utils/jwt.ts",
  "src/lib/logger.ts",
  "src/data/query-client.ts",
];

/**
 * Deterministic fabricated report — uses a hash of the repo name so the
 * numbers are stable across renders. Realistic-looking but obviously demo.
 */
function fabricate(repoName: string): Report {
  const h = hash(repoName);
  const files = 800 + (h % 3200);
  const routes = 20 + (h % 60);
  const edges = Math.floor(files * (0.6 + (h % 5) / 10));
  const domains = 4 + (h % 4);

  const overall = 55 + (h % 30);
  const primaryLang = pick(h, ["TypeScript", "Python", "Go", "Rust"]);

  const domainNames = DOMAIN_POOL.slice(0, domains);

  const highImpact: HighImpactFile[] = FILE_POOL.slice(0, 8).map(
    (path, i) => ({
      path,
      deps: 40 + ((h + i * 17) % 120),
      domain: pick(h + i, domainNames),
      lang: path.endsWith(".tsx") ? "tsx" : "ts",
    }),
  );

  const domainRows: Domain[] = domainNames.map((name, i) => ({
    name,
    files: Math.floor(files * (0.1 + ((h + i * 7) % 25) / 100)),
    coupling: Math.min(0.9, 0.2 + ((h + i * 11) % 60) / 100),
    stability: pick(h + i, [
      "stable",
      "drifting",
      "stable",
      "churning",
      "stable",
    ]) as Domain["stability"],
    note: pick(h + i, [
      "clean boundaries",
      "grew this quarter",
      "hot surface",
      "quiet, stable",
      "high coupling",
    ]),
  }));

  const hotspots: Hotspot[] = highImpact.slice(0, 5).map((f, i) => ({
    path: f.path,
    risk: Math.min(0.95, 0.35 + ((h + i * 13) % 55) / 100),
    churn: 5 + ((h + i * 5) % 40),
    blast: f.deps,
    coverage: 0.4 + ((h + i * 9) % 45) / 100,
  }));

  const blast: BlastEntry[] = [
    {
      file: highImpact[0].path,
      hops: 3 + (h % 3),
      direct: 8 + (h % 12),
      total: highImpact[0].deps,
      downstream: FILE_POOL.slice(1, 7),
    },
  ];

  const drift: DriftEvent[] = [
    {
      when: "3 wks ago",
      kind: "growth",
      body: `${domainNames[0]} grew ${8 + (h % 12)} files this quarter.`,
      domain: domainNames[0],
    },
    {
      when: "2 mo ago",
      kind: "coupling",
      body: `${domainNames[1]} started importing ${domainNames[Math.min(2, domainNames.length - 1)]} internals.`,
      domain: domainNames[1],
    },
    {
      when: "4 mo ago",
      kind: "split",
      body: `${domainNames[Math.min(2, domainNames.length - 1)]} split into two modules.`,
    },
  ];

  const routesArr: RouteEntry[] = [
    { method: "GET",  path: "/api/users/:id", file: "src/api/routes/users.ts", framework: "Express" },
    { method: "POST", path: "/api/users", file: "src/api/routes/users.ts", framework: "Express" },
    { method: "POST", path: "/api/auth/login", file: "src/auth/routes.ts", framework: "Express" },
    { method: "GET",  path: "/api/health", file: "src/api/routes/health.ts", framework: "Express" },
  ];

  const models: ModelEntry[] = [
    { name: "User", kind: "TS interface", file: "src/data/models/user.ts", fields: 8 },
    { name: "Session", kind: "TS interface", file: "src/auth/types.ts", fields: 5 },
    { name: "Project", kind: "TS interface", file: "src/data/models/project.ts", fields: 12 },
  ];

  return {
    repo: {
      name: repoName,
      url: `github.com/${repoName}`,
      indexedAt: "just now",
      primaryLang,
    },
    stats: {
      files,
      routes,
      edges,
      domains,
      firstIndexMs: 2000 + (h % 5000),
      reindexMs: 200 + (h % 800),
      dbSizeMb: 1.5 + (h % 12),
    },
    risk: {
      overall,
      label: overall >= 75 ? "healthy" : overall >= 60 ? "watch a few" : "at risk",
      categories: [
        { label: "Blast radius", score: 55 + (h % 30), note: `1 hotspot with ${highImpact[0].deps} deps`, weak: h % 3 === 0 },
        { label: "Churn", score: 60 + (h % 30), note: `${domainNames[0]} hot` },
        { label: "Cross-domain", score: 70 + (h % 20), note: "1 violation" },
        { label: "Coverage", score: 55 + (h % 30), note: "high-impact files under-covered", weak: h % 5 === 1 },
        { label: "Coupling", score: 50 + (h % 35), note: `${domainNames[1]} leans on ${domainNames[Math.min(2, domainNames.length - 1)]}`, weak: h % 4 === 0 },
      ],
    },
    highImpact,
    domains: domainRows,
    hotspots,
    blast,
    drift,
    crossDomain: [
      {
        from: FILE_POOL[2],
        fromDomain: domainNames[0],
        to: FILE_POOL[4],
        toDomain: domainNames[Math.min(1, domainNames.length - 1)],
        kind: "layer",
        note: "layer skipped",
      },
    ],
    routes: routesArr,
    models,
    invariants: [
      { text: "camelCase for identifiers", adherence: 0.92 + ((h % 8) / 100), scope: "codebase" },
      { text: "one export per file", adherence: 0.86 + ((h % 12) / 100), scope: "src/*" },
      { text: "no circular imports", adherence: 0.98, scope: "arch" },
    ],
    conventions: [
      { text: "Handlers export a default async function", example: "export default async function handler(req, res) { ... }" },
      { text: "Types live next to the code that uses them", example: "src/feature/{index.ts,types.ts}" },
    ],
    decisions: [
      { q: "Should new handlers use async/await or promises?", verdict: "async/await — matches existing style.", when: "3 wks ago", files: 8 },
      { q: "Consolidate config into one file?", verdict: "Yes, deferred to next quarter.", when: "2 mo ago", files: 4 },
    ],
    deadCode: [
      { path: "src/legacy/old-auth.ts", lines: 120 + (h % 100), confidence: 0.8 + (h % 15) / 100, reason: "no imports · pre-refactor" },
      { path: "src/utils/deprecated-helpers.ts", lines: 60 + (h % 80), confidence: 0.7 + (h % 20) / 100, reason: "superseded by new helpers" },
    ],
  };
}

// ---- entry point ----------------------------------------------------------

export function buildReport(input: string): Report {
  const name = normalizeName(input);
  const curated = CURATED[name];
  if (curated) return { ...curated, repo: { ...curated.repo, indexedAt: "just now" } };
  return fabricate(name);
}

// ---- AI-maintainability verdict ------------------------------------------
//
// The lead verdict of the report, reframed for the AI-native builder: not
// "is this code clean" but "can your AI keep building on this repo without
// breaking things it can't see." Everything here is *derived* from the
// report fields already computed above — no new data source. Deterministic:
// the same report always yields the same verdict.

export type VerdictCulprit = {
  path: string;
  deps: number;
  why: string;
};

export type VerdictSignal = {
  label: string;
  detail: string;
  bad: boolean;
};

export type AiVerdict = {
  score: number; // 0..100 — higher = an AI can keep building safely
  grade: "solid" | "holding" | "at risk" | "fragile";
  breakRate: string; // e.g. "1 in 3 edits"
  headline: string;
  subline: string;
  culprits: VerdictCulprit[];
  signals: VerdictSignal[];
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * aiVerdict(report) → AiVerdict
 *
 * Blends the sharpest structural signals into a single 0..100 answer to
 * "can your AI keep building on this?" The weighting is intentionally
 * legible rather than tuned — every deduction maps to a signal a builder
 * can see and act on.
 */
export function aiVerdict(report: Report): AiVerdict {
  const blast = report.blast?.[0]?.total ?? 0;
  const highImpact = report.highImpact ?? [];
  const hotspots = report.hotspots ?? [];
  const domains = report.domains ?? [];
  const crossDomain = report.crossDomain ?? [];

  const godFiles = highImpact.filter((f) => f.deps >= 50);
  const churning = domains.filter((d) => d.stability === "churning");
  const drifting = domains.filter((d) => d.stability === "drifting");
  const moving = [...churning, ...drifting];
  const untestedHubs = hotspots.filter((h) => h.blast >= 40 && h.coverage < 0.5);

  // Deductions from a perfect 100. Weights are deliberately gentle: large,
  // healthy repos naturally carry high-blast hub files (a shared util SHOULD
  // have many dependents), so blast is scaled softly and capped. The heavier
  // penalties fall on the real "AI-slop" tells — untested hubs, boundary
  // breaks, god-files. Each axis is capped so none alone tanks the score.
  const dBlast = clamp(blast / 8, 0, 16); // one giant hub file
  const dGod = clamp(godFiles.length * 2, 0, 12);
  const dCross = clamp(crossDomain.length * 4, 0, 12);
  const dMoving = clamp(churning.length * 3 + drifting.length * 1.5, 0, 12);
  const dUntested = clamp(untestedHubs.length * 4, 0, 14);

  const score = Math.round(
    clamp(100 - dBlast - dGod - dCross - dMoving - dUntested, 5, 98),
  );

  const grade: AiVerdict["grade"] =
    score >= 78 ? "solid" : score >= 55 ? "holding" : score >= 38 ? "at risk" : "fragile";

  // Break rate: how often an AI edit lands on something it can't see.
  // Lower score → smaller N → breaks more often.
  const n = clamp(Math.round(score / 11), 2, 20);
  const breakRate = `1 in ${n} edits`;

  // Named culprits — the files strangling the repo, worst first.
  const culprits: VerdictCulprit[] = hotspots
    .slice()
    .sort((a, b) => b.risk - a.risk)
    .slice(0, 3)
    .map((h) => ({
      path: h.path,
      deps: h.blast,
      why:
        h.coverage < 0.5 && h.churn >= 20
          ? `changes constantly, barely tested, and everything leans on it`
          : h.coverage < 0.5
            ? `touching it is risky — and it has almost no tests to catch mistakes`
            : `one edit here can ripple across the whole app`,
    }));

  // Detected signals — the "AI-slop" tells, in plain language.
  const signals: VerdictSignal[] = [
    {
      label: godFiles.length > 0 ? `${godFiles.length} overloaded file${godFiles.length > 1 ? "s" : ""}` : "nothing overloaded",
      detail:
        godFiles.length > 0
          ? `one change here ripples through dozens of files the AI can't keep track of`
          : `no single file is doing too much — edits stay contained`,
      bad: godFiles.length > 0,
    },
    {
      label: crossDomain.length > 0 ? `${crossDomain.length} tangled connection${crossDomain.length > 1 ? "s" : ""}` : "clean separation",
      detail:
        crossDomain.length > 0
          ? `parts of the app reach into each other in ways that confuse an AI mid-edit`
          : `the app's parts stay in their own lanes`,
      bad: crossDomain.length > 0,
    },
    {
      label: untestedHubs.length > 0 ? `${untestedHubs.length} risky untested file${untestedHubs.length > 1 ? "s" : ""}` : "safety net in place",
      detail:
        untestedHubs.length > 0
          ? `important files with no tests — nothing catches the AI when it gets something wrong`
          : `the files that matter most have tests to catch mistakes`,
      bad: untestedHubs.length > 0,
    },
    {
      label: moving.length > 0 ? `${moving.length} shifting area${moving.length > 1 ? "s" : ""}` : "stable structure",
      detail:
        moving.length > 0
          ? `these keep changing, so the AI's picture of the app goes stale fast`
          : `the codebase isn't shifting under the AI mid-task`,
      bad: moving.length > 0,
    },
  ];

  // Headline: painkiller framing, cites the sharpest signal.
  const topName = report.blast?.[0]?.file.split("/").slice(-1)[0] ?? "one file";
  let headline: string;
  if (grade === "fragile") {
    headline = `Your AI is about to lose control of this repo.`;
  } else if (grade === "at risk") {
    headline = `Your AI will break something it can't see ~${breakRate}.`;
  } else if (grade === "holding") {
    headline = `Your AI can keep building — but ${topName} is a landmine.`;
  } else {
    headline = `Your AI can keep building on this. For now.`;
  }

  const subline =
    grade === "solid"
      ? `The structure holds — nothing's overloaded and the parts stay separate. Keep an eye on ${topName} as it grows.`
      : `${godFiles.length} overloaded file${godFiles.length === 1 ? "" : "s"}, ${crossDomain.length} tangled connection${crossDomain.length === 1 ? "" : "s"}, and ${untestedHubs.length} risky file${untestedHubs.length === 1 ? "" : "s"} with no tests. Your AI edits through all of them blind.`;

  return { score, grade, breakRate, headline, subline, culprits, signals };
}
