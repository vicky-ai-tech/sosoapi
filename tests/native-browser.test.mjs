import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import { run } from '../skills/meta-browser-post/scripts/meta-post.mjs'
import { postURL } from '../skills/meta-browser-post/scripts/native.mjs'
import { createIntent, privateDirectory } from '../skills/meta-browser-post/scripts/intent.mjs'

const { chromium } = createRequire(
  new URL('../skills/meta-browser-post/package.json', import.meta.url),
)('playwright-core')
const temp = await mkdtemp(path.join(os.tmpdir(), 'meta-skill-test-')),
  photo = path.join(temp, 'fixture.png')
const origins = {
  facebook: 'https://www.facebook.com',
  instagram: 'https://www.instagram.com',
  threads: 'https://www.threads.com',
}
const links = {
  facebook: '/examplepage/posts/example',
  instagram: '/p/example/',
  threads: '/@example/post/example',
}
const names = { facebook: 'Example Page', instagram: '@example', threads: '@example' }
const titles = { facebook: 'Create post', instagram: 'Create new post', threads: 'New thread' }
const caption = 'A fictional post for the local browser fixture.'
let browser,
  tab,
  scenario,
  intercepted = 0
const escape = (s) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
function documentFor(platform, detail) {
  const author = scenario.wrong ? 'other' : names[platform]
  const handle =
    platform === 'facebook' ? 'examplepage' : platform === 'threads' ? '@example' : 'example'
  const actor =
    platform === 'facebook'
      ? `<img alt="Posting as Page: ${escape(author)}">`
      : `<a href="/${scenario.wrong ? 'other' : handle}/">${escape(author)}</a>`
  if (detail)
    return `<main><article><header><a href="/${handle}/">${escape(names[platform])}</a></header><p>${caption}</p><time datetime="${new Date().toISOString()}"></time><img src="data:image/png;base64,iVBORw0KGgo=" alt="Post photo"></article></main>`
  return `<main><div role="dialog" aria-label="${scenario.reply ? 'Reply' : titles[platform]}"><h2>${scenario.reply ? 'Reply' : titles[platform]}</h2>${actor}<textarea aria-label="Caption"></textarea><input type="file" accept="image/*"><section id="media"></section>${scenario.crosspost ? '<label>Also share to Facebook<input type="checkbox" checked></label>' : ''}<button id="send">${platform === 'instagram' ? 'Share' : 'Post'}</button></div></main>
  <script>window.submitCount=0;document.querySelector('input[type=file]').onchange=e=>{if(${Boolean(scenario.rejectPhoto)})return;const img=new Image();img.src=URL.createObjectURL(e.target.files[0]);img.alt='Selected photo preview';document.querySelector('#media').append(img);};document.querySelector('#send').onclick=()=>{window.submitCount++;document.querySelector('[role=dialog]').remove();${scenario.timeout ? '' : `document.body.insertAdjacentHTML('beforeend','<div role="status">Your post has been shared. <a href="${links[platform]}">View post</a></div>')`}};</script>`
}
before(async () => {
  process.env.META_POST_STATE_HOME = temp
  await writeFile(
    photo,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAOjyXfUAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  const profile = path.join(temp, 'test-chrome')
  browser = await chromium.launchPersistentContext(profile, {
    headless: true,
    serviceWorkers: 'block',
    args: [
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      '--disable-background-networking',
    ],
  })
  process.env.META_POST_PORT = (
    await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')
  ).split('\n')[0]
  await browser.route('**/*', async (route) => {
    const u = new URL(route.request().url())
    const p = Object.keys(origins).find((k) => origins[k] === u.origin)
    if (!p || !scenario || route.request().resourceType() !== 'document') return route.abort()
    intercepted++
    await route.fulfill({ contentType: 'text/html', body: documentFor(p, u.pathname === links[p]) })
  })
  tab = browser.pages()[0]
})
after(async () => {
  await browser?.close()
  await rm(temp, { recursive: true, force: true })
})
async function start(platform, opts = {}) {
  scenario = opts
  await tab.goto(origins[platform])
  const cmd = [
    'preview',
    platform,
    '--account',
    names[platform],
    '--key',
    String(++start.n),
    '--text',
    caption,
  ]
  if (platform === 'instagram' || opts.photo) cmd.push('--image', photo)
  return run(cmd)
}
start.n = 0
for (const p of ['threads', 'facebook', 'instagram'])
  test(`preview, publish once and return a verified ${p} permalink`, async () => {
    const i = await start(p)
    assert.equal(i.state, 'ready', JSON.stringify(i))
    assert.equal(await tab.locator('textarea').inputValue(), '')
    assert.equal(await tab.locator('input[type=file]').evaluate((e) => e.files.length), 0)
    const x = await run(['publish', '--id', i.id])
    assert.equal(x.state, 'published', JSON.stringify(x))
    assert.equal(x.url, origins[p] + links[p])
    assert.equal((await run(['publish', '--id', i.id])).url, x.url)
    assert.equal(await tab.evaluate(() => window.submitCount), 1)
    assert.deepEqual(await run(['status', '--id', i.id]), x)
  })
test('wrong actor and reply composer cannot publish', async () => {
  for (const opts of [{ wrong: true }, { reply: true }]) {
    const i = await start('threads', opts)
    assert.match(i.state, /needs_(?:account|composer)/)
    assert.equal(await tab.evaluate(() => window.submitCount), 0)
  }
})
test('a preselected extra destination stops the final submission', async () => {
  const i = await start('threads', { crosspost: true })
  assert.equal((await run(['publish', '--id', i.id])).state, 'needs_destination')
  assert.equal(await tab.evaluate(() => window.submitCount), 0)
})
test('missing Instagram image fails before a browser write', async () => {
  await assert.rejects(
    () => createIntent(temp, 'instagram', { account: '@example', text: caption, key: 'no-image' }),
    /requires --image/,
  )
})
test('existing images and rejected upload cannot produce a caption-only post', async () => {
  let i = await start('facebook')
  await tab
    .locator('#media')
    .evaluate((e) => (e.innerHTML = '<button>Remove photo</button><button>Remove image</button>'))
  assert.equal((await run(['publish', '--id', i.id])).state, 'needs_composer')
  i = await start('threads', { photo: true, rejectPhoto: true })
  assert.equal((await run(['publish', '--id', i.id])).state, 'needs_review')
  assert.equal(await tab.evaluate(() => window.submitCount), 0)
})
test('uncertain submit resumes with the same intent and rejects an unrelated link', async () => {
  const i = await start('threads', { timeout: true })
  const x = await run(['publish', '--id', i.id])
  assert.equal(x.state, 'pending')
  assert.equal((await run(['publish', '--id', i.id])).state, 'pending')
  assert.equal(await tab.evaluate(() => window.submitCount), 1)
  assert.equal((await run(['status', '--id', i.id])).state, 'pending')
  assert.equal(
    (await run(['status', '--id', i.id, '--url', 'https://www.threads.com/@other/post/example']))
      .state,
    'pending',
  )
  assert.equal(
    (await run(['status', '--id', i.id, '--url', origins.threads + links.threads])).url,
    origins.threads + links.threads,
  )
})
test('private receipts stay outside the checkout and permalink hosts are restricted', async () => {
  assert.equal(await privateDirectory(), path.join(temp, 'meta-browser-post'))
  assert.equal(postURL('https://www.instagram.com.example.invalid/p/x/', 'instagram'), null)
  assert.ok(intercepted > 0)
})

test('concurrent and repeated publishers produce one final click', async () => {
  const i = await start('facebook')
  const results = await Promise.allSettled([
    run(['publish', '--id', i.id]),
    run(['publish', '--id', i.id]),
  ])
  assert.ok(results.some((r) => r.status === 'fulfilled' && r.value.state === 'published'))
  assert.equal(await tab.evaluate(() => window.submitCount), 1)
})
test('changing identity after preview prevents upload and invalidates readiness', async () => {
  const i = await start('threads', { photo: true })
  await tab
    .locator('body')
    .evaluate((body) =>
      body.insertAdjacentHTML(
        'afterbegin',
        '<nav><a href="/@example" aria-label="Profile">Profile</a></nav>',
      ),
    )
  await tab.locator('[role=dialog] a').evaluate((a) => {
    a.href = '/@other'
    a.textContent = 'other'
  })
  assert.equal((await run(['publish', '--id', i.id])).state, 'needs_account')
  assert.equal(await tab.locator('input[type=file]').evaluate((e) => e.files.length), 0)
  assert.equal((await run(['status', '--id', i.id])).state, 'preview')
})
test('a quoted success message and old unrelated article cannot close a pending intent', async () => {
  const i = await start('threads', { timeout: true })
  await tab.locator('main').evaluate((main) => {
    const a = document.createElement('article')
    a.innerHTML = '<div role="status">Your post has been shared.</div>'
    main.append(a)
  })
  assert.equal((await run(['publish', '--id', i.id])).state, 'pending')
  assert.equal(await tab.evaluate(() => window.submitCount), 1)
})
