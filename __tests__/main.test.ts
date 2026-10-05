import {createHash} from 'node:crypto'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {chmod, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'

const mocks = vi.hoisted(() => ({
  inputs: {} as Record<string, string>,
  state: {} as Record<string, string>,
  outputs: {} as Record<string, string>,
  exported: {} as Record<string, string>,
  failed: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  completed: false,
  calls: [] as {command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string}[],
  exec: vi.fn(),
  cacheDir: ''
}))

vi.mock('@actions/core', () => ({
  getState: (name: string) => mocks.state[name] || '',
  getInput: (name: string) => mocks.inputs[name] || '',
  saveState: (name: string, value: string) => {mocks.state[name] = value},
  setFailed: mocks.failed,
  warning: mocks.warning,
  info: mocks.info,
  debug: vi.fn(),
  addPath: vi.fn(),
  exportVariable: (name: string, value: string) => {
    mocks.exported[name] = value
    process.env[name] = value
  },
  setOutput: (name: string, value: string) => {mocks.outputs[name] = value},
  setSecret: vi.fn(),
  summary: {addDetails: () => ({write: async () => {mocks.completed = true}})}
}))
vi.mock('@actions/exec', () => ({exec: mocks.exec}))
vi.mock('@actions/tool-cache', () => ({}))

let directory = ''
let executable = ''
let executableDigest = ''
let importExitCode = 0
let importOutputOverride: string | undefined
let tamperMbxOnImport = false

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.calls = []
  mocks.state = {}
  mocks.outputs = {}
  mocks.exported = {}
  mocks.completed = false
  directory = await mkdtemp(path.join(tmpdir(), 'mbx-main-test-'))
  executable = path.join(directory, 'mbx')
  const bytes = Buffer.from('fixture-mbx-binary')
  await writeFile(executable, bytes)
  await chmod(executable, 0o755)
  executableDigest = createHash('sha256').update(bytes).digest('hex')
  mocks.cacheDir = path.join(directory, 'cache')
  mocks.inputs = {
    'mbx-path': executable,
    'expected-version': '1.12.0',
    'expected-binary-sha256': executableDigest,
    'cache-links': 'false'
  }
  importExitCode = 0
  importOutputOverride = undefined
  tamperMbxOnImport = false
  vi.stubEnv('RUNNER_TEMP', directory)
  vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo')
  vi.stubEnv('GITHUB_WORKSPACE', directory)
  vi.stubEnv('CARGO_TARGET_DIR', path.join(directory, 'target'))
  vi.stubEnv('MBX_CACHE_DIR', path.join(directory, 'attacker-selected-cache'))
  vi.stubEnv('HOME', path.join(directory, 'attacker-selected-home'))
  vi.stubEnv('ACTIONS_RUNTIME_TOKEN', 'runtime-secret')
  vi.stubEnv('ACTIONS_CACHE_URL', 'https://cache.invalid/')
  vi.stubEnv('ACTIONS_RESULTS_URL', 'https://results.invalid/')
  vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', 'https://oidc.invalid/')
  vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'oidc-secret')
  vi.stubEnv('GITHUB_TOKEN', 'ambient-github-token')
  vi.stubEnv('GH_TOKEN', 'ambient-gh-token')
  vi.stubEnv('HTTPS_PROXY', 'https://proxy.invalid/')
  vi.stubEnv('NODE_OPTIONS', '--require=/repo/injected.js')
  mocks.exec.mockImplementation(async (command: string, args: string[], options: {env?: NodeJS.ProcessEnv; cwd?: string; listeners?: {stdout?: (data: Buffer) => void}; ignoreReturnCode?: boolean}) => {
    mocks.calls.push({command, args: [...args], env: {...options.env}, cwd: options.cwd})
    const line = args.includes('import-native')
      ? importOutputOverride ?? JSON.stringify({version: 2, status: 'authenticated_imported', authenticated: true, actions: 4, objects: 7, bytes: 99, comparison_state_recorded: true, workspace_restored: true, workspace_restore: 'restored'})
      : args[0] === 'cache' && args[1] === 'dir'
          ? mocks.cacheDir
          : args[0] === '--version'
            ? 'mbx 1.12.0'
            : ''
    if (args.includes('import-native') && importExitCode === 0) {
      try {
        const report = JSON.parse(line) as Record<string, unknown>
        if (report.status === 'authenticated_imported' && report.comparison_state_recorded === true) {
          await writeFile(path.join(options.env?.MBX_CACHE_DIR || '', 'mbx-native-comparison-state-v3.json'), '{}', {mode: 0o600})
        }
      } catch {}
    }
    options.listeners?.stdout?.(Buffer.from(line))
    if (args.includes('import-native') && tamperMbxOnImport) {
      await chmod(command, 0o700)
      await writeFile(command, 'tampered-mbx-binary')
    }
    return args.includes('import-native') ? importExitCode : 0
  })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(directory, {recursive: true, force: true})
})

async function loadAction(): Promise<void> {
  await import('../src/index.js')
  await vi.waitFor(() => {
    expect(mocks.outputs['native-snapshot-imported']).toBeDefined()
    expect(mocks.completed).toBe(true)
  })
}

describe('action main', () => {
  it('dispatches the untrusted artifact selector only to verified MBX with explicit read token', async () => {
    mocks.inputs['snapshot-selection'] = 'artifact-id'
    mocks.inputs['snapshot-artifact-id'] = '42'
    mocks.inputs['snapshot-read-token'] = 'snapshot-read-token'
    await loadAction()

    const call = mocks.calls.find(candidate => candidate.args.includes('import-native'))
    const canonicalTemp = await realpath(directory)
    expect(call?.args).toEqual([
      'cache', 'import-native', '--github-artifact-id', '42', '--json'
    ])
    expect(call?.env.GITHUB_TOKEN).toBe('snapshot-read-token')
    expect(call?.env.GITHUB_REPOSITORY).toBe('owner/repo')
    expect(path.dirname(call?.env.MBX_CACHE_DIR || '')).toBe(canonicalTemp)
    expect(path.basename(call?.env.MBX_CACHE_DIR || '')).toMatch(/^velnor-mbx-cache-[0-9a-f]{32}$/)
    expect(call?.env.RUNNER_TEMP).toBe(canonicalTemp)
    expect(call?.env.HOME).toBeUndefined()
    expect(call?.cwd).toBe(directory)
    expect(call?.env.PATH).toBeUndefined()
    expect(call?.env.CARGO_TARGET_DIR).toBeUndefined()
    expect(call?.env.CARGO_BUILD_BUILD_DIR).toBeUndefined()
    expect(call?.env.MBX_CACHE_DIR).not.toBe(path.join(directory, 'attacker-selected-cache'))
    expect(mocks.exported.MBX_CACHE_DIR).toBe(call?.env.MBX_CACHE_DIR)
    expect(mocks.outputs['native-snapshot-comparison-state']).toBe(path.join(call?.env.MBX_CACHE_DIR || '', 'mbx-native-comparison-state-v3.json'))
    await expect(realpath(mocks.outputs['native-snapshot-comparison-state'] || '')).resolves.toBe(mocks.outputs['native-snapshot-comparison-state'])
    expect(call?.env.ACTIONS_RUNTIME_TOKEN).toBeUndefined()
    expect(call?.env.ACTIONS_CACHE_URL).toBeUndefined()
    expect(call?.env.ACTIONS_RESULTS_URL).toBeUndefined()
    expect(call?.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined()
    expect(call?.env.GH_TOKEN).toBeUndefined()
    expect(call?.env.HTTPS_PROXY).toBeUndefined()
    expect(call?.env.NODE_OPTIONS).toBeUndefined()
    for (const child of mocks.calls.filter(candidate => !candidate.args.includes('import-native'))) {
      expect(child.env.ACTIONS_RUNTIME_TOKEN).toBeUndefined()
      expect(child.env.GITHUB_TOKEN).toBeUndefined()
      expect(child.env.GH_TOKEN).toBeUndefined()
      expect(child.env.NODE_OPTIONS).toBeUndefined()
      expect(child.env.HTTPS_PROXY).toBeUndefined()
    }
    expect(mocks.outputs['native-snapshot-imported']).toBe('true')
    expect(mocks.outputs['native-snapshot-comparison-state']).toBe(path.join(mocks.exported.MBX_CACHE_DIR || '', 'mbx-native-comparison-state-v3.json'))
    expect(mocks.failed).not.toHaveBeenCalled()
  })

  it('asks MBX to discover the latest compatible snapshot without caller provenance input', async () => {
    mocks.inputs['snapshot-selection'] = 'latest-compatible'
    mocks.inputs['snapshot-read-token'] = 'snapshot-read-token'
    await loadAction()
    const call = mocks.calls.find(candidate => candidate.args.includes('import-native'))
    expect(call?.args).toEqual(['cache', 'import-native', '--latest-compatible', '--json'])
    expect(call?.env.GITHUB_TOKEN).toBe('snapshot-read-token')
    expect(mocks.outputs['native-snapshot-imported']).toBe('true')
    expect(mocks.failed).not.toHaveBeenCalled()
  })

  it('continues cold when the native import operation fails', async () => {
    mocks.inputs['snapshot-selection'] = 'artifact-id'
    mocks.inputs['snapshot-artifact-id'] = '42'
    mocks.inputs['snapshot-read-token'] = 'snapshot-read-token'
    importExitCode = 1
    await loadAction()
    expect(mocks.outputs['native-snapshot-imported']).toBe('false')
    expect(mocks.outputs['native-snapshot-comparison-state']).toBe(path.join(mocks.exported.MBX_CACHE_DIR || '', 'mbx-native-comparison-state-v3.json'))
    await expect(realpath(mocks.outputs['native-snapshot-comparison-state'] || '')).rejects.toThrow()
    const cacheDirectory = mocks.exported.MBX_CACHE_DIR
    expect(path.basename(cacheDirectory || '')).toMatch(/^velnor-mbx-cache-[0-9a-f]{32}$/)
    const laterCacheCommand = mocks.calls.find(candidate => candidate.args[0] === 'cache' && candidate.args[1] === 'dir')
    expect(laterCacheCommand?.env.MBX_CACHE_DIR).toBe(cacheDirectory)
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringMatching(/unavailable or inadmissible/))
    expect(mocks.failed).not.toHaveBeenCalled()
  })

  it.each([
    ['missing report', ''],
    ['unknown status', JSON.stringify({version: 2, status: 'local_imported', authenticated: false, actions: 4, objects: 7, bytes: 99, workspace_restored: true})],
    ['missing authentication result', JSON.stringify({version: 2, status: 'authenticated_imported', actions: 4, objects: 7, bytes: 99, workspace_restored: true})],
    ['missing comparison state result', JSON.stringify({version: 2, status: 'authenticated_imported', authenticated: true, workspace_restored: true, workspace_restore: 'restored'})],
    ['workspace not restored', JSON.stringify({version: 2, status: 'authenticated_imported', authenticated: true, actions: 4, objects: 7, bytes: 99, workspace_restored: false})],
    ['malformed report', '{not-json']
  ])('continues cold for %s native import output', async (_caseName, output) => {
    mocks.inputs['snapshot-selection'] = 'artifact-id'
    mocks.inputs['snapshot-artifact-id'] = '42'
    mocks.inputs['snapshot-read-token'] = 'snapshot-read-token'
    importOutputOverride = output
    await loadAction()
    expect(mocks.outputs['native-snapshot-imported']).toBe('false')
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringMatching(/unavailable or inadmissible/))
    expect(mocks.failed).not.toHaveBeenCalled()
  })

  it('uses explicit authenticated restoration status instead of snapshot counters', async () => {
    mocks.inputs['snapshot-selection'] = 'artifact-id'
    mocks.inputs['snapshot-artifact-id'] = '42'
    mocks.inputs['snapshot-read-token'] = 'snapshot-read-token'
    importOutputOverride = JSON.stringify({version: 2, status: 'authenticated_imported', authenticated: true, actions: 0, objects: 0, bytes: 0, comparison_state_recorded: true, workspace_restored: true, workspace_restore: 'restored'})
    await loadAction()
    const canonicalTemp = await realpath(directory)
    expect(mocks.outputs['native-snapshot-imported']).toBe('true')
    await expect(realpath(mocks.outputs['native-snapshot-comparison-state'] || '')).resolves.toBe(mocks.outputs['native-snapshot-comparison-state'])
    expect(path.dirname(mocks.exported.MBX_CACHE_DIR || '')).toBe(canonicalTemp)
    expect(path.basename(mocks.exported.MBX_CACHE_DIR || '')).toMatch(/^velnor-mbx-cache-[0-9a-f]{32}$/)
  })

  it('keeps an authenticated imported store available when MBX leaves the workspace unchanged', async () => {
    mocks.inputs['snapshot-selection'] = 'artifact-id'
    mocks.inputs['snapshot-artifact-id'] = '42'
    mocks.inputs['snapshot-read-token'] = 'snapshot-read-token'
    importOutputOverride = JSON.stringify({version: 2, status: 'authenticated_imported', authenticated: true, actions: 4, objects: 7, bytes: 99, comparison_state_recorded: true, workspace_restored: false, workspace_restore: 'skipped_nonempty'})
    await loadAction()
    const canonicalTemp = await realpath(directory)
    expect(mocks.outputs['native-snapshot-imported']).toBe('false')
    await expect(realpath(mocks.outputs['native-snapshot-comparison-state'] || '')).resolves.toBe(mocks.outputs['native-snapshot-comparison-state'])
    expect(path.dirname(mocks.exported.MBX_CACHE_DIR || '')).toBe(canonicalTemp)
    expect(path.basename(mocks.exported.MBX_CACHE_DIR || '')).toMatch(/^velnor-mbx-cache-[0-9a-f]{32}$/)
  })

  it('fails the action if the verified MBX binary changes during native import', async () => {
    mocks.inputs['snapshot-selection'] = 'artifact-id'
    mocks.inputs['snapshot-artifact-id'] = '42'
    mocks.inputs['snapshot-read-token'] = 'snapshot-read-token'
    tamperMbxOnImport = true
    await import('../src/index.js')
    await vi.waitFor(() => expect(mocks.failed).toHaveBeenCalled())
    const error = mocks.failed.mock.calls[0]?.[0]
    expect(String(error)).toMatch(/SHA-256 does not match/)
    expect(mocks.outputs['native-snapshot-imported']).toBeUndefined()
  })

  it('does not create a comparison baseline or store when no snapshot is selected', async () => {
    await loadAction()
    expect(mocks.calls.some(candidate => candidate.args.includes('comparison-state'))).toBe(false)
    expect(mocks.calls.some(candidate => candidate.args.includes('import-native'))).toBe(false)
    expect(mocks.outputs['native-snapshot-imported']).toBe('false')
    expect(mocks.outputs['native-snapshot-comparison-state']).toBe('')
    expect(mocks.exported.MBX_CACHE_DIR).toBeUndefined()
  })

  it('continues cold on the explicit no-candidate report without creating comparison state', async () => {
    mocks.inputs['snapshot-selection'] = 'latest-compatible'
    mocks.inputs['snapshot-read-token'] = 'snapshot-read-token'
    importOutputOverride = JSON.stringify({version: 2, status: 'cold_miss', authenticated: false, actions: 0, objects: 0, bytes: 0, comparison_state_recorded: false, workspace_restored: false, workspace_restore: 'not_attempted'})
    await loadAction()
    const statePath = mocks.outputs['native-snapshot-comparison-state'] || ''
    expect(statePath).toBe(path.join(mocks.exported.MBX_CACHE_DIR || '', 'mbx-native-comparison-state-v3.json'))
    await expect(realpath(statePath)).rejects.toThrow()
    expect(mocks.outputs['native-snapshot-imported']).toBe('false')
    expect(mocks.failed).not.toHaveBeenCalled()
  })

  it('rejects GitHub cache as a backend instead of silently restoring or saving', async () => {
    mocks.inputs.backend = 'github'
    await import('../src/index.js')
    await vi.waitFor(() => expect(mocks.failed).toHaveBeenCalled())
    expect(mocks.failed).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining('backend must be "local" or "remote"')}))
    expect(mocks.calls).toEqual([])
  })

  it('preserves explicit remote MBX settings for later steps', async () => {
    mocks.inputs.backend = 'remote'
    mocks.inputs['remote-url'] = 'https://cache.example/'
    mocks.inputs.namespace = 'project'
    mocks.inputs.token = 'remote-secret'
    mocks.inputs['remote-mode'] = 'read-only'
    await loadAction()
    expect(mocks.exported).toMatchObject({
      MBX_REMOTE_URL: 'https://cache.example/',
      MBX_REMOTE_NAMESPACE: 'project',
      MBX_REMOTE_TOKEN: 'remote-secret',
      MBX_REMOTE_MODE: 'read-only'
    })
    expect(mocks.failed).not.toHaveBeenCalled()
  })
})
