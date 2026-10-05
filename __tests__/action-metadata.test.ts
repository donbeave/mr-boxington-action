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
    expect(metadata).toMatch(/^  actions-read-token:$/m)
  })
})
