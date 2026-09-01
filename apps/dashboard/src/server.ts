import http from "node:http";
import type { AddressInfo } from "node:net";
import { DevMemoryError } from "@devmemory/shared";
import type { Logger } from "@devmemory/shared";
import type { DevMemory } from "@devmemory/core";
import { handleApi, type ApiRequest } from "./api.js";
import { DASHBOARD_HTML } from "./ui.js";

export interface DashboardOptions {
  devmemory: DevMemory;
  port?: number;
  host?: string;
  /** Required to bind anything other than a loopback address (PRD 42). */
  allowRemote?: boolean;
  logger?: Logger;
}

export interface RunningDashboard {
  url: string;
  port: number;
  host: string;
  close(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_BODY_BYTES = 1_000_000;

/**
 * The local dashboard (PRD 41, 42). It is a plain node:http server over the same
 * core services the MCP server uses, bound to loopback unless the operator very
 * deliberately says otherwise.
 */
export async function startDashboard(options: DashboardOptions): Promise<RunningDashboard> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host) && options.allowRemote !== true) {
    throw new DevMemoryError(
      "PERMISSION_DENIED",
      `refusing to bind ${host}: the dashboard is local-only unless remote access is explicitly allowed`,
      { host },
    );
  }

  const server = http.createServer((request, response) => {
    void serve(options.devmemory, request, response, options.logger);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 7331, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const url = `http://${host === "::1" ? "[::1]" : host}:${address.port}`;
  options.logger?.info({ url }, "dashboard listening");

  return {
    url,
    port: address.port,
    host,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function serve(
  devmemory: DevMemory,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  logger?: Logger,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const method = request.method ?? "GET";

  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(DASHBOARD_HTML);
      return;
    }

    if (url.pathname === "/health") {
      json(response, 200, { ok: true, home: devmemory.home });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const segments = url.pathname.slice(5).split("/").filter(Boolean).map(decodeURIComponent);
      const apiRequest: ApiRequest = {
        method,
        segments,
        query: url.searchParams,
        body: method === "GET" || method === "HEAD" ? null : await readJsonBody(request),
      };

      const result = await handleApi(devmemory, apiRequest);
      json(response, result.status, result.body);
      return;
    }

    json(response, 404, { error: { code: "NOT_FOUND", message: `no route for ${url.pathname}` } });
  } catch (error) {
    logger?.warn({ err: error instanceof Error ? error.message : String(error) }, "dashboard request failed");
    json(response, 500, {
      error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) },
    });
  }
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new DevMemoryError("INVALID_INPUT", "request body is too large");
    chunks.push(buffer);
  }

  if (chunks.length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    throw new DevMemoryError("INVALID_INPUT", "request body is not valid JSON");
  }
}
