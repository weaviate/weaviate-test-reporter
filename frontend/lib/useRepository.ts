"use client";

import { useSearchParams } from "next/navigation";
import {
  DEFAULT_REPOSITORY,
  REPO_PARAM,
  repositoryFromParams,
} from "./repository";

/** The repository selected in the page URL (`?repo=`). A missing or malformed
 *  value reads as DEFAULT_REPOSITORY. Needs a Suspense boundary above it; the
 *  root layout provides one. */
export function useRepository(): string {
  const params = useSearchParams();
  return repositoryFromParams(params, REPO_PARAM) ?? DEFAULT_REPOSITORY;
}
