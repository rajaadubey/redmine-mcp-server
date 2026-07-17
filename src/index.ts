#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RedmineClient } from "./redmine.js";
import { registerRedmineTools } from "./tools.js";

async function main() {
  const client = new RedmineClient();

  const server = new McpServer({
    name: "redmine-mcp-server",
    version: "0.1.0",
  });

  registerRedmineTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start Redmine MCP server:", err instanceof Error ? err.message : err);
  process.exit(1);
});
