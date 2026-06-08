import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // SelfQA: generated apps + heavy artifacts have their own configs; don't lint them.
    "workspace/**",
    "artifacts/**",
  ]),
  // SPEC §6.3 — hot-path files must NEVER import an LLM provider (enforced, not aspirational).
  {
    files: ["src/lib/core/harness/**/*.ts", "src/lib/core/walk/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/provider", "**/provider/*"],
              message: "Hot-path files (SPEC §6.3) must not import an LLM provider.",
            },
            {
              group: ["@anthropic-ai/sdk"],
              message: "Hot-path files (SPEC §6.3) must not import the Anthropic SDK.",
            },
          ],
        },
      ],
    },
  },
  // Allow intentionally-unused params/vars when prefixed with _ (e.g. seam hooks).
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
]);

export default eslintConfig;
