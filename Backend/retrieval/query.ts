export type QueryOptimizationContext = {
  originalQuery: string;
  queryWithoutUrls: string;
  referencedUrls: string[];
  referencedDomains: string[];
  optimizedSearchQuery: string;
  llmFocusBlock: string;
};

const URL_MATCH_REGEX = /https?:\/\/[^\s<>"'`]+/gi;

export function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((v) => typeof v === "string" && v.startsWith("http")))];
}

function trimTrailingUrlPunctuation(value: string) {
  return value.replace(/[),.;!?]+$/g, "");
}

export function normalizeUrl(value: string) {
  const candidate = trimTrailingUrlPunctuation(value.trim());

  try {
    const parsed = new URL(candidate);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function hostnameOf(url: string) {
  return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
}

export function extractUrlsFromQuery(query: string) {
  const matches = query.match(URL_MATCH_REGEX) ?? [];
  const normalized = matches
    .map((value) => normalizeUrl(value))
    .filter((value): value is string => Boolean(value));

  return dedupeStrings(normalized);
}

export function extractDomainsFromUrls(urls: string[]) {
  const domains = urls
    .map((value) => {
      try {
        return hostnameOf(value);
      } catch {
        return null;
      }
    })
    .filter((value): value is string => Boolean(value));

  // not dedupeStrings: domains don't start with "http"
  return [...new Set(domains)];
}

export function stripUrlsFromQuery(query: string) {
  return query.replace(URL_MATCH_REGEX, " ").replace(/\s+/g, " ").trim();
}

export function buildOptimizedSearchQuery(
  queryWithoutUrls: string,
  referencedUrls: string[],
  referencedDomains: string[],
) {
  const parts: string[] = [];

  if (queryWithoutUrls) {
    parts.push(queryWithoutUrls);
  }

  if (referencedUrls.length) {
    parts.push(...referencedUrls.map((url) => `"${url}"`));
  }

  if (referencedDomains.length) {
    parts.push(...referencedDomains.map((domain) => `site:${domain}`));
  }

  return parts.join(" ").trim();
}

function buildLlmFocusBlock({
  referencedUrls,
  referencedDomains,
  optimizedSearchQuery,
}: Pick<
  QueryOptimizationContext,
  "referencedUrls" | "referencedDomains" | "optimizedSearchQuery"
>) {
  if (!referencedUrls.length && !referencedDomains.length) {
    return "No explicit URL or domain focus provided.";
  }

  return [
    referencedUrls.length
      ? `- Explicit URLs from the user: ${referencedUrls.join(", ")}`
      : "- Explicit URLs from the user: none",
    referencedDomains.length
      ? `- Preferred domains: ${referencedDomains.join(", ")}`
      : "- Preferred domains: none",
    optimizedSearchQuery
      ? `- Search emphasis used upstream: ${optimizedSearchQuery}`
      : "- Search emphasis used upstream: none",
    "- Prioritize extracted content from the explicit URLs first when it is relevant.",
    "- Use same-domain search results as supporting context before unrelated sources.",
  ].join("\n");
}

export function buildQueryOptimizationContext(query: string): QueryOptimizationContext {
  const referencedUrls = extractUrlsFromQuery(query);
  const referencedDomains = extractDomainsFromUrls(referencedUrls);
  const queryWithoutUrls = stripUrlsFromQuery(query);
  const optimizedSearchQuery =
    buildOptimizedSearchQuery(queryWithoutUrls, referencedUrls, referencedDomains) ||
    query;

  return {
    originalQuery: query,
    queryWithoutUrls,
    referencedUrls,
    referencedDomains,
    optimizedSearchQuery,
    llmFocusBlock: buildLlmFocusBlock({
      referencedUrls,
      referencedDomains,
      optimizedSearchQuery,
    }),
  };
}

export function isFocusedDomainMatch(url: string, referencedDomains: string[]) {
  if (!referencedDomains.length) {
    return false;
  }

  try {
    return referencedDomains.includes(hostnameOf(url));
  } catch {
    return false;
  }
}
