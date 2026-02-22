import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
    resolve: {
        alias: {
            obsidian: resolve(__dirname, "tests/__mocks__/obsidian.ts"),
            src: resolve(__dirname, "src"),
        },
    },
    test: {
        environment: "node",
        globals: true,
        testTimeout: 120_000, // real API calls
        hookTimeout: 60_000,
    },
});
