# Dependency advisories

Status of the advisories that affect what Pizarra ships. Issue #15 tracks this work.

## MCP SDK (`@modelcontextprotocol/server`, `@modelcontextprotocol/core`)

There is a single installed copy, version 2.4.0. The upstream tarball (`mcp-excalidraw-server`, see `upstream.json`) pins both packages to 2.0.0 exactly, and so does upstream main. `overrides` in `package.json` forces the gateway's version onto the tarball. `npm ls @modelcontextprotocol/server` shows one deduped 2.4.0 copy. Remove the override once an upstream release depends on a patched SDK.

| Advisory | Affected | Fixed in | Reachable here | Status |
|---|---|---|---|---|
| [GHSA-f897-62hf-6gxq](https://github.com/advisories/GHSA-f897-62hf-6gxq) (no request or batch limits, high) | `server` >=2.0.0 <2.1.0 | 2.1.0 | Yes, for authenticated clients (or with auth off on loopback). Before the upgrade, `/mcp` accepted up to 10 MB and batches of any length. | Fixed. Bodies over 4 MiB get 413, and batches over 100 messages get 400 (`scripts/check-mcp-http.mjs`). |
| [GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453) (memory exhaustion during validation, high) | `server` >=2.0.0 <2.3.0 | 2.3.0, opt-in | Yes, for authenticated clients. Upstream's tools are validated by the SDK. | Partly fixed. The 4 MiB body cap now applies. The SDK's element cap (`maxToolInputElements`) is set in upstream's `McpServer` constructor, which the gateway does not build, so it stays off until upstream sets it. |
| [GHSA-jm63-cq47-j5jp](https://github.com/advisories/GHSA-jm63-cq47-j5jp) (cross-client messages, high) | `server` >=2.0.0 <2.3.0 | 2.3.0 | No. `createMcpHandler` gets upstream's factory, which builds a new `McpServer` per request. | Upgraded anyway. A wire check runs concurrent clients that reuse one JSON-RPC id. |
| [GHSA-rvq5-wwqv-78pq](https://github.com/advisories/GHSA-rvq5-wwqv-78pq) (bearer audience, medium) | `server` <2.3.0 | 2.3.0 | No. The SDK's `requireBearerAuth` is not used. The gateway checks the token audience per board itself (`test:auth`). | Upgraded anyway. |

## Remaining findings

`npm audit --omit=dev` still reports one finding after the upgrade:

- [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): zod, memory exhaustion when validating oversized constrained collections (high).
  - **Where:** `zod` 3.25.76, which only the upstream tarball uses. Upstream depends on `zod` ^3.22.4 and imports it in `dist/server.js` (REST canvas API) and `dist/core/mcp-dispatch.js`.
  - **Fix:** the advisory lists no fixed 3.x release; the fix is `zod` 4.6.6. An override to zod 4 would break upstream's zod 3 code, so it is not applied here.
  - **Exposure:** it is reachable only by clients that may write to a board, and request bodies are bounded.
  - **Next step:** track it upstream.

## Checking a build

```sh
npm ls @modelcontextprotocol/server @modelcontextprotocol/core   # expect one 2.4.0 copy
npm audit --omit=dev
```

The runtime image has no npm. Read the installed version with node instead:

```sh
docker run --rm --entrypoint node <image> -p "require('/app/node_modules/@modelcontextprotocol/server/package.json').version"
```

A change in this repository does not update production. After a deploy, check the image tag that is actually running and repeat the checks there.
