// Run: npx tsx src/redmine.test.ts
import assert from "node:assert";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "redmine-mcp-"));
process.env.REDMINE_MCP_CONFIG = join(dir, "config.json");
process.env.REDMINE_MCP_LOG = join(dir, "test.log");

const { RedmineClient } = await import("./redmine.js");
const { log, logFile } = await import("./logger.js");
const { loadConfig } = await import("./config.js");

const calls: { url: string; method: string; body?: string }[] = [];
globalThis.fetch = (async (url: URL, init: RequestInit) => {
  calls.push({ url: url.toString(), method: init.method!, body: init.body as string });
  return new Response(JSON.stringify({
      issues: [],
      results: [],
      users: [],
      memberships: [],
      total_count: 0,
      issue: { id: 1 },
      project: { id: 1, issue_custom_fields: [] },
      versions: [],
      issue_categories: [],
      time_entry: { id: 1, hours: 1.5, spent_on: "2026-09-09" },
    }), {
    status: 200,
  });
}) as typeof fetch;

const c = new RedmineClient("https://redmine.example.com/", "key");

await c.listIssues({ projectId: "web", subject: "login bug", statusId: "open" });
assert.match(calls.at(-1)!.url, /project_id=web/);
assert.match(calls.at(-1)!.url, /subject=%7Elogin\+bug/, "subject must be sent as ~substring");

await c.search({ q: "timeout", projectId: "web", scope: { issues: true, wiki_pages: true } });
assert.match(calls.at(-1)!.url, /\/projects\/web\/search\.json/);
assert.match(calls.at(-1)!.url, /wiki_pages=1/);
assert.doesNotMatch(calls.at(-1)!.url, /news=/, "unset scopes must be omitted, not sent as 0");

await c.search({ q: "timeout" });
assert.match(calls.at(-1)!.url, /^https:\/\/redmine\.example\.com\/search\.json/);

await c.createIssue({ project_id: "web", subject: "hi", tracker_id: 2 });
assert.equal(calls.at(-1)!.method, "POST");
assert.deepEqual(JSON.parse(calls.at(-1)!.body!), {
  issue: { project_id: "web", subject: "hi", tracker_id: 2 },
});

await c.createIssue({
  project_id: "web",
  subject: "cf",
  status_id: 3,
  category_id: 4,
  fixed_version_id: 8,
  custom_fields: [{ id: 12, value: "abc" }, { id: 13, value: ["x", "y"] }],
});
assert.deepEqual(JSON.parse(calls.at(-1)!.body!), {
  issue: {
    project_id: "web",
    subject: "cf",
    status_id: 3,
    category_id: 4,
    fixed_version_id: 8,
    custom_fields: [{ id: 12, value: "abc" }, { id: 13, value: ["x", "y"] }],
  },
});

await c.listProjectCustomFields("web");
assert.match(calls.at(-1)!.url, /\/projects\/web\.json\?include=issue_custom_fields/);

await c.listVersions("web");
assert.match(calls.at(-1)!.url, /\/projects\/web\/versions\.json/);

await c.createTimeEntry({ issue_id: 5, hours: 1.5, activity_id: 9, comments: "work" });
assert.equal(calls.at(-1)!.method, "POST");
assert.deepEqual(JSON.parse(calls.at(-1)!.body!), {
  time_entry: { issue_id: 5, hours: 1.5, activity_id: 9, comments: "work" },
});

await c.listUsers({ name: "raja" });
assert.match(calls.at(-1)!.url, /\/users\.json\?name=raja/);

await c.listProjectMembers("web");
assert.match(calls.at(-1)!.url, /\/projects\/web\/memberships\.json/);

// Config file is used when env vars are absent, and env wins when present.
writeFileSync(process.env.REDMINE_MCP_CONFIG!, JSON.stringify({ url: "https://file", apiKey: "fk" }));
delete process.env.REDMINE_URL;
delete process.env.REDMINE_API_KEY;
assert.deepEqual(loadConfig(), { url: "https://file", apiKey: "fk" });
process.env.REDMINE_URL = "https://env";
assert.equal(loadConfig().url, "https://env", "env must override the config file");
delete process.env.REDMINE_URL;

// Secrets must never reach the log.
log("info", "probe", { api_key: "topsecret", nested: { token: "topsecret" }, keep: "visible" });
const written = readFileSync(logFile!, "utf8");
assert.doesNotMatch(written, /topsecret/, "secret-looking fields must be redacted");
assert.match(written, /"keep":"visible"/);

console.log(`ok — ${calls.length} requests checked`);
