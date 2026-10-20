import { afterEach, describe, expect, it, vi } from "vitest";
import { liveImageUrls } from "../retrieval/images";

const reply = (status: number, type: string) => new Response(status === 404 ? null : "x", { status, headers: { "content-type": type } });

describe("liveImageUrls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps only https images that load, without probing private hosts", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      if (url.includes("ok")) return reply(206, "image/jpeg");
      if (url.includes("page")) return reply(200, "text/html");
      if (url.includes("gone")) return reply(404, "text/html");
      throw new Error("ENOTFOUND");
    });

    const live = await liveImageUrls([
      "https://cdn.example.com/ok.jpg",
      "https://cdn.example.com/ok.jpg", // duplicate
      "https://example.com/page",
      "https://example.com/gone.png",
      "https://thumb.dead-host.org/x.jpg",
      "http://example.com/ok-but-http.jpg",
      "https://localhost/ok.jpg",
      "https://169.254.169.254/ok.jpg",
    ]);

    expect(live).toEqual(["https://cdn.example.com/ok.jpg"]);
    expect(fetched).not.toContain("https://localhost/ok.jpg");
    expect(fetched).not.toContain("https://169.254.169.254/ok.jpg");
    expect(fetched).toHaveLength(4);
  });
});
