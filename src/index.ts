#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RedmineClient } from "./redmine.js";
import { registerRedmineTools } from "./tools.js";
import { log, errorInfo, logFile } from "./logger.js";
import { login, configFile } from "./config.js";

const VERSION = "1.1.0";

async function main() {
  if (process.argv[2] === "login") {
    await login();
    return;
  }

  log("info", "server_starting", { pid: process.pid, version: VERSION, config: configFile });

  const client = new RedmineClient();

  const server = new McpServer({
    name: "redmine-mcp-server",
    version: VERSION,
  });

  registerRedmineTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "server_ready", { log_file: logFile });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log("info", "server_stopping", { signal });
      process.exit(0);
    });
  }
  process.on("uncaughtException", (err) => {
    log("error", "uncaught_exception", errorInfo(err));
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log("error", "unhandled_rejection", errorInfo(reason));
  });
}

main().catch((err) => {
  log("error", "server_failed", errorInfo(err));
  console.error("Failed to start Redmine MCP server:", err instanceof Error ? err.message : err);
  process.exit(1);
});
