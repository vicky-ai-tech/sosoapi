import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'
import { run } from '../skills/meta-browser-post/scripts/meta-post.mjs'
import { runSocialPost } from '../skills/meta-browser-post/scripts/social-post.mjs'
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
function threadsCard(post, onProfile) {
  const { id, account = 'example', offset = 0 } = post
  const datetime = new Date(scenario.submittedAt + offset).toISOString()
  const link = `/@${account}/post/${id}`
  const text = escape((!onProfile && post.detailText) || post.text || caption)
  const content = `<div lang="en"><span dir="auto">${text}</span></div>`
  let card = `<div${(scenario.signedIn || (onProfile && post.nestedQuote)) ? ' data-pressable-container="true"' : ''}>
    <div><a href="/@${account}"><span>${account}</span></a>
    <a href="${link}"><time datetime="${datetime}">Just now</time></a></div>
    ${post.quoted ? '<blockquote>' + content + '</blockquote>' : content}</div>`
  if (onProfile && post.nestedQuote) {
    card = `<div data-pressable-container="true"><a href="/@other">other</a>
      <a href="/@other/post/quoting"><time datetime="${datetime}">Just now</time></a>
      <div lang="en">A different top-level caption.</div>${card}</div>`
  }
  if (onProfile) card = `<div data-virtualized="${!scenario.signedIn}">${card}</div>`
  return post.reply ? '<div role="comment">' + card + '</div>' : card
}

function documentFor(platform, pathname) {
  if (platform === 'threads' && pathname.replace(/\/$/, '') === '/@example') {
    const posts = scenario.submittedAt ? scenario.profilePosts || [] : []
    return `<main><div data-pagelet="threads_profile_posts_timeline_0">${posts.map((p) => threadsCard(p, true)).join('')}</div></main>`
  }
  if (platform === 'threads' && scenario.profilePosts && pathname.includes('/post/')) {
    const post = scenario.profilePosts.find((p) => pathname === `/@${p.account || 'example'}/post/${p.id}`)
    return post
      ? `<main><section role="region">${threadsCard(post, false)}</section></main>`
      : '<main>Post unavailable</main>'
  }
  const author = scenario.wrong ? 'other' : names[platform]
  const handle =
    platform === 'facebook' ? 'examplepage' : platform === 'threads' ? '@example' : 'example'
  const actor =
    platform === 'facebook'
      ? `<img alt="Posting as Page: ${escape(author)}">`
      : `<a href="/${scenario.wrong ? 'other' : handle}/">${escape(author)}</a>`
  if (pathname === links[platform])
    return `<main><article><header><a href="/${handle}/">${escape(names[platform])}</a></header><p>${caption}</p><time datetime="${new Date().toISOString()}"></time><img src="data:image/png;base64,iVBORw0KGgo=" alt="Post photo"></article></main>`
  const viewLink = scenario.noNoticeLink ? '' : ` <a href="${links[platform]}">View post</a>`
  const notice = scenario.timeout ? '' : `<div role="status">Your post has been shared.${viewLink}</div>`
  return `<main><div role="dialog" aria-label="${scenario.reply ? 'Reply' : titles[platform]}"><h2>${scenario.reply ? 'Reply' : titles[platform]}</h2>${actor}<textarea aria-label="Caption"></textarea><input type="file" accept="image/*"><section id="media"></section>${scenario.crosspost ? '<label>Also share to Facebook<input type="checkbox" checked></label>' : ''}<button id="send">${platform === 'instagram' ? 'Share' : 'Post'}</button></div></main>
  <script>window.submitCount=0;document.querySelector('input[type=file]').onchange=e=>{if(${Boolean(scenario.rejectPhoto)})return;const img=new Image();img.src=URL.createObjectURL(e.target.files[0]);img.alt='Selected photo preview';document.querySelector('#media').append(img);};document.querySelector('#send').onclick=()=>{window.submitCount++;window.fixtureSubmitted(Date.now());document.querySelector('[role=dialog]').remove();document.body.insertAdjacentHTML('beforeend',${JSON.stringify(notice)})};</script>`
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
  await browser.exposeBinding('fixtureSubmitted', (_, at) => {
    scenario.submittedAt = at
  })
  await browser.route('**/*', async (route) => {
    const u = new URL(route.request().url())
    const p = Object.keys(origins).find((k) => origins[k] === u.origin)
    if (!p || !scenario || route.request().resourceType() !== 'document') return route.abort()
    intercepted++
    await route.fulfill({ contentType: 'text/html', body: documentFor(p, u.pathname) })
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

for (const [name, notice] of [
  ['missing confirmation', { timeout: true, signedIn: true }],
  ['confirmation with no link', { noNoticeLink: true }],
]) {
  test(`Threads publish returns its verified permalink after a ${name}, with one submission`, async () => {
    const key = 'native-recovery-' + ++start.n
    scenario = {
      ...notice,
      profilePosts: [
        { id: 'other', account: 'other' },
        { id: 'older', offset: -120_000 },
        { id: 'quoted', quoted: true },
        { id: 'reply', reply: true },
        { id: 'nested-quote', nestedQuote: true },
        { id: 'different', text: 'Different text.' },
        { id: 'new-post' },
      ],
    }
    await tab.goto(origins.threads)
    const publish = [
      'publish', '--key', key, '--via', 'browser', '--to', 'threads=@example', '--text', caption,
    ]
    const expected = origins.threads + '/@example/post/new-post'
    for (const command of [publish, ['status', '--key', key], publish]) {
      const result = await runSocialPost(command)
      assert.equal(result.state, 'published', JSON.stringify(result))
      assert.equal(result.results[0].url, expected)
    }
    assert.equal(await tab.evaluate(() => window.submitCount), 1)
  })
}

test('Threads status recovers after the original tab closes without posting again', async () => {
  const intent = await start('threads', { timeout: true, profilePosts: [] })
  const pending = await run(['publish', '--id', intent.id])
  assert.equal(pending.state, 'pending')
  assert.equal(await tab.evaluate(() => window.submitCount), 1)
  await tab.close()
  tab = await browser.newPage()
  scenario.profilePosts.push({ id: 'late-indexed' })
  const explicitWrong = await run([
    'status', '--id', intent.id, '--url', origins.threads + '/@other/post/late-indexed',
  ])
  assert.equal(explicitWrong.state, 'pending')
  const result = await run(['status', '--id', intent.id])
  assert.equal(result.state, 'published')
  assert.equal(result.url, origins.threads + '/@example/post/late-indexed')
  assert.deepEqual(await run(['publish', '--id', intent.id]), result)
})

test('Threads profile discovery keeps ambiguous matches and unverified detail pages pending', async () => {
  const intent = await start('threads', {
    timeout: true,
    signedIn: true,
    profilePosts: [{ id: 'first' }, { id: 'second' }],
  })
  assert.equal((await run(['publish', '--id', intent.id])).state, 'pending')
  scenario.profilePosts = [{ id: 'nested-quote', nestedQuote: true }]
  assert.equal((await run(['status', '--id', intent.id])).state, 'pending')
  scenario.profilePosts = [{ id: 'mismatch', detailText: 'Different text on the post itself.' }]
  const result = await run(['status', '--id', intent.id])
  assert.equal(result.state, 'pending')
  assert.equal(result.url, undefined)
  assert.equal(await tab.evaluate(() => window.submitCount), 1)
})
