import {createHash} from 'node:crypto'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {chmod, mkdtemp, realpath, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {preinstalledInputs, verifyPreinstalledMbxFile, verifiedPreinstalledMbx} from '../src/preinstalled.js'

const digest = createHash('sha256').update('fixture').digest('hex')
const directories: string[] = []
async function executable(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mbx-action-test-'))
  directories.push(directory)
  const bin = path.join(directory, process.platform === 'win32' ? 'mbx.exe' : 'mbx')
  await writeFile(bin, 'fixture')
  await chmod(bin, 0o755)
  return bin
}
async function verify(bin: string, capture: (command: string, args: string[]) => Promise<string> = vi.fn().mockResolvedValue('mbx 1.12.0')) {
  return verifiedPreinstalledMbx(bin, '1.12.0', digest, capture, path.dirname(bin))
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})))
})

describe('strict preinstalled executable', () => {
  it('requires both explicit inputs and excludes release installation', () => {
    expect(preinstalledInputs('', '', '')).toBe(false)
    expect(() => preinstalledInputs('/mbx', '', '')).toThrow(/together/)
    expect(() => preinstalledInputs('', '1.12.0', '')).toThrow(/together/)
    expect(() => preinstalledInputs('/mbx', '1.12.0', '')).toThrow(/together/)
    expect(() => preinstalledInputs('', '', '', digest)).toThrow(/together/)
    expect(() => preinstalledInputs('/mbx', '1.12.0', '', 'bad')).toThrow(/64 lowercase/)
    expect(() => preinstalledInputs('/mbx', '1.12.0', 'latest', digest)).toThrow(/cannot be combined/)
    expect(() => preinstalledInputs('mbx', '1.12.0', '', digest)).toThrow(/absolute/)
    for (const version of ['latest', 'v1.12.0', '1.12', '01.12.0']) {
      expect(() => preinstalledInputs('/mbx', version, '', digest)).toThrow(/exact/)
    }
  })

  it('uses only the selected executable and accepts the exact banner', async () => {
    const bin = await executable()
    const capture = vi.fn().mockResolvedValue('mbx 1.12.0')
    const selected = await verify(bin, capture)
    expect(selected.version).toBe('1.12.0')
    expect(selected.bin).not.toBe(bin)
    expect(selected.bin).toContain(`${path.sep}mbx-verified-`)
    expect(await realpath(selected.bin)).toBe(selected.bin)
    expect(await import('node:fs/promises').then(fs => fs.readFile(selected.bin, 'utf8'))).toBe('fixture')
    expect(capture.mock.calls).toEqual([[selected.bin, ['--version']]])
  })

  it.each(['mbx 1.12.1', 'other 1.12.0', 'mbx 1.12.0\nmbx 1.12.0', 'mbx 1.12.0 extra'])('rejects %s', async banner => {
    const bin = await executable()
    await expect(verify(bin, vi.fn().mockResolvedValue(banner))).rejects.toThrow(/expected/)
  })

  it('fails before execution when the path is missing or a directory', async () => {
    const bin = await executable()
    const capture = vi.fn()
    await expect(verify(`${bin}-absent`, capture)).rejects.toThrow()
    await expect(verify(path.dirname(bin), capture)).rejects.toThrow(/regular file/)
    expect(capture).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')('rejects non-executable files before execution', async () => {
    const bin = await executable()
    await chmod(bin, 0o644)
    const capture = vi.fn()
    await expect(verify(bin, capture)).rejects.toThrow()
    expect(capture).not.toHaveBeenCalled()
  })

  it('propagates execution failure without fallback', async () => {
    const bin = await executable()
    await expect(verify(bin, vi.fn().mockRejectedValue(new Error('exit 1')))).rejects.toThrow(/exit 1/)
  })
  it('rejects a wrong caller hash before invoking the matching-banner executable', async () => {
    const bin = await executable()
    const capture = vi.fn().mockResolvedValue('mbx 1.12.0')
    await expect(verifiedPreinstalledMbx(bin, '1.12.0', 'a'.repeat(64), capture, path.dirname(bin))).rejects.toThrow(/SHA-256/)
    expect(capture).not.toHaveBeenCalled()
  })
  it('accepts an exact source build identity banner with matching bytes', async () => {
    const bin = await executable()
    const version = '1.13.0-velnor.abcdef+source.123'
    const selected = await verifiedPreinstalledMbx(bin, version, digest, vi.fn().mockResolvedValue(`mbx ${version}`), path.dirname(bin))
    expect(selected.version).toBe(version)
    expect(selected.bin).not.toBe(bin)
  })

  it('resolves supported MISE-style symlinks and executes a concrete private copy', async () => {
    const bin = await executable()
    const alias = path.join(path.dirname(bin), 'mise-bin')
    await symlink(bin, alias)
    const capture = vi.fn().mockResolvedValue('mbx 1.12.0')
    const selected = await verify(alias, capture)
    expect(selected.bin).not.toBe(alias)
    expect(capture).toHaveBeenCalledWith(selected.bin, ['--version'])
    await expect(verifyPreinstalledMbxFile(selected.bin, digest)).resolves.toBeUndefined()
  })

  it('resolves symlink ancestors before selecting the concrete executable', async () => {
    const bin = await executable()
    const aliasDirectory = path.join(path.dirname(bin), 'mise-shims')
    await symlink(path.dirname(bin), aliasDirectory)
    const alias = path.join(aliasDirectory, path.basename(bin))
    const selected = await verify(alias)
    expect(selected.bin).not.toContain(`${path.sep}mise-shims${path.sep}`)
    await expect(verifyPreinstalledMbxFile(selected.bin, digest)).resolves.toBeUndefined()
  })

  it('keeps the selected bytes when the caller symlink retargets during version execution', async () => {
    const bin = await executable()
    const replacement = await executable()
    const alias = path.join(path.dirname(bin), 'mise-bin')
    await symlink(bin, alias)
    const capture = vi.fn(async (command: string) => {
      await rm(alias)
      await symlink(replacement, alias)
      expect(command).not.toBe(alias)
      return 'mbx 1.12.0'
    })
    const selected = await verify(alias, capture)
    const fs = await import('node:fs/promises')
    expect(await fs.readFile(selected.bin, 'utf8')).toBe('fixture')
    expect(await fs.readFile(await realpath(alias), 'utf8')).toBe('fixture')
  })

  it('keeps the selected bytes when the caller file is replaced during version execution', async () => {
    const bin = await executable()
    const capture = vi.fn(async (command: string) => {
      await chmod(bin, 0o700)
      await writeFile(bin, 'replacement')
      expect(command).not.toBe(bin)
      return 'mbx 1.12.0'
    })
    const selected = await verify(bin, capture)
    const fs = await import('node:fs/promises')
    expect(await fs.readFile(selected.bin, 'utf8')).toBe('fixture')
    await expect(verifyPreinstalledMbxFile(await realpath(bin), digest)).rejects.toThrow(/SHA-256/)
    await expect(verifyPreinstalledMbxFile(selected.bin, digest)).resolves.toBeUndefined()
  })

  it('rejects a staged copy changed by its version process and removes its private directory', async () => {
    const bin = await executable()
    let staged = ''
    const capture = vi.fn(async (command: string) => {
      staged = command
      await chmod(command, 0o700)
      await writeFile(command, 'mutated')
      return 'mbx 1.12.0'
    })
    await expect(verify(bin, capture)).rejects.toThrow(/SHA-256/)
    await expect(realpath(path.dirname(staged))).rejects.toThrow()
  })

  it('resolves a RUNNER_TEMP symlink but stages below its canonical private root', async () => {
    const bin = await executable()
    const aliasRoot = path.join(path.dirname(bin), 'runner-temp-alias')
    await symlink(path.dirname(bin), aliasRoot)
    const selected = await verifiedPreinstalledMbx(
      bin,
      '1.12.0',
      digest,
      vi.fn().mockResolvedValue('mbx 1.12.0'),
      aliasRoot
    )
    expect(selected.bin).not.toContain(`${path.sep}runner-temp-alias${path.sep}`)
    await expect(verifyPreinstalledMbxFile(selected.bin, digest)).resolves.toBeUndefined()
  })
})
