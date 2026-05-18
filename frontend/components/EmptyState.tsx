import type { LucideIcon } from "lucide-react";

/**
 * Empty state — a single Lucide icon + one line of copy.
 * Used when a query returns no results.
 */
export function EmptyState({
  Icon,
  title,
  description,
}: {
  Icon: LucideIcon;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <Icon size={56} strokeWidth={1.4} className="text-wv-fog-muted/70 mb-4" />
      <p className="font-display text-lg text-wv-fog">{title}</p>
      {description ? (
        <p className="mt-1 text-sm text-wv-fog-muted max-w-md">{description}</p>
      ) : null}
    </div>
  );
}
