import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { log } from "./logger.js";

export const configFile =
  process.env.REDMINE_MCP_CONFIG ?? join(homedir(), ".config", "redmine-mcp", "config.json");

export interface RedmineConfig {
  url?: string;
  apiKey?: string;
}

/** Env vars win over the config file, so a single deploy can still be overridden. */
export function loadConfig(): RedmineConfig {
  let file: RedmineConfig = {};
  try {
    file = JSON.parse(readFileSync(configFile, "utf8")) as RedmineConfig;
    log("info", "config_loaded", { source: configFile });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log("warn", "config_unreadable", { source: configFile, error: String(err) });
    }
  }
  return {
    url: process.env.REDMINE_URL ?? file.url,
    apiKey: process.env.REDMINE_API_KEY ?? file.apiKey,
  };
}

function saveConfig(config: RedmineConfig): void {
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

type Prompt = { text: string; hide?: boolean };

/**
 * Ask a series of questions on one interface. The promises variant of readline
 * silently drops piped input on the second question, so this uses the callback
 * API, which works for both a terminal and `printf ... | redmine-mcp-server login`.
 */
function ask(prompts: Prompt[]): Promise<string[]> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answers: string[] = [];
    const mute = (on: boolean) => {
      const target = rl as unknown as { _writeToOutput?: (s: string) => void };
      if (on) target._writeToOutput = () => {};
      else delete target._writeToOutput;
    };

    const next = () => {
      const prompt = prompts[answers.length];
      if (!prompt) return rl.close();
      process.stdout.write(prompt.text);
      mute(Boolean(prompt.hide));
    };

    rl.on("line", (line) => {
      if (prompts[answers.length]?.hide) process.stdout.write("\n");
      answers.push(line.trim());
      next();
    });
    // EOF before every question was answered: keep what we got.
    rl.on("close", () => {
      mute(false);
      resolve(answers);
    });

    next();
  });
}

/** `redmine-mcp-server login` \u2014 writes credentials once so MCP config needs none. */
export async function login(): Promise<void> {
  let existing: RedmineConfig = {};
  try {
    existing = JSON.parse(readFileSync(configFile, "utf8")) as RedmineConfig;
  } catch {
    // no config yet
  }

  console.log("API key: Redmine \u2192 My account \u2192 API access key \u2192 Show (input is hidden)");
  const [urlAnswer = "", keyAnswer = ""] = await ask([
    { text: `Redmine URL${existing.url ? ` [${existing.url}]` : ""}: ` },
    { text: `Redmine API key${existing.apiKey ? " [unchanged]" : ""}: `, hide: true },
  ]);

  const url = urlAnswer || existing.url;
  const apiKey = keyAnswer || existing.apiKey;
  if (!url) throw new Error("A Redmine URL is required.");
  if (!apiKey) throw new Error("A Redmine API key is required.");

  saveConfig({ url: url.replace(/\/+$/, ""), apiKey });
  log("info", "config_saved", { path: configFile });
  console.log(`Saved to ${configFile} (mode 0600).`);
  console.log("Register with: claude mcp add redmine-mcp-server -- redmine-mcp-server");
}
