# Feature: agent-panel
Objective: pi embedded in the board, signed in with the person's own ChatGPT account, drawing on the board progressively while it narrates, so the board feels like thinking out loud together with the agent.
Branch: `feat/agent-panel`. Prototype behind `PIZARRA_AGENT=1` and an allowlist of GitHub logins (`PIZARRA_AGENT_USERS`, Fran's is `FullFran`; never committed). Push, PR, merge and deploy are Fran's call. Runner: `npm test`.

## Specs

- S1 User (2026-11-19, verbatim): "pi embedido en la interfaz (sdk de pi) para usarlo conectandose con tu cuenta de chat gpt (revisa HCS y por ejemplo re-write y training mcp)".
- S2 User (verbatim): "que se vea el como el agente pinta en la pizarra como \"streaming response\" para dar sensacion de mayor velocidad e interactividad".
- S3 User (verbatim): "el objetivo es que se sienta como \"usar la pizarra en colaboracion con el agente pensando en voz alta\"".
- S4 Agreed scope (user: "si! me vale"): prototype only for Fran's account, behind a flag; Pizarra is open to very few people. OpenAI terms for hosted use of a ChatGPT subscription are unverified (risk carried from #7).
- S5 Design (parent, from the maps in Log L2-L4): pi 1.5.2 (`@earendil-works/*`) in a child Node process per person and board, device-code login, credential in an AES-GCM vault held by the gateway, agent tools limited to `AGENT_TOOLS` on that board's `/mcp` through a loopback engine token; text and thinking stream to the requester's panel over SSE; streamed tool arguments become draft shapes every viewer of the board sees, retired when the tool runs (real elements arrive through upstream's WebSocket).

## Tasks

- [ ] T0 (S5) inline: shared protocol `src/agent/protocol.ts`.
- [ ] T1 (S1, S2, S5) delegated writer, parallel: engine program `engine/` (pi session, device login, MCP, text/thinking/tool/draft events) and its Docker stage.
- [ ] T2 (S1, S4, S5) delegated writer, parallel: gateway host `src/agent/` (manager, vault, engine tokens + identity plugin, allowlist, tool policy on /mcp, HTTP/SSE routes, config).
- [ ] T3 (S2, S3) delegated writer, parallel: browser `src/agent/panel.ts` (panel, narration, draft rendering) and `BOARD_SCRIPT` changes.
- [ ] T4 (S1-S5) inline: wiring in `app.ts`, seam check (`npm test`), docs, independent verification (security: credentials, auth plugin).
- [ ] T5 (S1) Fran: real device login with his account and a live drawing turn.

Route evidence: T1-T3 are independent units with disjoint edit surfaces launched together (Writer trigger a); T0/T4 inline.

## Log

- L1 (2026-11-19, user, verbatim): "perfecto. te comento el siguiente objetivo es hacer esto más \"herramienta de pensar en voz alta\" pi embedido en la interfaz (sdk de pi) para usarlo conectandose con tu cuenta de chat gpt (revisa HCS y por ejemplo re-write y training mcp) y que se vea el como el agente pinta en la pizarra como \"streaming response\" para dar sensacion de mayor velocidad e interactividad. investiga si gente ya tiene estas cosas. el objetivo es que se sienta como \"usar la pizarra en colaboracion con el agente pensando en voz alta\""
- L2 (2026-11-19): Local map. re-write and training-mcp embed pi 1.5.2 in a child process per person (JSON lines), device-code login via `openaiCodexProvider().auth.oauth.login`, host-held refresh token in an AES-GCM vault, SSE to the browser; they drop tool arguments on purpose. Neither was tested with a real account.
- L3 (2026-11-19): Prior art. tldraw agent starter kit (MIT) streams typed actions and applies each when complete; excalidraw-mcp streams in the chat host via `ontoolinputpartial`. pi-ai emits `toolcall_delta` with partial parsed arguments (Gemini sends them at once). OpenAI's plan-usage sign-in targets local/OSS apps; hosted apps go to an interest form.
- L4 (2026-11-19): Pizarra map. Identity is the GitHub login only (no email). No internal bearer exists; an engine identity plugin bound to one board, loopback only, is the chosen way. Upstream broadcasts `element_created`/`elements_batch_created` to every viewer, so real elements need no WS injection; drafts go over a gateway SSE channel. Runtime image is alpine with nodejs, no npm.
- L5 (2026-11-19, user, verbatim): "si! me vale mi cuenta es la de [email] de todas formas pizarra lo tengo abierto a muy poca gente." (email redacted; Pizarra keys on GitHub login, `gh api user` = FullFran)
