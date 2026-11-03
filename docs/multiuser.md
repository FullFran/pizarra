# Multi-user pizarra: proposal

Status: proposal, nothing implemented. It builds on the plan in
[odd/tasks/pizarra-gateway.md](../odd/tasks/pizarra-gateway.md): S3 ("que solo pueda entrar yo y
la gente que invite a pizarra", invites per board) and S4 (several named boards, like a notebook).
It assumes the stateless gateway from [odd/tasks/stateless-gateway.md](../odd/tasks/stateless-gateway.md):
gateways share `auth-store.json` and reach the canvas at `CANVAS_URL`.

## What limits the design

- **The upstream canvas holds one board per process.** `mcp-excalidraw-server` keeps the elements in
  module-level maps, writes one `canvas-state-v1.json` and broadcasts over one WebSocket set. S1 says
  it is never patched. So one board means one upstream process with its own data directory.
- **Everyone on a board must reach the same process.** Real-time collaboration is the upstream's
  in-process broadcast, so all browsers and agents on a board must be routed to that board's
  process. With the canvas in its own container this already holds: there is one place to route to.
- **Identity already exists.** People sign in with GitHub (device flow). Agents sign in with OAuth
  and get audience-bound tokens (RFC 8707 `resource`), which can carry a board.

## Proposed shape

| Piece | Today | Multi-user |
|---|---|---|
| Boards | one canvas | `boards.json` in /data: id, name, notebook section, owner, members |
| Canvas container | one upstream child | a pool: one upstream child per **open** board, each on its own internal port and `<data>/boards/<id>/canvas`, started on first use and stopped after N minutes idle |
| Routing | `/`, `/api`, WebSocket to the one canvas | `/b/<id>/...` to that board's child; the gateway asks the canvas container which port serves `<id>` |
| Who may enter | `ALLOWED_GITHUB_LOGINS` | that list becomes the **admins**; anyone else needs a membership on a board |
| Roles | none | per board: `owner`, `editor`, `viewer` (viewer: read-only REST, WebSocket messages that change the board dropped) |
| Invites | none | by GitHub login (owner types `@login`), or a link: a signed ticket for a board and role, single use through the store's `claimOnce`, 7-day expiry |
| Agents (MCP) | one `/mcp`, one resource | `/b/<id>/mcp` per board, one RFC 8707 resource per board. A token for one board never opens another; the consent page names the board |
| Notebook | none | a list page grouped by section, showing only the boards the person can open |

The gateway stays stateless: boards, memberships and pending invites live in /data files written
under the same cross-process lock as `auth-store.json`. Only the canvas container holds live state,
and it stays a single copy.

## Costs and risks

- **Memory:** each open board is a Node process, about 60-100 MB (to measure). The idle stop and a
  cap on open boards keep the VPS within its 3.8 GiB.
- **Viewer role:** upstream has no read-only mode, so the gateway has to filter writes, both REST
  methods and WebSocket messages. That filter is new security-sensitive code; it needs its own tests.
- **Migration:** today's canvas becomes board `main`, owned by Fran, by moving `/data/canvas` to
  `/data/boards/main/canvas`. Existing agent tokens point at `/mcp`; keep `/mcp` as an alias of
  board `main` until they renew.
- **Exports:** upstream's file tools write to one export directory. It becomes per board, so one
  board's agent cannot read another board's files.

## Open decisions for Fran

1. Invites by GitHub login only, or also by link (links are easier to share, but anyone holding one
   can join until it is used).
2. Is a viewer role needed in the first version, or are all members editors? Without viewers the
   write filter, the riskiest piece, is not needed.
3. Can people outside `ALLOWED_GITHUB_LOGINS` create boards, or only join ones they were invited to?

## Suggested order

1. Boards and the canvas pool with one admin (Fran), migrating today's canvas to `main`.
2. Memberships and invites (editors only).
3. Per-board MCP resources and consent.
4. Notebook page.
5. Viewer role, if decision 2 asks for it.
