import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { createServer } from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export class InputError extends Error {}

export const platforms = Object.freeze({
  facebook: 'https://www.facebook.com/',
  instagram: 'https://www.instagram.com/',
  threads: 'https://www.threads.com/',
})
export function requirePlatform(value) {
  if (!Object.hasOwn(platforms, value))
    throw new InputError('Choose facebook, instagram or threads.')
  return value
}
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const normalized = (text) =>
  text
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim()
export const accountKey = (text) => normalized(text).replace(/^@/, '').toLowerCase()
export async function privateDirectory() {
  const directory = path.resolve(
    process.env.META_POST_STATE_HOME || path.join(homedir(), '.local', 'state'),
    'meta-browser-post',
  )
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (
    (await lstat(directory)).isSymbolicLink() ||
    spawnSync('git', ['-C', directory, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
    }).stdout?.trim() === 'true'
  ) {
    throw new InputError('Choose a private state directory outside a Git checkout.')
  }
  await chmod(directory, 0o700)
  return directory
}
export async function readPhoto(filename) {
  const resolved = await realpath(filename)
  const info = await stat(resolved)
  if (!info.isFile() || info.size === 0 || info.size > 32 * 1024 * 1024)
    throw new InputError('Choose a JPEG or PNG up to 32 MiB for this browser helper.')
  const buffer = await readFile(resolved)
  const mime = buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    ? 'image/png'
    : buffer.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
      ? 'image/jpeg'
      : null
  if (!mime) throw new InputError('Choose the approved JPEG or PNG file.')
  return { path: resolved, sha256: sha256(buffer), mime, buffer }
}
export async function createIntent(directory, platform, { account, text, image, key }) {
  requirePlatform(platform)
  if (!account?.trim() || !key?.trim() || (!text?.trim() && !image))
    throw new InputError('Supply --account, a unique --key and --text or --image.')
  if (platform === 'instagram' && !image)
    throw new InputError('An Instagram feed post requires --image.')
  const photo = image ? await readPhoto(image) : null
  const id = sha256(key).slice(0, 32)
  const input = {
    platform,
    account: account.trim(),
    text: text || '',
    photo: photo && { path: photo.path, sha256: photo.sha256, mime: photo.mime },
  }
  const next = { id, input, state: 'preview', created: new Date().toISOString() }
  // The hard link publishes a fully written record atomically, even if two agents preview together.
  const temp = path.join(directory, randomUUID() + '.tmp')
  const file = await open(temp, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(next))
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    await link(temp, intentPath(directory, id))
    return next
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const prior = await loadIntent(directory, id)
    if (JSON.stringify(prior.input) !== JSON.stringify(input))
      throw new InputError(
        'This key already identifies different content or a different destination. Choose a new key for a new post.',
      )
    return prior
  } finally {
    await unlink(temp)
  }
}
function intentPath(directory, id) {
  if (!/^[a-f0-9]{32}$/.test(id || ''))
    throw new InputError('Supply the intent ID returned by preview.')
  return path.join(directory, id + '.json')
}
export const loadIntent = async (dir, id) => JSON.parse(await readFile(intentPath(dir, id), 'utf8'))
export async function saveIntent(directory, intent) {
  const dest = intentPath(directory, intent.id),
    temp = dest + '.' + randomUUID() + '.tmp'
  const file = await open(temp, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(intent))
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temp, dest)
}
// The OS releases this loopback-only lock on process exit, including SIGKILL. An
// occupied address fails closed. The durable pending record owns submit-once semantics.
export async function exclusive(directory, id, fn) {
  const name = sha256(directory + '\0' + id)
  const localPort = 30000 + (Number.parseInt(name.slice(0, 8), 16) % 32000)
  const server = createServer((socket) => socket.destroy())
  await new Promise((resolve, reject) => {
    server.once('error', () =>
      reject(
        new InputError(
          'Local operation lock is busy. Inspect status and retry after the active operation finishes.',
        ),
      ),
    )
    server.listen(localPort, '127.0.0.1', resolve)
  })
  try {
    return await fn()
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}
