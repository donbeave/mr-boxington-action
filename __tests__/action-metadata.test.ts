import {readFile} from 'node:fs/promises'
import {expect, it} from 'vitest'

it('restricts cache publication and declares the source-bound comparison inputs', async () => {
  const [metadata, packageManifest] = await Promise.all([
    readFile('action.yml', 'utf8'),
    readFile('package.json', 'utf8')
  ])
  expect(JSON.parse(packageManifest)).toMatchObject({name: 'mr-boxington-action', version: '1.7.0'})
  expect(metadata).toMatch(/^  post-if: success\(\)$/m)
  for (const input of ['save-on-workflow-dispatch', 'save-on-pull-request', 'save-on-protected-branch']) {
    expect(metadata).not.toMatch(new RegExp(`^  ${input}:`, 'm'))
  }
  for (const input of ['mbx-path', 'expected-version', 'expected-binary-sha256', 'comparison-state']) {
    expect(metadata).toMatch(new RegExp(`^  ${input}:`, 'm'))
  }
})
