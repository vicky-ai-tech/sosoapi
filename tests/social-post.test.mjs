import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { runSocialPost } from '../skills/meta-browser-post/scripts/social-post.mjs'

let temp, original
beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'batch-test-'))
  original = process.env.META_POST_STATE_HOME
  process.env.META_POST_STATE_HOME = temp
})
afterEach(async () => {
  if (original === undefined) delete process.env.META_POST_STATE_HOME
  else process.env.META_POST_STATE_HOME = original
  await rm(temp, { recursive: true, force: true })
})

const caption = 'An exact “caption”\nwith a newline.'
function args(command, key, ...extra) {
  return [command, '--key', key, '--to', 'threads=@example', '--text', caption, ...extra]
}
function driver(overrides = {}) {
  const calls = []
  const adapter = {
    async preview(target, request) {
      calls.push(['preview', target.platform, request])
      return { state: 'ready', id: 'intent-' + target.platform }
    },
    async publish(target, request) {
      calls.push(['publish', target.platform, request])
      return {
        state: 'published',
        id: 'post-' + target.platform,
        url: 'https://example.invalid/post/' + target.platform,
      }
    },
    async status(target, request, receipt) {
      calls.push(['status', target.platform, receipt])
      return receipt
    },
  }
  Object.assign(adapter, overrides)
  return {
    calls,
    adapter,
    run: (argv) =>
      runSocialPost(argv, async (via) => {
        calls.push(['route', via])
        return adapter
      }),
  }
}
test('first use asks for a route; the first choice persists and per-batch overrides do not switch it', async () => {
  const { calls, run } = driver()
  assert.equal((await run(args('publish', 'one'))).state, 'needs_route')
  assert.deepEqual(calls, [])
  assert.equal((await run(args('preview', 'one', '--via', 'browser'))).content.text, caption)
  assert.equal((await run(args('publish', 'two', '--via', 'api'))).via, 'api')
  assert.equal((await run(args('publish', 'three'))).via, 'browser')
  assert.deepEqual(await run(['route', '--via', 'api']), { state: 'ready', via: 'api' })
  assert.equal((await run(['publish', '--key', 'one'])).via, 'browser')
  assert.equal((await run(args('publish', 'four'))).via, 'api')
})
test('all destinations preflight before any send and each child key and literal caption is stable', async () => {
  const { calls, run } = driver()
  const argv = args(
    'publish',
    'campaign',
    '--via',
    'browser',
    '--to',
    'facebook=Example Page',
    '--to',
    'instagram=@example',
  )
  const first = await run(argv)
  assert.equal(first.state, 'published')
  assert.equal(first.results.length, 3)
  assert.deepEqual(
    calls.map((x) => x[0]),
    ['route', 'preview', 'preview', 'preview', 'publish', 'publish', 'publish'],
  )
  const written = calls.filter(([op]) => op === 'publish')
  assert.equal(new Set(written.map(([, , r]) => r.key)).size, 3)
  assert.ok(written.every(([, , r]) => r.text === caption))
  assert.deepEqual(await run(['publish', '--key', 'campaign']), first)
  assert.deepEqual(await run(['status', '--key', 'campaign']), first)
  assert.equal(calls.length, 7)
})
test('a missing prerequisite in any destination prevents the entire first submission', async () => {
  const { calls, run, adapter } = driver()
  adapter.preview = async (target) =>
    target.platform === 'instagram'
      ? { state: 'needs_input', next: 'Choose an image.' }
      : { state: 'ready', id: 'intent' }
  const result = await run(args('publish', 'blocked', '--via', 'api', '--to', 'instagram=@example'))
  assert.equal(result.state, 'needs_input')
  assert.ok(!calls.some(([op]) => op === 'publish'))
  adapter.preview = async () => ({ state: 'ready' })
  assert.equal((await run(['publish', '--key', 'blocked'])).state, 'published')
})
test('partial completion and a lost receipt reconcile read-only; route and content stay bound', async () => {
  const { run, adapter } = driver()
  const sends = []
  let resolved = false
  adapter.publish = async (target) => {
    sends.push(target.platform)
    if (target.platform === 'threads') throw new Error('Connection lost during submission')
    return { state: 'published', id: 'known', url: 'https://example.invalid/post/known' }
  }
  adapter.status = async () =>
    resolved
      ? { state: 'published', url: 'https://example.invalid/post/recovered', id: 'found' }
      : { state: 'needs_input', next: 'Sign back in.' }
  assert.equal(
    (await run(args('publish', 'partial', '--via', 'browser', '--to', 'facebook=Example Page')))
      .state,
    'partial',
  )
  assert.equal(
    (await run(['publish', '--key', 'partial'])).results.find((r) => r.platform === 'threads')
      .state,
    'pending',
  )
  await assert.rejects(run(['publish', '--via', 'api', '--key', 'partial']), /pinned/)
  await assert.rejects(
    run(['publish', '--key', 'partial', '--to', 'threads=@example', '--text', 'different']),
    /different/,
  )
  resolved = true
  assert.equal((await run(['status', '--key', 'partial'])).state, 'published')
  assert.deepEqual(sends, ['facebook', 'threads'])
})
test('a definitely pre-submit failure can resume without repeating a confirmed destination', async () => {
  const { run, adapter } = driver()
  const written = []
  adapter.publish = async (target) => {
    written.push(target.platform)
    if (target.platform === 'threads' && written.length === 2)
      return { state: 'needs_input', safeToRetry: true }
    return { state: 'published', url: 'https://example.invalid/post/' + target.platform }
  }
  assert.equal(
    (await run(args('publish', 'safe', '--via', 'api', '--to', 'facebook=Example Page'))).state,
    'partial',
  )
  assert.equal((await run(['publish', '--key', 'safe'])).state, 'published')
  assert.deepEqual(written, ['facebook', 'threads', 'threads'])
})
test('concurrent batch invocations cannot send the same intent twice', async () => {
  const { run, adapter } = driver()
  let unlock, started
  const busy = new Promise((r) => {
    started = r
  })
  const gate = new Promise((r) => {
    unlock = r
  })
  let writes = 0
  adapter.publish = async () => {
    writes++
    started()
    await gate
    return { state: 'published', url: 'https://example.invalid/post/once' }
  }
  const first = run(args('publish', 'overlap', '--via', 'api'))
  await busy
  try {
    await assert.rejects(run(args('publish', 'overlap', '--via', 'api')), /busy/)
  } finally {
    unlock()
  }
  assert.equal((await first).state, 'published')
  assert.equal(writes, 1)
})
test('changed media, duplicate destinations and resolved aliases are rejected before submission', async () => {
  const { calls, run, adapter } = driver()
  const filename = path.join(temp, 'example.png')
  await writeFile(filename, 'fixture bytes')
  const ready = await run(args('preview', 'media', '--via', 'api', '--image', filename))
  assert.equal(ready.content.image, 'example.png')
  await writeFile(filename, 'different fixture')
  await assert.rejects(run(['publish', '--key', 'media']), /media changed/i)
  await assert.rejects(run(args('publish', 'dup', '--to', 'threads=EXAMPLE')), /only once/)
  adapter.preview = async () => ({
    state: 'ready',
    accountId: 'same-account',
    workspaceId: 'same-workspace',
  })
  await assert.rejects(
    run(args('publish', 'aliases', '--via', 'api', '--to', 'threads=another-alias')),
    /same account/,
  )
  assert.ok(!calls.some(([op]) => op === 'publish'))
})
test('resolving a handle after preview to a changed account requires a new review', async () => {
  const { run, adapter, calls } = driver()
  let accountId = 'original-account'
  adapter.preview = async () => ({ state: 'ready', accountId, workspaceId: 'test-workspace' })
  assert.equal((await run(args('preview', 'pinned', '--via', 'api'))).state, 'ready')
  accountId = 'changed-account'
  assert.equal((await run(['publish', '--key', 'pinned'])).state, 'needs_input')
  assert.ok(!calls.some(([op]) => op === 'publish'))
})
test('observed URLs are reconciled only for their selected browser destination', async () => {
  const { run, adapter } = driver()
  adapter.publish = async () => ({ state: 'pending', id: 'native-id' })
  adapter.status = async (_, __, receipt) =>
    receipt.observedUrl
      ? { state: 'published', id: receipt.id, url: receipt.observedUrl }
      : { state: 'pending', id: receipt.id }
  await run(args('publish', 'reconcile', '--via', 'browser', '--to', 'facebook=Example Page'))
  await assert.rejects(
    run([
      'status',
      '--key',
      'reconcile',
      '--to',
      'threads=wrong',
      '--url',
      'https://example.invalid/post/1',
    ]),
    /exact destination/,
  )
  const result = await run([
    'status',
    '--key',
    'reconcile',
    '--to',
    'threads=@example',
    '--url',
    'https://example.invalid/post/1',
  ])
  assert.equal(result.state, 'partial')
  assert.equal(
    result.results.find((r) => r.platform === 'threads').url,
    'https://example.invalid/post/1',
  )
  assert.equal(result.results.find((r) => r.platform === 'facebook').state, 'pending')
})

test('a terminated process leaves the first destination uncertain and allows remaining destinations to resume', async () => {
  const argv = args('publish', 'process-crash', '--via', 'api', '--to', 'facebook=Example Page')
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        'import { runSocialPost } from ' +
          JSON.stringify(
            new URL('../skills/meta-browser-post/scripts/social-post.mjs', import.meta.url).href,
          ),
        'await runSocialPost(' + JSON.stringify(argv) + ', async () => ({',
        "  preview: async () => ({state:'ready'}),",
        '  publish: async () => process.exit(17),',
        '}))',
      ].join('\n'),
    ],
    { timeout: 5000, encoding: 'utf8' },
  )
  assert.equal(child.status, 17, child.stderr)
  const { calls, run, adapter } = driver()
  adapter.status = async () => ({ state: 'pending', next: 'Inspect original outcome.' })
  const status = await run(['status', '--key', 'process-crash'])
  assert.deepEqual(
    status.results.map((x) => x.state),
    ['pending', 'ready'],
  )
  const result = await run(['publish', '--key', 'process-crash'])
  assert.deepEqual(
    result.results.map((x) => x.state),
    ['pending', 'published'],
  )
  assert.deepEqual(
    calls.filter(([op]) => op === 'publish').map((x) => x[1]),
    ['threads'],
  )
})
test('a workspace can be chosen after an unresolved first preview, before any writes', async () => {
  const { run, adapter } = driver()
  adapter.preview = async (_target, request) =>
    request.workspace
      ? { state: 'ready', workspaceId: request.workspace, accountId: 'account' }
      : { state: 'needs_input', choices: [{ name: 'Test workspace' }] }
  const first = await run(args('publish', 'workspace-selection', '--via', 'api'))
  assert.deepEqual(first.results[0].choices, [{ name: 'Test workspace' }])
  assert.equal(
    (await run(args('publish', 'workspace-selection', '--workspace', 'Test workspace'))).state,
    'published',
  )
  await assert.rejects(
    run(args('publish', 'workspace-selection', '--workspace', 'Elsewhere')),
    /different content/,
  )
})

test('YouTube receives its explicit title, audience, video and visibility on the selected route', async () => {
  const { calls, run } = driver()
  const filename = path.join(temp, 'clip.mp4')
  await writeFile(filename, 'synthetic fixture media')
  const args = [
    'preview',
    '--key',
    'studio-video',
    '--via',
    'browser',
    '--to',
    'youtube=UC-fixture',
    '--video',
    filename,
    '--title',
    'A reviewable video',
    '--privacy',
    'unlisted',
    '--audience',
    'not-kids',
  ]
  const result = await run(args)
  assert.equal(result.content.title, 'A reviewable video')
  assert.equal(result.content.privacy, 'unlisted')
  assert.equal(result.content.audience, 'not-kids')
  assert.equal(calls.find(([op]) => op === 'preview')[2].audience, 'not-kids')
  const crosspost = args
    .map((arg) => (arg === 'studio-video' ? 'video-crosspost' : arg))
    .concat('--to', 'x=@example')
  const multi = await run(crosspost)
  assert.equal(multi.state, 'ready')
  const xRequest = calls.find(([op, platform]) => op === 'preview' && platform === 'x')[2]
  assert.ok(!('audience' in xRequest) && !('privacy' in xRequest) && !('title' in xRequest))
  await assert.rejects(run(args.slice(0, -1).concat('not-selected')), /YouTube audience/)
})
