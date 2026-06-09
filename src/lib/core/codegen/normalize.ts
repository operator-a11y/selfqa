/**
 * Scaffold normalization — make a generated app BUILDABLE regardless of which
 * model produced it.
 *
 * The build-agent owns the APP (src/app/*, routes, logic); SelfQA owns the
 * SCAFFOLD (package.json versions + scripts, next/ts/postcss config). Local models
 * (and occasionally the API) pin an old Next, emit a next.config.ts the pinned Next
 * can't load, use Tailwind-v3 globals, or leave type errors — all of which fail
 * `next build` for reasons that have nothing to do with whether the app works.
 *
 * So we OVERWRITE the scaffold with a known-good baseline (keeping the model's own
 * dependencies so its imports still resolve), and tell Next to not fail the build
 * on the model's TypeScript/ESLint slips — the app is a test SUBJECT here; what
 * matters is that it runs so SelfQA can walk it.
 *
 * Pure (string/JSON only). Applied in the worker after buildApp, before instrument.
 */
import type { GeneratedApp } from "./build-agent";
import type { GeneratedFile } from "./protocol";

const NEXT_CONFIG = `/** @type {import('next').NextConfig} */
const nextConfig = {
  // SelfQA test subjects: a model's type/lint slip must not block a runnable build.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
`;

const POSTCSS = `const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
`;

const GLOBALS = `@import "tailwindcss";\n`;

const GITIGNORE = `node_modules\n.next\nnext-env.d.ts\n*.db\n*.db-wal\n*.db-shm\n`;

const CORE_DEPS: Record<string, string> = {
  next: "16.2.7",
  react: "19.2.4",
  "react-dom": "19.2.4",
};
const CORE_DEV_DEPS: Record<string, string> = {
  "@tailwindcss/postcss": "^4",
  "@types/node": "^24",
  "@types/react": "^19",
  "@types/react-dom": "^19",
  tailwindcss: "^4",
  typescript: "^5",
};

function normalizePackageJson(raw: string | undefined): string {
  let pkg: Record<string, unknown> = {};
  try {
    if (raw) pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    pkg = {};
  }
  const deps = { ...(pkg.dependencies as Record<string, string> | undefined), ...CORE_DEPS };
  const devDeps = { ...(pkg.devDependencies as Record<string, string> | undefined), ...CORE_DEV_DEPS };
  const scripts = { ...(pkg.scripts as Record<string, string> | undefined), dev: "next dev", build: "next build", start: "next start" };
  return JSON.stringify(
    {
      name: typeof pkg.name === "string" && pkg.name ? pkg.name : "selfqa-generated-app",
      version: "0.1.0",
      private: true,
      scripts,
      dependencies: deps,
      devDependencies: devDeps,
    },
    null,
    2,
  );
}

export function normalizeGeneratedApp(app: GeneratedApp): GeneratedApp {
  const byPath = new Map(app.files.map((f) => [f.path, f] as const));
  const set = (path: string, content: string): void => {
    byPath.set(path, { path, content });
  };

  // Force the scaffold to a known-good baseline (any model-emitted variant removed).
  for (const p of ["next.config.ts", "next.config.js", "next.config.mjs"]) byPath.delete(p);
  set("next.config.mjs", NEXT_CONFIG);
  set("tsconfig.json", TSCONFIG);
  for (const p of ["postcss.config.js", "postcss.config.mjs"]) byPath.delete(p);
  set("postcss.config.mjs", POSTCSS);
  set(".gitignore", GITIGNORE);
  set("package.json", normalizePackageJson(byPath.get("package.json")?.content));

  // Tailwind v4 globals at whichever app dir the model used (src/app preferred).
  const globalsPath = byPath.has("app/globals.css") && !byPath.has("src/app/globals.css")
    ? "app/globals.css"
    : "src/app/globals.css";
  set(globalsPath, GLOBALS);

  const files: GeneratedFile[] = [...byPath.values()];
  return { ...app, files };
}
