# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-11-26

### Added

- **`describe_project`** — a project's trackers, custom field ids and versions.
- **`list_saved_queries`** — saved issue queries; run one with `search_issues` `query_id`.
- **`link_issues`** / **`unlink_issues`** — create and remove issue relations.
- **`list_time_entries`** — logged time with a total, yours by default.
- `search_issues` filters: status by name, tracker, priority, assignee id, author, version,
  parent, created/updated/due dates, custom fields, saved query, sort and offset.
  Custom field ids are checked against the project, because Redmine silently ignores unknown ones.
- `update_issue` fields: subject, description, tracker, priority, start/due date, estimate,
  version, parent and custom fields.
- `get_issue` now shows custom fields, dates, version, parent, relations, subtasks,
  attachments and watchers.
- MCP server `instructions`: a guide telling the client which tool to use when.

### Changed

- `find_user` with a project falls back to people on the project's last 100 issues when the
  memberships endpoint fails (it returns 500 on some instances).

## [1.1.0] - 2026-09-09

### Added

- **`search_issues`** — filter issues by project, subject substring, status and assignee.
  The underlying client already supported these filters; no tool reached them.
- **`search`** — full-text search via `/search.json`, optionally scoped to a project and
  extendable to wiki pages and news.
- **`create_issue`** — create an issue, resolving tracker and priority by name.
- **`find_user`** — resolve a name or login to a user id. `/users.json` is admin-only in
  Redmine, so passing a project searches that project's memberships instead.
- **`log_time`** — log hours against an issue or project, resolving the activity by name.
- `assignee_id` on `update_issue` and `create_issue`. The client already accepted
  `assigned_to_id`, but no tool could set it.
- Full action logging to `~/.redmine-mcp.log` (override with `REDMINE_MCP_LOG`): server
  lifecycle, every tool call with its arguments, every tool result or failure, and every HTTP
  request/response with status and duration. One JSON object per line. The API key is never
  logged and key/token/password/secret fields are redacted. Nothing is written to stdout,
  which belongs to the MCP stdio transport.
- **`redmine-mcp-server login`** — prompts once for URL and API key (input hidden) and saves
  them to `~/.config/redmine-mcp/config.json` at mode `0600`, so `.mcp.json` no longer holds
  secrets and is safe to commit. Environment variables still take priority when set.
- `src/redmine.test.ts` (`npm test`) — stubbed-fetch checks of request construction, config
  precedence and log redaction. No framework, no network.

### Changed

- **Breaking:** `list_issue_statuses` is now **`list_enumerations`**, returning statuses,
  trackers, priorities and time-entry activities in one call. `create_issue` and `log_time`
  need the others, and a separate lookup tool per enumeration would have been dead weight.

### Notes

- Tool surface was informed by [joaoperfig/redmine_mcp_plugin](https://github.com/joaoperfig/redmine_mcp_plugin).
  No code was taken from it — that project is GPL-2.0 Ruby running inside Redmine, whereas this
  is an external TypeScript REST client.
- The log file is not rotated. Point `REDMINE_MCP_LOG` at a path covered by
  `logrotate`/`newsyslog` if volume becomes a concern.

## [1.0.0] - 2026-09-09

Initial release.

- MCP server over JSON-RPC 2.0 stdio, built on the official `@modelcontextprotocol/sdk`.
- Tools: `list_my_issues`, `get_issue`, `list_issue_statuses`, `update_issue`, `add_comment`,
  `list_projects`.
- `redmine-mcp-server` bin entry for global installation.
- Configuration via `REDMINE_URL` and `REDMINE_API_KEY`.

[1.1.0]: https://github.com/rajaadubey/redmine-mcp-server/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/rajaadubey/redmine-mcp-server/releases/tag/v1.0.0
