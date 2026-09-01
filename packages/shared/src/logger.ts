import fs from "node:fs";
import path from "node:path";
import pino, { type Logger } from "pino";
import { ensureHome, homeLayout } from "./paths.js";

export type { Logger };

let root: Logger | undefined;

export interface LoggerOptions {
  level?: string;
  /** stdio MCP servers must never write to stdout - it carries the protocol. */
  destination?: "file" | "stderr" | "silent";
  home?: string;
  name?: string;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? process.env.DEVMEMORY_LOG_LEVEL ?? "info";
  const destination = opts.destination ?? "file";

  if (destination === "silent") return pino({ level: "silent" });
  if (destination === "stderr") return pino({ level, name: opts.name }, pino.destination(2));

  const layout = homeLayout(opts.home);
  ensureHome(opts.home);
  fs.mkdirSync(layout.logsDir, { recursive: true });
  const file = path.join(layout.logsDir, `${opts.name ?? "devmemory"}.log`);
  return pino({ level, name: opts.name }, pino.destination({ dest: file, append: true, sync: false }));
}

export function getLogger(opts: LoggerOptions = {}): Logger {
  root ??= createLogger(opts);
  return root;
}

export function setLogger(logger: Logger): void {
  root = logger;
}
