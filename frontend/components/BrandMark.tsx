/**
 * Weaviate brand mark.
 *
 * Geometric W rendered from path data so it can be tinted with currentColor
 * (the official SVG from the Brand Drive folder is the long-term source of
 * truth — swap this for that asset before public release).
 */
export function BrandMark({
  size = 28,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M4 8 L10 24 L16 14 L22 24 L28 8" />
      <circle cx="16" cy="14" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
