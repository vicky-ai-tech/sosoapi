import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  InputError,
  accountKey,
  exclusive,
  loadIntent,
  privateDirectory,
  saveIntent,
  sha256,
} from './intent.mjs'

const idFor = (...parts) => sha256(JSON.stringify(parts)).slice(0, 32)
const preferenceId = idFor('route preference')
const needsRoute = {
  state: 'needs_route',
  next: 'Choose --via browser (native website) or --via api (SosoAPI account). Your first choice is remembered.',
}
const need = (next) => ({ state: 'needs_input', next })

export function checkRoute(via) {
  if (via !== undefined && via !== 'api' && via !== 'browser') {
    throw new InputError('Choose browser or api for --via.')
  }
}
async function directory() {
  const dir = path.join(await privateDirectory(), 'batches')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const info = await lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new InputError('Invalid batch state directory.')
  return dir
}
async function readRecord(dir, id) {
  try {
    return await loadIntent(dir, id)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
async function preference(dir, via, replace) {
  return exclusive(dir, preferenceId, async () => {
    const current = await readRecord(dir, preferenceId)
    if (via && (!current || replace)) {
      await saveIntent(dir, { id: preferenceId, via })
      return via
    }
    return current?.via
  })
}
export async function chooseRoute(via) {
  checkRoute(via)
  const selected = await preference(await directory(), via, true)
  return selected ? { state: 'ready', via: selected } : needsRoute
}

export function parseTargets(values) {
  const seen = new Set()
  return values
    .map((value) => {
      const equals = value.indexOf('=')
      const platform = value.slice(0, equals)
      const account = value.slice(equals + 1).trim()
      if (
        equals < 0 ||
        !['facebook', 'instagram', 'threads', 'x', 'youtube'].includes(platform) ||
        !accountKey(account)
      ) {
        throw new InputError('Use --to platform=ACCOUNT for each destination.')
      }
      const key = JSON.stringify([platform, accountKey(account)])
      if (seen.has(key)) throw new InputError('Supply each destination only once.')
      seen.add(key)
      return { platform, account }
    })
    .sort((a, b) => a.platform.localeCompare(b.platform) || a.account.localeCompare(b.account))
}
async function mediaHash(file) {
  if (!file) return null
  if (!(await stat(file)).isFile()) throw new InputError('Media must be a regular local file.')
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(file)) digest.update(bytes)
  return digest.digest('hex')
}
function checkInput(batch, input, targets) {
  if (
    input?.workspace &&
    !batch.input.workspace &&
    batch.via === 'api' &&
    batch.items.every((item) => !item.attempted && !item.ready)
  ) {
    // A workspace choice may complete an unresolved preview before any target
    // has been verified or attempted; it cannot retarget an established intent.
    batch.input = { ...batch.input, workspace: input.workspace }
  }
  if (
    input &&
    [...new Set([...Object.keys(input), ...Object.keys(batch.input)])].some(
      (k) => input[k] !== batch.input[k],
    )
  ) {
    throw new InputError(
      'This key already belongs to different content. Keep the original key for recovery.',
    )
  }
  if (
    targets &&
    JSON.stringify(targets) !== JSON.stringify(batch.items.map((item) => item.target))
  ) {
    throw new InputError('This key already belongs to different destinations.')
  }
}
function requestFor(batch, target) {
  const key = idFor(
    'social-post destination',
    batch.key,
    target.platform,
    accountKey(target.account),
  )
  const request = { ...batch.input, key }
  if (target.platform !== 'youtube') {
    delete request.title
    delete request.privacy
    delete request.audience
  }
  return request
}
function publicReceipt(batch, command) {
  const results = batch.items.map(({ target, receipt }) => {
    const { state, url, id, next, choices } = receipt
    return {
      ...target,
      state,
      ...(state === 'published' && url ? { url } : {}),
      ...(id ? { id } : {}),
      ...(next ? { next } : {}),
      ...(choices ? { choices } : {}),
    }
  })
  const states = new Set(results.map((r) => r.state))
  // A rejected preflight may leave some destinations ready; none have been sent.
  const hasOutcome = ['published', 'pending', 'failed'].some((s) => states.has(s))
  const state = states.size === 1 ? results[0].state : hasOutcome ? 'partial' : 'needs_input'
  const receipt = { key: batch.key, via: batch.via, state, results }
  if (command === 'preview') {
    receipt.content = { text: batch.input.text }
    for (const field of ['image', 'video'])
      if (batch.input[field]) receipt.content[field] = path.basename(batch.input[field])
    for (const field of ['title', 'privacy', 'audience'])
      if (batch.input[field]) receipt.content[field] = batch.input[field]
    if (batch.mediaSha256) receipt.content.mediaSha256 = batch.mediaSha256
  }
  return receipt
}
function refreshNeeded(item) {
  return (
    item.attempted &&
    (item.receipt.state === 'pending' || (item.receipt.state === 'published' && !item.receipt.url))
  )
}
async function reconcile(batch, adapter, observation) {
  for (const item of batch.items.filter(refreshNeeded)) {
    const receipt = { ...item.ready, ...item.receipt }
    if (
      observation &&
      observation.platform === item.target.platform &&
      accountKey(observation.account) === accountKey(item.target.account)
    ) {
      receipt.observedUrl = observation.url
    }
    try {
      const result = await adapter.status(item.target, requestFor(batch, item.target), receipt)
      // A failed status lookup cannot turn an already confirmed post into a new write.
      if (item.receipt.state === 'published' && result.state !== 'published') continue
      if (result.state === 'needs_input' && result.safeToRetry !== true) {
        item.receipt = { ...item.receipt, next: result.next }
        continue
      }
      item.receipt = { ...item.receipt, ...result }
      if (!result.next) delete item.receipt.next
      if (result.safeToRetry === true && result.state === 'needs_input') item.attempted = false
    } catch {
      // Preserve the last authoritative outcome and the token for its read-only status.
    }
  }
}
async function preflight(batch, adapter) {
  const file = batch.input.image || batch.input.video
  if (file && (await mediaHash(file)) !== batch.mediaSha256) {
    throw new InputError(
      'The media changed since this batch was created. Review the new file with a new key.',
    )
  }
  const seen = new Set()
  for (const item of batch.items) {
    if (!item.attempted) {
      try {
        const ready = await adapter.preview(item.target, requestFor(batch, item.target))
        if (ready.state === 'ready') {
          const prior = item.ready
          if (
            (prior?.accountId && prior.accountId !== ready.accountId) ||
            (prior?.workspaceId && prior.workspaceId !== ready.workspaceId)
          ) {
            item.receipt = need(
              'The account now resolves to a different destination. Review that destination separately with a new key.',
            )
            continue
          }
          const hash = ready.mediaSha256 || ready.image?.sha256
          if (hash && hash !== batch.mediaSha256) {
            item.receipt = need('The selected file changed. Review the media with a new key.')
            continue
          }
          item.ready = ready
        } else if (ready.state === 'pending' || ready.state === 'published') {
          item.attempted = true
        }
        item.receipt = ready
      } catch (error) {
        item.receipt = need(
          error instanceof InputError
            ? error.message
            : 'Could not verify this destination. Resolve access and retry the same batch.',
        )
      }
    }
    if (item.ready?.accountId) {
      const resolved = JSON.stringify([
        item.target.platform,
        item.ready.workspaceId,
        item.ready.accountId,
      ])
      if (seen.has(resolved))
        throw new InputError(
          'Two destinations resolve to the same account. Review the target list.',
        )
      seen.add(resolved)
    }
  }
}
async function publishReady(batch, adapter, save) {
  for (const item of batch.items.filter((item) => !item.attempted)) {
    item.attempted = true
    item.receipt = {
      state: 'pending',
      next: 'Check this batch with status before another submission.',
    }
    if (batch.via === 'browser' && item.ready?.id) item.receipt.id = item.ready.id
    // Persist uncertainty before the external side effect. A stopped process can
    // resume later destinations while this one is reconciled through status.
    await save()
    try {
      const result = await adapter.publish(item.target, requestFor(batch, item.target), item.ready)
      if (result.state === 'needs_input' && result.safeToRetry !== true) {
        item.receipt = { ...item.receipt, next: result.next }
      } else {
        item.receipt = result
        if (result.safeToRetry === true && result.state === 'needs_input') item.attempted = false
      }
    } catch {
      // An interrupted request may already have been accepted by the provider.
    }
    await save()
  }
}

export async function runBatch({ command, key, via, input, targets, observation }, adapterFor) {
  checkRoute(via)
  const dir = await directory()
  const id = idFor('social-post batch', key)
  return exclusive(dir, id, async () => {
    let batch = await readRecord(dir, id)
    if (batch) {
      if (via && via !== batch.via)
        throw new InputError(
          'This key is pinned to the ' +
            batch.via +
            ' route. Use its original route to reconcile the post.',
        )
      checkInput(batch, input, targets)
    } else {
      if (command === 'status' || !input || !targets?.length)
        throw new InputError(
          'Unknown batch. Supply the approved content, destinations and key to preview or publish.',
        )
      const route = via || (await preference(dir))
      if (!route) return needsRoute
      if (route === 'browser' && input.workspace)
        throw new InputError('--workspace selects a SosoAPI workspace only on the API route.')
      if (via) await preference(dir, via, false)
      batch = {
        id,
        key,
        via: route,
        input,
        mediaSha256: await mediaHash(input.image || input.video),
        items: targets.map((target) => ({
          target,
          attempted: false,
          receipt: { state: 'queued' },
        })),
      }
      await saveIntent(dir, batch)
    }
    if (
      observation &&
      (batch.via !== 'browser' ||
        !batch.items.some(
          ({ target }) =>
            target.platform === observation.platform &&
            accountKey(target.account) === accountKey(observation.account),
        ))
    ) {
      throw new InputError(
        'Supply an observed permalink for an exact destination in this browser batch.',
      )
    }
    const save = () => saveIntent(dir, batch)
    if (command === 'status' && !batch.items.some(refreshNeeded))
      return publicReceipt(batch, command)
    if (batch.items.every((item) => item.attempted && !refreshNeeded(item)))
      return publicReceipt(batch, command)
    const adapter = await adapterFor(batch.via)
    await reconcile(batch, adapter, observation)
    if (command !== 'status' && batch.items.some((item) => !item.attempted)) {
      await preflight(batch, adapter)
      await save()
      const blocked = batch.items.some((item) => !item.attempted && item.receipt.state !== 'ready')
      if (command === 'publish' && !blocked) await publishReady(batch, adapter, save)
    } else {
      await save()
    }
    return publicReceipt(batch, command)
  })
}
