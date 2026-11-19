# The board agent (prototype)

An agent that draws on a board while it talks, signed in with the person's own ChatGPT account.
It is a prototype: off by default, behind a flag and an allowlist of GitHub logins.

## What it is

- A panel in the board page (`src/agent/panel.ts`) talks to the gateway at `/b/<board>/__agent/`
  (`/__agent/` for board main).
- For each person and board the gateway runs one engine process (`engine/main.mjs`, the pi agent
  SDK) under the same Node, speaking line-delimited JSON on stdin/stdout (`src/agent/protocol.ts`).
- The person signs in to ChatGPT with the device-code flow: the panel shows a code and
  `https://auth.openai.com/codex/device`. The credential is kept encrypted by the gateway; the
  engine only ever holds the access token it is handed for a turn.
- The engine reaches the board through that board's own `/mcp`, with a short-lived engine token,
  limited to `AGENT_TOOLS`. Text and thinking stream to the requester's panel. The shapes the model
  is still writing are broadcast to everyone on the board as previews (`draft` events) and retired
  when the tool runs; the real elements arrive through the board's normal WebSocket.

## Turning it on

| Variable | Meaning |
| --- | --- |
| `PIZARRA_AGENT` | `1` turns it on. Anything else (or unset): nothing below exists and every `/__agent/` route answers 404. |
| `PIZARRA_AGENT_USERS` | Required. Comma-separated GitHub logins (case-insensitive) who may use it. |
| `PIZARRA_AGENT_KEY` | Required. 32 random bytes, base64 (`openssl rand -base64 32`): the key of the credential vault. Losing it disconnects everyone; changing it does too. |
| `PIZARRA_AGENT_MODELS` | Optional. Comma-separated model ids the engine may use; unset: whatever the account offers. |
| `PIZARRA_AGENT_MAX_PROCESSES` | Optional, 1 to 16, default 2. Engine processes running at once; beyond it a turn or login is refused with `busy` (HTTP 429). |

It also needs authentication with GitHub sign-in (`AUTH_MODE=oauth`, `github` in `AUTH_PROVIDERS`)
and `EXCALIDRAW_DATA_DIR`. Startup fails, naming the problem, when any of this is missing or invalid.
The engine dials the gateway at `http://127.0.0.1:<PORT>`, so the gateway must listen there
(the default `HOST=0.0.0.0` in the image and `127.0.0.1` locally both do).

## Who may use it

An authenticated board session whose provider is GitHub (never a trusted issuer's ticket), whose
login is on `PIZARRA_AGENT_USERS`, with role `editor` or `owner` on that board. Anyone else with
access to the board sees `{"enabled":false,...}` from `status`, gets a 404 from every other
route, and may still watch the agent's drafts (`events`).

## HTTP contract

All under `/b/<board>/__agent/` (the board must be open to you).

- `GET status` -> `{"enabled","connected","busy","pending":{"userCode","verificationUri"}|null}`.
- `POST login` -> `{"userCode","verificationUri"}`; `POST logout` (stops the engines, deletes the
  credential), `POST abort`, `POST reset` (forget the conversation on this board) -> 204.
- `POST prompt` with `{"text"}` (1 to 8000 characters) -> `text/event-stream`: `delta` `{text}`,
  `thinking` `{text}`, `tool` `{call,name,phase,ok}`, then `done` `{aborted}` or `error` `{code}`.
  A refusal before streaming is JSON `{"error":"<code>"}` (4xx, 429, 503). Closing the stream aborts the turn.
- `GET events` -> `text/event-stream` for anyone on the board: `draft` `{id,elements}`,
  `draft.end` `{id}`, `agent` `{state,login}`, and a `: keepalive` comment every 25 seconds.
- Every POST needs `Origin` equal to the site's own origin (403) and `Content-Type: application/json` (415).

## Isolation and limits

- One credential per person (`<data>/agent/credentials/<sha256(login)>.json`, mode 0600, AES-256-GCM
  with the login as associated data, so a file under another name does not decrypt). The refresh
  token rotates; the gateway is the only place that refreshes it, one refresh at a time per person.
- One engine process per person and board, with an empty working directory, `HOME` and `TMPDIR`
  of its own, and an environment of `PATH` only. Idle processes stop after 5 minutes, every process
  after 1 hour; one turn lasts at most 10 minutes and 2 MiB of text; one device login is pending
  per person for at most 15 minutes, at most 3 starts per 15 minutes.
- Engine tokens (`pze_...`) are random, held as a hash in memory, bound to one person and board,
  valid for one process lifetime and revoked when it stops. They are accepted only on `/mcp`, only
  on a direct loopback connection with no proxy header and `Host: 127.0.0.1:<PORT>`, and only for
  their own board. Everything else (REST API, pages, the agent routes, other boards) refuses them.
  A reverse proxy on the same host that adds none of the usual forwarding headers
  (`X-Forwarded-*`, `Forwarded`, `Via`, `X-Real-IP`, ...) cannot be told from the engine: do not
  run one that does.
- On `/mcp`, an engine's `tools/call` outside `AGENT_TOOLS` is refused with 403: no `clear_canvas`,
  `import_scene`, `restore_snapshot`, `export_*` or `set_viewport`. The gateway also stops an
  engine that announces a tool outside that list. `tools/list` is not filtered; the engine restricts itself.
- Everything the engine prints is parsed against the protocol and dropped when it does not match.
  Previews carry drawing properties only, and are shown as shapes, never as markup.

## Risk: OpenAI terms are unverified

Hosting someone's ChatGPT subscription sign-in on a server may not be allowed by OpenAI's terms.
This has not been checked (carried from issue #7). That is why this is a prototype for a few named
people, behind a flag. Do not offer it to others before reading the terms.

## Trying it

1. `openssl rand -base64 32` for the key, then run with
   `PIZARRA_AGENT=1 PIZARRA_AGENT_USERS=<your login> PIZARRA_AGENT_KEY=<key> EXCALIDRAW_DATA_DIR=./data`
   plus the usual GitHub sign-in variables (see `docs/auth.md`).
2. Open a board you edit, open the agent panel, choose connect, type the code at the OpenAI address.
3. Ask for a diagram; watch the previews appear for everyone on the board, then become real shapes.

Tests: `npm run build && node --test test/unit/agent-host.test.mjs test/unit/agent-router.test.mjs`
(a fake engine under `test/fixtures/agent/` stands in for pi).
