import { AlertTriangle, Loader2 } from "lucide-react";

export function LoadingState({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-wv-fog-muted">
      <Loader2 size={18} strokeWidth={1.6} className="animate-spin text-wv-green" />
      <span className="text-sm font-mono">{label ?? "Loading from Weaviate…"}</span>
    </div>
  );
}

export function ErrorState({ error }: { error: Error }) {
  return (
    <div className="rounded-lg border border-wv-danger/40 bg-wv-danger/5 px-5 py-4 my-6">
      <div className="flex items-start gap-3">
        <AlertTriangle
          size={18}
          strokeWidth={1.6}
          className="text-wv-danger shrink-0 mt-0.5"
        />
        <div className="min-w-0">
          <p className="text-wv-fog text-sm font-medium">
            Weaviate query failed.
          </p>
          <p className="mt-1 font-mono text-[12px] text-wv-fog-muted break-words">
            {error.message}
          </p>
          <p className="mt-3 text-[12px] text-wv-fog-muted">
            Check that the server is configured with{" "}
            <code className="text-wv-fog">WEAVIATE_URL</code> (and{" "}
            <code className="text-wv-fog">WEAVIATE_API_KEY</code>) pointing at a
            reachable cluster, and that the collections{" "}
            <code className="text-wv-fog">TestRun</code> +{" "}
            <code className="text-wv-fog">TestCase</code> exist.
          </p>
        </div>
      </div>
    </div>
  );
}
