import Image from "next/image";

/**
 * Weaviate brand mark.
 *
 * Renders the official horizontal Weaviate logo (icon + wordmark) shipped
 * by weaviate.io. The asset lives at public/weaviate-logo.svg so it is
 * served by Nginx as-is from the static export.
 *
 * The intrinsic SVG is 614 x 106 (~5.8 aspect). Use the `height` prop to
 * scale; width is derived to preserve the aspect ratio.
 */
export function BrandMark({
  height = 24,
  className = "",
}: {
  height?: number;
  className?: string;
}) {
  const ratio = 614.6 / 106;
  const width = Math.round(height * ratio);
  return (
    <Image
      src="/weaviate-logo.svg"
      alt="Weaviate"
      width={width}
      height={height}
      priority
      className={className}
    />
  );
}
