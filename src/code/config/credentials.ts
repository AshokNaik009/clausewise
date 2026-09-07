import { createHash } from "node:crypto";
import { lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { USER_CONFIG_DIRECTORY, endpointSchema, type ProviderDefinition } from "./configuration.js";
import { atomicJson, isMissing, privateDirectory, readJson } from "../persistence/storage.js";

const credentialSchema = z.object({ version: z.literal(1), provider: z.string(), endpoint: endpointSchema, key: z.string().min(1).max(16_384), addedAt: z.string().datetime() }).strict();
const secrets = new Set<string>();
export function registerSecret(secret: string): void { if (secret) secrets.add(secret); }
export function redactSecrets(value: string): string {
  for (const secret of secrets) value = value.replaceAll(secret, "[redacted]");
  return value;
}

export class CredentialStore {
  constructor(private readonly directory = join(USER_CONFIG_DIRECTORY, "credentials")) {}
  private path(provider: string, endpoint: string): string { return join(this.directory, `${createHash("sha256").update(`${provider}\0${endpointSchema.parse(endpoint)}`).digest("hex")}.json`); }

  async get(provider: string, endpoint: string): Promise<string | undefined> {
    try {
      const parent = await lstat(this.directory);
      const path = this.path(provider, endpoint);
      const file = await lstat(path);
      if (!parent.isDirectory() || parent.isSymbolicLink() || file.isSymbolicLink() || (process.platform !== "win32" && ((parent.mode & 0o077) || (file.mode & 0o077)))) throw new Error("Credential storage requires private directory/file permissions (0700/0600)");
      const credential = credentialSchema.parse(await readJson(path));
      if (credential.provider !== provider || credential.endpoint !== endpointSchema.parse(endpoint)) throw new Error("Credential endpoint mismatch");
      secrets.add(credential.key);
      return credential.key;
    } catch (error) { if (isMissing(error)) return undefined; throw error; }
  }

  async set(provider: string, endpoint: string, key: string): Promise<void> {
    const value = credentialSchema.parse({ version: 1, provider, endpoint, key: key.trim(), addedAt: new Date().toISOString() });
    await privateDirectory(this.directory);
    const info = await lstat(this.directory);
    if (process.platform !== "win32" && (info.mode & 0o077)) throw new Error("Credential directory must have 0700 permissions");
    const path = this.path(provider, endpoint);
    const lockPath = `${path}.lock`;
    const lock = await open(lockPath, "wx", 0o600);
    try { await atomicJson(path, value); secrets.add(value.key); } finally { await lock.close(); await unlink(lockPath); }
  }

  async resolve(name: string, definition: ProviderDefinition): Promise<{ key: string; source: string }> {
    const stored = await this.get(name, definition.endpoint);
    if (stored) return { key: stored, source: "credential-store" };
    const envName = name === "openai" && definition.endpoint === "https://api.openai.com/v1" && process.env.DCODE_API_KEY ? "DCODE_API_KEY" : definition.apiKeyEnv;
    const key = envName ? process.env[envName] : undefined;
    if (key) { secrets.add(key); return { key, source: envName! }; }
    throw new Error(`No credential for provider ${name}. Use /auth or configure its explicit API-key environment variable.`);
  }
}
