import {createHash} from 'node:crypto'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
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
  calls: [] as {command: string; args: string[]; env: NodeJS.ProcessEnv}[],
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
  exportVariable: (name: string, value: string) => {mocks.exported[name] = value},
  setOutput: (name: string, value: string) => {mocks.outputs[name] = value},
  setSecret: vi.fn(),
  summary: {addDetails: () => ({write: async () => {}})}
}))
vi.mock('@actions/exec', () => ({exec: mocks.exec}))
vi.mock('@actions/tool-cache', () => ({}))

let directory = ''
let executable = ''
let executableDigest = ''
let importExitCode = 0
let tamperMbxOnImport = false

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.calls = []
  mocks.state = {}
  mocks.outputs = {}
  mocks.exported = {}
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
  tamperMbxOnImport = false
  vi.stubEnv('RUNNER_TEMP', directory)
  vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo')
  vi.stubEnv('CARGO_TARGET_DIR', path.join(directory, 'target'))
  vi.stubEnv('ACTIONS_RUNTIME_TOKEN', 'runtime-secret')
  vi.stubEnv('ACTIONS_CACHE_URL', 'https://cache.invalid/')
  vi.stubEnv('ACTIONS_RESULTS_URL', 'https://results.invalid/')
  vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', 'https://oidc.invalid/')
  vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'oidc-secret')
  vi.stubEnv('GITHUB_TOKEN', 'ambient-github-token')
  vi.stubEnv('GH_TOKEN', 'ambient-gh-token')
  vi.stubEnv('HTTPS_PROXY', 'https://proxy.invalid/')
  vi.stubEnv('NODE_OPTIONS', '--require=/repo/injected.js')
  mocks.exec.mockImplementation(async (command: string, args: string[], options: {env?: NodeJS.ProcessEnv; listeners?: {stdout?: (data: Buffer) => void}; ignoreReturnCode?: boolean}) => {
    mocks.calls.push({command, args: [...args], env: {...options.env}})
    if (args[1] === 'comparison-state' && args[2]) {
      await writeFile(args[2], JSON.stringify({version: 1, empty: true}))
    }
    const line = args.includes('import-native')
      ? JSON.stringify({version: 1, actions: 4, objects: 7, bytes: 99, comparison_state_recorded: Boolean(mocks.inputs['comparison-state']), workspace_restored: false, workspace_restore: 'not_present'})
      : args.includes('comparison-state')
        ? JSON.stringify({version: 1, valid: true, empty: true})
        : args[0] === 'cache' && args[1] === 'dir'
          ? mocks.cacheDir
          : args[0] === '--version'
            ? 'mbx 1.12.0'
            : ''
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
  await vi.waitFor(() => expect(mocks.outputs['native-snapshot-imported']).toBeDefined())
}

describe('action main', () => {
  it('dispatches the untrusted artifact selector only to verified MBX with explicit read token', async () => {
    mocks.inputs['snapshot-selection'] = 'artifact-id'
    mocks.inputs['snapshot-artifact-id'] = '42'
    mocks.inputs['actions-read-token'] = 'actions-read-token'
    await loadAction()

    const call = mocks.calls.find(candidate => candidate.args.includes('import-native'))
    expect(call?.args).toEqual([
      'cache', 'import-native', '--github-artifact-id', '42', '--json'
    ])
    expect(call?.env).toMatchObject({GITHUB_TOKEN: 'actions-read-token', GITHUB_REPOSITORY: 'owner/repo'})
    expect(call?.env.PATH).toBeUndefined()
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
    expect(mocks.failed).not.toHaveBeenCalled()
  })

  it('asks MBX to discover the latest compatible snapshot without caller provenance input', async () => {
    mocks.inputs['snapshot-selection'] = 'latest-compatible'
    mocks.inputs['actions-read-token'] = 'actions-read-token'
    await loadAction()
    const call = mocks.calls.find(candidate => candidate.args.includes('import-native'))
    expect(call?.args).toEqual(['cache', 'import-native', '--latest-compatible', '--json'])
    expect(call?.env.GITHUB_TOKEN).toBe('actions-read-token')
    expect(mocks.outputs['native-snapshot-imported']).toBe('true')
    expect(mocks.failed).not.toHaveBeenCalled()
  })

  it('continues cold when the native import operation fails', async () => {
    mocks.inputs['snapshot-selection'] = 'artifact-id'
    mocks.inputs['snapshot-artifact-id'] = '42'
    mocks.inputs['actions-read-token'] = 'actions-read-token'
    importExitCode = 1
    await loadAction()
    expect(mocks.outputs['native-snapshot-imported']).toBe('false')
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringMatching(/unavailable or inadmissible/))
    expect(mocks.failed).not.toHaveBeenCalled()
  })

  it('fails the action if the verified MBX binary changes during native import', async () => {
    mocks.inputs['snapshot-selection'] = 'artifact-id'
    mocks.inputs['snapshot-artifact-id'] = '42'
    mocks.inputs['actions-read-token'] = 'actions-read-token'
    tamperMbxOnImport = true
    await import('../src/index.js')
    await vi.waitFor(() => expect(mocks.failed).toHaveBeenCalled())
    const error = mocks.failed.mock.calls[0]?.[0]
    expect(String(error)).toMatch(/SHA-256 does not match/)
    expect(mocks.outputs['native-snapshot-imported']).toBeUndefined()
  })

  it('creates a cold comparison baseline and skips transport when no ID is selected', async () => {
    mocks.inputs['comparison-state'] = path.join(directory, 'owner-state.json')
    await loadAction()
    expect(mocks.calls.some(candidate => candidate.args.includes('comparison-state'))).toBe(true)
    expect(mocks.calls.some(candidate => candidate.args.includes('import-native'))).toBe(false)
    expect(mocks.outputs['native-snapshot-imported']).toBe('false')
    await expect(readFile(mocks.inputs['comparison-state'], 'utf8')).resolves.toContain('"version":1')
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
