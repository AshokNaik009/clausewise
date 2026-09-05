import { FilesystemBackend } from "deepagents/node";

export function createDeepAgentsFilesystemBackend(rootDir: string): FilesystemBackend {
  return new FilesystemBackend({ rootDir });
}
