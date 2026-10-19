import { defineConfig } from "vitest/config";

// Dummy keys so modules that construct SDK clients can be imported; tests never hit the network.
export default defineConfig({
  test: { env: { TAVILY_API_KEY: "test", Groq_API_Key: "test" } },
});
