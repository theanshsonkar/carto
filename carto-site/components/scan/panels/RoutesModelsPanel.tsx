import { Panel } from "@/components/ui/Panel";
import type { RouteEntry, ModelEntry } from "../report-data";

/**
 * Two panels side-by-side (single Panel wrapping a 2-column split): extracted
 * routes on the left, data models on the right. Both are Carto's "structure
 * extraction" pitch in one row.
 */
export function RoutesModelsPanel({
  routes,
  models,
}: {
  routes: RouteEntry[];
  models: ModelEntry[];
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel label="ROUTES" hint={`${routes.length} extracted`}>
        {routes.length === 0 ? (
          <p className="font-mono text-[0.85rem] text-ink-3">
            no HTTP surface — this repo has no web routes.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {routes.map((r, i) => (
              <li key={i} className="flex items-baseline gap-3 py-2.5 first:pt-0 last:pb-0">
                <span
                  className={`w-14 shrink-0 border px-1.5 py-0.5 text-center font-mono text-[0.68rem] uppercase tracking-[0.05em] ${methodStyle(r.method)}`}
                >
                  {r.method}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[0.82rem] text-ink">
                  {r.path}
                </span>
                <span className="hidden font-mono text-[0.7rem] text-ink-3 md:inline">
                  {r.framework}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel label="MODELS" hint={`${models.length} detected`}>
        <ul className="divide-y divide-line">
          {models.map((m, i) => (
            <li key={i} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-[0.85rem] font-medium text-ink">
                  {m.name}
                </span>
                <span className="font-mono text-[0.7rem] text-ink-3">
                  {m.fields} fields
                </span>
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="border border-line bg-paper px-1.5 py-0.5 font-mono text-[0.62rem] uppercase tracking-[0.1em] text-route">
                  {m.kind}
                </span>
                <span className="truncate font-mono text-[0.72rem] text-ink-3">
                  {m.file}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function methodStyle(method: string): string {
  const m = method.toUpperCase();
  if (m === "GET") return "border-safe text-safe";
  if (m === "POST") return "border-route text-route";
  if (m === "PUT" || m === "PATCH") return "border-ink text-ink";
  if (m === "DELETE") return "border-signal text-signal";
  return "border-line text-ink-2";
}
