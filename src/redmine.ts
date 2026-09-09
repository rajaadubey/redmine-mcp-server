import { log, errorInfo } from "./logger.js";
import { loadConfig } from "./config.js";

export interface RedmineIssueStatus {
  id: number;
  name: string;
  is_closed?: boolean;
}

export interface RedmineProject {
  id: number;
  identifier: string;
  name: string;
}

export interface RedmineUser {
  id: number;
  login?: string;
  firstname?: string;
  lastname?: string;
  mail?: string;
}

export interface RedmineJournalDetail {
  property: string;
  name: string;
  old_value?: string;
  new_value?: string;
}

export interface RedmineJournal {
  id: number;
  user?: { id: number; name: string };
  notes?: string;
  created_on: string;
  details?: RedmineJournalDetail[];
}

export interface RedmineCustomField {
  id: number;
  name: string;
  /** Multi-value fields return an array. */
  value?: string | string[] | null;
}

export interface RedmineIssue {
  id: number;
  subject: string;
  description?: string;
  project: { id: number; name: string };
  tracker: { id: number; name: string };
  status: { id: number; name: string };
  priority: { id: number; name: string };
  author: { id: number; name: string };
  assigned_to?: { id: number; name: string };
  done_ratio?: number;
  created_on: string;
  updated_on: string;
  journals?: RedmineJournal[];
  category?: { id: number; name: string };
  fixed_version?: { id: number; name: string };
  custom_fields?: RedmineCustomField[];
}

export interface RedmineNamed {
  id: number;
  name: string;
}

export interface RedmineSearchResult {
  id: number;
  title: string;
  type: string;
  url: string;
  description?: string;
  datetime?: string;
}

interface RedmineErrorBody {
  errors?: string[];
}

export class RedmineApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "RedmineApiError";
  }
}

export class RedmineClient {
  private baseUrl: string;
  private apiKey: string;
  private currentUser: RedmineUser | null = null;

  constructor(baseUrl?: string, apiKey?: string) {
    const configured = baseUrl && apiKey ? { url: baseUrl, apiKey } : loadConfig();
    const url = baseUrl ?? configured.url;
    const key = apiKey ?? configured.apiKey;

    if (!url || !key) {
      throw new Error(
        "No Redmine credentials found. Run `redmine-mcp-server login` to save them, " +
          "or set REDMINE_URL and REDMINE_API_KEY.",
      );
    }

    this.baseUrl = url.replace(/\/+$/, "");
    this.apiKey = key;
  }

  private async request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T | null> {
    const url = new URL(this.baseUrl + path);
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    // The API key travels in a header and is never logged; the path and query are.
    log("info", "http_request", { method, path, query: options.query, has_body: options.body !== undefined });
    const started = Date.now();

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "X-Redmine-API-Key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch (err) {
      log("error", "http_failed", { method, path, ms: Date.now() - started, ...errorInfo(err) });
      throw err;
    }

    const ms = Date.now() - started;

    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = (await res.json()) as RedmineErrorBody;
        if (body.errors?.length) detail = body.errors.join("; ");
      } catch {
        // response had no JSON body; fall back to statusText
      }
      log("error", "http_response", { method, path, status: res.status, ms, detail });
      throw new RedmineApiError(`Redmine API error (${res.status}): ${detail}`, res.status);
    }

    log("info", "http_response", { method, path, status: res.status, ms });

    if (res.status === 204) return null;

    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  }

  async getCurrentUser(): Promise<RedmineUser> {
    if (this.currentUser) return this.currentUser;
    const data = await this.request<{ user: RedmineUser }>("GET", "/users/current.json");
    this.currentUser = data!.user;
    return this.currentUser;
  }

  async listIssues(params: {
    assignedToId?: number | "me";
    statusId?: string;
    projectId?: number | string;
    subject?: string;
    limit?: number;
    offset?: number;
    sort?: string;
  }): Promise<{ issues: RedmineIssue[]; total_count: number }> {
    const data = await this.request<{ issues: RedmineIssue[]; total_count: number }>(
      "GET",
      "/issues.json",
      {
        query: {
          assigned_to_id: params.assignedToId,
          status_id: params.statusId,
          project_id: params.projectId,
          subject: params.subject ? `~${params.subject}` : undefined,
          limit: params.limit ?? 25,
          offset: params.offset,
          sort: params.sort ?? "updated_on:desc",
        },
      },
    );
    return data!;
  }

  async getIssue(id: number, opts: { includeJournals?: boolean } = {}): Promise<RedmineIssue> {
    const include = opts.includeJournals ? "journals,attachments" : undefined;
    const data = await this.request<{ issue: RedmineIssue }>("GET", `/issues/${id}.json`, {
      query: { include },
    });
    return data!.issue;
  }

  async updateIssue(
    id: number,
    payload: {
      status_id?: number;
      assigned_to_id?: number;
      done_ratio?: number;
      notes?: string;
    },
  ): Promise<void> {
    await this.request("PUT", `/issues/${id}.json`, { body: { issue: payload } });
  }

  async listProjects(): Promise<RedmineProject[]> {
    const data = await this.request<{ projects: RedmineProject[] }>("GET", "/projects.json", {
      query: { limit: 100 },
    });
    return data!.projects;
  }

  async createIssue(payload: {
    project_id: number | string;
    subject: string;
    description?: string;
    tracker_id?: number;
    priority_id?: number;
    status_id?: number;
    category_id?: number;
    fixed_version_id?: number;
    assigned_to_id?: number;
    custom_fields?: { id: number; value: string | string[] }[];
  }): Promise<RedmineIssue> {
    const data = await this.request<{ issue: RedmineIssue }>("POST", "/issues.json", {
      body: { issue: payload },
    });
    return data!.issue;
  }

  /** Full-text search across issues, wiki pages and news. */
  async search(params: {
    q: string;
    projectId?: number | string;
    scope?: { issues?: boolean; wiki_pages?: boolean; news?: boolean };
    limit?: number;
  }): Promise<{ results: RedmineSearchResult[]; total_count: number }> {
    const scope = params.scope ?? { issues: true };
    const path = params.projectId ? `/projects/${params.projectId}/search.json` : "/search.json";
    const data = await this.request<{ results: RedmineSearchResult[]; total_count: number }>(
      "GET",
      path,
      {
        query: {
          q: params.q,
          issues: scope.issues ? 1 : undefined,
          wiki_pages: scope.wiki_pages ? 1 : undefined,
          news: scope.news ? 1 : undefined,
          limit: params.limit ?? 25,
        },
      },
    );
    return data!;
  }

  /** Admin-only in Redmine; non-admins get 403 and should search project members instead. */
  async listUsers(params: { name?: string; limit?: number }): Promise<RedmineUser[]> {
    const data = await this.request<{ users: RedmineUser[] }>("GET", "/users.json", {
      query: { name: params.name, limit: params.limit ?? 25 },
    });
    return data!.users;
  }

  /** Visible to any project member, unlike /users.json. */
  async listProjectMembers(projectId: number | string): Promise<RedmineNamed[]> {
    const data = await this.request<{
      memberships: { user?: RedmineNamed; group?: RedmineNamed }[];
    }>("GET", `/projects/${projectId}/memberships.json`, { query: { limit: 100 } });
    return data!.memberships.flatMap((m) => (m.user ? [m.user] : []));
  }

  /**
   * Custom fields usable on this project's issues. Uses the project include,
   * which any member can read; /custom_fields.json is admin-only.
   */
  async listProjectCustomFields(projectId: number | string): Promise<RedmineNamed[]> {
    const data = await this.request<{ project: { issue_custom_fields?: RedmineNamed[] } }>(
      "GET",
      `/projects/${projectId}.json`,
      { query: { include: "issue_custom_fields" } },
    );
    return data!.project.issue_custom_fields ?? [];
  }

  async listVersions(projectId: number | string): Promise<RedmineNamed[]> {
    const data = await this.request<{ versions: RedmineNamed[] }>(
      "GET",
      `/projects/${projectId}/versions.json`,
    );
    return data!.versions;
  }

  async listIssueCategories(projectId: number | string): Promise<RedmineNamed[]> {
    const data = await this.request<{ issue_categories: RedmineNamed[] }>(
      "GET",
      `/projects/${projectId}/issue_categories.json`,
    );
    return data!.issue_categories;
  }

  async listTimeEntryActivities(): Promise<RedmineNamed[]> {
    const data = await this.request<{ time_entry_activities: RedmineNamed[] }>(
      "GET",
      "/enumerations/time_entry_activities.json",
    );
    return data!.time_entry_activities;
  }

  async createTimeEntry(payload: {
    issue_id?: number;
    project_id?: number | string;
    hours: number;
    spent_on?: string;
    activity_id?: number;
    comments?: string;
  }): Promise<{ id: number; hours: number; spent_on: string }> {
    const data = await this.request<{
      time_entry: { id: number; hours: number; spent_on: string };
    }>("POST", "/time_entries.json", { body: { time_entry: payload } });
    return data!.time_entry;
  }

  async listTrackers(): Promise<RedmineNamed[]> {
    const data = await this.request<{ trackers: RedmineNamed[] }>("GET", "/trackers.json");
    return data!.trackers;
  }

  async listPriorities(): Promise<RedmineNamed[]> {
    const data = await this.request<{ issue_priorities: RedmineNamed[] }>(
      "GET",
      "/enumerations/issue_priorities.json",
    );
    return data!.issue_priorities;
  }

  async listIssueStatuses(): Promise<RedmineIssueStatus[]> {
    const data = await this.request<{ issue_statuses: RedmineIssueStatus[] }>(
      "GET",
      "/issue_statuses.json",
    );
    return data!.issue_statuses;
  }
}
