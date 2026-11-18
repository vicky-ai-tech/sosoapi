import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { InputError, privateDirectory } from './intent.mjs'

const exec = promisify(execFile)
const skill = fileURLToPath(new URL('../', import.meta.url))
let loading

function installed(directory, version) {
  const require = createRequire(path.join(directory, 'package.json'))
  try {
    const pkg = require('playwright-core/package.json')
    return pkg.version === version ? require('playwright-core') : null
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    return null
  }
}

async function provision() {
  const lock = await readFile(path.join(skill, 'package-lock.json'))
  const version = JSON.parse(lock).packages['node_modules/playwright-core'].version
  const local = installed(skill, version)
  if (local) return local
  const state = await privateDirectory()
  const directory = path.join(
    state,
    'driver-' + createHash('sha256').update(lock).digest('hex').slice(0, 16),
  )
  async function cached() {
    const entry = await lstat(directory).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (!entry) return null
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new InputError('Invalid private browser driver directory.')
    return installed(directory, version)
  }
  const existing = await cached()
  if (existing) return existing
  const temporary = await mkdtemp(path.join(state, 'driver-install-'))
  try {
    for (const name of ['package.json', 'package-lock.json'])
      await copyFile(path.join(skill, name), path.join(temporary, name))
    const windows = process.platform === 'win32'
    const npmArgs = windows
      ? [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
      : []
    await exec(
      windows ? process.execPath : 'npm',
      [...npmArgs, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      {
        cwd: temporary,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    )
    await rename(temporary, directory).catch((error) => {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
    })
    const driver = await cached()
    if (!driver) throw new Error('Driver unavailable after installation')
    return driver
  } catch {
    throw new InputError(
      'The pinned browser driver could not be installed. Check npm and network access, then run the same command again.',
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export function ensureBrowserRuntime() {
  loading ??= provision().catch((error) => {
    loading = undefined
    throw error
  })
  return loading
}
