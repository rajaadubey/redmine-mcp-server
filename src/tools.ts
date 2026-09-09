import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { log, errorInfo } from "./logger.js";
import { RedmineApiError, RedmineClient, RedmineIssue, RedmineIssueStatus, RedmineNamed, RedmineUser } from "./redmine.js";

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

function formatNamedList(items: RedmineNamed[]): string {
  return items.map((i) => `${i.id}: ${i.name}`).join("\n");
}

/** Resolve a tracker/priority name to its id, case-insensitively. */
function resolveNamed(items: RedmineNamed[], name: string): RedmineNamed | undefined {
  return items.find((i) => i.name.toLowerCase() === name.toLowerCase());
}

function formatUser(u: RedmineUser): string {
  const name = [u.firstname, u.lastname].filter(Boolean).join(" ");
  return `${u.id}: ${name || u.login || "(unnamed)"}${u.login ? ` (${u.login})` : ""}${u.mail ? ` <${u.mail}>` : ""}`;
}

function formatStatusList(statuses: RedmineIssueStatus[]): string {
  return statuses
    .map((s) => `${s.id}: ${s.name}${s.is_closed ? " (closed)" : ""}`)
    .join("\n");
}

export function registerRedmineTools(server: McpServer, client: RedmineClient) {
  // Same signature as server.registerTool, so call sites keep their inferred
  // arg types; every call, result and failure is logged.
  const registerTool: typeof server.registerTool = (name, config, cb: any) =>
    server.registerTool(name, config, (async (args: any, extra: any) => {
      const started = Date.now();
      log("info", "tool_call", { tool: name, args });
      try {
        const result = await cb(args, extra);
        log(result?.isError ? "warn" : "info", "tool_result", {
          tool: name,
          ms: Date.now() - started,
          is_error: Boolean(result?.isError),
        });
        return result;
      } catch (err) {
        log("error", "tool_failed", { tool: name, ms: Date.now() - started, ...errorInfo(err) });
        throw err;
      }
    }) as any);

  registerTool(
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

  registerTool(
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

  registerTool(
    "list_enumerations",
    {
      title: "List enumerations",
      description:
        "List the statuses, trackers, priorities and time entry activities available in this Redmine instance (name and id), needed by update_issue, create_issue and log_time.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [statuses, trackers, priorities, activities] = await Promise.all([
        client.listIssueStatuses(),
        client.listTrackers(),
        client.listPriorities(),
        client.listTimeEntryActivities(),
      ]);
      const text = [
        "Statuses:",
        formatStatusList(statuses),
        "",
        "Trackers:",
        formatNamedList(trackers),
        "",
        "Priorities:",
        formatNamedList(priorities),
        "",
        "Time entry activities:",
        formatNamedList(activities),
      ].join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  registerTool(
    "search_issues",
    {
      title: "Search issues",
      description:
        "Search issues by project, status, assignee and/or subject text. All filters are optional; with none, returns the most recently updated issues.",
      inputSchema: {
        project: z.string().optional().describe("Project identifier or numeric id (see list_projects)."),
        subject: z.string().optional().describe("Substring to match against the issue subject."),
        status: z
          .enum(["open", "closed", "all"])
          .optional()
          .describe("Filter by status. Defaults to 'open'."),
        assigned_to_me: z.boolean().optional().describe("Only issues assigned to the current user."),
        limit: z.number().int().positive().max(100).optional().describe("Max issues to return (default 25)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, subject, status, assigned_to_me, limit }) => {
      const { issues, total_count } = await client.listIssues({
        projectId: project,
        subject,
        statusId: status ?? "open",
        assignedToId: assigned_to_me ? (await client.getCurrentUser()).id : undefined,
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

  registerTool(
    "search",
    {
      title: "Search Redmine",
      description:
        "Full-text search across Redmine. Use this when you have keywords but no issue id; use search_issues when you want to filter by project/status/assignee instead.",
      inputSchema: {
        query: z.string().min(1).describe("Search keywords."),
        project: z.string().optional().describe("Restrict to a project identifier or numeric id."),
        include_wiki: z.boolean().optional().describe("Also search wiki pages (default false)."),
        include_news: z.boolean().optional().describe("Also search news (default false)."),
        limit: z.number().int().positive().max(100).optional().describe("Max results (default 25)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, project, include_wiki, include_news, limit }) => {
      const { results, total_count } = await client.search({
        q: query,
        projectId: project,
        scope: { issues: true, wiki_pages: include_wiki, news: include_news },
        limit,
      });

      if (results.length === 0) {
        return { content: [{ type: "text", text: `No results for "${query}".` }] };
      }

      const text = `Found ${total_count} result(s), showing ${results.length}:\n\n${results
        .map((r) => `[${r.type}] ${r.title}\n  ${r.url}${r.description ? `\n  ${r.description.trim()}` : ""}`)
        .join("\n\n")}`;
      return { content: [{ type: "text", text }] };
    },
  );

  registerTool(
    "create_issue",
    {
      title: "Create issue",
      description: "Create a new Redmine issue in a project.",
      inputSchema: {
        project: z.string().describe("Project identifier or numeric id (see list_projects)."),
        subject: z.string().min(1).describe("Issue subject / title."),
        description: z.string().optional().describe("Issue description body."),
        tracker: z.string().optional().describe("Tracker name, e.g. 'Bug', 'Feature' (see list_enumerations)."),
        priority: z.string().optional().describe("Priority name, e.g. 'Normal', 'High' (see list_enumerations)."),
        assign_to_me: z.boolean().optional().describe("Assign the new issue to the current user."),
        assignee_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("User id to assign the issue to (see find_user). Ignored if assign_to_me is set."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ project, subject, description, tracker, priority, assign_to_me, assignee_id }) => {
      let tracker_id: number | undefined;
      if (tracker) {
        const trackers = await client.listTrackers();
        const match = resolveNamed(trackers, tracker);
        if (!match) {
          return {
            content: [
              { type: "text", text: `Unknown tracker "${tracker}". Available:\n${formatNamedList(trackers)}` },
            ],
            isError: true,
          };
        }
        tracker_id = match.id;
      }

      let priority_id: number | undefined;
      if (priority) {
        const priorities = await client.listPriorities();
        const match = resolveNamed(priorities, priority);
        if (!match) {
          return {
            content: [
              { type: "text", text: `Unknown priority "${priority}". Available:\n${formatNamedList(priorities)}` },
            ],
            isError: true,
          };
        }
        priority_id = match.id;
      }

      const issue = await client.createIssue({
        project_id: project,
        subject,
        description,
        tracker_id,
        priority_id,
        assigned_to_id: assign_to_me ? (await client.getCurrentUser()).id : assignee_id,
      });

      return {
        content: [{ type: "text", text: `Created issue #${issue.id}.\n\n${formatIssueSummary(issue)}` }],
      };
    },
  );

  registerTool(
    "update_issue",
    {
      title: "Update issue",
      description: "Update a Redmine issue's status, % done, and/or add a note describing the update.",
      inputSchema: {
        issue_id: z.number().int().positive().describe("The Redmine issue ID."),
        status: z
          .string()
          .optional()
          .describe("New status name, e.g. 'In Progress', 'Resolved', 'Closed'. Must match an existing status (see list_enumerations)."),
        done_ratio: z.number().int().min(0).max(100).optional().describe("New % done (0-100)."),
        assignee_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("User id to assign the issue to (see find_user)."),
        notes: z.string().optional().describe("Note to attach to this update."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ issue_id, status, done_ratio, assignee_id, notes }) => {
      const payload: {
        status_id?: number;
        done_ratio?: number;
        assigned_to_id?: number;
        notes?: string;
      } = {};

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
      if (assignee_id !== undefined) payload.assigned_to_id = assignee_id;
      if (notes) payload.notes = notes;

      if (Object.keys(payload).length === 0) {
        return {
          content: [
            { type: "text", text: "Nothing to update — provide status, done_ratio, assignee_id, and/or notes." },
          ],
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

  registerTool(
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

  registerTool(
    "find_user",
    {
      title: "Find user",
      description:
        "Find Redmine users by name or login, to get the user id needed to assign an issue. Pass a project to search its members — the instance-wide user list is admin-only.",
      inputSchema: {
        name: z.string().optional().describe("Name or login to match. Omit to list everyone visible."),
        project: z
          .string()
          .optional()
          .describe("Project identifier or numeric id — searches that project's members instead of all users."),
        limit: z.number().int().positive().max(100).optional().describe("Max users to return (default 25)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name, project, limit }) => {
      if (project) {
        const members = await client.listProjectMembers(project);
        const matched = name
          ? members.filter((m) => m.name.toLowerCase().includes(name.toLowerCase()))
          : members;
        return {
          content: [
            {
              type: "text",
              text: matched.length
                ? formatNamedList(matched.slice(0, limit ?? 25))
                : `No members of "${project}" match${name ? ` "${name}"` : ""}.`,
            },
          ],
        };
      }

      try {
        const users = await client.listUsers({ name, limit });
        return {
          content: [
            {
              type: "text",
              text: users.length
                ? users.map(formatUser).join("\n")
                : `No users match${name ? ` "${name}"` : ""}.`,
            },
          ],
        };
      } catch (err) {
        // /users.json is admin-only; project memberships are not.
        if (err instanceof RedmineApiError && (err.status === 403 || err.status === 401)) {
          return {
            content: [
              {
                type: "text",
                text: "Listing all users requires admin rights. Pass a project to search its members instead.",
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    },
  );

  registerTool(
    "log_time",
    {
      title: "Log time",
      description: "Log time spent against a Redmine issue (or a project, if no issue is given).",
      inputSchema: {
        issue_id: z.number().int().positive().optional().describe("Issue to log against."),
        project: z
          .string()
          .optional()
          .describe("Project identifier or numeric id — used only when issue_id is omitted."),
        hours: z.number().positive().describe("Hours spent, e.g. 1.5."),
        spent_on: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Date in YYYY-MM-DD. Defaults to today."),
        activity: z
          .string()
          .optional()
          .describe("Activity name, e.g. 'Development' (see list_enumerations). Required unless the instance has a default."),
        comments: z.string().optional().describe("What the time was spent on."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ issue_id, project, hours, spent_on, activity, comments }) => {
      if (!issue_id && !project) {
        return {
          content: [{ type: "text", text: "Provide either issue_id or project." }],
          isError: true,
        };
      }

      let activity_id: number | undefined;
      if (activity) {
        const activities = await client.listTimeEntryActivities();
        const match = resolveNamed(activities, activity);
        if (!match) {
          return {
            content: [
              { type: "text", text: `Unknown activity "${activity}". Available:\n${formatNamedList(activities)}` },
            ],
            isError: true,
          };
        }
        activity_id = match.id;
      }

      const entry = await client.createTimeEntry({
        issue_id,
        project_id: issue_id ? undefined : project,
        hours,
        spent_on,
        activity_id,
        comments,
      });

      const target = issue_id ? `issue #${issue_id}` : `project ${project}`;
      return {
        content: [
          { type: "text", text: `Logged ${entry.hours}h on ${target} for ${entry.spent_on} (entry #${entry.id}).` },
        ],
      };
    },
  );

  registerTool(
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
