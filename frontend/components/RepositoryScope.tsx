"use client";

import { Fragment } from "react";
import { useRepository } from "@/lib/useRepository";

/**
 * Remounts the page whenever the selected repository changes, so no page state
 * (filters, expanded rows, chat history) carries over into another repository.
 */
export function RepositoryScope({ children }: { children: React.ReactNode }) {
  const repository = useRepository();
  return <Fragment key={repository}>{children}</Fragment>;
}
