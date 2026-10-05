import {describe, expect, it} from 'vitest'
import {
  cacheLinksValue,
  callingCard,
  githubApiHeaders,
  normalizedVersion,
  releaseTarget,
  remoteExports,
  verifiedReleaseAsset
} from '../src/lib.js'

describe('calling card', () => {
  it('escapes action-provided content', () => {
    expect(callingCard('<cold>', [{label: 'Remote', value: '<cache & server>'}])).toBe(
      '<blockquote>&lt;cold&gt;</blockquote>' +
        '<table><tr><th align="left">Remote</th><td>&lt;cache &amp; server&gt;</td></tr></table>'
    )
  })
})

describe('remote settings', () => {
  it('exports only explicitly supplied values and rejects mixed credentials', () => {
    expect(remoteExports({
      url: 'https://cache.example/', namespace: 'project', token: 'secret', tokenFile: '',
      oidcAudience: '', mode: 'read-only'
    })).toEqual({
      MBX_REMOTE_URL: 'https://cache.example/', MBX_REMOTE_NAMESPACE: 'project',
      MBX_REMOTE_MODE: 'read-only', MBX_REMOTE_TOKEN: 'secret'
    })
    expect(() => remoteExports({
      url: '', namespace: '', token: 'secret', tokenFile: '/tmp/token', oidcAudience: '', mode: ''
    })).toThrow(/set only one/)
    expect(() => remoteExports({
      url: '', namespace: '', token: '', tokenFile: '', oidcAudience: '', mode: 'read-sometimes'
    })).toThrow(/invalid remote-mode/)
  })
})

describe('MBX release selection', () => {
  it('uses the exact official targets', () => {
    expect(releaseTarget('linux', 'x64')).toBe('x86_64-unknown-linux-musl')
    expect(releaseTarget('darwin', 'arm64')).toBe('aarch64-apple-darwin')
    expect(releaseTarget('win32', 'x64')).toBe('x86_64-pc-windows-msvc')
    expect(() => releaseTarget('freebsd' as NodeJS.Platform, 'x64')).toThrow(/does not publish/)
  })

  it('normalizes explicit versions and validates immutable release digests', () => {
    expect(normalizedVersion('v1.2.3')).toBe('1.2.3')
    expect(normalizedVersion('latest')).toBe('latest')
    expect(() => normalizedVersion('1.2')).toThrow(/invalid mbx version/)
    expect(verifiedReleaseAsset({
      tag_name: 'v1.2.3', immutable: true,
      assets: [{name: 'mbx-linux.tar.gz', digest: `sha256:${'a'.repeat(64)}`}]
    }, '1.2.3', 'mbx-linux.tar.gz')).toEqual({version: '1.2.3', sha256: 'a'.repeat(64)})
    expect(() => verifiedReleaseAsset({
      tag_name: 'v1.2.3', immutable: false,
      assets: [{name: 'mbx-linux.tar.gz', digest: `sha256:${'a'.repeat(64)}`}]
    }, '1.2.3', 'mbx-linux.tar.gz')).toThrow(/not an immutable/)
  })

  it('does not attach a token to public release metadata requests by default', () => {
    expect(githubApiHeaders('')).toEqual({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    })
    expect(cacheLinksValue('auto', 'linux')).toBe('1')
    expect(cacheLinksValue('auto', 'darwin')).toBeUndefined()
    expect(cacheLinksValue('false', 'linux')).toBe('0')
  })
})
