import { PROMPT_TEMPLATE } from "../prompt";
import { hostnameOf, normalizeUrl, type QueryOptimizationContext } from "../retrieval/query";
import type { WebSearchResult } from "../retrieval/search";

type ImageCandidate = {
  url: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceDomain: string;
  sourceType: "search" | "direct_url_extract";
  focusedByUser?: boolean;
};

function extractImageCandidates(results: WebSearchResult[]) {
  const seen = new Set<string>();
  const candidates: ImageCandidate[] = [];

  for (const result of results) {
    const sourceUrl = normalizeUrl(result.url);

    if (!sourceUrl) {
      continue;
    }

    const sourceDomain = hostnameOf(sourceUrl);
    const sourceTitle = result.title.trim() || sourceDomain;

    for (const imageUrl of result.images ?? []) {
      const normalizedImageUrl = normalizeUrl(imageUrl);

      if (!normalizedImageUrl || seen.has(normalizedImageUrl)) {
        continue;
      }

      seen.add(normalizedImageUrl);
      candidates.push({
        url: normalizedImageUrl,
        sourceUrl,
        sourceTitle,
        sourceDomain,
        sourceType: result.sourceType,
        focusedByUser: result.focusedByUser,
      });
    }
  }

  return candidates;
}

function imageCandidateFromUrl(url: string): ImageCandidate | null {
  const normalizedUrl = normalizeUrl(url);

  if (!normalizedUrl) {
    return null;
  }

  return {
    url: normalizedUrl,
    sourceUrl: normalizedUrl,
    sourceTitle: "Tavily image result",
    sourceDomain: hostnameOf(normalizedUrl),
    sourceType: "search",
  };
}

function dedupeImageCandidates(candidates: ImageCandidate[]) {
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    if (seen.has(candidate.url)) {
      return false;
    }

    seen.add(candidate.url);
    return true;
  });
}

function buildImageFocusBlock(imageCandidates: ImageCandidate[]) {
  if (!imageCandidates.length) {
    return [
      "No verified image candidates were collected from the search pipeline.",
      "Do not invent, guess, or transform image URLs.",
      "If the user asks for images, say that no verified image links were found and only cite source pages.",
    ].join("\n");
  }

  return [
    "Only use image URLs from this section when rendering markdown images.",
    "Do not invent, guess, or transform image URLs.",
    "Each image URL below is verified from a source page in the search pipeline.",
    JSON.stringify(imageCandidates, null, 2),
  ].join("\n");
}

/** One numbered source passage shown to the model and cited as [n] (n = index + 1). */
export type SourceContext = { url: string; title: string; text: string };

export function formatSources(contexts: SourceContext[]) {
  return contexts.map((c, i) => `[${i + 1}] ${c.title} (${c.url})\n${c.text}`).join("\n\n");
}

export function buildPrompt(
  queryContext: QueryOptimizationContext,
  contexts: SourceContext[],
  webSearchResponse: WebSearchResult[],
  images: string[] = [],
) {
  const imageCandidates = dedupeImageCandidates([
    ...extractImageCandidates(webSearchResponse),
    ...images
      .map(imageCandidateFromUrl)
      .filter((candidate): candidate is ImageCandidate => Boolean(candidate)),
  ]);

  return PROMPT_TEMPLATE.replace(
    "{{QUERY_FOCUS}}",
    () => queryContext.llmFocusBlock,
  ).replace(
    "{{WEB_SEARCH_RESULTS}}",
    () => formatSources(contexts),
  ).replace(
    "{{IMAGE_CANDIDATES}}",
    () => buildImageFocusBlock(imageCandidates.slice(0, 8)),
  ).replace("{{USER_QUERY}}", () => queryContext.originalQuery);
}
