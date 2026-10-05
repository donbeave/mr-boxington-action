import {createHash} from 'node:crypto'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'

const mocks = vi.hoisted(() => ({inputs: {} as Record<string, string>, state: {} as Record<string, string>, exported: {} as Record<string, string>, exec: vi.fn(), restore: vi.fn(), save: vi.fn(), failed: vi.fn(), warning: vi.fn(), info: vi.fn(), context: {runId: 1, runAttempt: 1, eventName: 'push', ref: 'refs/heads/main', sha: 'abc', payload: {repository: {default_branch: 'main'}, pull_request: undefined as {head?: {repo?: {full_name?: string}}, base?: {repo?: {full_name?: string}}} | undefined}}}))
vi.mock('@actions/core', () => ({
  getState: (name: string) => mocks.state[name] || '', getInput: (name: string) => mocks.inputs[name] || '',
  getMultilineInput: (name: string) => (mocks.inputs[name] || '').split(/\r?\n/).filter(Boolean), getBooleanInput: (name: string) => mocks.inputs[name] === 'true',
  saveState: (name: string, value: string) => { mocks.state[name] = value },
  setFailed: mocks.failed, warning: mocks.warning, info: mocks.info,
  addPath: vi.fn(), exportVariable: (name: string, value: string) => { mocks.exported[name] = value }, setOutput: vi.fn(), setSecret: vi.fn(), debug: vi.fn(),
  summary: {addDetails: () => ({write: async () => {}})}
}))
vi.mock('@actions/cache', () => ({restoreCache: mocks.restore, saveCache: mocks.save, ValidationError: class ValidationError extends Error {}}))
vi.mock('@actions/exec', () => ({exec: mocks.exec}))
vi.mock('@actions/github', () => ({context: mocks.context}))
vi.mock('@actions/tool-cache', () => ({}))

let directory = ''
let importFails = false
let executableChangesOnRestore = false
let executableChangesOnExport = false
let sourceSymlinkRetargetsOnRestore = false
let exportExitCode = 0
let nativeCacheDirectory = ''
let nativeExportReport: Record<string, unknown>
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubEnv('ACTIONS_RUNTIME_TOKEN', 'fixture-token')
  vi.stubEnv('ACTIONS_RESULTS_URL', 'https://fixture.invalid/')
  vi.stubEnv('GITHUB_REF_PROTECTED', 'true')
  vi.stubEnv('ACTIONS_CACHE_SERVICE_V2', 'true')
  directory = await mkdtemp(path.join(tmpdir(), 'mbx-main-test-'))
  vi.stubEnv('RUNNER_TEMP', directory)
  nativeCacheDirectory = path.join(directory, 'cache')
  const bin = path.join(directory, 'mbx')
  await writeFile(bin, 'fixture-executable')
  await chmod(bin, 0o755)
  mocks.inputs = {'mbx-path': bin, 'expected-version': '1.12.0', 'expected-binary-sha256': createHash('sha256').update('fixture-executable').digest('hex'), backend: 'github', 'github-cache-mode': 'objects', 'comparison-state': path.join(directory, 'baseline'), 'cache-key': 'velnor-v1-mbx-trusted-test-compatibility', 'restore-keys': 'velnor-v1-mbx-trusted-test-compatibility-', toolchain: '1.98.0', 'cache-links': 'false', 'cache-generation': 'qualified'}
  mocks.state = {}
  mocks.exported = {}
  mocks.context.eventName = 'push'
  mocks.context.ref = 'refs/heads/main'
  mocks.context.payload = {repository: {default_branch: 'main'}, pull_request: undefined}
  importFails = false
  executableChangesOnRestore = false
  executableChangesOnExport = false
  sourceSymlinkRetargetsOnRestore = false
  exportExitCode = 0
  mocks.restore.mockImplementation(async (paths: string[]) => {
    const [destination] = paths
    if (!destination) throw new Error('test restore requires a destination')
    await mkdir(destination, {recursive: true})
    await writeFile(path.join(destination, 'manifest.json'), '{}')
    if (executableChangesOnRestore) {
      const selected = mocks.state['mbx-selected-bin']
      if (!selected) throw new Error('test restore requires the selected verified executable')
      await chmod(selected, 0o700)
      await writeFile(selected, 'changed-executable')
    }
    if (sourceSymlinkRetargetsOnRestore) {
      const original = mocks.inputs['mbx-path']!
      const replacement = path.join(directory, 'replacement-mbx')
      await writeFile(replacement, 'untrusted-replacement')
      await chmod(replacement, 0o755)
      await rm(original, {force: true})
      await symlink(replacement, original)
    }
    return 'restored-qualified-key'
  })
  mocks.save.mockResolvedValue(23)
  nativeExportReport = {
    version: 2, budget_refused: false, snapshot_budget_bytes: 100,
    exported: true, actions: 1, objects: 2, bytes: 3, emitted_bundle_useful_delta: true,
    workspace_usefulness: {status: 'unavailable', reason: 'scheduler_validity_not_proven'},
    delta: {
      new_action_results: 1, changed_action_results: 0, new_predictions: 0,
      new_workspace_variants: 0, changed_workspace_variants: 0
    },
    semantic_digest: 'b'.repeat(64),
    workspace_comparison: 'relative_path_type_content_mode_symlink_target',
    workspace_comparison_exclusions: ['effective_build_root/.rustc_info.json'],
    workspace_transport_scope: 'recorded_target_and_build_directories',
    workspace_capture: 'captured', workspace_capture_unavailable_reason: null,
    workspace_persistence_verified: false,
    qualification: 'compiler workspace persistence remains unverified'
  }
  mocks.exec.mockImplementation(async (_bin, args, options) => {
    let output = ''
    if (args[0] === '--version') output = 'mbx 1.12.0'
    else if (args[0] === '+1.98.0') output = 'rustc 1.98.0\nhost: fixture'
    else if (args[1] === 'dir') output = mocks.exported.MBX_CACHE_DIR ? path.join(mocks.exported.MBX_CACHE_DIR, 'actions') : nativeCacheDirectory
    else if (args[1] === 'comparison-state') {
      if (args.includes('--verify')) output = JSON.stringify({version: 1, valid: true})
      else {
        await writeFile(args[2], JSON.stringify({version: 1, cold: true}))
        output = JSON.stringify({version: 1, empty: true})
      }
    } else if (args[1] === 'import') {
      if (importFails) return 1
      await writeFile(args[3], JSON.stringify({version: 1, restored: true}))
    } else if (args[1] === 'export') {
      if (nativeExportReport.exported) {
        const bundle = args.at(-1) as string
        await mkdir(bundle, {recursive: true})
        await writeFile(path.join(bundle, 'manifest.json'), '{}')
      }
      if (executableChangesOnExport) {
        const selected = mocks.state['mbx-selected-bin']
        if (!selected) throw new Error('test export requires the selected verified executable')
        await chmod(selected, 0o700)
        await writeFile(selected, 'changed-executable')
      }
      output = JSON.stringify(nativeExportReport)
    }
    options?.listeners?.stdout?.(Buffer.from(output))
    return args[1] === 'export' ? exportExitCode : 0
  })
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, {recursive: true, force: true}) })
async function invoke() {
  await import('../src/index.js')
  await vi.waitFor(() => expect(
    mocks.failed.mock.calls.length > 0 ||
    mocks.state['mbx-post'] === 'github-save' ||
    mocks.state['mbx-post'] === 'github-restore-only'
  ).toBe(true))
}
async function invokePost(allowDuplicateSkip = false) {
  vi.resetModules()
  await import('../src/index.js')
  await vi.waitFor(() => expect(
    mocks.save.mock.calls.length > 0 ||
    mocks.failed.mock.calls.length > 0 ||
    mocks.warning.mock.calls.some(([message]) => String(message).includes('Optional mbx cache export')) ||
    (allowDuplicateSkip && mocks.info.mock.calls.some(([message]) => String(message).includes('skipping duplicate cache save')))
  ).toBe(true))
}
function restoreSnapshot(key: string): void {
  mocks.restore.mockImplementation(async (paths: string[]) => {
    const [destination] = paths
    if (!destination) throw new Error('test restore requires a destination')
    await mkdir(destination, {recursive: true})
    await writeFile(path.join(destination, 'manifest.json'), '{}')
    return key
  })
}
describe('strict object transport main', () => {
  it('records imported baseline digest and never installs an executable', async () => {
    await invoke()
    expect(mocks.failed).not.toHaveBeenCalled()
    expect(mocks.state['mbx-comparison-sha256']).toMatch(/^[0-9a-f]{64}$/)
    expect(mocks.state['mbx-bin']).toBe(mocks.state['mbx-selected-bin'])
    expect(mocks.state['mbx-bin']).not.toBe(mocks.inputs['mbx-path'])
    expect(mocks.exec.mock.calls.some(call => call[1][1] === 'import')).toBe(true)
  })
  it('falls back from failed import to an explicit cold owner baseline', async () => {
    importFails = true
    await invoke()
    expect(mocks.failed).not.toHaveBeenCalled()
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('cold comparison baseline'))
    expect(mocks.exec.mock.calls.filter(call => call[1][1] === 'comparison-state')).toHaveLength(2)
    expect(mocks.state['mbx-cache-hit']).toBe('false')
  })
  it('retains the returned immutable key across import failure and skips an unchanged post upload', async () => {
    importFails = true
    const restoredSnapshotKey = `${mocks.inputs['cache-key']}-${'b'.repeat(64)}`
    restoreSnapshot(restoredSnapshotKey)
    await invoke()
    expect(mocks.state['mbx-cache-restored-key']).toBe(restoredSnapshotKey)
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('continuing with a cold comparison baseline'))

    await invokePost(true)
    expect(mocks.exec.mock.calls.some(call => call[1][1] === 'export')).toBe(true)
    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('skipping duplicate cache save'))
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.failed).not.toHaveBeenCalled()
  })
  it('continues cold on a classified cache transport outage', async () => {
    mocks.restore.mockRejectedValue(Object.assign(new Error('offline'), {code: 'ECONNRESET'}))
    await invoke()
    expect(mocks.failed).not.toHaveBeenCalled()
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('restore unavailable'))
  })
  it('fails unexpected restore errors instead of suppressing bugs', async () => {
    mocks.restore.mockRejectedValue(new Error('unexpected bug'))
    await invoke()
    expect(mocks.failed).toHaveBeenCalledWith(expect.objectContaining({message: 'unexpected bug'}))
  })
  it('fails unsupported owner baseline capability before cache restore', async () => {
    const implementation = mocks.exec.getMockImplementation()
    mocks.exec.mockImplementation(async (bin, args, options) => {
      if (args[1] === 'comparison-state') { options.listeners.stdout(Buffer.from('{}')); return 0 }
      return implementation?.(bin, args, options)
    })
    await invoke()
    expect(mocks.failed).toHaveBeenCalled()
    expect(mocks.restore).not.toHaveBeenCalled()
  })
  it('keeps the protected default-branch comparison base key free of run identifiers', async () => {
    await invoke()
    expect(mocks.failed).not.toHaveBeenCalled()
    expect(mocks.state['mbx-cache-key']).toBe('velnor-v1-mbx-trusted-test-compatibility')
    expect(mocks.state['mbx-cache-key']).not.toContain('-run-')
  })
  it('rejects a wrong published binary hash before any executable or cache operation', async () => {
    mocks.inputs['expected-binary-sha256'] = 'a'.repeat(64)
    await invoke()
    expect(mocks.failed).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining('SHA-256')}))
    expect(mocks.exec).not.toHaveBeenCalled()
    expect(mocks.restore).not.toHaveBeenCalled()
  })
  it('requires explicit restore prefixes in comparison mode', async () => {
    mocks.inputs['restore-keys'] = ''
    await invoke()
    expect(mocks.failed).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining('explicit restore-keys')}))
    expect(mocks.restore).not.toHaveBeenCalled()
  })
  it('requires an explicit compatibility cache key instead of generated fallback', async () => {
    mocks.inputs['cache-key'] = ''
    await invoke()
    expect(mocks.failed).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining('explicit cache-key compatibility domain')}))
    expect(mocks.restore).not.toHaveBeenCalled()
  })
  it('rejects a restore prefix outside the compatibility domain before cache restore', async () => {
    mocks.inputs['restore-keys'] = 'broad-mbx-prefix-'
    await invoke()
    expect(mocks.failed).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining('stay inside the explicit cache-key compatibility domain')}))
    expect(mocks.restore).not.toHaveBeenCalled()
  })
  it.each([
    {eventName: 'pull_request', ref: 'refs/pull/7/merge', protectedRef: 'false'},
    {eventName: 'workflow_dispatch', ref: 'refs/heads/main', protectedRef: 'true'},
    {eventName: 'push', ref: 'refs/heads/release', protectedRef: 'true'},
    {eventName: 'push', ref: 'refs/heads/main', protectedRef: 'false'}
  ])('keeps non-writer event $eventName $ref restore-only even with write cache-mode', async ({eventName, ref, protectedRef}) => {
    mocks.context.eventName = eventName
    mocks.context.ref = ref
    vi.stubEnv('GITHUB_REF_PROTECTED', protectedRef)
    vi.stubEnv('ACTIONS_CACHE_MODE', 'write')
    if (eventName === 'pull_request') {
      mocks.context.payload.pull_request = {
        head: {repo: {full_name: 'fork/repository'}},
        base: {repo: {full_name: 'trusted/repository'}}
      }
    }
    await invoke()
    expect(mocks.failed).not.toHaveBeenCalled()
    expect(mocks.state['mbx-post']).toBe('github-restore-only')
    expect(mocks.exec.mock.calls.some(call => call[1][1] === 'export')).toBe(false)
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('rejects a successful restore that omitted the required bundle before native import', async () => {
    mocks.restore.mockResolvedValue('restored-qualified-key')
    await invoke()
    expect(mocks.failed).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining('missing after restore')}))
    expect(mocks.exec.mock.calls.some(call => call[1][1] === 'import')).toBe(false)
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('rejects an empty native cache directory before cache restore', async () => {
    nativeCacheDirectory = ''
    await invoke()
    expect(mocks.failed).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining('normalized absolute path')}))
    expect(mocks.restore).not.toHaveBeenCalled()
    expect(mocks.exec.mock.calls.some(call => call[1][1] === 'export')).toBe(false)
  })
  it('rejects a restored symlink before native import', async () => {
    mocks.restore.mockImplementation(async (paths: string[]) => {
      const [destination] = paths
      if (!destination) throw new Error('test restore requires a destination')
      await symlink(directory, destination)
      return 'restored-qualified-key'
    })
    await invoke()
    expect(mocks.failed).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining('unexpected type or is a symlink')}))
    expect(mocks.exec.mock.calls.some(call => call[1][1] === 'import')).toBe(false)
  })
  it('rejects a restored payload with the wrong type before native import', async () => {
    mocks.restore.mockImplementation(async (paths: string[]) => {
      const [destination] = paths
      if (!destination) throw new Error('test restore requires a destination')
      await writeFile(destination, 'not a directory bundle')
      return 'restored-qualified-key'
    })
    await invoke()
    expect(mocks.failed).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining('unexpected type or is a symlink')}))
    expect(mocks.exec.mock.calls.some(call => call[1][1] === 'import')).toBe(false)
  })
  it('uses the same canonical absolute bundle vector for restore, export, and save', async () => {
    const restoredSnapshotKey = `${mocks.inputs['cache-key']}-${'a'.repeat(64)}`
    restoreSnapshot(restoredSnapshotKey)
    await invoke()
    expect(mocks.failed).not.toHaveBeenCalled()
    const restorePaths = mocks.restore.mock.calls[0]?.[0] as string[]
    const savedPaths = JSON.parse(mocks.state['mbx-cache-paths'] || '[]') as string[]
    const [restoredArchive] = restorePaths
    if (!restoredArchive) throw new Error('main did not restore an object cache path')
    expect(restorePaths).toEqual(savedPaths)
    expect(restorePaths).toEqual([path.join(await realpath(path.join(directory, 'cache')), 'github-actions-cache-v1')])
    expect(path.isAbsolute(restoredArchive)).toBe(true)

    await invokePost()
    const exportCall = mocks.exec.mock.calls.find(call => call[1][1] === 'export')
    expect(exportCall?.[1].at(-1)).toBe(restoredArchive)
    expect(mocks.save).toHaveBeenCalledWith(restorePaths, `${mocks.state['mbx-cache-key']}-${'b'.repeat(64)}`)
    expect(mocks.failed).not.toHaveBeenCalled()
  })
  it('exports late work but skips upload when the restored semantic snapshot is unchanged', async () => {
    const restoredSnapshotKey = `${mocks.inputs['cache-key']}-${nativeExportReport.semantic_digest as string}`
    restoreSnapshot(restoredSnapshotKey)
    await invoke()
    expect(mocks.failed).not.toHaveBeenCalled()
    expect(mocks.state['mbx-cache-restored-key']).toBe(restoredSnapshotKey)

    await invokePost(true)
    expect(mocks.exec.mock.calls.some(call => call[1][1] === 'export')).toBe(true)
    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('skipping duplicate cache save'))
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.failed).not.toHaveBeenCalled()
  })
  it('preserves isolated-object staging while saving a changed semantic snapshot', async () => {
    mocks.inputs['isolate-objects-cache'] = 'true'
    const restoredSnapshotKey = `${mocks.inputs['cache-key']}-${'a'.repeat(64)}`
    restoreSnapshot(restoredSnapshotKey)
    await invoke()
    expect(mocks.failed).not.toHaveBeenCalled()
    const isolationRoot = mocks.state['mbx-cache-isolation-root']
    if (!isolationRoot) throw new Error('main did not record its isolated cache root')
    expect(isolationRoot).toContain('mbx-github-objects-store-')

    await invokePost()
    expect(mocks.save).toHaveBeenCalledWith(
      [path.join(await realpath(directory), 'mbx-github-objects-bundle-v1')],
      `${mocks.inputs['cache-key']}-${'b'.repeat(64)}`
    )
    await expect(realpath(isolationRoot)).rejects.toThrow()
    expect(mocks.failed).not.toHaveBeenCalled()
  })
  it('continues after an isolated comparison import failure and saves the resulting digest', async () => {
    mocks.inputs['isolate-objects-cache'] = 'true'
    importFails = true
    await invoke()
    expect(mocks.failed).not.toHaveBeenCalled()
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('cold comparison baseline'))
    expect(mocks.state['mbx-cache-hit']).toBe('false')

    await invokePost()
    expect(mocks.save).toHaveBeenCalledWith(
      [path.join(await realpath(directory), 'mbx-github-objects-bundle-v1')],
      `${mocks.inputs['cache-key']}-${'b'.repeat(64)}`
    )
    expect(mocks.failed).not.toHaveBeenCalled()
  })
  it('rechecks the preinstalled binary after native export before uploading', async () => {
    await invoke()
    executableChangesOnExport = true
    await invokePost()
    expect(mocks.failed).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining('SHA-256')}))
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('fails before native import when the selected staged executable changes during restore', async () => {
    executableChangesOnRestore = true
    await invoke()
    expect(mocks.failed).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining('SHA-256')}))
    expect(mocks.exec.mock.calls.some(call => call[1][1] === 'import')).toBe(false)
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('uses the initially verified executable when the caller symlink retargets during restore', async () => {
    const original = mocks.inputs['mbx-path']!
    const target = path.join(directory, 'mise-selected-mbx')
    const alias = path.join(directory, 'mise-bin')
    await rm(original)
    await writeFile(target, 'fixture-executable')
    await chmod(target, 0o755)
    await symlink(target, alias)
    mocks.inputs['mbx-path'] = alias
    sourceSymlinkRetargetsOnRestore = true

    await invoke()

    expect(mocks.failed).not.toHaveBeenCalled()
    expect(mocks.state['mbx-bin']).toBe(mocks.state['mbx-selected-bin'])
    expect(mocks.state['mbx-bin']).not.toBe(alias)
    const importCall = mocks.exec.mock.calls.find(call => call[1][1] === 'import')
    expect(importCall?.[0]).toBe(mocks.state['mbx-selected-bin'])
    expect(await realpath(alias)).toBe(await realpath(path.join(directory, 'replacement-mbx')))
  })
  it.each([false, true])('keeps comparison cache upload failures optional (isolated=%s)', async isolated => {
    if (isolated) mocks.inputs['isolate-objects-cache'] = 'true'
    await invoke()
    mocks.save.mockRejectedValue(new Error('cache upload unavailable'))
    await invokePost()
    await vi.waitFor(() => expect(mocks.warning).toHaveBeenCalledWith(
      expect.stringContaining('Optional mbx objects cache upload unavailable')
    ))
    expect(mocks.failed).not.toHaveBeenCalled()
  })
  it.each([false, true])('keeps comparison cache export failures optional (isolated=%s)', async isolated => {
    if (isolated) mocks.inputs['isolate-objects-cache'] = 'true'
    await invoke()
    exportExitCode = 1
    await invokePost()
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('Optional mbx cache export'))
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.failed).not.toHaveBeenCalled()
  })
})
