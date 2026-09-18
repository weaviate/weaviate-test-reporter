import { CheckCircle2, CircleDashed, ServerCrash, XCircle } from "lucide-react";
import type { TestCaseStatus, TestRunStatus } from "@/lib/types";

const ICONS = {
  passed: CheckCircle2,
  failed: XCircle,
  skipped: CircleDashed,
  success: CheckCircle2,
  failure: XCircle,
  infra_failure: ServerCrash,
  cancelled: CircleDashed,
} as const;

const TONES: Record<string, string> = {
  passed: "text-wv-green border-wv-green/40 bg-wv-green/8",
  failed: "text-wv-danger border-wv-danger/40 bg-wv-danger/8",
  skipped: "text-wv-fog-muted border-wv-fog-muted/30 bg-wv-fog-muted/5",
  success: "text-wv-green border-wv-green/40 bg-wv-green/8",
  failure: "text-wv-danger border-wv-danger/40 bg-wv-danger/8",
  infra_failure: "text-wv-warn border-wv-warn/40 bg-wv-warn/8",
  cancelled: "text-wv-warn border-wv-warn/40 bg-wv-warn/8",
};

// The runs list gives the badge a fixed 110px slot; values longer than
// "failure" overflow into the run title, so they get a short display label.
const LABELS: Record<string, string> = {
  infra_failure: "infra_fail",
};

export function StatusBadge({
  status,
}: {
  status: TestRunStatus | TestCaseStatus | string;
}) {
  const Icon = ICONS[status as keyof typeof ICONS] ?? CircleDashed;
  const tone = TONES[status] ?? TONES.skipped;
  const accessibleLabel = status.replaceAll("_", " ");
  return (
    <span
      title={accessibleLabel}
      aria-label={accessibleLabel}
      className={[
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full",
        "text-[11px] font-mono uppercase tracking-wider",
        "border",
        tone,
      ].join(" ")}
    >
      <Icon size={12} strokeWidth={2} />
      {LABELS[status] ?? status}
    </span>
  );
}
