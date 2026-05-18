"use client";

import { FlaskConical, Gauge, SearchCode } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark } from "./BrandMark";

type NavItem = {
  href: string;
  label: string;
  Icon: typeof FlaskConical;
};

const NAV: NavItem[] = [
  { href: "/", label: "Test Explorer", Icon: FlaskConical },
  { href: "/search", label: "Semantic Search", Icon: SearchCode },
  { href: "/dashboard", label: "Metrics", Icon: Gauge },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/" || pathname === "";
  return pathname.startsWith(href);
}

export function Sidebar() {
  const pathname = usePathname() ?? "/";

  return (
    <aside
      className="
        w-64 shrink-0 border-r border-wv-navy-3/60
        bg-wv-ink/40 backdrop-blur-sm
        flex flex-col
      "
    >
      <div className="px-6 pt-7 pb-5 border-b border-wv-navy-3/40">
        <Link
          href="/"
          className="flex flex-col gap-2 group"
          aria-label="Weaviate Test Reporter, go to Test Explorer"
        >
          <BrandMark height={22} />
          <span className="text-wv-fog-muted text-[11px] font-medium uppercase tracking-[0.22em] font-mono">
            Test Reporter
          </span>
        </Link>
      </div>

      <nav className="flex-1 p-3 space-y-1" aria-label="Primary">
        {NAV.map(({ href, label, Icon }, i) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={[
                "wv-reveal flex items-center gap-3 px-3 py-2.5 rounded-md text-sm",
                "transition-colors duration-150",
                active
                  ? "bg-wv-navy-2 text-wv-fog"
                  : "text-wv-fog-muted hover:text-wv-fog hover:bg-wv-navy-2/60",
              ].join(" ")}
              style={{ animationDelay: `${i * 50}ms` }}
            >
              <span
                aria-hidden="true"
                className={[
                  "h-7 w-1 -ml-3 rounded-r-sm",
                  active ? "bg-wv-green" : "bg-transparent",
                ].join(" ")}
              />
              <Icon
                size={18}
                strokeWidth={1.75}
                className={active ? "text-wv-green" : ""}
              />
              <span className="font-medium">{label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="px-4 py-4 border-t border-wv-navy-3/40 text-[11px] text-wv-fog-muted leading-relaxed">
        <p className="font-mono">
          v0.1.0 · MVP
        </p>
        <p className="mt-1">
          Dogfooding{" "}
          <span className="text-wv-green font-medium">text2vec-weaviate</span>
          {" "}over real CI data.
        </p>
      </div>
    </aside>
  );
}
