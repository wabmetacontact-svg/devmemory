#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DevMemory } from "@samirthakur024/core";
import { createDevMemoryServer } from "@samirthakur024/mcp";
import { createLogger, loadConfig, requireSupportedRuntime } from "@samirthakur024/shared";

/**
 * DevMemory MCP server (stdio). stdout carries the protocol, so every diagnostic
 * goes to the log file instead.
 */
async function main(): Promise<void> {
  requireSupportedRuntime();

  const config = loadConfig();
  const logger = createLogger({ name: "mcp-server", level: config.logLevel, destination: "file" });
  const devmemory = new DevMemory({ config });
  const { server } = createDevMemoryServer({ devmemory, logger, cwd: process.cwd() });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    try {
      devmemory.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => logger.error({ err: String(error) }, "uncaught exception"));
  process.on("unhandledRejection", (reason) => logger.error({ err: String(reason) }, "unhandled rejection"));

  await server.connect(new StdioServerTransport());
  logger.info({ cwd: process.cwd(), home: devmemory.home }, "devmemory mcp server ready");
}

main().catch((error: unknown) => {
  process.stderr.write(`devmemory-mcp failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
