# Redmine MCP Server

An MCP server that lets Claude find and manage your Redmine tickets, using the [Redmine REST API](https://www.redmine.org/projects/redmine/wiki/Rest_api).

## Is this a real MCP server?

Yes. This is not a wrapper or mock of the interface — it's a standards-compliant MCP
(Model Context Protocol) server:

- Built with the **official `@modelcontextprotocol/sdk`** (`McpServer` + `StdioServerTransport`).
- Speaks real **JSON-RPC 2.0 over stdio**, per the MCP spec. Verified directly by sending a raw
  `initialize` request and getting back a correct MCP handshake response
  (`protocolVersion`, `capabilities`, `serverInfo`).
- Exposes proper **MCP tools** (`list_my_issues`, `get_issue`, `update_issue`, etc.) with
  Zod-validated input schemas, discoverable via the standard `tools/list` method and callable via
  `tools/call` — the same mechanism any MCP client (Claude Code, Claude Desktop, or other
  MCP-aware apps) uses.

## Setup

1. **Enable the REST API on your Redmine instance** (if not already on): Administration → Settings → API → "Enable REST web service".
2. **Get your API key**: click your name (top right) → "My account" → "API access key" → "Show".
3. Install, build and link:
   ```bash
   npm install
   npm run build
   npm link
   ```
4. **Save your credentials once:**
   ```bash
   redmine-mcp-server login
   ```
   Prompts for your Redmine URL and API key (key input is hidden) and writes them to
   `~/.config/redmine-mcp/config.json` with mode `0600`. Re-run it any time to change them.

That's it — no `.env`, and no credentials in your MCP config.

## Installing as a global command

The package ships a `bin` entry (`redmine-mcp-server`), so once built it can be linked or
installed globally and run from anywhere, instead of pointing at an absolute path to
`dist/index.js`.

**From a local clone (not yet published to npm):**

```bash
npm install
npm run build
npm link          # registers the `redmine-mcp-server` command globally
```

Run `npm unlink -g redmine-mcp-server` to remove it later.

**If published to npm:**

```bash
npm install -g redmine-mcp-server
```

Either way, you can now just run `redmine-mcp-server` from any directory.

## Registering with Claude Code

After `redmine-mcp-server login`, registration needs no credentials at all:

```bash
claude mcp add redmine-mcp-server -- redmine-mcp-server
```

Or in `.mcp.json` — safe to commit, since it holds no secrets:

```json
{
  "mcpServers": {
    "redmine-mcp-server": {
      "command": "redmine-mcp-server"
    }
  }
}
```

If you'd rather not link it globally, use `"command": "node", "args": ["/absolute/path/to/dist/index.js"]`.

**Environment variables still work and take priority** over the saved config, for CI or
one-off overrides:

| Variable | Purpose |
| --- | --- |
| `REDMINE_URL` | Redmine base URL |
| `REDMINE_API_KEY` | API access key |
| `REDMINE_MCP_CONFIG` | Alternate config file path |
| `REDMINE_MCP_LOG` | Alternate log file path |

## Logging

Every action is logged as one JSON object per line: server start/stop, each tool call with its
arguments, each tool result or failure, and every HTTP request/response with status and duration.
The API key is never logged, and any field named like a key/token/password/secret is redacted.
Nothing is ever written to stdout — that channel belongs to the MCP protocol.

The log goes to `~/.redmine-mcp.log`; set `REDMINE_MCP_LOG` to choose another path. Tail it with:

```bash
tail -f ~/.redmine-mcp.log
```

There is no rotation — point `REDMINE_MCP_LOG` at a path covered by `logrotate`/`newsyslog` if
the volume ever matters.

## Tools

- **list_my_issues** — list issues assigned to you (`status`: open/closed/all).
- **get_issue** — full details + comment history for one issue.
- **search_issues** — filter issues by project/subject/status/assignee.
- **search** — full-text search across issues (and optionally wiki + news).
- **list_enumerations** — valid status, tracker and priority names/ids for this Redmine instance.
- **update_issue** — change status/% done and/or add a note.
- **add_comment** — add a comment without changing fields.
- **create_issue** — create an issue in a project.
- **list_projects** — list visible projects (id/identifier/name).

## Example prompts

- "What are my open tickets?"
- "Show me the details and history of issue 1234."
- "Find open bugs in the web project mentioning login."
- "Create a bug in the web project: checkout page 500s on submit."
- "Mark issue 1234 as Resolved and note that it's deployed to prod."
- "Add a comment to issue 1234 saying I'm blocked on QA."

## Manual testing

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

This opens the MCP Inspector so you can invoke each tool directly against your real Redmine instance before wiring it into Claude Code.
