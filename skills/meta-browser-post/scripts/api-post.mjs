import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { constants, existsSync } from 'node:fs'
import { copyFile, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createInterface } from 'node:readline'

const version = 'sosoapi@0.5.25'
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const providers = ['threads', 'facebook', 'instagram', 'x', 'youtube']
const needs = (next) => ({ state: 'needs_input', safeToRetry: true, next })
const pending = 'Check the original Scheduled Post. Do not submit it again.'
const normalize = (v) => (typeof v === 'string' ? v.trim().replace(/^@/, '').toLowerCase() : '')
const sha = (v) => createHash('sha256').update(v).digest('hex')

function executable() {
  if (process.env.SOSOAPI_SKILL_CLI) return [process.env.SOSOAPI_SKILL_CLI, []]
  if (process.platform === 'win32') {
    const npx = join(dirname(process.execPath), 'node_modules/npm/bin/npx-cli.js')
    if (!existsSync(npx)) throw new Error('Cannot locate npm.')
    return [process.execPath, [npx, '--yes', version]]
  }
  return ['npx', ['--yes', version]]
}

// Spawn without a shell. Generic post bodies and scoped route input use stdin.
function runCli(command, prefix, args, body) {
  return new Promise((resolveResult) => {
    const child = execFile(
      command,
      [...prefix, ...args],
      {
        timeout: 125_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        let value
        try {
          value = JSON.parse(stdout)
        } catch {
          /* output may end after an accepted write */
        }
        let accepted
        for (const line of stderr.split('\n')) {
          try {
            const record = JSON.parse(line)
            if (record.accepted_post) accepted = record.accepted_post
          } catch {
            /* ordinary CLI output */
          }
        }
        resolveResult({
          value,
          accepted,
          login: /Not logged in\. Run: sosoapi auth login/i.test(stderr),
          code: error?.code ?? 0,
        })
      },
    )
    child.stdin.on('error', () => {})
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

// The published CLI exposes its verified local-file uploader over MCP stdio.
// Use the same binary and its upload, auth and asset-registration checks.
async function uploadWithCli(command, prefix, args) {
  const child = spawn(command, prefix, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  child.stdin.on('error', () => {})
  const timer = setTimeout(() => {
    child.stdin.end()
    child.kill()
  }, 180_000)
  const input = createInterface({ input: child.stdout })
  const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  try {
    await once(child, 'spawn')
    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'social-post-skill', version: '1' },
      },
    })
    for await (const line of input) {
      if (line.length > 1024 * 1024) break
      const msg = JSON.parse(line)
      if (msg.error) break
      if (msg.id === 1 && msg.result?.capabilities?.tools) {
        send({ method: 'notifications/initialized' })
        send({
          id: 2,
          method: 'tools/call',
          params: { name: 'sosoapi_upload_asset', arguments: args },
        })
      }
      if (msg.id === 2) {
        if (!msg.result?.isError) return msg.result?.structuredContent?.asset
        break
      }
    }
    throw new Error('Upload could not be confirmed.')
  } finally {
    clearTimeout(timer)
    input.close()
    child.stdin.end()
    child.kill()
  }
}

// A private snapshot ensures that even a concurrent file edit cannot upload different
// bytes. Check the original file against the official uploader's local scope before
// staging it, so moving the snapshot to the temp folder cannot widen access.
async function uploadSource(file) {
  if (process.platform === 'win32' && /^[\\/]{2}/.test(file))
    throw new Error('Choose a local file.')
  const home = await realpath(homedir())
  const canonical = await realpath(resolve(file))
  const roots = [
    process.cwd(),
    tmpdir(),
    ...['Pictures', 'Videos', 'Movies'].map((p) => join(home, p)),
  ]
  if (process.platform !== 'win32') roots.push('/tmp')
  for (const extra of (process.env.SOSOAPI_UPLOAD_ROOTS || '').split(delimiter).filter(Boolean))
    roots.push(extra.startsWith('~/') ? join(home, extra.slice(2)) : extra)
  const inside = (rel) => !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)
  for (const root of roots) {
    if (process.platform === 'win32' && /^[\\/]{2}/.test(root)) continue
    const actual = await realpath(root).catch(() => null)
    if (!actual || inside(relative(actual, home))) continue
    const path = relative(actual, canonical)
    if (inside(path) && path.split(sep).every((part) => !part.startsWith('.'))) return canonical
  }
  throw new Error('Choose a file inside an allowed SosoAPI upload folder.')
}

const requestDigest = (target, request) =>
  sha(
    JSON.stringify([
      target.platform,
      target.account,
      request.workspace || '',
      request.key,
      request.text || '',
      request.image ? resolve(request.image) : '',
      request.video ? resolve(request.video) : '',
      request.title || '',
      request.privacy || '',
      request.audience || '',
    ]),
  )

async function digestFile(file) {
  const fd = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const stat = await fd.stat()
    if (!stat.isFile() || !stat.size || stat.size > 500 * 1024 * 1024)
      throw new Error('Invalid media.')
    const hash = createHash('sha256')
    for await (const chunk of fd.createReadStream({ autoClose: false })) hash.update(chunk)
    return hash.digest('hex')
  } finally {
    await fd.close()
  }
}

function format(platform, request) {
  const file = request.image || request.video
  if (
    !providers.includes(platform) ||
    (request.image && request.video) ||
    (!file && !request.text?.trim())
  )
    return needs('Choose a supported platform and provide text or one image/video.')
  if (platform === 'instagram' && !file) return needs('Supply an Instagram feed image or video.')
  if (
    platform === 'youtube' &&
    (!request.video ||
      !request.title?.trim() ||
      request.title.length > 100 ||
      (request.audience !== undefined && !['kids', 'not-kids'].includes(request.audience)) ||
      !['public', 'private', 'unlisted'].includes(request.privacy))
  )
    return needs(
      'Supply a YouTube video, its approved title (1–100 characters), and public, private or unlisted visibility.',
    )
  if (
    file &&
    ((!['.jpg', '.jpeg', '.png'].includes(extname(file).toLowerCase()) && request.image) ||
      (request.video && extname(file).toLowerCase() !== '.mp4'))
  )
    return needs('Supply a local JPEG/PNG image or MP4 video.')
  const post_type = request.image ? 'IMAGE' : request.video ? 'VIDEO' : 'TEXT'
  const options = { post_type }
  const capabilities = [`can_publish_${post_type.toLowerCase()}`]
  if (platform === 'youtube') {
    Object.assign(options, {
      title: request.title,
      description: request.text || '',
      privacy_status: request.privacy,
      ...(request.audience && { self_declared_made_for_kids: request.audience === 'kids' }),
      cancellation_mode: 'UNSCHEDULE_KEEP_PRIVATE',
    })
    capabilities.splice(
      0,
      1,
      'can_upload_video',
      'can_set_title',
      'can_set_description',
      'can_set_privacy_status',
    )
  }
  return { file, options, capabilities }
}

const hosts = {
  threads: ['threads.com', 'threads.net'],
  facebook: ['facebook.com', 'fb.watch'],
  instagram: ['instagram.com'],
  youtube: ['youtube.com', 'youtu.be'],
  x: ['x.com', 'twitter.com'],
}
function permalink(platform, value) {
  try {
    const url = new URL(value)
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      hosts[platform]?.includes(url.hostname.replace(/^www\./, ''))
    )
      return url.href
  } catch {
    /* confirmed posts can lack a verified permalink */
  }
}

function postReceipt(reply, coord, expectedId) {
  const matches = (post) =>
    post &&
    uuid.test(post.id) &&
    (!expectedId || expectedId === post.id) &&
    post.workspace_id === coord.workspaceId &&
    post.social_account_id === coord.accountId &&
    post.platform === coord.platform
  const post = matches(reply.value?.post) ? reply.value.post : undefined
  const id = post?.id || (matches(reply.accepted) ? reply.accepted.id : expectedId)
  const result = {
    workspaceId: coord.workspaceId,
    accountId: coord.accountId,
    platform: coord.platform,
    ...(id && { id }),
  }
  if (
    post &&
    reply.value.state === 'published' &&
    reply.value.complete === true &&
    reply.value.publication_confirmed === true
  ) {
    const url = permalink(coord.platform, reply.value.provider?.permalink)
    return { ...result, state: 'published', ...(url && { url }) }
  }
  if ((post && reply.value.state === 'stopped') || (!id && reply.value?.state === 'rejected'))
    return {
      ...result,
      state: 'failed',
      next: 'The official CLI rejected or stopped this post. Review the account and content.',
    }
  return { ...result, state: 'pending', next: pending }
}

export function createApiAdapter(options = {}) {
  const [command, prefix] = options.command ? [options.command, options.args || []] : executable()
  const call = (args, body) => runCli(command, prefix, args, body)
  const assets = new Map()
  const discovery = new Map()
  async function list(route, input, field) {
    const key = JSON.stringify([route, input])
    const recent = discovery.get(key)
    if (recent && recent.until > Date.now()) return recent
    const { value, login } = await call(['api', 'post', route], input)
    if (login)
      return needs(
        'Sign in using npx --yes sosoapi@0.5.25 auth login, then select the intended workspace.',
      )
    if (value?.http_status !== 200 || !Array.isArray(value.body?.[field]))
      return needs('Check API access and the current workspace grant.')
    const result = { rows: value.body[field], until: Date.now() + 10_000 }
    discovery.set(key, result)
    return result
  }
  async function preview(target, request) {
    const { platform, account } = target
    const spec = format(platform, request)
    if (spec.state) return spec
    if (!normalize(account))
      return needs('Supply the exact account handle, Page name, or account ID.')
    const listing = await list('/identity-api/workspace/list', {}, 'workspaces')
    if (listing?.state) return listing
    const workspaces = listing.rows.filter(
      (row) =>
        !request.workspace ||
        [row.id, row.name, row.slug].some(
          (field) => normalize(field) === normalize(request.workspace),
        ),
    )
    if (workspaces.length !== 1 || !uuid.test(workspaces[0].id)) {
      return {
        ...needs('Select one accessible SosoAPI workspace by exact name, slug, or ID.'),
        choices: listing.rows.slice(0, 12).map(({ id, name }) => ({ id, name })),
      }
    }
    const workspace = workspaces[0]
    if (!['owner', 'editor'].includes(workspace.role))
      return needs('This workspace requires an editor or owner for publishing.')
    const listing2 = await list(
      '/identity-api/user/social-accounts/list',
      { workspace_id: workspace.id },
      'accounts',
    )
    if (listing2?.state) return listing2
    const accounts = listing2.rows.filter(
      (row) =>
        row.platform === platform &&
        (!row.workspace_id || row.workspace_id === workspace.id) &&
        [row.id, row.handle].some((field) => normalize(field) === normalize(account)),
    )
    if (accounts?.length !== 1 || !uuid.test(accounts[0].id))
      return needs(
        'Select one connected account with this exact handle, name, or ID in the chosen workspace.',
      )
    const row = accounts[0]
    const has = (cap) =>
      row.capability_facts?.some(
        (f) =>
          f.capability === cap &&
          f.availability === 'available' &&
          f.observed_allowed === true &&
          Date.parse(f.valid_until) > Date.now(),
      )
    if (
      !['valid', 'expiring_soon'].includes(row.status) ||
      row.health_state !== 'ready' ||
      Date.parse(row.blocked_until) > Date.now() ||
      !spec.capabilities.every(has)
    )
      return needs('Verify the connection and exact publishing capability for this account.')
    const ready = {
      state: 'ready',
      requestDigest: requestDigest(target, request),
      workspaceId: workspace.id,
      accountId: row.id,
      account,
      platform,
    }
    if (platform === 'threads' && spec.options.post_type === 'TEXT' && has('can_auto_publish_text'))
      ready.autoText = true
    if (spec.file) {
      try {
        ready.mediaSha256 = await digestFile(await uploadSource(spec.file))
      } catch {
        return needs('Choose a local file up to 500 MiB inside an allowed SosoAPI upload folder.')
      }
    }
    return ready
  }

  async function registeredMedia(file, request, ready) {
    const source = await uploadSource(file)
    const digest = await digestFile(source)
    if (digest !== ready.mediaSha256) throw new Error('Media changed since preview.')
    const key = sha(JSON.stringify(['asset', ready.workspaceId, digest]))
    if (assets.has(key)) return assets.get(key)
    const dir = await mkdtemp(join(tmpdir(), 'sosoapi-upload-'))
    try {
      const snapshot = join(dir, basename(source))
      await copyFile(source, snapshot, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
      if ((await digestFile(snapshot)) !== digest)
        throw new Error('Media changed during preparation.')
      const asset = await uploadWithCli(command, prefix, {
        workspace_id: ready.workspaceId,
        file_path: snapshot,
        idempotency_key: key,
      })
      const type = request.image ? 'image' : 'video'
      if (
        !asset ||
        asset.workspace_id !== ready.workspaceId ||
        asset.asset_type !== type ||
        !Number.isSafeInteger(Number(asset.id)) ||
        Number(asset.id) < 1 ||
        !asset.asset_url ||
        asset.metadata?.content_sha256 !== digest
      )
        throw new Error('Unverified asset.')
      const media = [{ asset_id: Number(asset.id), kind: type, url: asset.asset_url }]
      assets.set(key, media)
      return media
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async function publish(target, request, ready) {
    const spec = format(target.platform, request)
    if (spec.state) return spec
    if (
      ready?.state !== 'ready' ||
      ready.platform !== target.platform ||
      ready.account !== target.account ||
      ready.requestDigest !== requestDigest(target, request) ||
      !uuid.test(ready.workspaceId) ||
      !uuid.test(ready.accountId) ||
      !request.key
    )
      return needs('Preview this exact destination first.')
    let media = []
    if (spec.file) {
      try {
        media = await registeredMedia(spec.file, request, ready)
      } catch {
        return needs(
          'The approved media could not be verified and registered. Check the file and upload access, then preview again.',
        )
      }
    }
    const args = ['posts', 'publish']
    let body
    if (target.platform === 'threads' && !spec.file && ready.autoText) {
      args.push(
        '--workspace',
        ready.workspaceId,
        '--account',
        ready.accountId,
        '--text',
        request.text,
        '--key',
        request.key,
      )
    } else {
      body = {
        workspace_id: ready.workspaceId,
        social_account_id: ready.accountId,
        caption: request.text || '',
        media,
        provider_payload: { platform: target.platform, publish_options: spec.options },
        idempotency_key: request.key,
      }
    }
    const result = await call(args, body)
    if (result.login && !result.accepted && !result.value)
      return needs('Sign in to SosoAPI and preview this destination again.')
    return postReceipt(result, ready)
  }
  async function status(target, _request, receipt) {
    const coord = { ...receipt?.ready, ...receipt }
    if (
      !receipt?.id ||
      !uuid.test(receipt.id) ||
      !uuid.test(coord.workspaceId) ||
      !uuid.test(coord.accountId) ||
      target.platform !== coord.platform
    )
      return { state: 'pending', next: pending }
    return postReceipt(
      await call(['posts', 'status', '--id', receipt.id, '--wait-seconds', '5']),
      coord,
      receipt.id,
    )
  }
  return { preview, publish, status }
}
