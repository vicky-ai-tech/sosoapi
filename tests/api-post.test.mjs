import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApiAdapter } from '../skills/meta-browser-post/scripts/api-post.mjs'

const ws = '11111111-1111-4111-8111-111111111111'
const pid = '22222222-2222-4222-8222-222222222222'
const ids = {
  threads: '33333333-3333-4333-8333-333333333331',
  facebook: '33333333-3333-4333-8333-333333333332',
  instagram: '33333333-3333-4333-8333-333333333333',
  x: '33333333-3333-4333-8333-333333333334',
  youtube: '33333333-3333-4333-8333-333333333335',
}
const target = (platform) => ({ platform, account: '@fixture' })
const request = {
  text: 'A fixture for the local CLI.',
  key: 'fixture-origin-key',
  workspace: 'Fixture',
}
let root, command, output, media
const state = (name) => writeFile(join(root, 'mode'), name)
const readLog = async () =>
  (await readFile(output, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((x) => JSON.parse(x))
const adapter = () => createApiAdapter({ command: process.execPath, args: [command] })

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'sosoapi-cli-fixture-'))
  command = join(root, 'fixture.mjs')
  output = join(root, 'commands.ndjson')
  media = join(root, 'image.png')
  await writeFile(media, Buffer.from('synthetic media for a mocked local uploader'))
  await writeFile(
    command,
    `
import { readFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
const root = dirname(process.argv[1]), args = process.argv.slice(2)
const ws = ${JSON.stringify(ws)}, ids = ${JSON.stringify(ids)}, id = ${JSON.stringify(pid)}
const log = (record) => appendFileSync(join(root, 'commands.ndjson'), JSON.stringify(record)+'\\n')
const mode = readFileSync(join(root, 'mode'), 'utf8')
const send = (m) => console.log(JSON.stringify(m))
if (!args.length) {
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    const m = JSON.parse(line)
    if (m.method === 'initialize') send({jsonrpc:'2.0', id:m.id, result:{protocolVersion:'2025-03-26', capabilities:{tools:{}}, serverInfo:{name:'fixture',version:'1'}}})
    if (m.method === 'tools/call') {
      const a = m.params.arguments; const bytes=readFileSync(a.file_path)
      log({tool:m.params.name, workspace:a.workspace_id})
      const asset = { id:17, workspace_id:ws, asset_type:a.file_path.endsWith('.mp4')?'video':'image', asset_url:'https://assets.example.invalid/test', metadata:{content_sha256:createHash('sha256').update(bytes).digest('hex')}}
      if(mode==='bad-media')asset.workspace_id=id
      send({jsonrpc:'2.0', id:m.id, result:{structuredContent:{asset,deduped:false}}})
      break
    }
  }
} else {
  const raw=readFileSync(0,'utf8'), data=raw?JSON.parse(raw):null
  log({args,data})
  if (args[0]==='api') {
    if(mode==='auth'){console.error('Not logged in. Run: sosoapi auth login');process.exit(1)}
    if(args[2]==='/identity-api/workspace/list')send({http_status:200,body:{workspaces:[{id:ws,name:'Fixture',slug:'fixture',role:'owner'}]}})
    else send({http_status:200,body:{accounts:Object.keys(ids).map((platform)=>({
        id:ids[platform],platform,workspace_id:mode==='wrong-workspace'?id:ws,handle:'fixture',status:'valid',health_state:'ready',capability_facts:['can_publish_text','can_publish_image','can_auto_publish_text','can_publish_video','can_upload_video','can_set_title','can_set_description','can_set_privacy_status'].map(capability=>({capability,availability:'available',observed_allowed:true,valid_until:mode==='stale'?'2000-01-01':new Date(Date.now()+600000).toISOString()}))}))}})
  } else {
    const platform = data?.provider_payload?.platform || 'threads'
    const post={workspace_id:ws, social_account_id:ids[platform],platform,id}
    if (mode==='lost'){console.error(JSON.stringify({accepted_post:post}));process.exit(1)}
    if (mode==='unknown'){process.exit(1)}
    if (mode==='mismatch')post.social_account_id=ws
    const domain={threads:'threads.com',facebook:'facebook.com',instagram:'instagram.com',x:'x.com',youtube:'youtube.com'}[platform]
    send({state:mode==='not-confirmed'?'pending':'published',post,complete:mode!=='not-confirmed',publication_confirmed:mode!=='not-confirmed',provider:{permalink:'https://www.'+domain+'/post/fixture'}})
  }
}
`,
  )
})
after(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

test('preview is read-only; Threads text uses one pinned CLI publish and requires confirmed identity', async () => {
  await state('ok')
  const api = adapter()
  const ready = await api.preview(target('threads'), request)
  assert.equal(ready.state, 'ready')
  assert.equal(ready.accountId, ids.threads)
  const changed = await api.publish(target('threads'), { ...request, text: 'Changed text' }, ready)
  assert.equal(changed.state, 'needs_input')
  assert.equal(changed.safeToRetry, true)
  assert.ok((await readLog()).every((x) => x.args?.[0] === 'api'))
  const result = await api.publish(target('threads'), request, ready)
  assert.equal(result.state, 'published')
  assert.equal(result.id, pid)
  assert.equal(result.url, 'https://www.threads.com/post/fixture')
  assert.equal((await readLog()).at(-1).args.at(-1), request.key)
  await state('mismatch')
  assert.equal((await api.status(target('threads'), request, result)).state, 'pending')
  assert.equal((await readLog()).at(-1).args[1], 'status')
})

test('a scoped denial, missing grant, or expired capability returns an actionable pre-submit result', async () => {
  for (const mode of ['wrong-workspace', 'stale', 'auth']) {
    await state(mode)
    const r = await adapter().preview(target('facebook'), request)
    assert.equal(r.state, 'needs_input')
    assert.equal(r.safeToRetry, true)
  }
})

test('one approved image is registered once and reused by each selected account', async () => {
  await state('ok')
  const api = adapter()
  const r = { ...request, image: media }
  const before = (await readLog()).length
  for (const p of ['threads', 'facebook', 'instagram', 'x']) {
    const ready = await api.preview(target(p), r)
    assert.equal(ready.state, 'ready')
    assert.equal((await api.publish(target(p), r, ready)).state, 'published')
    const row = (await readLog()).at(-1)
    assert.deepEqual(row.data.media, [
      { asset_id: 17, kind: 'image', url: 'https://assets.example.invalid/test' },
    ])
    assert.deepEqual(row.data.provider_payload, {
      platform: p,
      publish_options: { post_type: 'IMAGE' },
    })
    assert.equal(row.data.social_account_id, ids[p])
  }
  assert.equal(
    (await readLog()).slice(before).filter((x) => x.tool === 'sosoapi_upload_asset').length,
    1,
  )
  assert.equal((await readdir(root)).filter((x) => x.startsWith('sosoapi-upload-')).length, 0)
})

test('changed file or mismatched asset blocks the post; unsupported requests stop before upload', async () => {
  await state('ok')
  const api = adapter(),
    r = { ...request, image: media }
  const ready = await api.preview(target('instagram'), r)
  const before = (await readLog()).length
  await writeFile(media, 'different fixture')
  assert.equal((await api.publish(target('instagram'), r, ready)).state, 'needs_input')
  assert.equal((await readLog()).length, before)
  await state('bad-media')
  const updated = await api.preview(target('instagram'), r)
  assert.equal((await api.publish(target('instagram'), r, updated)).state, 'needs_input')
  assert.ok((await readLog()).slice(before).every((x) => x.args?.[0] !== 'posts'))
  assert.equal((await api.preview(target('instagram'), request)).state, 'needs_input')
  assert.equal(
    (await api.preview(target('youtube'), { ...request, video: media })).state,
    'needs_input',
  )
})

test('YouTube uses explicit title and visibility on a single video', async () => {
  await state('ok')
  const api = adapter()
  const video = join(root, 'fixture.mp4')
  await writeFile(video, 'mock video')
  const r = { ...request, video, title: 'Fixture video', privacy: 'unlisted', audience: 'not-kids' }
  const ready = await api.preview(target('youtube'), r)
  assert.equal(ready.state, 'ready')
  assert.equal(
    (await api.publish(target('youtube'), { ...r, audience: 'kids' }, ready)).state,
    'needs_input',
  )
  assert.equal((await api.publish(target('youtube'), r, ready)).state, 'published')
  const options = (await readLog()).at(-1).data.provider_payload.publish_options
  assert.equal(options.title, r.title)
  assert.equal(options.privacy_status, 'unlisted')
  assert.equal(options.self_declared_made_for_kids, false)
  assert.equal(options.cancellation_mode, 'UNSCHEDULE_KEEP_PRIVATE')
})

test('unknown create stays pending and only a confirmed accepted ID can be queried', async () => {
  await state('ok')
  const api = adapter()
  const ready = await api.preview(target('threads'), request)
  for (const mode of ['unknown', 'lost', 'not-confirmed']) {
    await state(mode)
    const res = await api.publish(target('threads'), request, ready)
    assert.equal(res.state, 'pending')
    assert.equal(res.id, mode === 'unknown' ? undefined : pid)
    const before = (await readLog()).length
    await state('ok')
    const status = await api.status(target('threads'), request, res)
    assert.equal(status.state, mode === 'unknown' ? 'pending' : 'published')
    const reads = (await readLog()).slice(before)
    assert.ok(reads.every((x) => x.args?.[1] === 'status'))
    assert.equal(reads.length, mode === 'unknown' ? 0 : 1)
  }
})
