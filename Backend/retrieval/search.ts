import { tavly } from "../config";
import { truncateText } from "../lib/text";
import { withTimeout } from "../lib/timeout";
import {
  buildQueryOptimizationContext,
  dedupeStrings,
  isFocusedDomainMatch,
  normalizeUrl,
} from "./query";

export type WebSearchResult = {
  title: string;
  url: string;
  content: string;
  rawContent?: string;
  score?: number;
  publishedDate?: string;
  favicon?: string;
  images?: string[];
  sourceType: "search" | "direct_url_extract";
  focusedByUser?: boolean;
};

const DIRECT_EXTRACT_CONTENT_CHAR_LIMIT = 12_000; // matches the chunker's per-page cap
const DIRECT_EXTRACT_SNIPPET_CHAR_LIMIT = 1_200;
// Tavily calls have no built-in deadline; a hung request used to stall the whole answer.
const SEARCH_TIMEOUT_MS = 20_000;
// Tavily's basic depth sometimes keys on one word of a full question ("Who won ... Nobel Prize" returned pages about
// the Korean won, best score 0.06; relevant results score 0.7-0.9). Below this, retry once at advanced depth.
export const LOW_RELEVANCE_SCORE = 0.2;

export const isLowRelevance = (results: Array<{ score?: number }>) =>
  results.length > 0 && Math.max(...results.map((r) => r.score ?? 0)) < LOW_RELEVANCE_SCORE;

export function dedupeWebSearchResults(results: WebSearchResult[]) {
  const seen = new Set<string>();

  return results.filter((result) => {
    const normalizedUrl = normalizeUrl(result.url) ?? result.url;

    if (seen.has(normalizedUrl)) {
      return false;
    }

    seen.add(normalizedUrl);
    return true;
  });
}

export const wantsImages = (query: string) =>
  /image|photo|picture|visual|graph|chart|show me|display|gallery/i.test(query);

/** `images` overrides the keyword check, e.g. for a deep-research sub-query of a question that asked for images. */
export async function getWebSearchResults(query: string, { images }: { images?: boolean } = {}) {
  const queryContext = buildQueryOptimizationContext(query);

  const needsImages = images ?? wantsImages(query);
  console.log(`[Tavily] Query images needed: ${needsImages}`);

  // Run URL extraction and web search in PARALLEL instead of sequentially
  const extractionPromise = queryContext.referencedUrls.length
    ? withTimeout(tavly
        .extract(queryContext.referencedUrls, {
          extractDepth: "advanced",
          format: "markdown",
          includeImages: needsImages,
          includeFavicon: true,
          query: queryContext.queryWithoutUrls || undefined,
        }), SEARCH_TIMEOUT_MS, "Tavily extract")
        .catch((error) => {
          console.error("Direct URL extraction failed", error);
          return null;
        })
    : Promise.resolve(null);

  const search = (searchDepth: "basic" | "advanced") => withTimeout(tavly
    .search(queryContext.optimizedSearchQuery, {
      searchDepth,
      includeDomains: queryContext.referencedDomains.length
        ? queryContext.referencedDomains
        : undefined,
      includeFavicon: true,
      includeImages: needsImages,
      includeImageDescriptions: needsImages,
      includeRawContent: "markdown", // full page text for chunking; snippets alone lose most of the page
    }), SEARCH_TIMEOUT_MS, "Tavily search")
    .catch((error) => {
      console.error("Web search failed", error);
      return null;
    });

  const [extracted, basicResults] = await Promise.all([
    extractionPromise,
    search("basic"),
  ]);

  let webResults = basicResults;
  if (basicResults && isLowRelevance(basicResults.results ?? [])) {
    console.warn(`[Tavily] low-relevance results for ${JSON.stringify(queryContext.optimizedSearchQuery)}; retrying at advanced depth`);
    const advanced = await search("advanced");
    if (advanced && !isLowRelevance(advanced.results ?? [])) webResults = advanced;
  }

  // Process extraction results
  const extractedResults: WebSearchResult[] = [];
  const extractedImages: string[] = [];

  if (extracted) {
    extractedResults.push(
      ...extracted.results.map((result) => {
        // Keep newlines: the chunker splits on paragraph boundaries
        const rawContent = (result.rawContent ?? "").slice(0, DIRECT_EXTRACT_CONTENT_CHAR_LIMIT);

        return {
          title: result.title?.trim() || result.url,
          url: result.url,
          content: truncateText(rawContent, DIRECT_EXTRACT_SNIPPET_CHAR_LIMIT),
          rawContent,
          favicon: result.favicon,
          images: result.images ?? [],
          sourceType: "direct_url_extract" as const,
          focusedByUser: true,
        };
      }),
    );

    extracted.results.forEach((res: any) => {
      if (res.images && Array.isArray(res.images)) {
        extractedImages.push(
          ...res.images.map((img: any) =>
            typeof img === "string" ? img : img.url,
          ).filter(Boolean),
        );
      }
    });
  }

  // Process search results
  let searchResults: WebSearchResult[] = [];
  let fetchedImages: string[] = [];

  if (webResults) {
    const rawImages = (webResults as any).images || [];
    fetchedImages = rawImages
      .map((img: any) => (typeof img === "string" ? img : img.url))
      .filter(Boolean);
    console.log(
      `[Tavily] Search returned ${fetchedImages.length} images. First: ${fetchedImages[0] || "none"}`,
    );

    searchResults = (webResults.results ?? []).map((result) => ({
      ...result,
      rawContent: result.rawContent?.slice(0, DIRECT_EXTRACT_CONTENT_CHAR_LIMIT),
      sourceType: "search" as const,
      focusedByUser: isFocusedDomainMatch(
        result.url,
        queryContext.referencedDomains,
      ),
    }));
  }

  if (!extractedResults.length && !searchResults.length) {
    throw new Error("Both search and extraction failed");
  }

  return {
    queryContext,
    results: dedupeWebSearchResults([...extractedResults, ...searchResults]),
    images: dedupeStrings([...extractedImages, ...fetchedImages]),
  };
}
