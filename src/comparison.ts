import path from 'node:path'
import {access, lstat, realpath} from 'node:fs/promises'
import {constants} from 'node:fs'

/** Require a fresh regular owner-state path contained by this run's private temp root. */
export async function prepareComparisonPath(file: string, runnerTemp: string): Promise<void> {
  if (!file || !path.isAbsolute(file)) throw new Error('comparison-state must be an absolute path')
  if (!runnerTemp || !path.isAbsolute(runnerTemp)) {
    throw new Error('comparison-state requires an absolute RUNNER_TEMP')
  }
  const root = await realpath(runnerTemp)
  const parent = await realpath(path.dirname(file))
  const relative = path.relative(root, parent)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('comparison-state must stay inside RUNNER_TEMP')
  }
  await access(parent, constants.W_OK)
  try {
    await lstat(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error('comparison-state must be a fresh path; preexisting files and symlinks are forbidden')
}

export async function requireComparisonFile(file: string): Promise<void> {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('comparison-state must be a regular file, never a symlink')
  }
}
