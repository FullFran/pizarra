Objective: pizarra, Fran's shared handwriting whiteboard for humans and agents, as its own hexagonal repo: an authenticated gateway over the unmodified `mcp-excalidraw-server` npm package.
Branch: `main` (work-unit commits). Delivery: push and deploy are Fran's call per milestone. Runner: `npm test` (node:test + wire scripts under `scripts/`).

## Specs

- S1 (own repo, upstream as dependency, hexagonal): "pues repo propio y su servidor como dependencia!!!! me encanta :v y seguiremos arquitectura hexagonal para que estas cosas siempre sean faciles de hacer vamos a ello!!!". New repo FullFran/pizarra; `mcp-excalidraw-server` pinned as an npm dependency and never patched; code in `src/domain`, `src/application`, `src/infrastructure`, `src/presentation`, with dependencies pointing inwards (domain imports nothing from the others).
- S2 (parity with the fork, secure first): "primero que funcione y sea seguro". Everything FullFran/mcp_excalidraw `feat/remote-whiteboard` (2d5cd3e) does for the remote server must keep working: `/mcp` over Streamable HTTP for spec 2026-07-28 and 2025-era clients; OAuth 2.1 authorization server (PKCE S256 only, RFC 9207 `iss`, RFC 8707 `resource`, RFC 9728/8414 metadata, rotating refresh tokens with family revocation, single-use codes and consent tickets, CIMD with SSRF-safe fetch and one DNS retry, DCR for compatibility); GitHub device-flow sign-in with only the public client ID; signing secret generated on first start (0600); CSRF on every cookie-authenticated write (case-insensitive paths); rate limits; canvas UI, REST API and WebSocket reachable only with a session or bearer token. The upstream canvas server listens only on 127.0.0.1 inside the container; the gateway is the only public listener and reverse-proxies UI, API and WebSocket after authentication. Local loopback use stays zero-config.
- S3 (who can enter): "tenemos que limitar la gente que puede entrar xD que solo pueda entrar yo y la gente que invite a pizarra". Now: only logins in `ALLOWED_GITHUB_LOGINS` (production: FullFran). Later (M3): Fran invites people per board.
- S4 (notebook): "tenemos que poner un gestor de pizarras rollo 'cuaderno' eso estaria guapisimo, tengo un proyecto antiguo intentando hacerlo :v pero por ahora no es lo mas importante". Later (M4): several named boards organised like a notebook. Look at Fran's old project first.
- S5 (deploy): same domain `pizarra.fullfran.com`, same Dokploy project on vpscontavo, still no secret in Dokploy; switch only after parity is verified.
- S6 (embedded agent, later): "nosotros podriamos embedir pifran en pizarra? con el oauth de device de chat gpt para el login". Phase 2 (M5): pifran running server-side next to the board, ChatGPT device-code login. Risk: not an OpenAI-documented flow for hosted apps (engram #9404). Agent tools limited to the board.

## Tasks

| ID | Specs | Route | Status | Evidence |
|----|-------|-------|--------|----------|
| T0 | S1 | inline | done | repo FullFran/pizarra created (public, ctx-agentes), feature doc, milestones and issues |
| T1 | S1, S2, S3 | delegated (writer trigger b: long-session context backstop) | in progress | issues #1-#3 |
| T2 | S5 | pending | pending | |
| T3 | S3 (invites) | pending | later | |
| T4 | S4 | pending | later | |
| T5 | S6 | pending | later | |

## Log

- L1 (2026-11-03, Fran): "esto esta duro de cojones xD pero no se si es mejor desligarse de que sea un fork y dejar el mcp de la comunidad como dependencia o que hacer, que se puede hacer?"
- L2 (2026-11-03, Fran): "pues repo propio y su servidor como dependencia!!!! me encanta :v y seguiremos arquitectura hexagonal para que estas cosas siempre sean faciles de hacer vamos a ello!!!"
- L3 (2026-11-03, Fran): "a, tenemos que limitar la gente que puede entrar xD que solo pueda entrar yo y la gente que invite a pizarra y tenemos que poner un gestor de pizarras rollo \"cuaderno\" eso estaria guapisimo, tengo un proyecto antiguo intentando hacerlo :v pero por ahora no es lo mas importante primero que funcione y sea seguro"
- L4: Verified before deciding: `mcp-excalidraw-server` 2.1.2 has no `exports` field, so `mcp-excalidraw-server/dist/core/mcp-server.js` exporting `excalidrawMcpServerFactory` can be imported; its tools reach the canvas through `EXPRESS_SERVER_URL` (read from env at import time in upstream `src/core/config.ts`). The fork's remote server is live at pizarra.fullfran.com and passed the end-to-end test (pifran read handwritten "Hola" with `get_canvas_screenshot`).
- L5: Context from the fork: two independent verifications found and closed B1 (CSRF bypass with `/API/` path case) and B2 (open redirect via `return_to` control characters); keep both regression checks. Gotchas: Express 4 routes are case-insensitive; browsers drop tab/newline in URLs; the canvas Docker image used to delete `@modelcontextprotocol/*`; the container resolver can fail once (DNS retry).
