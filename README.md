# mr-boxington-action

Set up [mr boxington](https://github.com/jdx/mr-boxington) and use its local
store directly or back it with GitHub Actions cache, an mbx-compatible server, or an S3
bucket. When
`version` is omitted, the action uses `mbx` from `PATH` and downloads the latest
release only when it is absent. Setting `version` always installs that release.

To use a caller-verified executable without installing or downloading mbx,
supply `mbx-path`, `expected-version`, and `expected-binary-sha256` together.
The action checks the exact bytes and version before use and again around a
comparison-mode post export. These inputs cannot be combined with `version`.

GitHub `objects` mode can use a fresh `comparison-state` file inside
`RUNNER_TEMP`. This strict mode needs the verified executable, an explicit
stable `cache-key` compatibility identity, and ordered source-bound
`restore-keys`. Useful native export reports append their semantic digest to
the key. The action skips upload when the restored semantic snapshot is
unchanged; workspace persistence remains unqualified by this action.

## Local filesystem

```yaml
steps:
  - uses: actions/checkout@v7
  - uses: jdx/mr-boxington-action@v1
    with:
      backend: local
  - run: mbx test --workspace
```

The local backend installs or reuses mbx and leaves its store on the filesystem without
configuring a remote transport or an upload/download phase. This is useful on
persistent runners and with volume actions that mount mbx's cache directory.

## GitHub Actions cache

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@v7
  - uses: jdx/mr-boxington-action@v1
  - run: mbx test --workspace
```

The default backend restores Cargo's pruned target directory and registry from
the previous compatible build on every run, so a job that changes a few files
recompiles only those crates. It saves a new immutable entry only after a
successful push to a protected default branch. Pull requests and all other
branches are restore-only.

The action disables mbx-managed target views and native-link object caching so
it can transport the in-place `target` tree without also transporting mbx's
object cache. The post step removes final products and unrelated Cargo state
before saving, while retaining fingerprints, dependencies, build-script state,
and the registry. Full mbx executables used by build-script shims, including
legacy hard-linked copies, are omitted from transport and rehydrated from the
installed mbx after restore; tiny launchers and Cargo freshness timestamps
remain intact. When `version` pins an exact release, the archive also carries
one mbx executable so later warm jobs avoid a separate release download.

The earlier `objects` payload is still available for workflows whose builds
must share across differing target directories or checkout layouts:

```yaml
- uses: jdx/mr-boxington-action@v1
  with:
    github-cache-mode: objects
- run: mbx test --workspace
```

That mode imports the restored bundle before any build steps and exports the
deduplicated closure of every completed `mbx` command in the job afterward,
assigning a unique `MBX_CACHE_EXPORT_GROUP` automatically. Its entries are
smaller because they omit the Cargo registry, which Cargo then downloads again
inside the build; in paired measurements on GitHub-hosted runners it restored
and built a small edit roughly ten seconds slower than the `target` payload.

For disposable hosted runners, set `isolate-objects-cache: true` to keep the
live mbx store under `RUNNER_TEMP` and save only the external exported bundle.
After a valid bundle is exported, the action removes that isolated store before
`actions/cache` stages its upload archive. Leave this off on persistent runners
that rely on mbx's native warm store. Use one isolated objects-cache action
invocation per job; its stable bundle path keeps the cache version shared across
jobs and runs.

From mbx 1.12.0 the bundle is a directory instead of a tar. `actions/cache`
archives whatever path it is given, so a tar meant every byte was written twice
on restore: once when the cache action unpacked its own archive, and again when
the importer unpacked the tar inside it. The importer now reads the restored
tree in place. On a warm restore of a 4,071-object closure this took
`mbx cache import` from 6.5s to 2.0s, against roughly 1.3s more spent inside
the cache action's own restore, which handles many files less quickly than one
archive. Earlier mbx versions keep the tar form. The two use separate cache
keys, so the first job after an mbx version crosses 1.12.0 restores cold.

On GitHub-hosted runners, `objects` mode sets `MBX_GC_AUTO=0` for the job unless
that environment variable is already set. This prevents mbx's local disk budget
from immediately evicting a large restored bundle. The cache can grow during
the job; set `MBX_GC_AUTO=1` in the job's environment to keep automatic cleanup.
Self-hosted and unrecognized runners retain their existing GC policy. For a
disposable self-hosted runner, set `MBX_GC_AUTO=0` in the job's environment to
opt into the same behavior.

The generated cache key includes the identity of the `rustc` on `PATH`
(a hash of `rustc -vV`, the same identity Swatinem/rust-cache keys on). mbx
keys every cached compilation on the compiler, so a store built by one
toolchain matches nothing under another; scoping the key keeps each toolchain
on its own cache instead of restoring one that can no longer produce hits—
which otherwise happens whenever a runner image updates its preinstalled Rust.
Install your toolchain **before** this action so the key sees the compiler the
build will use; without a `rustc` on `PATH` the segment is the literal
`norust`.

A build that names its toolchain on its own command line is the one case the
probe cannot see: `mbx +1.91 check` compiles with 1.91 while `rustc` on `PATH`
still reports the default, so the 1.91 store lands under the default
toolchain's key and the two share an entry. Name it with `toolchain` and the
key follows it:

```yaml
- uses: jdx/mr-boxington-action@v1
  with:
    toolchain: "1.91"
- run: mbx +1.91 check --workspace
```

`toolchain` scopes the cache key only — it neither installs the toolchain nor
selects it for the build.

On Linux, the action also enables mbx's native link cache. This avoids relinking
eligible test binaries and executables on a warm build. Set `cache-links: false`
to opt out, or `cache-links: true` to opt in explicitly on another supported
platform.

The action accepts a resolved version only when GitHub reports that release as
immutable and supplies an asset digest. Release metadata requests use
`GITHUB_TOKEN` when set and otherwise use the `github-token` input; either requires
`contents: read` permission.

Change `cache-generation` when a cache-format or policy change should start
fresh:

```yaml
- uses: jdx/mr-boxington-action@v1
  with:
    version: 0.3.0
    cache-generation: v2
```

When the Cargo workspace is not at the checkout root, point `working-directory`
at it so the `target` payload caches that workspace's `target/` and prunes it
against its own `cargo metadata`:

```yaml
- uses: jdx/mr-boxington-action@v1
  with:
    working-directory: rust
- run: mbx test --workspace
  working-directory: rust
```

`cache-key` and newline-separated `restore-keys` are available when the default
`${platform}-${architecture}-mbx-${generation}-${toolchain}-${commit}` layout
is not enough. Use `cache-key-suffix` to give parallel jobs distinct primary
keys while keeping the generated restore prefixes shared:

```yaml
- uses: jdx/mr-boxington-action@v1
  with:
    cache-key-suffix: ${{ matrix.job }}
```

The suffix is appended after the complete generated key and does not alter
restore prefixes, so a job can warm-start from another job's compatible entry.
It accepts ASCII letters, numbers, periods, underscores, or hyphens, and the
final generated key must be at most 512 characters. `cache-key-suffix` cannot be
combined with `cache-key`; use `cache-key` alone when supplying the complete
primary key yourself.

### Write policy

Only successful pushes to a protected default branch may publish GitHub cache
entries. Pull requests, dispatches, tags, unprotected refs, and protected
non-default branches remain restore-only. GitHub's cache service decides
whether an attempted write is authorized.

An `ACTIONS_CACHE_MODE` hint of `read` or `none` makes this action skip
save-side pruning and export. The hint cannot authorize a write; the event,
ref, and protection checks still gate save attempts.

Comparison mode's `cache-save-eligible` and `cache-save-reason` outputs report
whether a protected default-branch push may attempt a save. An eligible run
still skips an unchanged semantic snapshot or a target-cache exact hit.

## Remote cache

The `remote` backend points mbx at a cache server or an `s3://` bucket. With a
cache server and OIDC:

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@v7
  - uses: jdx/mr-boxington-action@v1
    with:
      backend: remote
      remote-url: https://cache.example.com
      namespace: acme/backend
      oidc-audience: mbx-cache
  - run: mbx build --workspace --all-features
```

Or pass a secret bearer token:

```yaml
- uses: jdx/mr-boxington-action@v1
  with:
    backend: remote
    remote-url: https://cache.example.com
    namespace: acme/backend
    token: ${{ secrets.MBX_REMOTE_TOKEN }}
```

An S3 bucket authenticates with the `AWS_*` variables instead, which
`aws-actions/configure-aws-credentials` exports:

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@v7
  - uses: aws-actions/configure-aws-credentials@v6
    with:
      role-to-assume: arn:aws:iam::123456789012:role/mbx-cache
      aws-region: us-east-1
  - uses: jdx/mr-boxington-action@v1
    with:
      backend: remote
      remote-url: s3://acme-build-cache/mbx
      namespace: acme/backend
  - run: mbx build --workspace --all-features
```

Each input the backend receives is exported as the matching `MBX_REMOTE_*`
variable. A setting without an input keeps the value an earlier step exported,
so a step that already configured mbx's remote needs no inputs repeated here:

```yaml
- run: |
    echo "MBX_REMOTE_URL=s3://acme-build-cache/mbx" >> "$GITHUB_ENV"
    echo "MBX_REMOTE_NAMESPACE=acme/backend" >> "$GITHUB_ENV"
- uses: jdx/mr-boxington-action@v1
  with:
    backend: remote
```

After exporting, the action runs `mbx doctor` and fails the step when mbx finds
no remote URL in its inputs, the environment, or mbx's user config file, or
when mbx rejects the configuration, for example a URL without a namespace. A
remote that is configured but cannot be reached only produces a warning.

mbx itself writes to the remote only from pushes to protected branches. Every
other run, including pull requests, tags, and releases, reads only, and a
`write-only` remote is left unused. The server or bucket policy must still
enforce its own authorization, and a release build that must not read from a
shared cache should not configure a remote at all.

`server` is an alias for `remote`, and `server-url` and `server-mode` are
aliases for `remote-url` and `remote-mode`.

## Inputs

| Input                       | Default               | Purpose                                                                        |
| --------------------------- | --------------------- | ------------------------------------------------------------------------------ |
| `backend`                   | `github`              | `local`, `github`, or `remote`                                                 |
| `version`                   |                       | mbx release version, or `latest`; when omitted, prefer `mbx` from `PATH`       |
| `mbx-path`                  |                       | Absolute preinstalled executable path; requires version and SHA-256; never downloads |
| `expected-version`          |                       | Exact version required from `mbx-path`; excludes `version`                    |
| `expected-binary-sha256`     |                       | Caller descriptor's exact lowercase binary SHA-256; required before execution |
| `comparison-state`          |                       | Fresh path in `RUNNER_TEMP`; strict GitHub objects mode saves useful semantic snapshots |
| `github-token`              | `${{ github.token }}` | Token used when `GITHUB_TOKEN` is not exported                                 |
| `cache-generation`          | `v1`                  | Generated GitHub cache key generation                                          |
| `github-cache-mode`         | `target`              | GitHub payload: warm Cargo `target` tree or portable mbx `objects`             |
| `isolate-objects-cache`     | `false`               | Put GitHub `objects` mode in a private `RUNNER_TEMP` store and save its bundle |
| `toolchain`                 |                       | Toolchain the build names, such as `1.91` or `+1.91`; the cache key follows it |
| `working-directory`         | `.`                   | Cargo workspace whose `target/` the `target` payload caches                    |
| `cache-links`               | `auto`                | Cache native links; automatically enabled on Linux                             |
| `cache-key`                 | generated             | Primary key; comparison mode requires a comma-free compatibility base up to 447 characters |
| `cache-key-suffix`          |                       | Safe suffix for generated primary keys; restore prefixes stay shared           |
| `restore-keys`              | generated             | Newline-separated restore prefixes; comparison mode requires up to nine source-bound prefixes |
| `remote-url`                |                       | Cache server URL or `s3://` bucket; keeps `MBX_REMOTE_URL` when omitted        |
| `namespace`                 |                       | Remote namespace; keeps `MBX_REMOTE_NAMESPACE` when omitted                    |
| `oidc-audience`             |                       | OIDC audience for a cache server                                               |
| `token`                     |                       | Secret bearer token for a cache server                                         |
| `token-file`                |                       | Bearer-token file for a cache server                                           |
| `remote-mode`               |                       | Remote mode; keeps `MBX_REMOTE_MODE` when omitted, and mbx defaults to `read-write` |

## Outputs

- `mbx-version` — installed version.
- `cache-hit` — `true` for an exact GitHub cache-key match.
- `cache-primary-key` — key used by the GitHub backend.
- `cache-save-eligible` — `true` when the GitHub backend may attempt a save after a successful job.
- `cache-save-reason` — why the GitHub backend may or may not save.

## License

[MIT](LICENSE)
