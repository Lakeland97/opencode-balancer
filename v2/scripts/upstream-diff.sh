#!/usr/bin/env bash
# upstream-diff.sh — report how far core/ has drifted from the published upstream package.
#
# Resolves the latest @thelioo/opencode-balancer from the npm registry, downloads and
# extracts its tarball, then compares every path in core/ with package/dist/core/.
#
# One line per path (union of both trees):
#   identical          present in both, byte-identical
#   changed            present in both, content differs
#   new-local          present in core/ only (local addition, never published)
#   upstream-only      present upstream only (core/ intentionally vendors a subset)
#
# Drift means `changed` or `new-local`: core/ is meant to be verbatim upstream bytes.
# `upstream-only` is coverage, not drift — this repo vendors only the modules it uses,
# so a permanently non-zero exit would make the tool useless as a gate.
#
# Exit codes: 0 = no drift, 1 = drift, 2 = tooling failure.

set -uo pipefail

PKG="@thelioo/opencode-balancer"
REGISTRY_LATEST="https://registry.npmjs.org/${PKG}/latest"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_CORE="$ROOT/core"

usage() {
	cat <<EOF
Usage: $(basename "$0") [--help]

Compare this repo's core/ with the latest published ${PKG}.

Exit codes: 0 no drift, 1 core/ differs from upstream bytes, 2 tooling failure.
EOF
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
	usage
	exit 0
fi

die() {
	printf 'upstream-diff: %s\n' "$*" >&2
	exit 2
}

for tool in curl tar jq cmp comm sort sed mktemp; do
	command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool"
done

[ -d "$LOCAL_CORE" ] || die "local core/ not found at $LOCAL_CORE"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/opencode-balancer-upstream.XXXXXX")" ||
	die "could not create temp dir"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT
trap 'exit 2' INT TERM HUP

# 1. Resolve the latest version and tarball URL.
META="$TMP_DIR/latest.json"
curl -fsSL --max-time 60 -o "$META" "$REGISTRY_LATEST" ||
	die "cannot fetch $REGISTRY_LATEST (network or registry unavailable)"

VERSION="$(jq -r '.version // empty' "$META" 2>/dev/null)" ||
	die "cannot parse .version from registry metadata"
TARBALL="$(jq -r '.dist.tarball // empty' "$META" 2>/dev/null)" ||
	die "cannot parse .dist.tarball from registry metadata"
[ -n "$VERSION" ] || die "registry metadata has no .version"
[ -n "$TARBALL" ] || die "registry metadata has no .dist.tarball"

# 2. Download and extract the tarball into the temp dir.
curl -fsSL --max-time 120 -o "$TMP_DIR/pkg.tgz" "$TARBALL" ||
	die "cannot download $TARBALL"

mkdir -p "$TMP_DIR/pkg"
tar -xzf "$TMP_DIR/pkg.tgz" -C "$TMP_DIR/pkg" ||
	die "cannot extract $TARBALL"

UPSTREAM_CORE="$TMP_DIR/pkg/package/dist/core"
[ -d "$UPSTREAM_CORE" ] || die "$PKG@$VERSION has no package/dist/core/ in its tarball"

# 3. Build sorted relative path lists. LC_ALL=C keeps sort and comm consistent.
(cd "$LOCAL_CORE" && find . -type f -print | sed 's|^\./||') |
	LC_ALL=C sort >"$TMP_DIR/local.list"
(cd "$UPSTREAM_CORE" && find . -type f -print | sed 's|^\./||') |
	LC_ALL=C sort >"$TMP_DIR/upstream.list"
LC_ALL=C sort -u "$TMP_DIR/local.list" "$TMP_DIR/upstream.list" >"$TMP_DIR/all.list"

# 4. Compare each path and print one line per file.
identical=0
changed=0
new_local=0
upstream_only=0

while IFS= read -r rel; do
	[ -n "$rel" ] || continue
	if [ -f "$LOCAL_CORE/$rel" ] && [ -f "$UPSTREAM_CORE/$rel" ]; then
		if cmp -s "$LOCAL_CORE/$rel" "$UPSTREAM_CORE/$rel"; then
			status=identical
			identical=$((identical + 1))
		else
			status=changed
			changed=$((changed + 1))
		fi
	elif [ -f "$LOCAL_CORE/$rel" ]; then
		status=new-local
		new_local=$((new_local + 1))
	else
		status=upstream-only
		upstream_only=$((upstream_only + 1))
	fi
	printf '%-15s core/%s\n' "$status" "$rel"
done <"$TMP_DIR/all.list"

total=$((identical + changed + new_local + upstream_only))
drift=$((changed + new_local))

# 5. One-line summary, then exit with the drift verdict. Files upstream ships but this
# repo does not vendor are reported as coverage, not as drift.
if [ "$drift" -eq 0 ]; then
	printf 'summary: core/ matches %s@%s — %d identical, %d upstream-only (not vendored)\n' \
		"$PKG" "$VERSION" "$identical" "$upstream_only"
	exit 0
fi

printf 'summary: core/ has DRIFTED from %s@%s — %d/%d identical, %d changed, %d new-local, %d upstream-only\n' \
	"$PKG" "$VERSION" "$identical" "$total" "$changed" "$new_local" "$upstream_only"
exit 1
