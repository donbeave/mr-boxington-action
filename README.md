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

## Authenticated native snapshot

The consuming workflow passes a verified MBX binary and sets
`snapshot-selection` to `latest-compatible` or `artifact-id`. The optional
artifact ID is only an untrusted service-record selector. The action passes an
`actions: read` token only to the native importer and may receive a fresh
comparison-state path. A selector grants no authority. The selected MBX operation must verify the
fixed GitHub service response, artifact bytes, signed producer provenance, and
compiled source profile before importing native data. If the artifact is absent,
unavailable, or inadmissible, the action continues cold. No source profile,
workflow identity, or admission boolean is accepted as an action input.

The verified preinstalled MBX path is copied into a private `RUNNER_TEMP`
directory and checked by version and SHA-256 before use. Snapshot import needs
`actions: read`; the token is passed only to the native importer. Ordinary MBX
and tool children receive a small explicit environment without Actions runtime,
cache, OIDC, proxy, or GitHub credentials. Toolkit archive extraction runs with
a system-only search path and a scrubbed environment.

With `latest-compatible`, MBX discovers candidate artifact IDs and verifies
each against its compiled source profile. This action does not create producer
artifacts. A source-bound producer workflow must export MBX's native payload
and upload it through its pinned artifact step. The consuming MBX profile
decides which producer and artifact can be admitted.

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
| `actions-read-token` | `${{ github.token }}` | Token used only by native snapshot import |
| `comparison-state` | | Fresh owner-state file under `RUNNER_TEMP` |
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
| `native-snapshot-imported` | `true` only when MBX reports a verified native import |
| `mbx-version` | Selected MBX version |
