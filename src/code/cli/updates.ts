import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { readJson, atomicJson, isMissing, privateDirectory } from "../persistence/storage.js";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { acquireSessionLock } from "../persistence/locks.js";

const exec = promisify(execFile);
const packageName = z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u);
const version = z.string().regex(/^\d+\.\d+\.\d+$/u);
const metadataSchema = z.object({ name: packageName, version: z.string(), private: z.boolean().optional(), bin: z.record(z.string(), z.string()).optional() });
export interface UpdateSettings { updatePackage?: string | undefined; autoUpdate?: boolean | undefined; updateCheck?: boolean | undefined; offline?: boolean | undefined }
export interface UpdatePlan { package: string; currentVersion: string; version: string; prefix: string; publishedAt: string; argv: string[] }
export type PackageRunner = (args: string[]) => Promise<string>;
const runNpm: PackageRunner = async (args) => {
  try {
    const { stdout } = await exec(process.platform === "win32" ? "npm.cmd" : "npm", args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", windowsHide: true });
    return stdout;
  } catch { throw new Error(`npm ${args[0]} failed or timed out. Inspect npm locally; raw package-manager diagnostics are withheld to avoid exposing registry credentials.`); }
};
const newer = (a: string, b: string) => {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index]! > right[index]!;
  return false;
};

export class ApplicationUpdates {
  constructor(private readonly settings: UpdateSettings, private readonly packageFile = fileURLToPath(new URL("../../../package.json", import.meta.url)), private readonly run: PackageRunner = runNpm) {}
  async status() {
    const metadata = metadataSchema.parse(await readJson(this.packageFile));
    if (metadata.private || !this.settings.updatePackage || metadata.name !== this.settings.updatePackage || !metadata.bin?.["dcode-ts"]) return { kind: "development" as const, version: metadata.version, reason: "Self-updates are disabled for this source checkout or unbound distribution. No public package identity has been confirmed." };
    packageName.parse(this.settings.updatePackage);
    const prefix = (await this.run(["prefix", "--global"])).trim();
    const root = (await this.run(["root", "--global"])).trim();
    const expected = await realpath(join(root, metadata.name));
    if (expected !== await realpath(dirname(this.packageFile))) throw new Error("The running application is not the detected global npm installation; refusing to update another copy");
    return { kind: "npm" as const, package: metadata.name, version: version.parse(metadata.version), prefix };
  }
  async check(now = Date.now()): Promise<{ status: Awaited<ReturnType<ApplicationUpdates["status"]>>; plan: UpdatePlan | null }> {
    const status = await this.status();
    if (status.kind !== "npm" || this.settings.offline || this.settings.updateCheck === false) return { status, plan: null };
    const raw: unknown = JSON.parse(await this.run(["view", status.package, "versions", "time", "--json"]));
    const metadata = z.object({ versions: z.array(z.string()), time: z.record(z.string(), z.string()) }).parse(raw);
    const eligible = metadata.versions.filter((candidate) => version.safeParse(candidate).success && newer(candidate, status.version) && Number.isFinite(Date.parse(metadata.time[candidate] ?? "")) && Date.parse(metadata.time[candidate]!) <= now - 7 * 86_400_000);
    const selected = eligible.reduce((best, candidate) => !best || newer(candidate, best) ? candidate : best, "");
    if (!selected) return { status, plan: null };
    return { status, plan: { package: status.package, currentVersion: status.version, version: selected, prefix: status.prefix, publishedAt: metadata.time[selected]!, argv: ["install", "--global", "--prefix", status.prefix, "--ignore-scripts", "--", `${status.package}@${selected}`] } };
  }
  async apply(plan: UpdatePlan, acknowledgement: string) {
    if (acknowledgement !== `Update ${plan.package} to ${plan.version}`) throw new Error("Explicit acknowledgement is required for this exact application update");
    const checked = await this.check();
    if (!checked.plan || JSON.stringify(checked.plan) !== JSON.stringify(plan)) throw new Error("Installation or update metadata changed; review the update again");
    const release = await acquireSessionLock(join(plan.prefix, ".dcode-ts-update.lock"));
    try {
      const before = metadataSchema.parse(await readJson(this.packageFile));
      if (before.name !== plan.package || before.version !== plan.currentVersion) throw new Error("Installation changed while waiting for the update lock");
      await this.run(checked.plan.argv);
      const installed = metadataSchema.parse(await readJson(this.packageFile));
      if (installed.name !== plan.package || installed.version !== plan.version) throw new Error("npm did not install the expected version; inspect the installation before restarting");
      return { version: installed.version, restartRequired: true };
    } finally { await release(); }
  }
  async automatic(notice: (message: string) => void | Promise<void>, directory = join(homedir(), ".config", "dcode-ts", "updates")) {
    const status = await this.status();
    if (status.kind !== "npm" || this.settings.offline || this.settings.autoUpdate === false || this.settings.updateCheck === false) return;
    if (this.settings.autoUpdate === undefined) {
      const marker = join(directory, `${createHash("sha256").update(status.package).digest("hex")}.json`);
      try { z.object({ version: z.literal(1), announced: z.literal(true) }).parse(await readJson(marker)); }
      catch (error) {
        if (!isMissing(error)) throw error;
        await notice("Automatic updates are enabled for this npm installation. No update will run on this first launch. Use /auto-update off to opt out; source checkouts never self-update.");
        await privateDirectory(directory);
        await atomicJson(marker, { version: 1, announced: true });
        return;
      }
    }
    const checked = await this.check();
    if (!checked.plan) return;
    await notice(`Automatically updating ${checked.plan.package}: ${checked.plan.currentVersion} -> ${checked.plan.version}. No session has started yet.`);
    return this.apply(checked.plan, `Update ${checked.plan.package} to ${checked.plan.version}`);
  }
}
