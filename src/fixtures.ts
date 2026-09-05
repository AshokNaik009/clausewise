import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { RegCompareError } from "./errors.js";

const expectationSchema = z.object({
  min_published_findings: z.number().int().min(1),
  required_concept_ids: z.array(z.string().min(1)),
  expected_profile: z.enum(["consultation-impact", "version-change", "cross-guidance", "policy-gap"]),
  minimum_materiality_counts: z.record(z.string(), z.number().int().nonnegative()).optional(),
  minimum_action_counts: z.record(z.string(), z.number().int().nonnegative()).optional(),
}).strict();

const fixtureSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().min(1),
  publisher: z.string().min(1),
  jurisdiction: z.literal("UAE"),
  status: z.string().min(1),
  publication_date: z.string().date(),
  original_url: z.string().url().refine((value) => value.startsWith("https://"), "Fixture URL must use HTTPS."),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  local_path: z.string().min(1).nullable(),
  fetch_state: z.enum(["committed", "operator_fetch_required"]),
  applicable_profiles: z.array(z.enum(["consultation-impact", "version-change", "cross-guidance", "policy-gap"])).min(1),
  license_terms_review: z.string().min(1),
  expectation_manifest_path: z.string().min(1),
  quarantine: z.object({ owner: z.string().min(1), reason: z.string().min(1), created_at: z.string().date(), expires_at: z.string().date() }).strict().optional(),
}).strict();

const fixtureManifestSchema = z.object({ schema_version: z.literal("1.0"), fixtures: z.array(fixtureSchema) }).strict();
export type Fixture = z.infer<typeof fixtureSchema>;

// Some regulator file stores (CBUAE's among them) reject any request whose
// agent string is not in the conventional `Mozilla/5.0 (...)` form, so fixture
// downloads use the `compatible` variant: it satisfies those filters while
// still naming this tool rather than impersonating a browser.
const FIXTURE_FETCH_USER_AGENT = "Mozilla/5.0 (compatible; reg-compare/0.1; +fixture download)";

function hash(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function loadManifest(projectRoot: string): Promise<z.infer<typeof fixtureManifestSchema>> {
  const path = join(projectRoot, "fixtures", "manifest.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new RegCompareError("fixture_manifest_missing", `Fixture manifest is missing: ${path}`, 3);
  }
  try {
    return fixtureManifestSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new RegCompareError("fixture_manifest_invalid", error instanceof Error ? error.message : "Fixture manifest is invalid.", 3);
  }
}

async function validateExpectation(projectRoot: string, fixture: Fixture): Promise<void> {
  const path = resolve(projectRoot, fixture.expectation_manifest_path);
  if (!path.startsWith(resolve(projectRoot) + "/")) throw new RegCompareError("fixture_path_invalid", `Fixture expectation path escapes the project: ${fixture.id}`, 3);
  try {
    expectationSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new RegCompareError("fixture_expectation_invalid", `${fixture.id}: ${error instanceof Error ? error.message : "invalid expectation manifest"}`, 3);
  }
}

export async function verifyFixtures(projectRoot: string): Promise<{ schema_version: "1.0"; valid: boolean; fixtures: { id: string; valid: boolean; detail: string }[] }> {
  const manifest = await loadManifest(projectRoot);
  const results: { id: string; valid: boolean; detail: string }[] = [];
  for (const fixture of manifest.fixtures) {
    try {
      await validateExpectation(projectRoot, fixture);
      const relativePath = fixture.local_path ?? join("fixtures", "cache", `${fixture.id}-${basename(new URL(fixture.original_url).pathname) || "source"}`);
      const path = resolve(projectRoot, relativePath);
      if (!path.startsWith(resolve(projectRoot) + "/")) throw new RegCompareError("fixture_path_invalid", "Fixture source path escapes the project.", 3);
      const details = await stat(path).catch(() => null);
      if (!details && fixture.fetch_state === "operator_fetch_required") {
        results.push({ id: fixture.id, valid: true, detail: "Metadata and expectation manifest valid; operator fetch required." });
        continue;
      }
      if (!details?.isFile()) throw new RegCompareError("fixture_file_missing", "Committed fixture source is absent.", 3);
      const contents = await readFile(path);
      if (hash(contents) !== fixture.source_sha256) throw new RegCompareError("fixture_hash_mismatch", "Fixture source hash differs from manifest.", 3);
      results.push({ id: fixture.id, valid: true, detail: fixture.fetch_state === "operator_fetch_required" ? "Cached operator download hash and expectation manifest valid." : "Source hash and expectation manifest valid." });
    } catch (error) {
      results.push({ id: fixture.id, valid: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return { schema_version: "1.0", valid: results.every((result) => result.valid), fixtures: results };
}

export async function fetchFixture(projectRoot: string, id: string, confirmed: boolean): Promise<{ id: string; path: string; sha256: string }> {
  if (!confirmed) throw new RegCompareError("fixture_fetch_confirmation_required", "fixtures fetch requires --confirm-public-download.", 1);
  const manifest = await loadManifest(projectRoot);
  const fixture = manifest.fixtures.find((item) => item.id === id);
  if (!fixture) throw new RegCompareError("unknown_fixture", `Unknown fixture ID: ${id}`, 1);
  if (fixture.fetch_state !== "operator_fetch_required") throw new RegCompareError("fixture_fetch_not_required", `Fixture ${id} is already committed.`, 1);
  const response = await fetch(fixture.original_url, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    headers: { "user-agent": FIXTURE_FETCH_USER_AGENT, accept: "application/pdf,*/*" },
  });
  if (!response.ok) throw new RegCompareError("fixture_download_failed", `Fixture download failed with HTTP ${response.status}.`, 2);
  const contents = Buffer.from(await response.arrayBuffer());
  const actualHash = hash(contents);
  if (actualHash !== fixture.source_sha256) throw new RegCompareError("fixture_hash_mismatch", `Downloaded fixture ${id} does not match its pinned SHA-256.`, 3);
  const cache = join(projectRoot, "fixtures", "cache");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const path = join(cache, `${id}-${basename(new URL(fixture.original_url).pathname) || "source"}`);
  await writeFile(path, contents, { mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new RegCompareError("fixture_cache_exists", `Cached fixture already exists: ${path}`, 1);
    throw error;
  });
  return { id, path, sha256: actualHash };
}
