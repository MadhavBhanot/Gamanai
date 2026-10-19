import crypto from "node:crypto";

// Sized for Gemini's free embedding tier (100 texts/min): ~8 chunks/page, ~64/question at most.
const CHUNK_CHARS = 1500;
const OVERLAP_CHARS = 200;
// The answer is usually early on the page; the tail is mostly navigation/footer, and every chunk costs an embedding.
const MAX_PAGE_CHARS = 12_000;

/** Strip markdown noise that hurts both embeddings and full-text search. */
export function cleanPageText(markdown: string) {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> link text
    .replace(/<[^>]+>/g, " ") // stray html
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Split text into ~CHUNK_CHARS windows with OVERLAP_CHARS overlap, snapping each end back to a
 * paragraph or sentence boundary when one sits in the back half of the window.
 */
export function chunkText(text: string, size = CHUNK_CHARS, overlap = OVERLAP_CHARS) {
  const source = text.slice(0, MAX_PAGE_CHARS);
  const chunks: string[] = [];
  let start = 0;

  while (start < source.length) {
    let end = Math.min(start + size, source.length);
    if (end < source.length) {
      const window = source.slice(start, end);
      const boundary = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "));
      if (boundary > size / 2) end = start + boundary + 1;
    }
    const chunk = source.slice(start, end).trim();
    if (chunk.length > 40) chunks.push(chunk); // skip crumbs like lone headings
    if (end >= source.length) break;
    start = Math.max(end - overlap, start + 1);
    const space = source.indexOf(" ", start); // don't open the next chunk mid-word
    if (space !== -1 && space < end) start = space + 1;
  }

  return chunks;
}

export const hashContent = (content: string) => crypto.createHash("sha1").update(content).digest("hex");
