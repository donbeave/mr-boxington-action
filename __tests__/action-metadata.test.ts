import {readFile} from 'node:fs/promises'
import {describe, expect, it} from 'vitest'
import path from 'node:path'

describe('action metadata', () => {
  it('has one main entrypoint and no post lifecycle', async () => {
    const metadata = await readFile(path.join(process.cwd(), 'action.yml'), 'utf8')
    expect(metadata).toMatch(/^  main: dist\/index\.js$/m)
    expect(metadata).not.toMatch(/^  post:/m)
    expect(metadata).not.toMatch(/^  post-if:/m)
  })

  it('removes the GitHub Actions cache API and writer inputs', async () => {
    const metadata = await readFile(path.join(process.cwd(), 'action.yml'), 'utf8')
    expect(metadata).not.toMatch(/@actions\/cache|github-cache-mode|cache-key|restore-keys|isolate-objects-cache/)
    expect(metadata).toMatch(/^  snapshot-selection:$/m)
    expect(metadata).toMatch(/^  snapshot-artifact-id:$/m)
    expect(metadata).toMatch(/^  snapshot-read-token:$/m)
    expect(metadata).not.toMatch(/^  comparison-state:$/m)
    expect(metadata).toMatch(/^  native-snapshot-comparison-state:$/m)
  })

  it('documents native reader permissions and prelaunch environment boundaries', async () => {
    const readme = await readFile(path.join(process.cwd(), 'README.md'), 'utf8')
    for (const permission of ['actions: read', 'attestations: read', 'contents: read']) {
      expect(readme).toContain(permission)
    }
    for (const key of [
      'ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NPM_CONFIG_PROXY',
      'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS',
      'OPENSSL_CONF', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'TAR_OPTIONS'
    ]) {
      expect(readme).toMatch(new RegExp(`^    ${key}: ''$`, 'm'))
    }
    expect(readme).toMatch(/node24` starts before the action can scrub its environment/)
  })
})
