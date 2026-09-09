import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentClient } from "../client/agent-client.js";
import { terminalText } from "../shared/output.js";

function argumentsFor(command: string): string[] {
  const args: string[] = [];
  let quote = "";
  let value = "";
  let escaped = false;
  for (const char of command) {
    if (escaped) { value += char; escaped = false; }
    else if (char === "\\" && quote !== "'") escaped = true;
    else if (quote) { if (char === quote) quote = ""; else value += char; }
    else if (char === "'" || char === '"') quote = char;
    else if (/\s/u.test(char)) { if (value) { args.push(value); value = ""; } }
    else value += char;
  }
  if (quote || escaped) throw new Error("Invalid quoting in editor command");
  if (value) args.push(value);
  if (!args.length) throw new Error("Set VISUAL or EDITOR to an editor command");
  return args;
}

export async function editPrompt(text: string, cwd: string): Promise<string> {
  const command = process.env.VISUAL ?? process.env.EDITOR;
  if (!command) throw new Error("Set VISUAL or EDITOR before using /editor");
  const [executable, ...args] = argumentsFor(command);
  const directory = await mkdtemp(join(tmpdir(), "dcode-editor-"));
  const path = join(directory, "prompt.txt");
  try {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(text); } finally { await file.close(); }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable!, [...args, path], { cwd, stdio: "inherit", shell: false, timeout: 10 * 60_000, killSignal: "SIGKILL" });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Editor exited ${code}; no prompt was sent`)));
    });
    const edited = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await edited.stat();
      if (!info.isFile() || info.size > 100_000) throw new Error("Edited prompt exceeds 100 KB");
      return terminalText(await edited.readFile("utf8"));
    } finally { await edited.close(); }
  } finally { await unlink(path); await rmdir(directory); }
}

export async function openUrl(value: string): Promise<void> {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Only HTTP(S) browser links without credentials are allowed");
  const command = process.platform === "darwin" ? ["open", url.href] : process.platform === "win32" ? ["rundll32.exe", "url.dll,FileProtocolHandler", url.href] : ["xdg-open", url.href];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: "ignore", shell: false, timeout: 10_000 });
    child.once("error", () => reject(new Error(`Browser launcher is unavailable. Open this URL manually: ${url.href}`)));
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Browser launcher failed. Open: ${url.href}`)));
  });
}

export async function copyText(text: string): Promise<void> {
  const command = process.platform === "darwin" ? ["pbcopy"] : process.platform === "win32" ? ["clip.exe"] : process.env.WAYLAND_DISPLAY ? ["wl-copy"] : ["xclip", "-selection", "clipboard"];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "ignore", "ignore"], shell: false, timeout: 5000 });
    child.once("error", () => reject(new Error("System clipboard utility is unavailable; use /export instead")));
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Clipboard command failed")));
    child.stdin.on("error", reject);
    child.stdin.end(terminalText(text));
  });
}

export async function readUserText(cwd: string, path: string, limit = 12_000): Promise<string> {
  const file = await open(resolve(cwd, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error(`Expected a regular text file up to ${limit} bytes`);
    return await file.readFile("utf8");
  } finally { await file.close(); }
}

export async function exportConversation(client: AgentClient, path: string): Promise<void> {
  if (!path.trim()) throw new Error("Use /export <new-file-path>");
  const data = { version: 1, session: client.session, messages: await client.history(), controls: await client.controls(), costs: (await client.result()).costs };
  const file = await open(resolve(client.session.cwd, path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(data, null, 2)); await file.sync(); } finally { await file.close(); }
}
