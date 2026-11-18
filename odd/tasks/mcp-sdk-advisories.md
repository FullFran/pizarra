# Feature: mcp-sdk-advisories
Objective: issue #15. Move the shipped MCP SDK off the advisory ranges (GHSA-46jr, f897, jm63, rvq5), document reachability, and test the limits.
Branch: `fix/mcp-sdk-advisories`. Delivery: push, PR and deploy are Fran's call. Runner: `npm test`.

## Specs

- S1 Issue #15 acceptance (verbatim): "Upgrade or replace affected dependencies to compatible non-vulnerable releases, including the pinned upstream package/build as needed; update lockfiles. If a fix is unavailable, document and test an effective mitigation and track the upstream fix."
- S2 Issue #15 acceptance (verbatim): "Test bounded HTTP input/batches and validation, concurrent clients and board isolation, and rejection of tokens for other audiences, as applicable. Preserve existing MCP, OAuth and board regression suites."
- S3 Issue #15 acceptance (verbatim): "Verify advisory package/range and patched versions from upstream, map all installed copies with lockfiles and production container, and document whether each affected path is reachable in each deployment."
- S4 Issue #15 acceptance (verbatim): "Verify the built image and runtime installation with an appropriate dependency scan; record remaining findings and evidence."
- S5 Issue #15 acceptance (verbatim): "Plan safe rollout and verify the actual deployed version; do not assume a repository change updates production." (rollout is Fran's call; this branch only documents it)

## Tasks

- [x] T1 (S1, S2) inline: `@modelcontextprotocol/server` and `core` to 2.4.0 with npm `overrides` (the upstream tarball pins 2.0.0 exactly); lockfile; full suite. Commit 554d890.
- [x] T2 (S1, S2) inline: wire checks for oversized body, batch over the cap, concurrent clients on one board (SDK 2.4.0 enforces 4 MiB and 100 messages itself; no gateway change). RED on 2.0.0: body and batch checks fail; concurrency passes on both (jm63 not reachable). Commit 554d890.
- [x] T3 (S3, S5) inline: docs/security-advisories.md (reachability, remaining zod finding, image check). S4 image scan and S5 deployed version: pending, not run here.

## Log

- L1 (2026-11-18, user, verbatim): "vamos con esos 2!" (PR #19 review and issue #15)
- L2 (2026-11-18): Advisory map (explorer). Patched: server 2.3.0 for 46jr/jm63/rvq5, 2.1.0 for f897; latest server/core 2.4.0. Tarball mcp-excalidraw-server@66b768b pins server/core 2.0.0 exactly; upstream main still pins 2.0.0. Reachability: f897 partly (express.raw 10mb in mcp-route.ts then SDK fetch, after auth); 46jr yes for authenticated clients, and the SDK fix `maxToolInputElements` is opt-in in upstream's McpServer constructor; jm63 not reachable (new McpServer per request); rvq5 not reachable (gateway's own audience check, SDK requireBearerAuth unused).
- L3 (2026-11-18): After upgrade `npm ls` shows one deduped 2.4.0 copy of server and core. `npm test` green: unit 77, auth 41 groups, MCP HTTP 12, proxy 11, boards 5, tickets 4, embed 3. `npm audit --omit=dev` still reports GHSA-mrhx-c7xc-m3w5 (zod 3.25.76 used only by upstream; fixed only in zod 4.6.6). 46jr only partly mitigated: maxToolInputElements must be set in upstream's McpServer constructor.
