import { describe, expect, it } from "vitest";
import { citationQuote } from "../llm/stream";

describe("citationQuote", () => {
  it("takes six words from the first capitalised plain run", () => {
    expect(citationQuote("ends mid sentence. The HNSW index builds a multilayer graph of vectors, which is fast."))
      .toBe("The HNSW index builds a multilayer");
  });

  it("skips runs containing markdown or links", () => {
    expect(citationQuote("## **Install** [docs](https://x.y) Run the installer and then restart the server now"))
      .toBe("Run the installer and then restart");
  });

  it("drops trailing punctuation and returns undefined when nothing fits", () => {
    expect(citationQuote("Postgres stores vectors in tables, rows")).toBe("Postgres stores vectors in tables, rows");
    expect(citationQuote("Too short")).toBeUndefined();
    expect(citationQuote("| a | b | c | d | e | f |")).toBeUndefined();
  });
});
