#!/usr/bin/env sh
# Builds the unmodified upstream canvas (mcp-excalidraw-server) at the commit
# pinned in upstream.json and packs it into vendor/, where package.json
# installs it from as a `file:` tarball. Upstream ships `dist/` only through
# `prepublishOnly`, so a plain git dependency would have no build output.
#
# Nothing in the upstream tree is edited: clone, check out the pinned commit,
# verify HEAD is exactly that commit, `npm ci`, `npm run build`, `npm pack`.
# The clone lives in a temporary directory outside the repository and is
# removed afterwards. UPSTREAM_GIT_URL may point at a local mirror; the commit
# hash is verified either way.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
commit=$(node -p "require('$root/upstream.json').commit")
repository=${UPSTREAM_GIT_URL:-$(node -p "require('$root/upstream.json').repository")}
short=$(printf %s "$commit" | cut -c1-12)
out="$root/vendor/mcp-excalidraw-server-$short.tgz"

case "$commit" in
  *[!0-9a-f]*|"") echo "upstream.json: commit must be a full lowercase hex SHA-1" >&2; exit 1 ;;
esac
[ ${#commit} -eq 40 ] || { echo "upstream.json: commit must have 40 hex digits" >&2; exit 1; }

if [ -f "$out" ] && [ "${FORCE:-0}" != 1 ]; then
  echo "upstream tarball already built: $out"
  exit 0
fi

# Prebuilt tarball (see .github/workflows/upstream-tarball.yml): compiling the upstream frontend
# (Excalidraw + Mermaid) needs about 2 GB of RAM, so tests, Docker builds and local setups
# download the asset published for this pin and check it against the integrity hash that
# package-lock.json already records for it (the pack is reproducible). BUILD_FROM_SOURCE=1
# compiles it instead, which is what the workflow does to publish it.
if [ "${BUILD_FROM_SOURCE:-0}" != 1 ]; then
  url=${UPSTREAM_TARBALL_URL:-https://github.com/FullFran/pizarra/releases/download/upstream-$short/mcp-excalidraw-server-$short.tgz}
  mkdir -p "$root/vendor"
  # shellcheck disable=SC2016 # JavaScript, not shell: ${...} are template literals
  if ! ROOT="$root" OUT="$out" URL="$url" node -e '
    const { createHash } = require("node:crypto");
    const fs = require("node:fs");
    (async () => {
      const lock = JSON.parse(fs.readFileSync(process.env.ROOT + "/package-lock.json", "utf8"));
      const want = lock.packages?.["node_modules/mcp-excalidraw-server"]?.integrity || "";
      if (!want.startsWith("sha512-")) throw new Error("package-lock.json has no sha512 integrity for mcp-excalidraw-server");
      const res = await fetch(process.env.URL);
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${process.env.URL}`);
      const body = Buffer.from(await res.arrayBuffer());
      const got = "sha512-" + createHash("sha512").update(body).digest("base64");
      if (got !== want) throw new Error(`integrity mismatch: got ${got}, package-lock.json has ${want}`);
      fs.writeFileSync(process.env.OUT + ".tmp", body);
      fs.renameSync(process.env.OUT + ".tmp", process.env.OUT);
    })().catch((err) => { console.error(err.message); process.exit(1); });
  '; then
    rm -f "$out.tmp"
    echo "could not use the prebuilt tarball; publish it with the upstream-tarball workflow, or run with BUILD_FROM_SOURCE=1 to compile it here (about 2 GB of RAM)" >&2
    exit 1
  fi
  echo "downloaded $out (matches package-lock.json integrity)"
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
git init -q "$work/src"
git -C "$work/src" fetch -q --depth 1 "$repository" "$commit" 2>/dev/null || git -C "$work/src" fetch -q "$repository"
git -C "$work/src" -c advice.detachedHead=false checkout -q "$commit"
head=$(git -C "$work/src" rev-parse HEAD)
[ "$head" = "$commit" ] || { echo "upstream HEAD $head is not the pinned $commit" >&2; exit 1; }

cd "$work/src"
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent
git diff --quiet HEAD -- . || { echo "upstream build modified tracked files; refusing to pack" >&2; exit 1; }
mkdir -p "$root/vendor"
packed=$(npm pack --silent --pack-destination "$work")
mv "$work/$packed" "$out"
echo "built $out from $repository@$commit"
