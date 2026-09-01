/**
 * node:sqlite prints an ExperimentalWarning the moment it is imported. On an MCP
 * stdio transport and in CLI output that noise is pure cost, so this side-effect
 * module installs a narrow filter and must be imported *before* node:sqlite.
 * Only that one warning is swallowed; everything else still reaches stderr.
 */
type ProcessEmit = (event: string, ...args: unknown[]) => boolean;

const target = process as unknown as { emit: ProcessEmit };
const originalEmit: ProcessEmit = target.emit.bind(process);

target.emit = (event: string, ...args: unknown[]): boolean => {
  const payload = args[0];
  if (
    event === "warning" &&
    payload instanceof Error &&
    payload.name === "ExperimentalWarning" &&
    payload.message.includes("SQLite")
  ) {
    return false;
  }
  return originalEmit(event, ...args);
};

export {};
