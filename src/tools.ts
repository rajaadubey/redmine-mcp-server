import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { log, errorInfo } from "./logger.js";
import { IssueUpdate, RedmineApiError, RedmineClient, RedmineIssue, RedmineIssueStatus, RedmineNamed, RedmineUser } from "./redmine.js";

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
  ];
  const extra = [
    issue.start_date && `Start: ${issue.start_date}`,
    issue.due_date && `Due: ${issue.due_date}`,
    issue.estimated_hours != null && `Estimate: ${issue.estimated_hours}h`,
    issue.fixed_version && `Version: ${issue.fixed_version.name} (id ${issue.fixed_version.id})`,
    issue.parent && `Parent: #${issue.parent.id}`,
  ].filter(Boolean);
  if (extra.length) lines.push(extra.join(" | "));

  const cfs = (issue.custom_fields ?? []).filter((cf) =>
    Array.isArray(cf.value) ? cf.value.length : cf.value,
  );
  if (cfs.length) {
    lines.push("", "Custom fields:");
    for (const cf of cfs) {
      const v = Array.isArray(cf.value) ? cf.value.join(", ") : cf.value;
      lines.push(`- ${cf.name} (cf_${cf.id}): ${v}`);
    }
  }
  if (issue.relations?.length) {
    lines.push("", "Relations:");
    for (const r of issue.relations) {
      const other = r.issue_id === issue.id ? r.issue_to_id : r.issue_id;
      const dir = r.issue_id === issue.id ? r.relation_type : `${r.relation_type} (from #${other})`;
      lines.push(`- ${dir} #${other} (relation id ${r.id})`);
    }
  }
  if (issue.children?.length) {
    lines.push("", "Subtasks:", ...issue.children.map((c) => `- #${c.id} [${c.tracker.name}] ${c.subject}`));
  }
  if (issue.attachments?.length) {
    lines.push("", "Attachments:", ...issue.attachments.map((a) => `- ${a.filename} (${a.filesize} bytes) ${a.content_url}`));
  }
  if (issue.watchers?.length) {
    lines.push("", `Watchers: ${issue.watchers.map((w) => w.name).join(", ")}`);
  }

  lines.push("", "Description:", issue.description?.trim() || "(none)");

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
      description:
        "Quick list of issues assigned to the current user. Use for 'what's on my plate?'. For any other filter (project, dates, tracker, custom fields) use search_issues.",
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
      description:
        "Get everything about ONE issue when you already know its id: description, custom fields, relations, subtasks, attachments, watchers and full comment/change history. To find issues, use search_issues or search first.",
      inputSchema: {
        issue_id: z.number().int().positive().describe("The Redmine issue ID."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ issue_id }) => {
      const issue = await client.getIssue(issue_id, { full: true });
      return { content: [{ type: "text", text: formatIssueDetail(issue) }] };
    },
  );

  registerTool(
    "list_enumerations",
    {
      title: "List enumerations",
      description:
        "List instance-wide statuses, trackers, priorities and time-entry activities (name and id). Use when you need a valid name for status/tracker/priority/activity. For project-specific things (custom fields, versions, which trackers a project uses) use describe_project.",
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
        "Find issues by structured filters: project, status, tracker, priority, assignee, author, version, dates, custom fields, or a saved query. " +
        "Use this whenever you know WHICH attributes the issues have. Use `search` instead when you only have free-text keywords to look for in descriptions/comments. " +
        "All filters are optional and combine with AND; with none, returns the most recently updated open issues. " +
        "Date/custom-field values use Redmine's operator prefixes: '>=2026-01-01', '<=2026-01-31', '><2026-01-01|2026-01-31' (between), '>t-7' (in the last 7 days), " +
        "'~text' (contains), '!value' (not), '*' (any value), '!*' (no value); a bare value means equals.",
      inputSchema: {
        project: z.string().optional().describe("Project identifier or numeric id (see list_projects)."),
        subject: z.string().optional().describe("Substring to match against the issue subject."),
        status: z
          .string()
          .optional()
          .describe("'open' (default), 'closed', 'all', or an exact status name such as 'In Progress' (see list_enumerations)."),
        tracker: z.string().optional().describe("Tracker name, e.g. 'Bug' (see list_enumerations or describe_project)."),
        priority: z.string().optional().describe("Priority name, e.g. 'High' (see list_enumerations)."),
        assigned_to_me: z.boolean().optional().describe("Only issues assigned to the current user."),
        assignee_id: z.number().int().positive().optional().describe("Only issues assigned to this user id (see find_user)."),
        author_me: z.boolean().optional().describe("Only issues the current user created."),
        version_id: z.number().int().positive().optional().describe("Target version id (see describe_project)."),
        parent_id: z.number().int().positive().optional().describe("Only subtasks of this issue."),
        created: z.string().optional().describe("Created-date filter, e.g. '>=2026-11-01' or '>t-30'."),
        updated: z.string().optional().describe("Updated-date filter, e.g. '>t-7'."),
        due: z.string().optional().describe("Due-date filter, e.g. '<=2026-12-31' or '!*' (no due date)."),
        custom_fields: z
          .record(z.string().regex(/^\d+$/), z.string())
          .optional()
          .describe(
            "Custom field filters keyed by field id (from describe_project), e.g. {\"13\": \"Android\", \"45\": \"<=2026-12-01\"}. " +
              "Redmine silently ignores filters on unknown or non-filterable fields, so pass `project` to have ids checked.",
          ),
        query_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Run a saved query (see list_saved_queries). Its own filters replace status and the other filters here; project, sort and limit still apply."),
        sort: z.string().optional().describe("Sort, e.g. 'due_date:asc' or 'priority:desc,updated_on:desc'. Default 'updated_on:desc'."),
        limit: z.number().int().positive().max(100).optional().describe("Max issues to return (default 25, Redmine max 100)."),
        offset: z.number().int().min(0).optional().describe("Skip this many issues, for paging past the first 100."),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
      const filters: Record<string, string | number | undefined> = {
        created_on: a.created,
        updated_on: a.updated,
        due_date: a.due,
        fixed_version_id: a.version_id,
        parent_id: a.parent_id,
      };

      let statusId: string | undefined = a.query_id ? undefined : "open";
      if (a.status) {
        if (["open", "closed", "all"].includes(a.status.toLowerCase())) {
          statusId = { open: "open", closed: "closed", all: "*" }[a.status.toLowerCase()];
        } else {
          const statuses = await client.listIssueStatuses();
          const match = resolveNamed(statuses, a.status);
          if (!match) return fail(`Unknown status "${a.status}". Available:\n${formatStatusList(statuses)}`);
          statusId = String(match.id);
        }
      }
      if (a.tracker) {
        const trackers = await client.listTrackers();
        const match = resolveNamed(trackers, a.tracker);
        if (!match) return fail(`Unknown tracker "${a.tracker}". Available:\n${formatNamedList(trackers)}`);
        filters.tracker_id = match.id;
      }
      if (a.priority) {
        const priorities = await client.listPriorities();
        const match = resolveNamed(priorities, a.priority);
        if (!match) return fail(`Unknown priority "${a.priority}". Available:\n${formatNamedList(priorities)}`);
        filters.priority_id = match.id;
      }
      if (a.author_me) filters.author_id = "me";

      if (a.custom_fields) {
        if (a.project) {
          // Redmine drops filters on unknown custom fields and returns everything; refuse instead.
          const known = (await client.getProject(a.project)).issue_custom_fields ?? [];
          const unknown = Object.keys(a.custom_fields).filter((id) => !known.some((f) => String(f.id) === id));
          if (unknown.length) {
            return fail(`Project ${a.project} has no custom field ${unknown.join(", ")}. Its fields:\n${formatNamedList(known)}`);
          }
        }
        for (const [id, v] of Object.entries(a.custom_fields)) filters[`cf_${id}`] = v;
      }

      const { issues, total_count } = await client.listIssues({
        projectId: a.project,
        subject: a.subject,
        statusId,
        assignedToId: a.assigned_to_me ? "me" : a.assignee_id,
        limit: a.limit,
        offset: a.offset,
        sort: a.sort,
        queryId: a.query_id,
        filters,
      });

      if (issues.length === 0) {
        return { content: [{ type: "text", text: "No matching issues found." }] };
      }

      const more = total_count > (a.offset ?? 0) + issues.length ? ` Use offset ${(a.offset ?? 0) + issues.length} for more.` : "";
      const caveat = a.custom_fields && !a.project ? "\n(Custom field ids were not checked; if the count looks like 'everything', the id is probably wrong.)" : "";
      const text = `Found ${total_count} issue(s), showing ${issues.length}.${more}${caveat}\n\n${issues
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
        "Full-text keyword search across issue subjects, descriptions and comments (optionally wiki pages and news). " +
        "Use this when you only have words to look for (an error message, a feature name) and no structured filter. " +
        "Use search_issues instead when you can say which project/status/tracker/assignee/dates you want; it is exact and pageable.",
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
      description: "Create a new issue in a project. Check search_issues/search first if it might already exist. Use describe_project to see the project's trackers.",
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
      description:
        "Change one or more fields of an existing issue in a single write: status, assignee, % done, subject, description, tracker, priority, dates, estimate, version, parent, custom fields, with an optional note. " +
        "Use add_comment instead if you only want to add a comment. Use link_issues for relations (blocks, relates, duplicates). " +
        "Redmine rejects the whole update if any value is invalid (e.g. a status change your role's workflow doesn't allow) and returns the reason.",
      inputSchema: {
        issue_id: z.number().int().positive().describe("The Redmine issue ID."),
        status: z
          .string()
          .optional()
          .describe("New status name, e.g. 'In Progress', 'Resolved' (see list_enumerations)."),
        done_ratio: z.number().int().min(0).max(100).optional().describe("New % done (0-100)."),
        assignee_id: z.number().int().positive().optional().describe("User id to assign the issue to (see find_user)."),
        subject: z.string().min(1).optional().describe("New subject."),
        description: z.string().optional().describe("New description. Replaces the whole description."),
        tracker: z.string().optional().describe("New tracker name (see list_enumerations)."),
        priority: z.string().optional().describe("New priority name (see list_enumerations)."),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD."),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD."),
        estimated_hours: z.number().min(0).optional().describe("Estimated hours."),
        version_id: z.number().int().positive().optional().describe("Target version id (see describe_project)."),
        parent_issue_id: z.number().int().positive().optional().describe("Make this issue a subtask of that issue."),
        custom_fields: z
          .record(z.string().regex(/^\d+$/), z.union([z.string(), z.array(z.string())]))
          .optional()
          .describe(
            "Custom field values keyed by field id (see describe_project / get_issue), e.g. {\"13\": \"Android\", \"45\": \"2026-12-01\"}. " +
              "User-type fields take a user id as a string. Use an array only for multi-value fields.",
          ),
        notes: z.string().optional().describe("Note to attach to this update."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (a) => {
      const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
      const payload: IssueUpdate = {
        done_ratio: a.done_ratio,
        assigned_to_id: a.assignee_id,
        subject: a.subject,
        description: a.description,
        start_date: a.start_date,
        due_date: a.due_date,
        estimated_hours: a.estimated_hours,
        fixed_version_id: a.version_id,
        parent_issue_id: a.parent_issue_id,
        notes: a.notes || undefined,
      };

      if (a.status) {
        const resolved = await resolveStatusId(client, a.status);
        if (!resolved) {
          return fail(`Unknown status "${a.status}". Available statuses:\n${formatStatusList(await client.listIssueStatuses())}`);
        }
        payload.status_id = resolved.id;
      }
      if (a.tracker) {
        const trackers = await client.listTrackers();
        const match = resolveNamed(trackers, a.tracker);
        if (!match) return fail(`Unknown tracker "${a.tracker}". Available:\n${formatNamedList(trackers)}`);
        payload.tracker_id = match.id;
      }
      if (a.priority) {
        const priorities = await client.listPriorities();
        const match = resolveNamed(priorities, a.priority);
        if (!match) return fail(`Unknown priority "${a.priority}". Available:\n${formatNamedList(priorities)}`);
        payload.priority_id = match.id;
      }
      if (a.custom_fields) {
        payload.custom_fields = Object.entries(a.custom_fields).map(([id, value]) => ({ id: Number(id), value }));
      }

      const sent = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined)) as IssueUpdate;
      if (Object.keys(sent).length === 0) return fail("Nothing to update — provide at least one field or notes.");

      await client.updateIssue(a.issue_id, sent);
      const issue = await client.getIssue(a.issue_id);
      return {
        content: [{ type: "text", text: `Updated issue #${a.issue_id}.\n\n${formatIssueSummary(issue)}` }],
      };
    },
  );

  registerTool(
    "add_comment",
    {
      title: "Add comment",
      description: "Add a comment to an issue without changing any field. Use update_issue (with notes) when you are also changing fields, so it is one journal entry.",
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
        "Turn a person's name into the user id that update_issue, create_issue and search_issues need. Always pass a project unless you are admin: the instance-wide user list is admin-only.",
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
        let members: RedmineNamed[];
        let source = "";
        try {
          members = await client.listProjectMembers(project);
        } catch (err) {
          if (!(err instanceof RedmineApiError)) throw err;
          // Memberships can be forbidden or broken (500 seen on some instances); people on
          // recent issues are a good-enough stand-in.
          // ponytail: last 100 issues only; widen if someone old can't be found.
          const { issues } = await client.listIssues({ projectId: project, statusId: "*", limit: 100 });
          const seen = new Map<number, RedmineNamed>();
          for (const i of issues) for (const u of [i.assigned_to, i.author]) if (u) seen.set(u.id, u);
          members = [...seen.values()];
          source = `(Member list unavailable: HTTP ${err.status}. Showing people from the project's last 100 issues.)\n`;
        }
        const matched = name
          ? members.filter((m) => m.name.toLowerCase().includes(name.toLowerCase()))
          : members;
        return {
          content: [
            {
              type: "text",
              text:
                source +
                (matched.length
                  ? formatNamedList(matched.slice(0, limit ?? 25))
                  : `No members of "${project}" match${name ? ` "${name}"` : ""}.`),
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
      description: "Record hours spent on an issue (or a project). Use list_time_entries to see what was already logged.",
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
      description: "List projects visible to you (id, identifier, name). Use to turn a project name into the identifier other tools need; use describe_project for one project's trackers, custom fields and versions.",
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

  registerTool(
    "describe_project",
    {
      title: "Describe project",
      description:
        "Show one project's trackers, custom fields (with the ids search_issues and update_issue need) and versions. " +
        "Use before filtering or setting custom fields or versions. For instance-wide statuses/priorities use list_enumerations.",
      inputSchema: {
        project: z.string().describe("Project identifier or numeric id (see list_projects)."),
        include_closed_versions: z.boolean().optional().describe("Also list closed/locked versions (default false)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, include_closed_versions }) => {
      const [p, versions] = await Promise.all([
        client.getProject(project),
        client.listVersions(project).catch(() => null),
      ]);
      const shown = (versions ?? []).filter((v) => include_closed_versions || v.status === "open");
      const text = [
        `${p.id}: ${p.identifier} — ${p.name}`,
        "",
        "Trackers:",
        formatNamedList(p.trackers ?? []) || "(none)",
        "",
        "Custom fields (filter/update with these ids):",
        formatNamedList(p.issue_custom_fields ?? []) || "(none)",
        "",
        `Versions${include_closed_versions ? "" : " (open)"}:`,
        versions === null
          ? "(not visible to you)"
          : shown.map((v) => `${v.id}: ${v.name} [${v.status}]${v.due_date ? ` due ${v.due_date}` : ""}${v.project.id !== p.id ? ` (shared from ${v.project.name})` : ""}`).join("\n") || "(none)",
      ].join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  registerTool(
    "list_saved_queries",
    {
      title: "List saved queries",
      description:
        "List the saved issue queries (custom filters) you can see, public and private. " +
        "Use when the user names a saved filter ('the On Hold query') or a team view; then run it with search_issues query_id.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const queries = await client.listQueries();
      const text = queries
        .map((q) => `${q.id}: ${q.name} (${q.is_public ? "public" : "private"}${q.project_id ? `, project ${q.project_id}` : ""})`)
        .join("\n");
      return { content: [{ type: "text", text: text || "No saved queries visible." }] };
    },
  );

  registerTool(
    "link_issues",
    {
      title: "Link issues",
      description:
        "Create a relation between two issues (relates, blocks, precedes, duplicates, copied_to and their reverses). " +
        "Use for 'X blocks Y' / 'mark as duplicate of'. Use update_issue parent_issue_id for a parent/subtask link instead. " +
        "get_issue shows existing relations with their relation ids.",
      inputSchema: {
        issue_id: z.number().int().positive().describe("The issue the relation starts from."),
        to_issue_id: z.number().int().positive().describe("The other issue."),
        relation: z
          .enum(["relates", "duplicates", "duplicated", "blocks", "blocked", "precedes", "follows", "copied_to", "copied_from"])
          .describe("Read as: issue_id <relation> to_issue_id, e.g. 101 blocks 202."),
        delay_days: z.number().int().min(0).optional().describe("Only for precedes/follows: gap in days."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ issue_id, to_issue_id, relation, delay_days }) => {
      const r = await client.createRelation(issue_id, { issue_to_id: to_issue_id, relation_type: relation, delay: delay_days });
      return { content: [{ type: "text", text: `Linked: #${issue_id} ${relation} #${to_issue_id} (relation id ${r.id}).` }] };
    },
  );

  registerTool(
    "unlink_issues",
    {
      title: "Unlink issues",
      description: "Remove one relation between issues by its relation id (shown by get_issue). Does not touch the issues themselves.",
      inputSchema: {
        relation_id: z.number().int().positive().describe("Relation id from get_issue's Relations list."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ relation_id }) => {
      await client.deleteRelation(relation_id);
      return { content: [{ type: "text", text: `Removed relation ${relation_id}.` }] };
    },
  );

  registerTool(
    "list_time_entries",
    {
      title: "List time entries",
      description:
        "Show logged time with a total: yours by default, or for an issue/project/date range. " +
        "Use for 'what did I log this week?' or 'how much time went into #123?'. Use log_time to add an entry.",
      inputSchema: {
        issue_id: z.number().int().positive().optional().describe("Only time on this issue."),
        project: z.string().optional().describe("Only time in this project."),
        everyone: z.boolean().optional().describe("Include other people's time (default: only yours)."),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date, YYYY-MM-DD."),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date, YYYY-MM-DD."),
        limit: z.number().int().positive().max(100).optional().describe("Max entries (default 100)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ issue_id, project, everyone, from, to, limit }) => {
      const { time_entries, total_count } = await client.listTimeEntries({
        userId: everyone ? undefined : "me",
        issueId: issue_id,
        projectId: project,
        from,
        to,
        limit,
      });
      if (!time_entries.length) return { content: [{ type: "text", text: "No time entries found." }] };
      const total = time_entries.reduce((sum, e) => sum + e.hours, 0);
      const partial = total_count > time_entries.length ? ` (first ${time_entries.length} of ${total_count} entries; narrow the dates for an exact total)` : "";
      const text =
        `Total: ${Math.round(total * 100) / 100}h${partial}\n\n` +
        time_entries
          .map((e) => `${e.spent_on} ${e.hours}h ${e.user.name} — ${e.project.name}${e.issue ? ` #${e.issue.id}` : ""} [${e.activity.name}]${e.comments ? ` ${e.comments}` : ""}`)
          .join("\n");
      return { content: [{ type: "text", text }] };
    },
  );
}
