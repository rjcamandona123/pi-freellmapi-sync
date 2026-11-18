// Pi extension for FreeLLMAPI — standalone re-implementation of the OpenCode
// sync plugin. It does not import or modify the OpenCode plugin.
//
// Provides:
//   - automatic local gateway activation (source build, tsx source, or Docker/Podman Compose)
//   - live model-catalog sync through Pi's dynamic provider refreshModels
//   - /freellmapi-sync (force start + refresh) and /setup (first-run wizard)

import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const PROVIDER_ID = "freellmapi";
const DEFAULT_BASE_URL = "http://127.0.0.1:3001/v1";
const FETCH_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 1500;
const PROBE_INTERVAL_MS = 400;
const SPAWN_COOLDOWN_MS = 60000;
const LOCK_STALE_MS = 45000;
const START_TIMEOUT_MS = envNumber("FREELLMAPI_AUTOSTART_TIMEOUT_MS", 25000);
const IS_WINDOWS = process.platform === "win32";

const COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function autostartDisabled(): boolean {
  return ["0", "false", "off", "no"].includes(
    String(process.env.FREELLMAPI_AUTOSTART || "").toLowerCase(),
  );
}

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host === "::"
    );
  } catch {
    return false;
  }
}

function originOf(baseURL: string): string {
  try {
    return new URL(baseURL).origin;
  } catch {
    return "";
  }
}

function piAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".pi", "agent");
}

// Pi does not load .env files, so setup-pi writes the literal key into
// models.json. Read it from there as a fallback for catalog refresh requests.
function readConfiguredKey(): string {
  if (process.env.FREELLMAPI_API_KEY) return process.env.FREELLMAPI_API_KEY;
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(piAgentDir(), "models.json"), "utf8"),
    );
    const providers = parsed?.providers || {};
    for (const id of Object.keys(providers)) {
      if (id !== PROVIDER_ID && !id.startsWith(`${PROVIDER_ID}-`)) continue;
      const raw = providers[id]?.apiKey;
      if (typeof raw !== "string" || !raw) continue;
      return raw
        .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
          (_, a, b) => process.env[a || b] || "")
        .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
          (_, name) => process.env[name] || "");
    }
  } catch {
    /* no models.json, or unreadable */
  }
  return "";
}

// --- install discovery ------------------------------------------------------

function findComposeFile(dir: string | null | undefined): string | null {
  if (!dir) return null;
  for (const name of COMPOSE_FILES) {
    const file = path.join(dir, name);
    try {
      if (!existsSync(file)) continue;
      // A Docker one-liner install has only a compose file + .env. Require the
      // service name so an unrelated compose file in a parent dir is ignored.
      if (/freellmapi/i.test(readFileSync(file, "utf8"))) return file;
    } catch {
      /* unreadable compose file: keep looking */
    }
  }
  return null;
}

function isServerHome(dir: string | null | undefined): boolean {
  if (!dir) return false;
  try {
    return (
      existsSync(path.join(dir, "server", "dist", "index.js")) ||
      existsSync(path.join(dir, "server", "src", "index.ts")) ||
      Boolean(findComposeFile(dir))
    );
  } catch {
    return false;
  }
}

function findServerHome(): string | null {
  const home = os.homedir?.();
  // Explicit overrides are trusted as-is: a Docker install has no server/src.
  for (const explicit of [
    process.env.FREELLMAPI_HOME,
    process.env.FREELLMAPI_DIR,
    process.env.FREELLMAPI_ROOT,
  ]) {
    if (!explicit) continue;
    const resolved = path.resolve(explicit);
    try {
      if (existsSync(resolved)) return resolved;
    } catch {
      /* keep looking */
    }
  }

  const candidates: string[] = [];
  const cwd = process.cwd();
  candidates.push(cwd, path.join(cwd, "freellmapi"));

  let dir = cwd;
  for (let i = 0; i < 4; i += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    candidates.push(parent, path.join(parent, "freellmapi"));
    dir = parent;
  }

  if (home) {
    candidates.push(
      path.join(home, "freellmapi"),
      path.join(home, ".freellmapi", "app"),
      path.join(home, "Documents", "freellmapi"),
      path.join(home, "Projects", "freellmapi"),
    );
  }

  for (const base of [process.env.LOCALAPPDATA, process.env.APPDATA]) {
    if (!base) continue;
    candidates.push(
      path.join(base, "Programs", "freellmapi"),
      path.join(base, "freellmapi"),
    );
  }

  candidates.push("/opt/freellmapi", "/usr/local/freellmapi", "/srv/freellmapi");

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (isServerHome(resolved)) return resolved;
  }
  return null;
}

// --- gateway activation -----------------------------------------------------

function hasCommand(name: string): boolean {
  const extensions = IS_WINDOWS ? [".exe", ".cmd", ".bat", ".ps1"] : [""];
  for (const entry of String(process.env.PATH || "").split(path.delimiter)) {
    if (!entry) continue;
    for (const ext of extensions) {
      try {
        if (existsSync(path.join(entry, `${name}${ext}`))) return true;
      } catch {
        /* ignore malformed PATH entries */
      }
    }
  }
  return false;
}

function composeCommand(): string[] | null {
  // Same preference order as the official install.sh.
  if (hasCommand("docker")) return ["docker", "compose"];
  if (hasCommand("docker-compose")) return ["docker-compose"];
  if (hasCommand("podman")) return ["podman", "compose"];
  if (hasCommand("podman-compose")) return ["podman-compose"];
  return null;
}

function resolveNodeBin(): string {
  // Pi may run under Bun; FreeLLMAPI's native bindings need Node.
  if (process.versions?.bun) return process.env.FREELLMAPI_NODE || "node";
  return process.execPath;
}

type StartSpec = {
  command: string;
  args: string[];
  cwd: string;
  shell: boolean;
};

function buildStartCommand(home: string): StartSpec | null {
  const custom = process.env.FREELLMAPI_START_CMD;
  if (custom) return { command: custom, args: [], cwd: home, shell: true };

  const serverDir = path.join(home, "server");
  const distEntry = path.join(serverDir, "dist", "index.js");
  if (existsSync(distEntry)) {
    return {
      command: resolveNodeBin(),
      args: [distEntry],
      cwd: serverDir,
      shell: false,
    };
  }

  const tsxCli = [
    path.join(home, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(serverDir, "node_modules", "tsx", "dist", "cli.mjs"),
  ].find((candidate) => existsSync(candidate));
  if (tsxCli && existsSync(path.join(serverDir, "src", "index.ts"))) {
    return {
      command: resolveNodeBin(),
      args: [tsxCli, "watch", "src/index.ts"],
      cwd: serverDir,
      shell: false,
    };
  }

  // curl -fsSL https://freellmapi.co/install.sh | bash leaves only a compose
  // file + .env, so use Compose directly instead of requiring a custom command.
  if (findComposeFile(home)) {
    const compose = composeCommand();
    if (compose) {
      return {
        command: compose[0],
        args: [...compose.slice(1), "up", "-d"],
        cwd: home,
        shell: IS_WINDOWS,
      };
    }
    // A Compose-only install has no server/ tree: falling through to npm would
    // just produce ENOENT and burn the whole startup timeout.
    return null;
  }

  return {
    command: IS_WINDOWS ? "npm.cmd" : "npm",
    args: ["run", "dev", "-w", "server"],
    cwd: home,
    shell: IS_WINDOWS,
  };
}

function readLock(lockPath: string): { pid: number; startedAt: number } | null {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8"));
    if (!raw || typeof raw.pid !== "number") return null;
    return raw;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function probe(baseURL: string): Promise<boolean> {
  const origin = originOf(baseURL);
  if (!origin) return false;
  try {
    // Any HTTP answer (200/401/404) means the gateway is listening.
    await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: "manual",
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForServer(baseURL: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(baseURL)) return true;
    await delay(PROBE_INTERVAL_MS);
  }
  return probe(baseURL);
}

let starting: Promise<boolean> | null = null;
let lastSpawnAt = 0;

function spawnServer(home: string): number | null | undefined {
  const spec = buildStartCommand(home);
  const logPath =
    process.env.FREELLMAPI_AUTOSTART_LOG || path.join(home, "server.autostart.log");

  if (!spec) {
    try {
      appendFileSync(
        logPath,
        `[${new Date().toISOString()}] No start command available in ${home}: ` +
          `no built server, no tsx source, no Compose binary, and FREELLMAPI_START_CMD is unset\n`,
      );
    } catch {
      /* logging is best-effort */
    }
    return null;
  }

  let out: number | "ignore" = "ignore";
  try {
    out = openSync(logPath, "a");
  } catch {
    out = "ignore";
  }

  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    shell: spec.shell,
    detached: true,
    windowsHide: true,
    stdio: out === "ignore" ? "ignore" : ["ignore", out, out],
    env: process.env,
  });

  // ENOENT/EACCES arrive asynchronously; never take Pi down with them.
  child.on("error", () => {});
  child.unref();

  if (typeof out === "number") {
    try {
      closeSync(out);
    } catch {
      /* already closed */
    }
  }

  if (child.pid) {
    try {
      writeFileSync(
        path.join(home, ".autostart.lock"),
        JSON.stringify({ pid: child.pid, startedAt: Date.now() }),
      );
    } catch {
      /* lock is advisory only */
    }
  }
  return child.pid;
}

async function ensureServer(baseURL: string, force = false): Promise<boolean> {
  if (autostartDisabled() || !isLocalUrl(baseURL)) return false;
  if (starting) return starting;

  starting = (async () => {
    if (await probe(baseURL)) return true;

    const home = findServerHome();
    if (!home) return false;

    const lockPath = path.join(home, ".autostart.lock");
    const lock = readLock(lockPath);
    const lockFresh = lock && Date.now() - Number(lock.startedAt || 0) < LOCK_STALE_MS;

    if (lockFresh && pidAlive(lock.pid)) {
      return waitForServer(baseURL, START_TIMEOUT_MS);
    }
    if (!force && Date.now() - lastSpawnAt < SPAWN_COOLDOWN_MS) {
      return waitForServer(baseURL, START_TIMEOUT_MS);
    }

    lastSpawnAt = Date.now();
    try {
      // null = nothing available to start (e.g. Compose install with no engine).
      if (spawnServer(home) === null) return false;
    } catch {
      return false;
    }
    return waitForServer(baseURL, START_TIMEOUT_MS);
  })().finally(() => {
    starting = null;
  });

  return starting;
}

// --- live catalog -----------------------------------------------------------

type PiModel = {
  type: "chat";
  id: string;
  name: string;
  reasoning: false;
  input: ["text"];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

function toPiModel(m: any): PiModel | null {
  const id = m?.id;
  if (typeof id !== "string" || !id) return null;
  return {
    type: "chat",
    id,
    name: typeof m.name === "string" && m.name ? m.name : id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow:
      Number(m.context_length || m.context_window || m.contextWindow || m.limit?.context) ||
      131072,
    maxTokens:
      Number(m.max_output_tokens || m.output_limit || m.maxTokens || m.limit?.output) ||
      8192,
  };
}

async function fetchModels(
  baseURL: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<PiModel[] | null> {
  const base = String(baseURL || "").replace(/\/+$/, "");
  if (!base || !apiKey) return null;
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal || AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const models = (Array.isArray(body?.data) ? body.data : [])
      .filter((m: any) => m && m.available !== false)
      .map(toPiModel)
      .filter(Boolean) as PiModel[];
    return models.length ? models : null;
  } catch {
    return null;
  }
}

function storedModels(stored: any): PiModel[] {
  if (Array.isArray(stored)) return stored;
  if (stored && typeof stored === "object") {
    for (const key of ["models", "catalog", "snapshot"]) {
      if (Array.isArray(stored[key])) return stored[key];
    }
  }
  return [];
}

// --- /setup prompt ----------------------------------------------------------

function redactKey(text: string): string {
  return text.replace(/freellmapi-[A-Za-z0-9_-]+/gi, "[unified key hidden]");
}

function setupPrompt(args: string, baseURL: string): string {
  const safeArgs = redactKey(args).trim();
  const envKeyPresent = Boolean(process.env.FREELLMAPI_API_KEY);
  return `You are running first-time FreeLLMAPI setup for Pi (the pi coding agent). Follow these steps in order, using your shell tool, and pause whenever the user has to act.

Raw arguments: ${safeArgs || "(none)"}
Gateway URL: ${baseURL}

Background you should use in your explanations:
- FreeLLMAPI is a local, open-source router that puts many free-tier LLM providers behind one OpenAI-compatible endpoint (${baseURL}). It is a good alternative when the user has no paid API key yet.
- The user adds their own provider keys (Groq, Gemini, Mistral, etc.) on the dashboard at http://localhost:3001, under Keys.
- The dashboard then shows one unified key starting with freellmapi-. That is the only credential Pi needs.
- The FreeLLMAPI install directory is whatever FREELLMAPI_HOME points at, otherwise ~/freellmapi (Docker one-liner), a source checkout such as ~/Documents/freellmapi or ~/Projects/freellmapi, or an equivalent path on Windows/this machine.

${
  envKeyPresent
    ? "A unified key was supplied privately with /setup and is already exported as FREELLMAPI_API_KEY. Use it from the environment; never echo, print, or paste it back."
    : "No key was supplied with /setup. When you need one, ask the user to paste it (hidden input) and keep it out of your replies."
}

Steps:

1. Check whether the gateway is already running. Probe ${baseURL.replace(/\/v1\/?$/, "")}/api/health over HTTP. Any HTTP response means it is up; only a connection error means it is not. Do not treat 401/404 as failure.

2. If it is not running, locate the install and start it detached.
   - Prefer a built server: node server/dist/index.js, with server/ as the working directory; append output to server.autostart.log.
   - Otherwise start the dev server from the install root: npm run dev -w server (only the server workspace; the dashboard on port 5173 is optional). Plain npm run dev also starts the dashboard and is only for manual source installs.
   - For a Docker/Podman Compose install (a docker-compose.yml, docker-compose.yaml, compose.yml, or compose.yaml containing a freellmapi service, with no server/ tree), start it from the install directory with the first available of: docker compose up -d, docker-compose up -d, podman compose up -d, podman-compose up -d.
   - Use the platform's syntax: nohup … & on macOS/Linux/Termux, Start-Process -WindowStyle Hidden in PowerShell on Windows.
   - Wait for /api/health to answer, up to 60 seconds.
   - If the install cannot be found, do not invent one. Explain the options and stop:
     * Docker one-liner: curl -fsSL https://freellmapi.co/install.sh | bash
     * From source: git clone https://github.com/tashfeenahmed/freellmapi.git, then npm install, then npm run dev
     * Desktop app: https://github.com/tashfeenahmed/freellmapi/releases/latest
     Ask the user to run one of them and then re-run /setup.

3. Get the unified key.
   - If FREELLMAPI_API_KEY is already set (see the note above), use it without printing it.
   - Otherwise ask the user to open http://localhost:3001, add at least one provider key on the Keys page, and paste the freellmapi-… key from the same page.
   - Never print the key back, never write it into a repository file, and do not continue until you have a key.

4. Validate the key before changing any config. Call GET ${baseURL}/models with Authorization: Bearer <key>. A 200 with a non-empty data array means the key works. On 401, ask the user to copy the key again.

5. Configure Pi with the official generator.
   - Run: npx -y freellmapi setup-pi --url ${baseURL} --api-key "$FREELLMAPI_API_KEY"
   - It writes ~/.pi/agent/models.json (mode 0600) with the freellmapi provider, the OpenAI-compatible endpoint, and the live model list, and sets defaultProvider/defaultModel in ~/.pi/agent/settings.json. PI_CODING_AGENT_DIR overrides that directory.
   - Preserve any unrelated providers and settings. Do not commit models.json or any file containing the key.
   - The OpenCode equivalent is npx -y freellmapi setup-opencode --url ${baseURL} --api-key "$FREELLMAPI_API_KEY"; note that freellmapi 0.8.x writes apiKey "{env:FREELLMAPI_API_KEY}" and asks you to export the variable instead of writing auth.json.

6. Verify end to end. Send a tiny completion to POST ${baseURL}/chat/completions with {"model":"auto","messages":[{"role":"user","content":"Say OK"}],"max_tokens":8} and the unified key. Report which upstream model answered, not the key.

7. Finish. Tell the user to run /reload in Pi so the catalog is picked up, then suggest a first message like "hello". Mention:
   - Dashboard: http://localhost:3001 (add/replace provider keys there any time)
   - Diagnose problems: npx freellmapi doctor
   - The FreeLLMAPI Pi extension keeps the model list fresh and auto-starts the gateway on later launches; /freellmapi-sync forces a refresh.
   - Install command for other machines: pi install git:github.com/rjcamandona123/pi-freellmapi-sync

If any step fails, show the exact command and its error output, explain the likely cause in one sentence, and stop rather than guessing. Do not include the unified key in the error output.`;
}

// --- extension --------------------------------------------------------------

export default function (pi: any) {
  const baseURL = process.env.FREELLMAPI_BASE_URL || DEFAULT_BASE_URL;
  let lastModelCount = 0;

  async function refreshModels(context: any = {}): Promise<PiModel[]> {
    const key = readConfiguredKey();
    // Gateway activation is initiated in session_start; this is a safety net
    // for refreshes triggered before that hook runs.
    if (key && isLocalUrl(baseURL) && !autostartDisabled()) {
      await ensureServer(baseURL);
    }
    if (key && !context.signal?.aborted) {
      const models = await fetchModels(baseURL, key, context.signal);
      if (models?.length) {
        lastModelCount = models.length;
        return models;
      }
    }
    // Keep the catalog from setup-pi when live discovery is unavailable.
    return storedModels(context.stored);
  }

  const providerConfig: any = {
    name: "FreeLLMAPI",
    baseUrl: baseURL,
    api: "openai-completions",
    // Seed model so a fresh install has a selectable model before the first
    // refresh; refreshModels replaces this with the live catalog.
    models: [
      {
        type: "chat",
        id: "auto",
        name: "FreeLLMAPI Auto",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 8192,
      },
    ],
    refreshModels,
  };
  // models.json (from setup-pi) overrides this when a literal key is stored.
  if (process.env.FREELLMAPI_API_KEY) {
    providerConfig.apiKey = "$FREELLMAPI_API_KEY";
  }
  pi.registerProvider(PROVIDER_ID, providerConfig);

  pi.on("session_start", async (_event: any, ctx: any) => {
    // Never start processes from the extension factory: hooks are the right
    // place for session-scoped/background work.
    void (async () => {
      if (isLocalUrl(baseURL) && !autostartDisabled()) {
        await ensureServer(baseURL);
      }
      await ctx.modelRegistry.refresh();
    })().catch(() => {
      // A catalog refresh failure must not break the session.
    });
  });

  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    // Only gate a turn when it actually uses this local provider.
    if (ctx.model?.provider !== PROVIDER_ID) return;
    await ensureServer(baseURL);
  });

  pi.registerCommand("freellmapi-sync", {
    description: "Start the FreeLLMAPI gateway (if needed) and refresh its model catalog",
    handler: async (_args: string, ctx: any) => {
      const up = await ensureServer(baseURL, true);
      if (!up) {
        ctx.ui.notify(
          "FreeLLMAPI gateway is not reachable. Run /setup or check FREELLMAPI_HOME.",
          "warning",
        );
        return;
      }
      await ctx.modelRegistry.refresh();
      ctx.ui.notify(
        `FreeLLMAPI catalog refreshed (${lastModelCount || "live"} models).`,
        "info",
      );
    },
  });

  pi.registerCommand("setup", {
    description: "First-time FreeLLMAPI setup: start gateway, get a key, configure Pi",
    handler: async (args: string, ctx: any) => {
      // Keep a key passed as /setup freellmapi-… out of the transcript.
      const supplied = String(args || "").match(/freellmapi-[A-Za-z0-9_-]+/i);
      if (supplied) process.env.FREELLMAPI_API_KEY = supplied[0];

      ctx.ui.notify("Checking the FreeLLMAPI gateway…", "info");
      await ensureServer(baseURL, true);
      pi.sendUserMessage(setupPrompt(String(args || ""), baseURL));
    },
  });
}
