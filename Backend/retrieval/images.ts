const CHECK_TIMEOUT_MS = 2500;
const MAX_CHECKED = 12; // the prompt shows at most 8 candidates

/** Only public https hosts: the URLs come from scraped pages, so never probe localhost or raw IPs. */
function isCheckable(url: string) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && hostname.includes(".") && !/^[\d.]+$|^\[|localhost$/i.test(hostname);
  } catch {
    return false;
  }
}

async function isLiveImage(url: string) {
  try {
    // GET with a 1-byte range: many CDNs reject HEAD
    const res = await fetch(url, {
      headers: { Range: "bytes=0-0", "User-Agent": "Gaminai/1.0 (+https://gaminai-alpha.vercel.app)" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    await res.body?.cancel();
    return res.ok && (res.headers.get("content-type") ?? "").startsWith("image/");
  } catch {
    return false;
  }
}

/** The subset of `urls` that currently load as images, checked in parallel. Unchecked extras are dropped. */
export async function liveImageUrls(urls: string[]) {
  const candidates = [...new Set(urls)].filter(isCheckable).slice(0, MAX_CHECKED);
  const live = await Promise.all(candidates.map(isLiveImage));
  return candidates.filter((_, i) => live[i]);
}
