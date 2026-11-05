# Multi-user pizarra

Status: implemented on `feat/multiuser-pluggable-auth` (issues #10, #11, #5, #12, #13; plan in
[odd/tasks/multiuser.md](../odd/tasks/multiuser.md)). The notebook page (#6) and the embedded agent
(#7) are not part of it.

## What limits the design

- **The upstream canvas holds one board per process.** `mcp-excalidraw-server` keeps the elements in
  module-level maps, writes one `canvas-state-v1.json` and broadcasts over one WebSocket set, and it
  is never patched. So one board is one upstream process with its own data directory.
- **Everyone on a board must reach the same process.** Real-time collaboration is the upstream's
  in-process broadcast, so every browser and agent on a board is routed to that board's process.
- **Upstream's page uses absolute paths.** It loads `/assets/...`, calls `fetch("/api/...")` and opens
  its WebSocket at `/`. Under `/b/<id>/` those would reach another board, so the gateway adds one
  script of its own to each board page (below).
- **Upstream's MCP tools read their canvas URL and export directory once, at import,** and keep scene
  state at module level.

## Shape

| Piece | How |
|---|---|
| Boards | `boards.json` in the data directory (0600, atomic writes, the same cross-process lock as `auth-store.json`): id, name, owner, members. Code: `src/boards/` (its own bounded context). |
| Owners | A **GitHub board** is run by the admins (`ALLOWED_GITHUB_LOGINS`, owners of every GitHub board) and the members they invite. An **issuer board** belongs to one trusted issuer (Hagalink Projects) and is opened only by that issuer's tickets, which carry the role. Neither kind ever opens the other. |
| Roles | `owner`, `editor`, `viewer`. Viewers read: REST writes are refused (`403`), every data frame their browser sends on the WebSocket is dropped (control frames pass), and over MCP they may call only the read-only tools (fail closed: a body the filter cannot read exactly as the MCP handler will, such as invalid JSON, another charset or a content encoding, is refused) (`describe_scene`, `get_canvas_screenshot`, `get_element`, `get_resource`, `query_elements`, `read_diagram_guide`). |
| Canvas pool | One upstream child per **open** board, on its own loopback port and `<data>/boards/<id>/canvas`, started on the board's first request, stopped after `BOARD_IDLE_SECONDS` (default 600) without requests or open WebSockets, at most `MAX_OPEN_BOARDS` (default 8, main included) at once: opening another stops the least recently used idle board, or answers `503` if all are in use. Board `main` starts with the pool and never idles. |
| Pool front | One listener in front of the pool routes `/b/<id>/...` to that board's canvas (prefix removed) and everything else to `main`, exactly as the single canvas answered before, so a gateway (even an older one, during a deploy) talks to it as it talked to the canvas. It runs inside the gateway (`127.0.0.1:CANVAS_INTERNAL_PORT`) or as the canvas container (`PIZARRA_ROLE=canvas`, `CANVAS_URL`). |
| Routing | `/b/<id>/` is the board page, `/b/<id>/api/*` its REST API, `ws(s)://…/b/<id>/` its WebSocket, `/b/<id>/mcp` its MCP endpoint. Unprefixed `/`, `/api/*`, the WebSocket at `/` and `/mcp` are board `main`. Upstream's bundle (`/assets/*`) is shared by every board. Any other case of `/b/` (`/B/…`) or an invalid id is a `404`; the gateway and the pool route with the same function. |
| Board page | The gateway serves upstream's page with one script first in `<head>` (`/__pizarra/board.js`): it points the page's `/api/...` requests and its WebSocket at `/b/<id>/...`, and shows a small badge (board name, sign out) unless the page is opened with `?embed=1`. Upstream's code is untouched. |
| MCP per board | `/b/<id>/mcp`, with one RFC 8707 resource per board, `${PUBLIC_BASE_URL}/b/<id>/mcp`, so a token for one board never opens another. `/mcp` is board main's resource and stays its alias, so existing agent tokens keep working (refresh renews them for the same resource). The consent page names the board. Each board gets its own instance of upstream's MCP modules, pointed at `<pool>/b/<id>` and at its own export directory, through a module resolution hook (`src/gateway/infrastructure/board-module-hooks.ts`). |
| Export directory | `<data>/boards/<id>/files` per board, so one board's agent never reads another's files. |
| Invites (#5) | Owners and admins of a GitHub board invite GitHub logins as `editor` or `viewer` (`PUT /b/<id>/members/<login>`), change their role, and remove them (`DELETE`). An invited login may then sign in with GitHub and sees only its boards. Removing the last membership ends its sessions and tokens. |
| Boards API | `GET /boards` (the boards you can open), `POST /boards` `{id, name}` (admins), `GET/PUT/DELETE /b/<id>/members[/<login>]` (owners). Browser session only; cookie writes need our `Origin`. |

The gateways stay stateless: boards and memberships live in `/data`, shared by every gateway and the
canvas container.

## Migration of today's canvas

On the first start on an existing data directory, `<data>/canvas` (the single canvas) is renamed to
`<data>/boards/main/canvas` and `<data>/files` to `<data>/boards/main/files`: a rename on the same
volume, nothing is copied. Board `main` is created in `boards.json`, owned by the admins. Nothing
moves when `CANVAS_DATA_DIR` (or `EXCALIDRAW_EXPORT_DIR`) is set: they then name board main's
directories, as before. If both the old and the new directory exist, both are left alone and the
new one is used (a warning is logged).

In split mode the canvas container moves `canvas/` and a gateway moves `files/`. A canvas
container of this version also serves gateways of the previous version during a deploy: unprefixed
paths still reach `main`.

## Memory per open board

Measured with `node scripts/measure-boards.mjs 5` (2026-11-05, Node 24.14, Linux x86-64, glibc; one
REST write, one MCP call and one open WebSocket per board):

| | per board |
|---|---|
| Canvas process, resident set (RSS) | 118-126 MiB (average 124) |
| Canvas process, proportional set (PSS, shared pages split) | 70-79 MiB (average 77) |
| Gateway, upstream MCP modules for one more board | about 8.5 MiB (kept for the life of the gateway process) |

Board `main` alone: 118-125 MiB RSS; a gateway with only main: about 104 MiB RSS. With the
default `MAX_OPEN_BOARDS=8` the canvases stay under about 1 GiB RSS (about 620 MiB PSS), within the
VPS's 3.8 GiB next to the rest. The image runs Node from Alpine (musl), so production numbers may
differ a little; rerun the script there to check.

## Decisions (taken 2026-11-05, by default, overridable)

Fran delegated the three open decisions of #10; these defaults are in place and each can be changed
later without a migration:

1. **Viewer role: yes, in the first version.** Hagalink Projects issues `viewer` tickets when the
   person can only read the project, so the write filter exists: REST methods and WebSocket data
   frames for viewers, and read-only MCP tools.
2. **Invites: by GitHub login only, for GitHub boards; no link invites yet.** Issuer boards get no
   invites: the issuer decides membership through the tickets it signs.
3. **Board creation: only admins (`ALLOWED_GITHUB_LOGINS`) create GitHub boards.** A trusted issuer
   creates its own board on its first valid ticket (#12).

## Costs and risks

- **Viewer filter** is security-sensitive code: it is covered by `scripts/check-boards.mjs` (REST,
  WebSocket frames, MCP tools), and `src/gateway/infrastructure/websocket-filter.ts` parses frames
  instead of guessing.
- **Per-board MCP modules** are never unloaded (ES modules cannot be): a gateway process keeps about
  8.5 MiB per board whose MCP it ever served. Gateways restart on every deploy.
- **Board ids are global**: two issuers cannot both own a board called `p1`; the second one's tickets
  are refused. Issuers should use ids that are unique to them (for example a prefix).
