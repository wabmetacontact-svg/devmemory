import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.join(root, "packages", name, "src", "index.ts");

export default defineConfig({
  resolve: {
    // Tests run against the TypeScript sources so a build is never a prerequisite.
    alias: {
      "@samirthakur024/shared": pkg("shared"),
      "@samirthakur024/storage": pkg("storage"),
      "@samirthakur024/indexer": pkg("indexer"),
      "@samirthakur024/core": pkg("core"),
      "@samirthakur024/mcp": pkg("mcp"),
      "@samirthakur024/dashboard": path.join(root, "apps", "dashboard", "src", "index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    fileParallelism: false,
  },
});
