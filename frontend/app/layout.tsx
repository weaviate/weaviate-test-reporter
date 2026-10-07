import type { Metadata } from "next";
import { Suspense } from "react";
import { Inter, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/Sidebar";
import { RepositoryScope } from "@/components/RepositoryScope";
import { getAgentAvailable } from "@/lib/server-env";

// Rendered per-request so `getAgentAvailable()` reads the runtime WEAVIATE_URL
// (not a build-time value) — the Agent nav must reflect the deployed cluster.
export const dynamic = "force-dynamic";

const display = Plus_Jakarta_Sans({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  display: "swap",
});

const body = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Weaviate Test Reporter",
  description:
    "Semantic search and metrics over CI test results. Dogfood project: " +
    "Weaviate makes CI triage faster.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <div className="flex min-h-screen">
          {/* Both read the selected repository from the URL
              (useSearchParams), which needs a Suspense boundary. */}
          <Suspense fallback={null}>
            <Sidebar agentAvailable={getAgentAvailable()} />
          </Suspense>
          <main className="flex-1 min-w-0">
            <Suspense fallback={null}>
              <RepositoryScope>{children}</RepositoryScope>
            </Suspense>
          </main>
        </div>
      </body>
    </html>
  );
}
