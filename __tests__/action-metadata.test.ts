import {readFile} from 'node:fs/promises'
import {describe, expect, it} from 'vitest'
import path from 'node:path'

const prelaunchKeys = [
  'ALL_PROXY', 'all_proxy', 'FTP_PROXY', 'ftp_proxy', 'HTTP_PROXY', 'http_proxy',
  'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'GLOBAL_AGENT_HTTP_PROXY',
  'NPM_CONFIG_HTTPS_PROXY', 'NPM_CONFIG_PROXY', 'npm_config_https_proxy', 'npm_config_proxy',
  'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY',
  'NODE_USE_SYSTEM_CA', 'NODE_OPTIONS', 'NODE_PATH', 'OPENSSL_CONF', 'OPENSSL_MODULES',
  'SSLKEYLOGFILE', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'BASH_ENV', 'ENV', 'TAR_OPTIONS'
]

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
    expect(metadata).not.toMatch(/^  (cache-generation|toolchain|working-directory|server-url|server-mode):$/m)
  })

  it('documents native reader permissions and prelaunch environment boundaries', async () => {
    const readme = await readFile(path.join(process.cwd(), 'README.md'), 'utf8')
    for (const permission of ['actions: read', 'attestations: read', 'contents: read']) {
      expect(readme).toContain(permission)
    }
    for (const key of prelaunchKeys) {
      expect(readme).toMatch(new RegExp(`^      ${key}: ''$`, 'm'))
    }
    expect(readme).toMatch(/node24` before any action code can inspect or scrub its\s+environment/)
    expect(readme).toMatch(/Every actual `uses:` invocation must include the step-level startup environment/)
    expect(readme).toMatch(/default `snapshot-read-token` is `\$\{\{ github\.token \}\}`/)
    expect(readme).toMatch(/Native snapshot support is reader-only/)
    expect(readme).toMatch(/hosted transport/i)
  })

  it('keeps every owned CI action call within the native input contract and prelaunch scrub', async () => {
    const workflow = await readFile(path.join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')
    const actionSteps = workflow
      .split(/^      - /m)
      .filter(step => /^        uses: \.\/$/m.test(step))

    expect(actionSteps).toHaveLength(6)
    for (const step of actionSteps) {
      for (const key of prelaunchKeys) {
        expect(step).toMatch(new RegExp(`^          ${key}: ''$`, 'm'))
      }
      const inputs = step.match(/^        with:\n((?:^          [^\n]*\n)+)/m)?.[1] || ''
      expect(inputs).not.toMatch(/^          (github-cache-mode|cache-generation|cache-key|restore-keys|toolchain|working-directory|server-url|server-mode):/m)
    }
    expect(workflow).not.toMatch(/github-cache-mode|cache-primary-key|cache-save-eligible|cache-save-reason|cache-generation|restore-keys|server-url|server-mode|toolchain:/)
    expect(workflow).toMatch(/^          backend: local$/m)
    expect(workflow).toMatch(/^          backend: remote$/m)
    expect(workflow).toMatch(/^          snapshot-selection: latest-compatible$/m)
    expect(workflow).toMatch(/^          snapshot-read-token: ''$/m)
    expect(workflow).toMatch(/^        run: mbx build --locked --manifest-path \.github\/e2e\/fixture\/Cargo\.toml$/m)
    expect(workflow).not.toMatch(/^        run: cargo build --locked$/m)
    expect(workflow).toMatch(/\.github\/e2e\/fixture\/target\/debug\/\.fingerprint/)
  })
})
