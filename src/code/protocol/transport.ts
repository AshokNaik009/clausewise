import type { Socket } from "node:net";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MAX_IPC_BYTES } from "./index.js";

export const connectionSchema = z.object({ version: z.literal(1), id: z.string().uuid(), pid: z.number().int().positive(), socket: z.string().min(1), token: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export type ConnectionInfo = z.infer<typeof connectionSchema>;
export const helloSchema = z.object({ kind: z.literal("hello"), token: z.string(), after: z.number().int().nonnegative(), pending: z.array(z.string().uuid()).max(32) }).strict();

export function connectionPath(directory: string, id: string): string {
  return join(directory, `server-${z.string().uuid().parse(id)}.json`);
}

export async function readConnection(directory: string, id: string): Promise<ConnectionInfo> {
  const handle = await open(connectionPath(directory, id), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("Server connection file must be private and owned by the current user");
    const info = connectionSchema.parse(JSON.parse(await handle.readFile("utf8")));
    if (info.id !== id) throw new Error("Server identity mismatch");
    return info;
  } finally { await handle.close(); }
}

export function receiveFrames(socket: Socket, receive: (value: unknown) => void): void {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (!length || length > MAX_IPC_BYTES) throw new Error("Invalid frame length");
        if (buffer.length < length + 4) break;
        const value: unknown = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
        buffer = buffer.subarray(length + 4);
        receive(value);
      }
      if (buffer.length > MAX_IPC_BYTES + 4) throw new Error("Frame buffer limit exceeded");
    } catch { socket.destroy(new Error("Invalid local transport frame")); }
  });
}

export function sendFrame(socket: Socket, value: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_IPC_BYTES) return Promise.reject(new Error("Local transport message exceeds 4 MiB"));
  if (socket.destroyed || socket.writableLength > MAX_IPC_BYTES * 8) return Promise.reject(new Error("Local transport disconnected or backlogged"));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return new Promise((resolve, reject) => socket.write(Buffer.concat([header, body]), (error) => error ? reject(error) : resolve()));
}
