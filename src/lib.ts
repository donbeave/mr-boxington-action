import {createHash} from 'node:crypto'
import path from 'node:path'

export type Backend = 'local' | 'github' | 'remote'
export type GithubCacheMode = 'objects' | 'target'
export type BundleForm = 'tar' | 'directory'

/** Keep a restored object bundle available for the lifetime of a hosted job. */
export function githubObjectGcDefault(
  backend: Backend,
  mode: GithubCacheMode,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (
    backend === 'github' &&
    mode === 'objects' &&
    env.RUNNER_ENVIRONMENT === 'github-hosted' &&
    env.MBX_GC_AUTO === undefined
  ) return '0'
  return undefined
}

export interface CallingCardRow {
  label: string
  value: string
}

export interface GithubRelease {
  tag_name: string
  immutable: boolean
  assets: {
    name: string
    digest: string | null
  }[]
}

export interface VerifiedReleaseAsset {
  version: string
  sha256: string
}

export function parsedMbxVersion(value: string): string | undefined {
  return value.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/)?.[0]
}

export function mbxReleaseToInstall(requested: string, foundOnPath: boolean): string | undefined {
  if (requested) return normalizedVersion(requested)
  return foundOnPath ? undefined : 'latest'
}

export function githubApiHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

export function githubTokenValue(input: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.GITHUB_TOKEN || input
}

export function requireGithubCacheRuntime(env: NodeJS.ProcessEnv = process.env): void {
  const missing: string[] = []
  if (!env.ACTIONS_RUNTIME_TOKEN) missing.push('ACTIONS_RUNTIME_TOKEN')
  if (env.ACTIONS_CACHE_SERVICE_V2) {
    if (!env.ACTIONS_RESULTS_URL) missing.push('ACTIONS_RESULTS_URL')
  } else if (!env.ACTIONS_CACHE_URL && !env.ACTIONS_RESULTS_URL) {
    missing.push('ACTIONS_CACHE_URL or ACTIONS_RESULTS_URL')
  }
  if (missing.length === 0) return

  throw new Error(
    `GitHub Actions cache runtime credentials are unavailable (missing ${missing.join(', ')}). ` +
      'The GitHub backend must run through a uses: action step; invoking the distribution ' +
      'bundle from a shell step is unsupported.'
  )
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function callingCard(note: string, rows: CallingCardRow[]): string {
  const tableRows = rows
    .map(
      ({label, value}) =>
        `<tr><th align="left">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`
    )
    .join('')
  return [
    `<blockquote>${escapeHtml(note)}</blockquote>`,
    `<table>${tableRows}</table>`
  ].join('')
}

export function parseBackend(value: string): Backend {
  if (value === 'local' || value === 'github' || value === 'remote') return value
  // `server` named this backend before an s3:// bucket could stand in for a
  // cache server, and existing workflows still spell it that way.
  if (value === 'server') return 'remote'
  throw new Error(`backend must be "local", "github", or "remote", got ${JSON.stringify(value)}`)
}

/** One setting under two input names, which must agree when both are given. */
export function aliasedInput(
  name: string,
  value: string,
  alias: string,
  aliasValue: string
): string {
  if (value && aliasValue && value !== aliasValue) {
    throw new Error(`${name} and ${alias} name the same setting with different values; set only ${name}`)
  }
  return value || aliasValue
}

export interface RemoteInputs {
  url: string
  namespace: string
  token: string
  tokenFile: string
  oidcAudience: string
  mode: string
}

/**
 * The `MBX_REMOTE_*` variables the remote backend exports: one per input that
 * was given, and nothing else.
 *
 * A setting without an input keeps whatever an earlier step exported, such as
 * a runner action that points mbx at its own bucket, and mbx applies its own
 * default when nothing set it. Exporting an empty or default value here would
 * overwrite that step's choice.
 */
export function remoteExports(inputs: RemoteInputs): Record<string, string> {
  if (inputs.mode && !['read-write', 'read-only', 'write-only'].includes(inputs.mode)) {
    throw new Error(`invalid remote-mode ${JSON.stringify(inputs.mode)}`)
  }
  if ([inputs.token, inputs.tokenFile, inputs.oidcAudience].filter(Boolean).length > 1) {
    throw new Error('set only one of token, token-file, or oidc-audience')
  }
  const variables: [string, string][] = [
    ['MBX_REMOTE_URL', inputs.url],
    ['MBX_REMOTE_NAMESPACE', inputs.namespace],
    ['MBX_REMOTE_MODE', inputs.mode],
    ['MBX_REMOTE_TOKEN', inputs.token],
    ['MBX_REMOTE_TOKEN_FILE', inputs.tokenFile],
    ['MBX_REMOTE_OIDC_AUDIENCE', inputs.oidcAudience]
  ]
  return Object.fromEntries(variables.filter(([, value]) => value))
}

export interface RemoteStatus {
  /**
   * `ready` when mbx built a client and reached the remote, or its write
   * policy disables the remote for this run; `unreachable` when the
   * configuration is sound but the connection check failed; `missing` when no
   * URL is configured anywhere mbx looks; `invalid` when mbx rejects the
   * configuration, which fails every build that uses it; `unknown` when mbx
   * gave no report.
   */
  state: 'ready' | 'unreachable' | 'missing' | 'invalid' | 'unknown'
  detail: string
  /** Configured and effective mode, when a URL is configured. */
  policy?: string
}

interface DoctorCheck {
  severity: string
  name: string
  detail: string
}

/**
 * What `mbx doctor --json` says about the remote cache.
 *
 * mbx resolves the remote from the environment and its user config file, so
 * asking it covers every place a URL can come from and applies the same checks
 * a build does before its first compilation.
 */
export function remoteStatus(doctorOutput: string): RemoteStatus {
  let checks: DoctorCheck[]
  try {
    const report = JSON.parse(doctorOutput) as {checks?: DoctorCheck[]}
    if (!Array.isArray(report.checks)) throw new Error('no checks')
    checks = report.checks
  } catch {
    return {state: 'unknown', detail: 'mbx doctor --json produced no report'}
  }
  const config = checks.find(check => check.name === 'config')
  if (config?.severity === 'fail') return {state: 'invalid', detail: config.detail}
  const remote = checks.find(check => check.name === 'remote')
  if (!remote) return {state: 'unknown', detail: 'mbx doctor reported no remote check'}
  const policy = checks.find(check => check.name === 'policy')?.detail
  if (remote.severity === 'fail') {
    // mbx wraps only a failed probe of a client it could build this way; any
    // other failure is a configuration the build would refuse too.
    const state = remote.detail.startsWith('connection check failed') ? 'unreachable' : 'invalid'
    return {state, detail: remote.detail, policy}
  }
  if (remote.detail.startsWith('not configured')) {
    return {state: 'missing', detail: remote.detail}
  }
  return {state: 'ready', detail: remote.detail, policy}
}

export function parseGithubCacheMode(value: string): GithubCacheMode {
  if (value === 'objects' || value === 'target') return value
  throw new Error(
    `github-cache-mode must be "objects" or "target", got ${JSON.stringify(value)}`
  )
}

export function cacheLinksValue(value: string, platform: NodeJS.Platform): string | undefined {
  if (value === 'auto') return platform === 'linux' ? '1' : undefined
  if (value === 'true') return '1'
  if (value === 'false') return '0'
  throw new Error(`cache-links must be "auto", "true", or "false", got ${JSON.stringify(value)}`)
}

export function releaseTarget(platform: NodeJS.Platform, arch: string): string {
  const targets: Record<string, string> = {
    'linux:x64': 'x86_64-unknown-linux-musl',
    'linux:arm64': 'aarch64-unknown-linux-musl',
    'darwin:x64': 'x86_64-apple-darwin',
    'darwin:arm64': 'aarch64-apple-darwin',
    'win32:x64': 'x86_64-pc-windows-msvc',
    'win32:arm64': 'aarch64-pc-windows-msvc'
  }
  const target = targets[`${platform}:${arch}`]
  if (!target) throw new Error(`mbx does not publish a binary for ${platform}/${arch}`)
  return target
}

export function normalizedVersion(value: string): string {
  const version = value.trim()
  if (version === 'latest') return version
  if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid mbx version ${JSON.stringify(value)}`)
  }
  return version.replace(/^v/, '')
}

/** A pinned release can be reused without asking GitHub whether "latest" moved. */
export function canReuseCachedMbx(requested: string, installed: string | undefined): boolean {
  const version = normalizedVersion(requested)
  return version !== 'latest' && installed === version
}

export function verifiedReleaseAsset(
  release: GithubRelease,
  requested: string,
  archiveName: string
): VerifiedReleaseAsset {
  const version = normalizedVersion(release.tag_name)
  if (requested !== 'latest' && version !== requested) {
    throw new Error(`GitHub returned mbx ${version} when ${requested} was requested`)
  }
  if (release.immutable !== true) {
    throw new Error(`mbx ${version} is not an immutable GitHub release`)
  }
  const asset = release.assets.find(candidate => candidate.name === archiveName)
  const sha256 = asset?.digest?.match(/^sha256:([0-9a-f]{64})$/)?.[1]
  if (!sha256) {
    throw new Error(`${archiveName} has no valid SHA-256 digest in the mbx ${version} release`)
  }
  return {version, sha256}
}

export function generatedKey(
  os: string,
  arch: string,
  generation: string,
  toolchain: string,
  sha: string
): string {
  return `${os}-${arch}-mbx-${generation}-${toolchain}-${sha}`
}

const MAX_CACHE_KEY_LENGTH = 512

/** Resolve the primary key while keeping generated restore prefixes shareable. */
export function primaryCacheKey(
  cacheKeyOverride: string,
  suffix: string,
  generated: string
): string {
  if (cacheKeyOverride && suffix) {
    throw new Error('cache-key and cache-key-suffix cannot be used together')
  }
  if (cacheKeyOverride) return cacheKeyOverride
  if (!suffix) return generated

  if (!/^[A-Za-z0-9._-]+$/.test(suffix)) {
    throw new Error('cache-key-suffix may contain only ASCII letters, numbers, ., _, and -')
  }
  const scoped = `${generated}-${suffix}`
  if (scoped.length > MAX_CACHE_KEY_LENGTH) {
    throw new Error(
      `generated cache key with cache-key-suffix must be at most ${MAX_CACHE_KEY_LENGTH} characters`
    )
  }
  return scoped
}

export function generatedRestoreKey(
  os: string,
  arch: string,
  generation: string,
  toolchain: string
): string {
  return `${os}-${arch}-mbx-${generation}-${toolchain}-`
}

/** Use caller prefixes as given, or the generated defaults when none were provided. */
export function effectiveRestoreKeys(
  explicit: string[],
  generated: string[]
): string[] {
  return explicit.length > 0 ? explicit : generated
}

/**
 * Whether an installed mbx can read and write directory-form bundles.
 *
 * `mbx cache export --format directory` arrived in mbx 1.12.0, and an older
 * binary rejects the flag outright. The form has to follow the version that is
 * actually installed, which the action learns before it builds a cache key.
 * Anything that does not parse is treated as too old: falling back to a tar
 * costs a slower restore, while guessing wrong fails the export.
 */
export function supportsDirectoryBundle(version: string): boolean {
  const parsed = /^(\d+)\.(\d+)\./.exec(version.trim().replace(/^v/, ''))
  if (!parsed) return false
  const major = Number(parsed[1])
  const minor = Number(parsed[2])
  return major > 1 || (major === 1 && minor >= 12)
}

/**
 * Generation segment of a generated key, scoped by payload so no two cache
 * formats can restore each other. `objects` keeps the bare generation because
 * that is the key space its entries were saved under before `target` became
 * the default; a directory bundle is a third payload and takes its own.
 */
export function githubCacheGeneration(
  generation: string,
  mode: GithubCacheMode,
  bundle: BundleForm = 'tar'
): string {
  if (mode !== 'objects') return `${generation}-${mode}`
  return bundle === 'directory' ? `${generation}-dir` : generation
}

/** The export error that means a job completed without running an mbx build. */
export function isEmptyExport(output: string): boolean {
  return output.includes('no completed mbx builds are recorded for export group')
}

/**
 * `rustc` arguments that probe the identity of the toolchain a build will use.
 *
 * Bare `rustc` on `PATH` is rustup's shim, so it already answers for a
 * `rust-toolchain.toml` or a directory override. What it cannot see is a
 * toolchain named on the build's own command line — `mbx +1.91 check` compiles
 * with 1.91 while the shim still reports the default — and keying on the
 * default there files the 1.91 store under stable's identity, where the two
 * toolchains share one cache entry and neither restores cleanly.
 *
 * The name is the one rustup takes after a `+`, so a caller who writes the
 * sigil out the way the build spells it means the same toolchain as one who
 * does not.
 */
export function rustcIdentityArgs(toolchain: string): string[] {
  const name = toolchain.trim().replace(/^\+/, '')
  return name ? [`+${name}`, '-vV'] : ['-vV']
}

/**
 * Cache-key segment naming the Rust toolchain the cache was built by.
 *
 * mbx keys every cached compilation on the compiler's identity, so a store
 * built by one toolchain matches nothing once the toolchain changes — which
 * happens under a workflow whenever a runner image updates its preinstalled
 * Rust. Scoping the generated cache key by `rustc -vV` (the same identity
 * Swatinem/rust-cache keys on) keeps each toolchain's store on its own key
 * instead of restoring hundreds of megabytes that can no longer match.
 *
 * Without a `rustc` on `PATH` the segment is the literal `norust`: the cache
 * may still hold C/C++ compilations, and a stable fallback keeps those keyed
 * consistently rather than failing the job.
 */
export function toolchainSegment(rustcIdentity: string | null): string {
  const identity = rustcIdentity?.trim()
  if (!identity) return 'norust'
  return `rust-${createHash('sha256').update(identity).digest('hex').slice(0, 12)}`
}

export interface SaveContext {
  eventName: string
  ref: string
  defaultBranch?: string | null
  /** `GITHUB_REF_PROTECTED`: the ref has branch protection or rulesets. */
  refProtected?: boolean
  /** Client-side ACTIONS_CACHE_MODE hint; it does not authorize writes. */
  cacheMode?: string
}

export interface SaveDecision {
  save: boolean
  reason: string
}

/**
 * Only protected default-branch pushes may save. The event/ref check is
 * defense in depth; GitHub's cache service remains the write authority.
 * ACTIONS_CACHE_MODE can suppress save work on read-only jobs, but cannot
 * authorize a write.
 */
export function savePolicy(run: SaveContext): SaveDecision {
  const decision = eventSavePolicy(run)
  const mode = run.cacheMode?.trim().toLowerCase() ?? ''
  if (decision.save && !cacheModePermitsWrites(mode)) {
    return {save: false, reason: `${decision.reason}; client cache-mode hint ${mode} skips writes`}
  }
  return decision
}

/**
 * The same lattice `@actions/cache` applies: an unset or unrecognized mode is
 * permissive, so runners that do not export one keep today's behavior.
 */
export function cacheModePermitsWrites(mode: string): boolean {
  if (!['none', 'read', 'write', 'write-only'].includes(mode)) return true
  return mode === 'write' || mode === 'write-only'
}

function eventSavePolicy(run: SaveContext): SaveDecision {
  const {eventName, ref, defaultBranch} = run
  if (eventName === 'push' && ref.startsWith('refs/heads/')) {
    if (run.refProtected !== true) return {save: false, reason: 'unprotected-branch push'}
    if (defaultBranch && ref === `refs/heads/${defaultBranch}`) {
      return {save: true, reason: 'default-branch push'}
    }
    return {save: false, reason: 'protected non-default branch push'}
  }
  return {save: false, reason: `${eventName} event`}
}

/**
 * The Cargo target tree the `target` payload transports: `target` beside the
 * workspace named by `working-directory`, resolved against the job's working
 * directory so a workspace below the checkout root is found.
 */
export function cargoTargetDirectory(workingDirectory: string, cwd = process.cwd()): string {
  return path.resolve(cwd, workingDirectory.trim() || '.', 'target')
}
