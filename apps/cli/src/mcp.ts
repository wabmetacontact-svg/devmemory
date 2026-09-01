#!/usr/bin/env node
/**
 * The `devmemory-mcp-server` command.
 *
 * MCP clients need a command they can spawn, not a path into node_modules. The
 * CLI package therefore ships this wrapper as a second binary: importing the
 * server package runs it, and npm puts the name on PATH during a global install.
 */
import "@samirthakur024/mcp-server";
