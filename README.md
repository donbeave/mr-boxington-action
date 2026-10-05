# Mr Boxington

This action sets up the native `mbx` command for a local or remote cache. An
optional native snapshot is imported only by a verified MBX binary. The action
has no GitHub cache writer, cache restore key, or post step.

## Local cache

```yaml
- uses: jdx/mr-boxington-action@<full-commit-sha>
  with:
    backend: local
```

The action selects `mbx` from `PATH` or installs a verified immutable release.
Use `version` to pin a release.

If release resolution or download runs, apply the step-level environment block
below to the `uses:` step. It applies to both local and snapshot backends.

## Authenticated native snapshot

The consuming workflow grants `actions: read`, `attestations: read`, and
`contents: read`, passes a verified MBX binary, and sets
`snapshot-selection` to `latest-compatible` or `artifact-id`. The optional
artifact ID is only an untrusted service-record selector. The action passes a
snapshot read token only to the native importer and exposes a fixed
comparison-state path under its private MBX store. That file exists only after
authenticated import; a cold import creates no baseline. A selector grants no
authority. The selected MBX operation must verify the
fixed GitHub service response, artifact bytes, signed producer provenance, and
compiled source profile before importing native data. If the artifact is absent,
unavailable, or inadmissible, the action continues cold. No source profile,
workflow identity, or admission boolean is accepted as an action input.
Native snapshot admission currently requires Unix no-follow directory handles;
other platforms fail cold while ordinary MBX setup and builds continue.
This source change alone does not qualify a reader or producer. Native data is
usable only after the separately compiled MBX source profile and signed
producer/job provenance have passed their own review.

Set the job's snapshot permissions to:

```yaml
permissions:
  actions: read
  attestations: read
  contents: read
```

`node24` starts before the action can scrub its environment. A workflow using
release resolution or download must blank proxy, TLS, CA, loader, and shell
startup variables on the `uses:` step itself, before Node starts. A prior
hardening step cannot do this because later actions may change the environment.
The action cannot repair those values after startup. Example:

```yaml
- uses: jdx/mr-boxington-action@<full-commit-sha>
  env:
    ALL_PROXY: ''
    all_proxy: ''
    FTP_PROXY: ''
    ftp_proxy: ''
    HTTP_PROXY: ''
    http_proxy: ''
    HTTPS_PROXY: ''
    https_proxy: ''
    NO_PROXY: ''
    no_proxy: ''
    GLOBAL_AGENT_HTTP_PROXY: ''
    NPM_CONFIG_HTTPS_PROXY: ''
    NPM_CONFIG_PROXY: ''
    npm_config_https_proxy: ''
    npm_config_proxy: ''
    CURL_CA_BUNDLE: ''
    REQUESTS_CA_BUNDLE: ''
    SSL_CERT_FILE: ''
    SSL_CERT_DIR: ''
    NODE_TLS_REJECT_UNAUTHORIZED: ''
    NODE_EXTRA_CA_CERTS: ''
    NODE_USE_ENV_PROXY: ''
    NODE_USE_SYSTEM_CA: ''
    NODE_OPTIONS: ''
    NODE_PATH: ''
    OPENSSL_CONF: ''
    OPENSSL_MODULES: ''
    SSLKEYLOGFILE: ''
    LD_PRELOAD: ''
    LD_LIBRARY_PATH: ''
    LD_AUDIT: ''
    LD_DEBUG: ''
    DYLD_INSERT_LIBRARIES: ''
    DYLD_LIBRARY_PATH: ''
    BASH_ENV: ''
    ENV: ''
    TAR_OPTIONS: ''
```

A Velnor generator integration must bind its callsite to this reviewed
prelaunch set. This action source alone does not prove the generated workflow
does so.

The verified preinstalled MBX path is copied into a private `RUNNER_TEMP`
directory and checked by version and SHA-256 before use. Snapshot import needs
`actions: read`, `attestations: read`, and `contents: read`; the token is passed
only to the native importer. The importer receives the repository selector,
canonical runner temp, and a fresh empty private MBX store path created by the
action under runner temp; it starts in `GITHUB_WORKSPACE`. MBX validates that
store directory before use, and the action exports the same path for later MBX
steps. It does not use Cargo or MBX store paths from earlier-step environment.
Ordinary MBX
and tool children receive a small explicit environment without Actions runtime,
cache, OIDC, proxy, or GitHub credentials. Toolkit archive extraction runs with
a system-only search path and a scrubbed environment.

The action passes `latest-compatible` discovery to MBX, but this source packet
does not qualify a compiled producer profile or prove candidate discovery and
admission. This action does not create producer artifacts. A separately
reviewed source-bound producer workflow must export MBX's native payload and
upload it through its pinned artifact step. The consuming MBX profile decides
which producer and artifact can be admitted. On a cold run, the comparison
state output names the fixed path but the file is absent; export callers must
omit comparison when that file does not exist and must not synthesize a baseline.

## Remote cache

```yaml
- uses: jdx/mr-boxington-action@<full-commit-sha>
  with:
    backend: remote
    remote-url: https://cache.example.com
    namespace: project-name
    token: ${{ secrets.MBX_CACHE_TOKEN }}
    remote-mode: read-write
```

The action exports only the remote settings supplied in inputs, preserving
settings established by earlier steps or MBX configuration. `server-url` and
`server-mode` aliases are not supported.

For GitHub Actions OIDC, set `oidc-audience` and grant `id-token: write` to the
job. The action exports the audience for later MBX commands; ordinary children
of this action do not receive the OIDC request credentials.

## Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `backend` | `local` | `local` or `remote` MBX mode |
| `version` | PATH, then `latest` | MBX release version to use |
| `mbx-path` | | Absolute preinstalled MBX executable |
| `expected-version` | | Exact version required for `mbx-path` |
| `expected-binary-sha256` | | Source-bound digest required for `mbx-path` |
| `snapshot-selection` | `none` | `none`, `latest-compatible`, or `artifact-id` |
| `snapshot-artifact-id` | | Untrusted service ID; required only for `artifact-id` selection |
| `snapshot-read-token` | `${{ github.token }}` | Token with `actions:read`, `attestations:read`, and `contents:read`, used only by native snapshot import |
| `cache-links` | `auto` | Whether MBX caches native links |
| `remote-url` | | Remote server URL or S3 bucket |
| `namespace` | | Remote cache namespace |
| `token` | | Remote cache bearer token |
| `token-file` | | Remote cache bearer token file |
| `oidc-audience` | | Remote cache OIDC audience |
| `remote-mode` | | `read-write`, `read-only`, or `write-only` |

## Outputs

| Output | Meaning |
| --- | --- |
| `native-snapshot-imported` | `true` only when MBX reports authenticated workspace restoration |
| `native-snapshot-comparison-state` | Fixed private-store path; file exists only after authenticated import |
| `mbx-version` | Selected MBX version |
