<h1 align="center">GlyphMark</h1>

<p align="center">
  One TypeScript core, four agent-facing surfaces: a CLI, a local MCP server, a remote MCP server, and a Skill.
</p>

---

GlyphMark is a small monorepo that demonstrates a single pattern: write a capability **once** in a shared core package, then expose it through every interface an agent or human might reach for. The shipped capability sends Telegram messages, but it is deliberately tiny — the point is the wiring around it.

```text
                    ┌────────────────────────────┐
                    │  @krish-dev/glyphmark-core │
                    │  schemas + operations      │
                    └─────────────┬──────────────┘
                                  │
        ┌────────────────┬────────┴────────┬──────────────────┐
        │                │                 │                  │
   packages/cli   packages/local-mcp  apps/remote-mcp   skills/glyphmark
   `glyphmark`    `glyphmark-mcp`     Hono + Clerk      SKILL.md
   (terminal)     (stdio MCP)         (HTTP MCP)        (instructions)
```

Every adapter does the same three things and nothing more: read credentials from wherever *its* audience keeps them, validate input against the shared schema, and call core. No business logic lives outside `packages/core`.

## Contents

- [What's in the box](#whats-in-the-box)
- [Tech stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [The CLI](#the-cli)
- [Local MCP server](#local-mcp-server)
- [Remote MCP server](#remote-mcp-server)
- [The Skill](#the-skill)
- [The core package](#the-core-package)
- [Working on GlyphMark](#working-on-glyphmark)
- [Adding your own operation](#adding-your-own-operation)
- [Publishing](#publishing)
- [Troubleshooting](#troubleshooting)

## What's in the box

| Path | Package | Published | Role |
| --- | --- | --- | --- |
| `packages/core` | `@krish-dev/glyphmark-core` | yes | Zod schemas and the `sendTelegramMessage` operation. |
| `packages/cli` | `@krish-dev/glyphmark` | yes | Commander CLI, binary `glyphmark`. |
| `packages/local-mcp` | `@krish-dev/glyphmark-mcp` | yes | MCP stdio server, binary `glyphmark-mcp`. |
| `apps/remote-mcp` | `glyphmark-remote-mcp` | no (private) | Hono HTTP MCP server behind Clerk OAuth. |
| `skills/glyphmark` | — | — | `SKILL.md` telling agents when to use MCP vs. the CLI. |

## Tech stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Language | **TypeScript 6** | `strict`, ES2022 target, ESNext modules, `Bundler` resolution. |
| Package manager / runtime | **Bun** | Runs the workspace (`apps/*`, `packages/*`), the dev scripts, and publishing. |
| Published runtime | **Node.js** | Builds emit native Node ESM; the CLI and local MCP ship a `#!/usr/bin/env node` shebang. |
| Validation | **Zod 4** | One schema per shape; every exported type is inferred, never hand-written. |
| CLI framework | **Commander 15** | Argument parsing for `init` and `telegram`. |
| Agent protocol | **`@modelcontextprotocol/sdk` 1.29** | `McpServer` plus the stdio and Web-standard streamable HTTP transports. |
| HTTP server | **Hono 4** | Routing for the remote MCP app, served through Bun's default export. |
| Auth | **Clerk** (`@clerk/backend`, `@clerk/mcp-tools`) | OAuth bearer verification and protected-resource metadata for MCP clients. |
| Bundler | **tsdown 0.22** | ESM output with declarations and sourcemaps, `node20` target, Zod left unbundled. |
| Formatter | **oxfmt** | `bun run format` / `format:check`. |
| Linter | **oxlint** | TypeScript, unicorn, and oxc plugins; `correctness` errors, `suspicious` warns. |

Notably absent: no test runner, no web framework, no dependency-injection layer. The adapters are thin enough to verify by running them.

## Prerequisites

- A **Telegram bot token** from [@BotFather](https://t.me/botfather), and a chat ID the bot is allowed to message.
- **Node.js** to run the published packages.
- **Bun** to work in this repository.
- For the remote MCP server: a **Clerk** application (publishable + secret key).

## Quick start

```bash
npm install -g @krish-dev/glyphmark
glyphmark init --telegram-bot-token "<bot-token>"
glyphmark telegram "<chat-id>" "Hello from GlyphMark"
```

That prints the operation result as JSON:

```json
{"ok":true,"chatId":"<chat-id>","messageId":123}
```

## The CLI

Two commands, no more.

### `glyphmark init`

```bash
glyphmark init --telegram-bot-token "<bot-token>"
```

`--telegram-bot-token` is required. The token is written to `~/.config/glyphmark/config.json` with file mode `0600`, and the CLI confirms the path it wrote to.

### `glyphmark telegram`

```bash
glyphmark telegram "<chat-id>" "Your message text"
```

Both arguments are required and must be non-empty. Output is always a single line of JSON on stdout — there is no `--json` flag because there is no human-formatted mode to opt out of. That makes the CLI directly parseable by scripts and by agents falling back from MCP.

On failure the error message goes to stderr and the process exits with code `1`. Without a saved token you get:

```text
Telegram bot token is required. Run `glyphmark init`.
```

## Local MCP server

A stdio MCP server for any MCP-capable client (Claude Code, Claude Desktop, OpenCode, and friends).

```bash
npm install -g @krish-dev/glyphmark-mcp
```

Point your client at the `glyphmark-mcp` binary and pass the token through the server environment:

```json
{
  "mcpServers": {
    "glyphmark": {
      "command": "glyphmark-mcp",
      "args": [],
      "environment": {
        "TELEGRAM_BOT_TOKEN": "<bot-token>"
      }
    }
  }
}
```

Or skip the global install entirely if your client can run npm packages:

```json
{
  "mcpServers": {
    "glyphmark": {
      "command": "npx",
      "args": ["-y", "@krish-dev/glyphmark-mcp"],
      "environment": {
        "TELEGRAM_BOT_TOKEN": "<bot-token>"
      }
    }
  }
}
```

### The `telegram` tool

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `chatId` | string | yes | Non-empty Telegram chat ID. |
| `message` | string | yes | Non-empty message text. |

The tool returns a human-readable `content` block (`Sent Telegram message <id> to chat <chatId>`) **and** `structuredContent` carrying `{ ok, chatId, messageId }`, so both reasoning and programmatic consumption work.

The bot token is **not** a tool parameter. It comes from `TELEGRAM_BOT_TOKEN` in the server environment; if it is missing, the tool call throws with a message pointing you back at your MCP client config. Keeping credentials out of tool schemas means a model can never be talked into leaking one through a tool call.

## Remote MCP server

`apps/remote-mcp` is a Hono app served by Bun. It is private and unpublished — there is no hosted GlyphMark endpoint, so deploy your own copy.

### Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/.well-known/oauth-protected-resource/:botToken/mcp` | Public Clerk protected-resource metadata. |
| `POST` | `/:botToken/mcp` | The MCP endpoint. Requires a Clerk OAuth bearer token. |

Anything else returns `404` as JSON.

### How auth works

Two independent credentials meet at each request:

1. **Who is calling** — a Clerk OAuth bearer token in the `Authorization` header, verified with `clerkClient.authenticateRequest({ acceptsToken: "oauth_token" })`. A missing, malformed, or invalid token yields `401` with a `WWW-Authenticate: Bearer resource_metadata="..."` header pointing at the metadata route, which is exactly the handshake MCP OAuth clients follow to discover the login flow.
2. **Which bot to send as** — the URL-encoded Telegram bot token in the path segment, read per request and handed straight to core.

```text
https://your-host.example.com/<telegram-bot-token>/mcp
```

> **Treat that URL as a secret.** It contains a live bot token. If it leaks, revoke and reissue the token through BotFather.

Each request builds a fresh `McpServer` bound to that request's bot token, connects it over `WebStandardStreamableHTTPServerTransport` in stateless JSON mode (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), and closes it in a `finally` block once the response is produced. Nothing is shared between requests.

The app rewrites the incoming URL from `x-forwarded-proto` and `x-forwarded-host` before routing, so metadata URLs stay correct behind a proxy or platform load balancer.

### Running it

Both Clerk variables are required — the process throws on startup without them.

```bash
CLERK_PUBLISHABLE_KEY="<publishable-key>" \
CLERK_SECRET_KEY="<secret-key>" \
bun run dev:remote-mcp
```

It listens on `PORT`, defaulting to `3000`.

### Connecting clients

In the Clerk Dashboard, enable **Dynamic client registration** for OAuth applications before connecting clients that register themselves.

- **Clients supporting dynamic registration** connect with just the URL — they perform registration and the OAuth dance on their own.
- **Clients that do not** (notably ChatGPT connectors) need an OAuth client you create manually in Clerk: add the client's redirect/callback URI to the allowed list, then supply the resulting client ID and secret during connector setup.

An example remote entry, keeping the bot token in an environment variable rather than the config file:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "glyphmark": {
      "type": "remote",
      "url": "https://your-host.example.com/{env:TELEGRAM_BOT_TOKEN}/mcp",
      "enabled": true
    }
  }
}
```

## The Skill

`skills/glyphmark/SKILL.md` is documentation aimed at agents rather than people. It covers when to prefer the MCP tool over the CLI, the exact shape of both, how to verify the toolchain end to end, and the fact that `@krish-dev/glyphmark-core` is an implementation detail agents should not import directly.

```bash
npx skills add https://github.com/KrishJeswal/glyphmark/tree/main/skills/glyphmark
```

The Skill contains no business logic — only routing guidance. When you change an operation, update the Skill's description of it, not a second copy of the behavior.

## The core package

`packages/core` exports everything from `schemas.ts` and `operations.ts` and imports nothing from any adapter — no Commander, no MCP SDK, no `console`, no `process.exit`.

```ts
import { sendTelegramMessage } from "@krish-dev/glyphmark-core";

const result = await sendTelegramMessage({
  botToken: "<bot-token>",
  chatId: "<chat-id>",
  message: "Hello from GlyphMark",
});
// { ok: true, chatId: "<chat-id>", messageId: 123 }
```

### Schemas

Zod v4 schemas, layered so each adapter validates exactly what it accepts:

- `telegramMessageInputSchema` — `{ chatId, message }`. This is what MCP tools expose, deliberately excluding the credential.
- `telegramMessageOptionsSchema` — the above plus `botToken`. This is what the operation takes.
- `telegramSendMessageRequestSchema` / `telegramSendMessageResponseSchema` — the Telegram Bot API wire format, validated in both directions.
- `telegramMessageOutputSchema` — `{ ok: true, chatId, messageId }`.

Matching types (`TelegramMessageInput`, `TelegramMessageOptions`, `TelegramMessageOutput`) are inferred from the schemas, so there is one source of truth per shape.

### The operation

`sendTelegramMessage` parses its input, POSTs to `https://api.telegram.org/bot<token>/sendMessage`, validates the response, and throws with Telegram's own `description` when the request fails or `ok` is false. Success returns the parsed output object. It reports failure by throwing, leaving each adapter to decide how to surface it — the CLI prints to stderr and sets an exit code, the MCP servers turn it into a tool error.

## Working on GlyphMark

```bash
bun install
```

Root scripts:

| Script | Does |
| --- | --- |
| `bun run dev:cli` | Runs the CLI from source. |
| `bun run dev:local-mcp` | Runs the stdio MCP server from source. |
| `bun run dev:remote-mcp` | Runs the remote MCP app from source. |
| `bun run format` / `format:check` | oxfmt write / check. |
| `bun run lint` / `lint:fix` | oxlint, warnings denied / autofix. |
| `bun run typecheck` | `tsc --noEmit` across the workspace. |
| `bun run build:core` / `build:cli` / `build:local-mcp` | tsdown builds. |
| `bun run release:pack:*` | Build plus `bun pm pack --dry-run` for each publishable package. |

Exercising the CLI from source:

```bash
bun run dev:cli init --telegram-bot-token "<bot-token>"
bun run dev:cli telegram "<chat-id>" "Hello from GlyphMark"
```

Running the local MCP server from source — it will sit there waiting for stdio messages, which is correct behavior, not a hang:

```bash
TELEGRAM_BOT_TOKEN="<bot-token>" bun run dev:local-mcp
```

To point a client at your working copy instead of an installed binary:

```json
{
  "mcpServers": {
    "glyphmark": {
      "command": "bun",
      "args": ["run", "packages/local-mcp/src/index.ts"],
      "environment": {
        "TELEGRAM_BOT_TOKEN": "<bot-token>"
      }
    }
  }
}
```

### Testing the CLI as a real binary

```bash
cd packages/cli
bun link
glyphmark --help
```

`glyphmark` is then on your `PATH` machine-wide. Undo it with `bun unlink` from the same directory.

### Before you call a change done

There is no test suite; verification is running the checks and exercising the surfaces:

```bash
bun install
bun run format:check
bun run lint
bun run typecheck
bun run build:core && bun run build:cli && bun run build:local-mcp
```

Then confirm by hand that the CLI sends a real message, the local MCP server starts with a token and errors clearly without one, and — for remote changes — that the server refuses to boot without Clerk keys, the metadata route returns Clerk metadata, a missing or bad `Authorization` header gives `401` with `WWW-Authenticate`, and a valid token reaches MCP initialization.

## Adding your own operation

The registration is intentionally explicit — each adapter names the operations it exposes. Resist adding a shared registry until you have enough operations that the boilerplate genuinely hurts; the explicitness is what keeps adapter boundaries visible.

1. Add input and output schemas in `packages/core/src/schemas.ts`.
2. Add the operation function in `packages/core/src/operations.ts`. It takes validated input, does the work, returns validated output, and throws on failure.
3. `packages/core/src/index.ts` re-exports both files wholesale, so nothing to do there unless you add a new file.
4. Add a command in `packages/cli/src/index.ts`.
5. Register a tool in `packages/local-mcp/src/index.ts`.
6. Register the same tool in `apps/remote-mcp/src/index.ts` if it belongs in the remote surface.
7. Describe it in `skills/glyphmark/SKILL.md`.
8. Document it here.

### The credential pattern

Three interfaces, three audiences, three places a credential naturally lives:

| Surface | Credential source | Why |
| --- | --- | --- |
| CLI | `~/.config/glyphmark/config.json`, mode `0600` | A human configures a machine once. |
| Local MCP | `TELEGRAM_BOT_TOKEN` in the server environment | The MCP client owns the process and its secrets. |
| Remote MCP | The URL path, per request | The server is multi-tenant; each caller brings their own bot. |

The rule they share: a credential never appears in an MCP tool's input schema unless it is genuinely part of the operation payload. Keep it out of the model's reach.

### Forking checklist

To turn this into a different product, replace: package names across the `package.json` files, the `glyphmark` and `glyphmark-mcp` binary names, the CLI config directory, the operation in `packages/core`, the CLI commands, the tool registrations in both MCP adapters, the Skill's frontmatter and body, and this README. Keep the dependency direction — adapters depend on core, core depends on nothing internal.

## Publishing

For maintainers. Three packages publish to npm; `apps/remote-mcp` is private and never does.

npm versions are immutable, so pick unpublished versions before you start. **Publish core first** whenever a release touches it — the CLI and local MCP both depend on it via `workspace:*`, which `bun publish` resolves to the concrete published version at publish time. Leave those ranges alone; never hand-edit them.

After bumping versions, refresh the lockfile from the repository root with `bun install`, run the checks, and commit before publishing so the published artifact traces to a specific revision.

Each package follows the same flow:

```bash
cd packages/core        # then packages/cli, then packages/local-mcp
bun publish --dry-run
bun publish
```

`bun publish` runs `prepublishOnly` (which builds via tsdown) and reads `publishConfig.access`, so no separate build step or `--access` flag is needed. The dry run should list `package.json` plus `dist/index.js`, `dist/index.d.ts`, and `dist/index.js.map` — and should **not** contain `src/`, `node_modules/`, or `tsconfig.build.json`. Note that `files` is set to `["dist"]`, so add `README.md` to that array if you want the package page on npm to show one.

If npm asks for a one-time password, rerun just the publish with `bun publish --otp <code>`. If it says you are not logged in, run `npm login` — `bun publish` reuses the token in `~/.npmrc`.

Verify afterward:

```bash
npm view @krish-dev/glyphmark-core version
npm install -g @krish-dev/glyphmark && glyphmark --help
npm install -g @krish-dev/glyphmark-mcp && command -v glyphmark-mcp
```

If npm accepts a publish but a later check fails, do not reuse the version — bump and publish again.

## Troubleshooting

**`bun --filter` can't find a package.** Run `bun install` at the repository root and check the filter matches the `name` in that package's `package.json`, not its directory.

**TypeScript can't resolve a workspace package.** Confirm the package has `"type": "module"` and an `exports` map, and that the consumer declares the dependency. `workspace:*` is fine — it never reaches npm.

**The MCP server "hangs."** That is a stdio server waiting for client messages. `Ctrl-C` to stop it.

**An MCP client can't start the server.** Check the command is on `PATH`. Use `npx -y @krish-dev/glyphmark-mcp`, or an absolute path during local development.

**Telegram calls fail from the CLI.** Run `glyphmark init` again and confirm the bot is permitted to message that chat — a bot must be added to a group, or the user must have started a conversation with it.

**Telegram calls fail from MCP.** Confirm `TELEGRAM_BOT_TOKEN` is set in the server `environment` block of your client config, not in your own shell — the client spawns the process and controls what it inherits.

**The remote server exits immediately.** It throws at startup when `CLERK_PUBLISHABLE_KEY` or `CLERK_SECRET_KEY` is missing. The error names the variable.

**Remote MCP always returns 401.** Verify the client sends `Authorization: Bearer <clerk-oauth-token>`, and that Dynamic client registration is enabled in Clerk for clients that self-register.
