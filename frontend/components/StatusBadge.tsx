import { CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import type { TestCaseStatus, TestRunStatus } from "@/lib/types";

const ICONS = {
  passed: CheckCircle2,
  failed: XCircle,
  skipped: CircleDashed,
  success: CheckCircle2,
  failure: XCircle,
  cancelled: CircleDashed,
} as const;

const TONES: Record<string, string> = {
  passed: "text-wv-green border-wv-green/40 bg-wv-green/8",
  failed: "text-wv-danger border-wv-danger/40 bg-wv-danger/8",
  skipped: "text-wv-fog-muted border-wv-fog-muted/30 bg-wv-fog-muted/5",
  success: "text-wv-green border-wv-green/40 bg-wv-green/8",
  failure: "text-wv-danger border-wv-danger/40 bg-wv-danger/8",
  cancelled: "text-wv-warn border-wv-warn/40 bg-wv-warn/8",
};

export function StatusBadge({
  status,
}: {
  status: TestRunStatus | TestCaseStatus | string;
}) {
  const Icon = ICONS[status as keyof typeof ICONS] ?? CircleDashed;
  const tone = TONES[status] ?? TONES.skipped;
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full",
        "text-[11px] font-mono uppercase tracking-wider",
        "border",
        tone,
      ].join(" ")}
    >
      <Icon size={12} strokeWidth={2} />
      {status}
    </span>
  );
}
