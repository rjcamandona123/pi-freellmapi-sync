# pi-freellmapi-sync

[![Pi Extension](https://img.shields.io/badge/Pi-Coding%20Agent-111111?style=for-the-badge&logo=terminal&logoColor=white)](https://pi.dev/)
[![FreeLLMAPI Compatible](https://img.shields.io/badge/FreeLLMAPI-Compatible-2563EB?style=for-the-badge)](https://github.com/tashfeenahmed/freellmapi)
[![License: MIT](https://img.shields.io/badge/License-MIT-F59E0B?style=for-the-badge)](LICENSE)
[![GitHub Repo](https://img.shields.io/badge/GitHub-rjcamandona123%2Fpi--freellmapi--sync-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/rjcamandona123/pi-freellmapi-sync)

Pi coding agent extension for [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) — a local, open-source router that puts many free-tier LLM providers behind one OpenAI-compatible endpoint.

It auto-starts the local gateway, keeps Pi's `freellmapi` model catalog in sync with what the gateway actually serves, and adds two commands:

- `/setup` — first-time wizard (gateway → unified key → official generator → end-to-end check)
- `/freellmapi-sync` — force gateway start + refresh the live catalog

This is a standalone Pi package.

## Install

```sh
pi install git:github.com/rjcamandona123/pi-freellmapi-sync
```

Then reload Pi (`/reload`) or start a new session.

## First-time setup

Run `/setup` in Pi. It walks through:

1. probing `http://127.0.0.1:3001/api/health` (any HTTP status means "up"),
2. starting the gateway if needed — built server (`node server/dist/index.js`), `npm run dev -w server`, or Docker/Podman Compose (`docker compose up -d` and fallbacks),
3. getting the unified `freellmapi-…` key from the dashboard's **Keys** page (never printed back),
4. validating it with `GET /v1/models`,
5. running the official generator:

   ```sh
   npx -y freellmapi setup-pi --url http://127.0.0.1:3001 --api-key "$FREELLMAPI_API_KEY"
   ```

   which writes `~/.pi/agent/models.json` (mode 0600) and sets defaults in `~/.pi/agent/settings.json` (override with `PI_CODING_AGENT_DIR`),

6. sending a small completion and reporting which upstream model answered,
7. telling you to run `/reload` and send “hello”.

You can pass a key privately: `/setup freellmapi-…`. It is stored only in the process environment and never echoed into the transcript.

If FreeLLMAPI is not installed, `/setup` stops and shows the options (Docker one-liner, git source, desktop app) instead of guessing.

## What the extension does

- Registers a `freellmapi` provider (`api: openai-completions`, `baseUrl: …/v1`) with a seed `auto` model.
- `refreshModels` fetches `/v1/models` on every Pi model refresh and replaces the catalog with the live, available models (context window/output limits included). If discovery fails, the catalog from `setup-pi` is kept.
- `session_start` ensures the local gateway is up, then triggers a model refresh.
- `before_agent_start` re-checks the gateway only when the active model belongs to `freellmapi`.
- `/freellmapi-sync` bypasses the spawn cooldown and refreshes immediately.

Gateway output is appended to `server.autostart.log` in the install directory. A `.autostart.lock` prevents duplicate starts across sessions.

## Activation

Start command preference:

1. `FREELLMAPI_START_CMD` (custom shell command, for any install method)
2. `node server/dist/index.js` from `<install>/server`
3. `node node_modules/tsx/dist/cli.mjs watch src/index.ts`
4. `docker compose up -d` → `docker-compose up -d` → `podman compose up -d` → `podman-compose up -d` when a compose file containing a `freellmapi` service is found (this is exactly what `curl -fsSL https://freellmapi.co/install.sh | bash` leaves behind)
5. `npm run dev -w server` (`npm.cmd` via shell on Windows)

| Variable | Default | Purpose |
| --- | --- | --- |
| `FREELLMAPI_HOME` | auto-detected | Install directory (trusted as-is when set) |
| `FREELLMAPI_DIR`, `FREELLMAPI_ROOT` | — | Alternate explicit install directory |
| `FREELLMAPI_BASE_URL` | `http://127.0.0.1:3001/v1` | Gateway endpoint |
| `FREELLMAPI_API_KEY` | from `models.json` | Unified key; `setup-pi` stores a literal key in `models.json` |
| `FREELLMAPI_AUTOSTART` | `1` | Set to `0`/`false` to disable auto-start |
| `FREELLMAPI_AUTOSTART_TIMEOUT_MS` | `25000` | Startup wait budget |
| `FREELLMAPI_AUTOSTART_LOG` | `<home>/server.autostart.log` | Child process log |
| `FREELLMAPI_START_CMD` | — | Override the start command |
| `FREELLMAPI_NODE` | `node` | Node binary when Pi runs under Bun |

Auto-start only runs for local gateways; a remote `baseURL` is never spawned.

## Requirements

- Pi coding agent (`@earendil-works/pi-coding-agent`; `pi --version` 1.x)
- Node.js 20.18+ (same as FreeLLMAPI)
- A FreeLLMAPI gateway, or an install directory the extension can find

## License

MIT
