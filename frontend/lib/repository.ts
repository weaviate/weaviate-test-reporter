/**
 * Repository scoping, shared by client and server. Every page shows one
 * repository's data; the selection lives in the page URL as `?repo=owner/name`,
 * and an absent param means DEFAULT_REPOSITORY. API routes take it as
 * `?repository=` (or a `repository` body field for POSTs).
 */

export const DEFAULT_REPOSITORY = "weaviate/weaviate-e2e-tests";

/** Page-URL query param holding the selected repository. */
export const REPO_PARAM = "repo";

// GitHub owner/name: owners max 39 chars, repositories max 100. Owners keep
// `_`: Enterprise Managed User logins end in `_<shortcode>`.
const REPOSITORY_RE = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

/** The trimmed value when it is a GitHub `owner/name`, otherwise null. The
 *  value reaches Weaviate filters, cache keys and the agent prompt, so nothing
 *  else gets through. */
export function parseRepository(raw: string | null | undefined): string | null {
  const v = raw?.trim() ?? "";
  return REPOSITORY_RE.test(v) ? v : null;
}

/** The repository named by `param`: DEFAULT_REPOSITORY when absent or empty,
 *  null when present but malformed. */
export function repositoryFromParams(
  params: URLSearchParams,
  param: string,
): string | null {
  const raw = params.get(param);
  if (raw === null || raw.trim() === "") return DEFAULT_REPOSITORY;
  return parseRepository(raw);
}

/** A POST body's `repository` field, with the rules of a query param:
 *  DEFAULT_REPOSITORY when absent, null or blank, null when malformed or not
 *  a string. */
export function repositoryFromBody(value: unknown): string | null {
  if (value === undefined || value === null) return DEFAULT_REPOSITORY;
  if (typeof value !== "string") return null;
  if (value.trim() === "") return DEFAULT_REPOSITORY;
  return parseRepository(value);
}

/** `href` scoped to `repository`: sets `?repo=` for a non-default repository
 *  and drops it for the default one, keeping every other param. */
export function withRepository(href: string, repository: string): string {
  const url = new URL(href, "http://x");
  url.searchParams.delete(REPO_PARAM);
  if (repository !== DEFAULT_REPOSITORY) {
    url.searchParams.set(REPO_PARAM, repository);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The Test Explorer with run `uuid` pinned, scoped to `repository`. */
export function runHref(uuid: string, repository: string): string {
  return withRepository(`/?${new URLSearchParams({ run: uuid })}`, repository);
}
