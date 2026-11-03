# Feature: stateless-gateway
Objective: two pizarra gateways can run at once on the same /data (blue-green deploys without downtime, infra odd/tasks/zero-downtime.md), with the canvas in its own single container; plus a multi-user proposal.
Branch: `FullFran/pizarra-stateless` (Orca worktree). Delivery: ask-on-risk; push, PR and deploy are Fran's call. Runner: `npm test` (node:test + wire scripts under `scripts/`).

## Specs

- S1 User (2026-11-03, verbatim): "ni modo, pizarra hay que cambiarla para que sea stateless jajaja" / "mira como hacerlo de forma segurao" / "Hazlo! y de paso, podemos aprobechar para plantear hacerlo multiusuario, haz un worktree de pizarra en orca".
- S2 Agreed design (owner said "Hazlo!" to it): (a) the canvas runs in its own container, one copy, and the gateway connects to it by URL instead of spawning it; (b) auth without per-process state: everything the gateway must share lives in `/data/auth-store.json`, re-read when it changes on disk and written under a lock that works across containers, with atomic single-use operations (authorization codes, consent tickets, refresh tokens) and the GitHub device logins.
- S3 Safety: existing behaviour and checks keep passing (`npm test`); single use stays exact across two processes (a code or refresh token redeemed on one copy is "already used" on the other, and replay still revokes the family); no raw token or client secret is ever written; the store file stays mode 0600 and keeps format version 1 readable (existing volume).
- S4 The canvas container is reachable only by the gateway (private network, no Traefik route); it has no auth of its own.
- S5 Multi-user: write a proposal only (no implementation), building on the existing plan in odd/tasks/pizarra-gateway.md (S3 invites per board, S4 notebook).

## Tasks

- [x] T1 (S2b, S3) inline: shared, cross-process auth store; codes, consent tickets, device logins and refresh-token use go through it. RED: test/unit/shared-store.test.mjs 11 of 12 failing on the old store. GREEN: npm test (unit 47, auth 41 groups, MCP 9, proxy 7).
- [ ] T2 (S2a, S4) inline: canvas role (`PIZARRA_ROLE=canvas`) and gateway external canvas mode (`CANVAS_URL`).
- [ ] T3 (S2, S4) inline, infra repo: compose with gateway + canvas services; gateway on STRATEGY=rollout.
- [ ] T4 (S5) inline: docs/multiuser.md proposal.

## Log

- L1 (2026-11-03, user, verbatim): "Hazlo! y de paso, podemos aprobechar para plantear hacerlo multiusuario, haz un worktree de pizarra en orca"
- L2 (2026-11-03): Baseline on 4df80a7: `npm test` passes (unit, auth 41 groups, MCP HTTP 9 checks, proxy 7 groups). State map (explorer, spot-checked): OAuth codes, device logins and used consent tickets in Maps; JsonFileTokenStore loads once and rewrites whole; canvas child holds state in memory and its lock staleness uses kill(pid,0), meaningless across containers.
- L3 (2026-11-03): T1 design and evidence. Every change is a transaction under `auth-store.json.lock` (mkdir, stale after 10 s), re-loading inside; reads re-load when inode/size/mtime changed. Atomic single use: useCode(hash, clientId), markRefreshTokenUsed -> boolean (a lost race is treated as reuse and revokes the family), claimOnce for consent tickets. The existing check "a GitHub token or device code is in the auth store" failed with device logins in the store, so the device code moved into the binding cookie, AES-256-GCM sealed (TicketSigner.seal/open, key derived from the signing secret with its own label); the store keeps the rest. Two DeviceSignIn on one store: GitHub polled once, exactly one completes. 4 real processes x 25 concurrent writes: nothing lost.
