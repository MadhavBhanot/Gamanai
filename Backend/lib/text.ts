import crypto from "node:crypto";

export function truncateText(value: string, maxChars: number) {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

export function slugify(text: string) {
  const base =
    text
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "chat";

  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}
