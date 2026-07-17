import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RedmineClient, RedmineIssue, RedmineIssueStatus } from "./redmine.js";

function formatIssueSummary(issue: RedmineIssue): string {
  return [
    `#${issue.id} [${issue.status.name}] ${issue.subject}`,
    `  project: ${issue.project.name} | tracker: ${issue.tracker.name} | priority: ${issue.priority.name}`,
    `  assignee: ${issue.assigned_to?.name ?? "(unassigned)"} | done: ${issue.done_ratio ?? 0}% | updated: ${issue.updated_on}`,
  ].join("\n");
}

function formatIssueDetail(issue: RedmineIssue): string {
  const lines = [
    `#${issue.id} — ${issue.subject}`,
    `Project: ${issue.project.name}`,
    `Tracker: ${issue.tracker.name} | Status: ${issue.status.name} | Priority: ${issue.priority.name}`,
    `Author: ${issue.author.name} | Assignee: ${issue.assigned_to?.name ?? "(unassigned)"}`,
    `Done: ${issue.done_ratio ?? 0}% | Created: ${issue.created_on} | Updated: ${issue.updated_on}`,
    "",
    "Description:",
    issue.description?.trim() || "(none)",
  ];

  if (issue.journals?.length) {
    lines.push("", "History / Comments:");
    for (const j of issue.journals) {
      const who = j.user?.name ?? "unknown";
      const changes = (j.details ?? [])
        .map((d) => `${d.name}: ${d.old_value ?? "–"} -> ${d.new_value ?? "–"}`)
        .join(", ");
      lines.push(`- [${j.created_on}] ${who}${changes ? ` (${changes})` : ""}`);
      if (j.notes) lines.push(`  ${j.notes}`);
    }
  }

  return lines.join("\n");
}

async function resolveStatusId(
  client: RedmineClient,
  status: string,
): Promise<{ id: number; name: string } | null> {
  const statuses = await client.listIssueStatuses();
  const match = statuses.find((s) => s.name.toLowerCase() === status.toLowerCase());
  return match ? { id: match.id, name: match.name } : null;
}

function formatStatusList(statuses: RedmineIssueStatus[]): string {
  return statuses
    .map((s) => `${s.id}: ${s.name}${s.is_closed ? " (closed)" : ""}`)
    .join("\n");
}

export function registerRedmineTools(server: McpServer, client: RedmineClient) {
  server.registerTool(
    "list_my_issues",
    {
      title: "List my issues",
      description: "List Redmine issues assigned to the current user (identified by the configured API key).",
      inputSchema: {
        status: z
          .enum(["open", "closed", "all"])
          .optional()
          .describe("Filter by status. Defaults to 'open'."),
        limit: z.number().int().positive().max(100).optional().describe("Max issues to return (default 25)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status, limit }) => {
      const me = await client.getCurrentUser();
      const { issues, total_count } = await client.listIssues({
        assignedToId: me.id,
        statusId: status ?? "open",
        limit,
      });

      if (issues.length === 0) {
        return { content: [{ type: "text", text: "No matching issues found." }] };
      }

      const text = `Found ${total_count} issue(s), showing ${issues.length}:\n\n${issues
        .map(formatIssueSummary)
        .join("\n\n")}`;
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "get_issue",
    {
      title: "Get issue",
      description: "Get full details of a single Redmine issue, including its description and comment/change history.",
      inputSchema: {
        issue_id: z.number().int().positive().describe("The Redmine issue ID."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ issue_id }) => {
      const issue = await client.getIssue(issue_id, { includeJournals: true });
      return { content: [{ type: "text", text: formatIssueDetail(issue) }] };
    },
  );

  server.registerTool(
    "list_issue_statuses",
    {
      title: "List issue statuses",
      description: "List the issue statuses available in this Redmine instance (name and id), useful for update_issue.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const statuses = await client.listIssueStatuses();
      return { content: [{ type: "text", text: formatStatusList(statuses) }] };
    },
  );

  server.registerTool(
    "update_issue",
    {
      title: "Update issue",
      description: "Update a Redmine issue's status, % done, and/or add a note describing the update.",
      inputSchema: {
        issue_id: z.number().int().positive().describe("The Redmine issue ID."),
        status: z
          .string()
          .optional()
          .describe("New status name, e.g. 'In Progress', 'Resolved', 'Closed'. Must match an existing status (see list_issue_statuses)."),
        done_ratio: z.number().int().min(0).max(100).optional().describe("New % done (0-100)."),
        notes: z.string().optional().describe("Note to attach to this update."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ issue_id, status, done_ratio, notes }) => {
      const payload: { status_id?: number; done_ratio?: number; notes?: string } = {};

      if (status) {
        const resolved = await resolveStatusId(client, status);
        if (!resolved) {
          const statuses = await client.listIssueStatuses();
          return {
            content: [
              {
                type: "text",
                text: `Unknown status "${status}". Available statuses:\n${formatStatusList(statuses)}`,
              },
            ],
            isError: true,
          };
        }
        payload.status_id = resolved.id;
      }
      if (done_ratio !== undefined) payload.done_ratio = done_ratio;
      if (notes) payload.notes = notes;

      if (Object.keys(payload).length === 0) {
        return {
          content: [{ type: "text", text: "Nothing to update — provide status, done_ratio, and/or notes." }],
          isError: true,
        };
      }

      await client.updateIssue(issue_id, payload);
      const issue = await client.getIssue(issue_id);
      return {
        content: [
          { type: "text", text: `Updated issue #${issue_id}.\n\n${formatIssueSummary(issue)}` },
        ],
      };
    },
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add comment",
      description: "Add a comment to a Redmine issue without changing any of its fields.",
      inputSchema: {
        issue_id: z.number().int().positive().describe("The Redmine issue ID."),
        comment: z.string().min(1).describe("The comment text to add."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ issue_id, comment }) => {
      await client.updateIssue(issue_id, { notes: comment });
      return { content: [{ type: "text", text: `Added comment to issue #${issue_id}.` }] };
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List Redmine projects visible to the current user (id, identifier, name).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const projects = await client.listProjects();
      const text = projects
        .map((p) => `${p.id}: ${p.identifier} — ${p.name}`)
        .join("\n");
      return { content: [{ type: "text", text: text || "No projects found." }] };
    },
  );
}
