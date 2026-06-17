import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pure logic + client fetch serialization run fine under Node. The
    // server query layer (gRPC) is covered by the Playwright E2E suite against
    // a real seeded Weaviate, not here.
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
