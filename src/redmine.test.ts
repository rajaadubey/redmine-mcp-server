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
  return new Response(JSON.stringify({ issues: [], results: [], total_count: 0, issue: { id: 1 } }), {
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
