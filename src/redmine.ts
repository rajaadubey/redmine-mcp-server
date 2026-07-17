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
    const url = baseUrl ?? process.env.REDMINE_URL;
    const key = apiKey ?? process.env.REDMINE_API_KEY;

    if (!url) {
      throw new Error(
        "REDMINE_URL is not set. Set it to the base URL of your Redmine instance, e.g. https://redmine.example.com",
      );
    }
    if (!key) {
      throw new Error(
        "REDMINE_API_KEY is not set. Find your API key under Redmine -> My account -> API access key.",
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

    const res = await fetch(url, {
      method,
      headers: {
        "X-Redmine-API-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = (await res.json()) as RedmineErrorBody;
        if (body.errors?.length) detail = body.errors.join("; ");
      } catch {
        // response had no JSON body; fall back to statusText
      }
      throw new RedmineApiError(`Redmine API error (${res.status}): ${detail}`, res.status);
    }

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
    projectId?: number;
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

  async listIssueStatuses(): Promise<RedmineIssueStatus[]> {
    const data = await this.request<{ issue_statuses: RedmineIssueStatus[] }>(
      "GET",
      "/issue_statuses.json",
    );
    return data!.issue_statuses;
  }
}
