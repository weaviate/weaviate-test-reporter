/**
 * Consistent page header — title + eyebrow + optional right slot.
 * Used by every tab so the visual rhythm matches across the app.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  right,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  right?: React.ReactNode;
}) {
  return (
    <header className="border-b border-wv-navy-3/40 px-8 py-7 wv-reveal">
      <div className="flex items-start justify-between gap-6">
        <div>
          {eyebrow ? (
            <p className="text-[11px] uppercase tracking-[0.22em] text-wv-green font-mono mb-2">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="font-display text-3xl text-wv-fog">{title}</h1>
          {description ? (
            <p className="mt-2 text-wv-fog-muted max-w-2xl leading-relaxed text-[14px]">
              {description}
            </p>
          ) : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </div>
    </header>
  );
}
