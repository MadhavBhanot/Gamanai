import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("../db", () => ({ prisma: { requestLog: { create } } }));
vi.mock("../llm/providers", () => ({ ANSWER_CHAIN: [{ label: "google:primary" }] }));

const { startRequestLog } = await import("../lib/requestLog");

describe("startRequestLog", () => {
  beforeEach(() => {
    create.mockReset().mockResolvedValue({}); // braces: a function returned from beforeEach runs as a cleanup hook
  });

  it("writes one row, marks fallbacks, and ignores later finishes", async () => {
    const log = startRequestLog({ route: "guest", mode: "deep" });
    log.finish({ ok: true, model: "groq:backup", ttftMs: 812.6, researchSteps: 3 });
    log.finish({ ok: false, error: "late failure" });

    expect(create).toHaveBeenCalledTimes(1);
    const { data } = create.mock.calls[0][0];
    expect(data).toMatchObject({ route: "guest", mode: "deep", ok: true, fellBack: true, ttftMs: 813, researchSteps: 3 });
    expect(Number.isInteger(data.totalMs)).toBe(true);
  });

  it("never throws when the table is missing", async () => {
    create.mockImplementation(async () => {
      throw new Error('relation "RequestLog" does not exist');
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    startRequestLog({ route: "ai", mode: "quick" }).finish({ ok: true, model: "google:primary" });
    await new Promise((r) => setTimeout(r, 0));
    expect(create.mock.calls[0][0].data.fellBack).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });
});
