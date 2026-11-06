# Upstream drift check

`core/` is supposed to be an **unmodified copy** of the upstream package. `server/` and
`index.ts` are the OpenCode 2 port and are expected to diverge. `scripts/upstream-diff.sh`
reports how far `core/` has drifted from the latest published `@thelioo/opencode-balancer`.

## When to run it

- Before rebasing or re-porting `core/` onto a new upstream release.
- After a new `@thelioo/opencode-balancer` version is published, to see what changed.
- Before opening a PR or cutting a release that touches `core/`.
- Periodically, as a sanity check that nobody hand-edited `core/`.

## Usage

```sh
./scripts/upstream-diff.sh
```

The script resolves the latest version from
`https://registry.npmjs.org/@thelioo/opencode-balancer/latest`, downloads and extracts that
tarball into a temporary directory, compares every path in `core/` against
`package/dist/core/`, and deletes the temporary directory on exit (including on failure).

Requirements: `bash`, `curl`, `jq`, `tar`, and network access to the npm registry.

### Reading the output

Each path appears once, as a status followed by its path under `core/`:

| Status | Meaning |
| --- | --- |
| `identical` | Present in both `core/` and the tarball, byte-identical. Nothing to do. |
| `changed` | Present in both, but the content differs. `core/` no longer matches upstream. |
| `new-local` | Present in `core/` only. Either a local addition or a file upstream has removed/renamed. |
| `upstream-only` | Present in the tarball only. Expected: `core/` vendors a curated subset, not every upstream module. |

`core/` deliberately excludes upstream modules this port does not use (`usage/`, `pending.ts`,
`native-*.ts`). Those appear as `upstream-only` on every run and are **not** drift.

A final `summary:` line totals the statuses.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No drift: every vendored file is `identical`; `upstream-only` paths are allowed. |
| `1` | Drift: at least one `changed` or `new-local` path. |
| `2` | Tooling failure (missing tool, network/registry error, bad download or extraction). |

## What to do when a file is `changed`

A `changed` file means `core/` is **not** an unmodified upstream copy. Do not edit `core/`
to "fix" the diff by hand — decide which side is right:

1. **You did not intend to modify `core/`:** restore the upstream bytes. Copy the file out of
   the downloaded tarball, or re-extract it:

   ```sh
   curl -fsSL "https://registry.npmjs.org/@thelioo/opencode-balancer/-/opencode-balancer-<version>.tgz" \
     | tar -xz --strip-components=3 -C core "package/dist/core/<path>"
   ```

   Then re-run the script; the file should report `identical`.

2. **You are intentionally carrying a local patch:** move it out of `core/`. Port the change
   into `server/` or `index.ts` instead, then restore the upstream copy of the `core/` file.
   Keeping a patched file in `core/` makes the next rebase silently lose or conflict with it.

For `new-local`, either drop the file or, if upstream removed it, delete it here too. For
`missing-upstream`, carry the upstream file over into `core/` (unless the port deliberately
dropped it, in which case record why). Re-run until the summary reports zero drift.
