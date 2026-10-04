import {describe, expect, it} from 'vitest'
import {
  archiveExtractionEnvironment,
  mbxChildEnvironment,
  snapshotTransportEnvironment,
  withTemporaryProcessEnvironment
} from '../src/child-env.js'

describe('MBX child environments', () => {
  it('keeps Actions runtime, cache, OIDC, GitHub, and proxy credentials out of ordinary children', () => {
    const selected = mbxChildEnvironment({
      PATH: '/runner/bin',
      HOME: '/runner/home',
      RUNNER_TEMP: '/runner/tmp',
      ACTIONS_RUNTIME_TOKEN: 'runtime-secret',
      ACTIONS_CACHE_URL: 'https://cache.invalid/',
      ACTIONS_RESULTS_URL: 'https://results.invalid/',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.invalid/',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-secret',
      GITHUB_TOKEN: 'github-secret',
      GH_TOKEN: 'gh-secret',
      HTTP_PROXY: 'https://proxy.invalid/',
      NODE_OPTIONS: '--require=/repo/injected.js',
      MBX_REMOTE_TOKEN: 'remote-token',
      MBX_REMOTE_URL: 'https://cache.invalid/'
    })

    expect(selected).toEqual({
      PATH: '/runner/bin',
      HOME: '/runner/home',
      RUNNER_TEMP: '/runner/tmp'
    })
  })

  it('gives native transport only its explicit token, repository, and action-owned roots', () => {
    const selected = snapshotTransportEnvironment('snapshot-read-token', '/runner/private-cache', '/runner/tmp', {
      GITHUB_REPOSITORY: 'owner/repo',
      RUNNER_TEMP: '/runner/tmp',
      CARGO_TARGET_DIR: '/workspace/target',
      CARGO_BUILD_BUILD_DIR: '/workspace/build',
      MBX_CACHE_DIR: '/runner/cache',
      HOME: '/runner/home',
      USERPROFILE: 'C:\\runner\\home',
      ACTIONS_RUNTIME_TOKEN: 'runtime-secret',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-secret',
      GH_TOKEN: 'gh-secret',
      HTTPS_PROXY: 'https://proxy.invalid/',
      NODE_OPTIONS: '--require=/repo/injected.js'
    })

    expect(selected).toEqual({
      GITHUB_REPOSITORY: 'owner/repo',
      RUNNER_TEMP: '/runner/tmp',
      MBX_CACHE_DIR: '/runner/private-cache',
      GITHUB_TOKEN: 'snapshot-read-token'
    })
    expect(selected.PATH).toBeUndefined()
    expect(selected.ACTIONS_RUNTIME_TOKEN).toBeUndefined()
    expect(selected.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined()
    expect(selected.GH_TOKEN).toBeUndefined()
    expect(selected.HTTPS_PROXY).toBeUndefined()
    expect(selected.NODE_OPTIONS).toBeUndefined()
  })

  it('rejects an empty transport token', () => {
    expect(() => snapshotTransportEnvironment('  ', '/runner/private-cache', '/runner/tmp', {})).toThrow(/read token is required/)
  })

  it('uses only system search paths for toolkit archive extraction', () => {
    expect(archiveExtractionEnvironment('linux', {
      PATH: '/repo/bin:/usr/local/bin:/usr/bin',
      RUNNER_TEMP: '/runner/tmp',
      ACTIONS_RUNTIME_TOKEN: 'runtime-secret',
      INPUT_GITHUB_TOKEN: 'input-secret',
      HTTPS_PROXY: 'https://proxy.invalid/'
    })).toEqual({PATH: '/usr/bin:/bin', RUNNER_TEMP: '/runner/tmp'})
    expect(archiveExtractionEnvironment('win32', {
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\repo\\bin;C:\\Windows\\System32',
      RUNNER_TEMP: 'C:\\runner\\tmp',
      ACTIONS_RUNTIME_TOKEN: 'runtime-secret'
    })).toEqual({
      PATH: 'C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
      RUNNER_TEMP: 'C:\\runner\\tmp',
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      PATHEXT: '.EXE;.COM;.BAT;.CMD',
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe'
    })
    expect(() => archiveExtractionEnvironment('win32', {
      SystemRoot: 'C:\\runner\\repository\\Windows'
    })).toThrow(/operating-system Windows directory/)
  })

  it('restores the action process environment after a toolkit helper exits', async () => {
    const before = {...process.env}
    await expect(withTemporaryProcessEnvironment(
      {PATH: '/usr/bin:/bin'},
      async () => {
        expect(process.env.PATH).toBe('/usr/bin:/bin')
        expect(process.env.ACTIONS_RUNTIME_TOKEN).toBeUndefined()
        throw new Error('fixture failure')
      }
    )).rejects.toThrow('fixture failure')
    expect({...process.env}).toEqual(before)
  })
})
