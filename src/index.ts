#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RedmineClient } from "./redmine.js";
import { registerRedmineTools } from "./tools.js";
import { log, errorInfo, logFile } from "./logger.js";
import { login, configFile } from "./config.js";

const VERSION = "1.2.0";

const INSTRUCTIONS = `Which Redmine tool to use:

Finding issues
- You know the issue id -> get_issue.
- "My issues" with no other filter -> list_my_issues.
- You know attributes (project, status, tracker, priority, assignee, author, version, dates, custom fields) -> search_issues.
- The user names a saved filter or team view -> list_saved_queries, then search_issues with query_id.
- You only have keywords (error text, a feature name) -> search (full text, also wiki/news).

Looking up ids and names
- A project name -> list_projects.
- A project's trackers, custom field ids, versions -> describe_project (do this before filtering or setting custom fields/versions).
- Instance-wide status/tracker/priority/activity names -> list_enumerations.
- A person's user id -> find_user with a project (the full user list is admin-only).

Changing issues
- Only a comment -> add_comment.
- Any field change (with or without a note) -> update_issue, all changes in one call.
- New issue -> create_issue (check it doesn't already exist first).
- Blocks/relates/duplicates -> link_issues; remove -> unlink_issues with the relation id from get_issue. Parent/subtask -> update_issue parent_issue_id.

Time
- Record hours -> log_time. See logged hours and totals -> list_time_entries.

Notes for this API
- Redmine silently ignores filters on unknown custom field ids, so take ids from describe_project.
- Status changes are checked by Redmine on write; a rejected change comes back as an error with the reason, and nothing is saved.`;

async function main() {
  if (process.argv[2] === "login") {
    await login();
    return;
  }

  log("info", "server_starting", { pid: process.pid, version: VERSION, config: configFile });

  const client = new RedmineClient();

  const server = new McpServer(
    {
      name: "redmine-mcp-server",
      version: VERSION,
    },
    { instructions: INSTRUCTIONS },
  );

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
