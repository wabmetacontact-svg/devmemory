#!/usr/bin/env node
import { DevMemory } from "@samirthakur024/core";
import { createLogger, loadConfig, requireSupportedRuntime } from "@samirthakur024/shared";
import { startDashboard } from "./server.js";

/** Standalone entry point: `devmemory-dashboard`. */
async function main(): Promise<void> {
  requireSupportedRuntime();

  const config = loadConfig();
  const logger = createLogger({ name: "dashboard", level: config.logLevel, destination: "stderr" });
  const devmemory = new DevMemory({ config });

  const port = Number(process.env.DEVMEMORY_DASHBOARD_PORT ?? config.dashboard.port);
  const dashboard = await startDashboard({ devmemory, port, host: config.dashboard.host, logger });
  process.stdout.write(`DevMemory dashboard: ${dashboard.url}\n`);

  const shutdown = (): void => {
    void dashboard.close().finally(() => {
      devmemory.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`dashboard failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
