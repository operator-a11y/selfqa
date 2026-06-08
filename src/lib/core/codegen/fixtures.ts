/**
 * Fixtures contract (SPEC §12, §9.4) — the build-agent emits TWO artifacts: the
 * app AND a fixtures manifest so SelfQA can walk past its own auth/payment walls.
 *
 * This module is the typed + zod-validated manifest (pure — schema/parse only;
 * the fs loader lives in workspace/repo.ts to keep this client-safe). Seed-entity
 * ids are stable-by-contract (§9.4): the build-agent may add entities but must
 * not renumber/rename existing ones, same discipline as test-ids.
 */
import { z } from "zod";

export const FIXTURES_FILENAME = "selfqa.fixtures.json";

export const FixturesManifestSchema = z.object({
  /** seed users + a way to log in as them */
  seedUsers: z
    .array(
      z.object({
        id: z.string().min(1),
        email: z.string().min(1),
        password: z.string().min(1),
      }),
    )
    .default([]),
  loginHook: z
    .object({
      kind: z.enum(["programmatic", "form", "none"]),
      note: z.string().optional(),
    })
    .optional(),
  /** mock payment keys, etc. (never real) */
  mockKeys: z.record(z.string(), z.string()).default({}),
  stubbedEmailOtp: z.boolean().default(false),
  /** deterministic seed data with STABLE ids (§9.4) */
  seedData: z
    .array(z.object({ entity: z.string().min(1), id: z.string().min(1) }))
    .default([]),
  /** the snapshot/restore hook = isolation primitive (§9.2); "none" for client-state apps */
  snapshotRestore: z
    .object({ kind: z.enum(["db-file-copy", "none"]), note: z.string().optional() })
    .default({ kind: "none" }),
});

export type FixturesManifest = z.infer<typeof FixturesManifestSchema>;

export function parseFixturesManifest(json: unknown): FixturesManifest {
  return FixturesManifestSchema.parse(json);
}
