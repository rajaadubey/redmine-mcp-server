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
3. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```
4. Copy `.env.example` to `.env` and fill in `REDMINE_URL` and `REDMINE_API_KEY` (only needed for local testing — see registration below for how Claude Code passes these in).

## Registering with Claude Code

```bash
claude mcp add redmine-mcp-server \
  --env REDMINE_URL=https://redmine.example.com \
  --env REDMINE_API_KEY=your_api_key_here \
  -- node /absolute/path/to/redmine-mcp-server/dist/index.js
```

Or add directly to your `.mcp.json`:

```json
{
  "mcpServers": {
    "redmine-mcp-server": {
      "command": "node",
      "args": ["/absolute/path/to/redmine-mcp-server/dist/index.js"],
      "env": {
        "REDMINE_URL": "https://redmine.example.com",
        "REDMINE_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

## Tools

- **list_my_issues** — list issues assigned to you (`status`: open/closed/all).
- **get_issue** — full details + comment history for one issue.
- **list_issue_statuses** — valid status names/ids for this Redmine instance.
- **update_issue** — change status/% done and/or add a note.
- **add_comment** — add a comment without changing fields.
- **list_projects** — list visible projects (id/identifier/name).

## Example prompts

- "What are my open tickets?"
- "Show me the details and history of issue 1234."
- "Mark issue 1234 as Resolved and note that it's deployed to prod."
- "Add a comment to issue 1234 saying I'm blocked on QA."

## Manual testing

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

This opens the MCP Inspector so you can invoke each tool directly against your real Redmine instance before wiring it into Claude Code.
