import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createExtraBrowserAdapter } from '../skills/meta-browser-post/scripts/extra-browser.mjs'
import { runSocialPost } from '../skills/meta-browser-post/scripts/social-post.mjs'
const { chromium } = createRequire(
  new URL('../skills/meta-browser-post/package.json', import.meta.url),
)('playwright-core')
const handle = '@fictional',
  channel = 'UC' + 'a'.repeat(22),
  watch = 'Fiction_123'
const xURL = 'https://x.com/fictional/status/1234',
  studio = 'https://studio.youtube.com/channel/' + channel + '/videos'
const api = createExtraBrowserAdapter()
const x = { platform: 'x', account: handle },
  yt = { platform: 'youtube', account: channel }
let ctx,
  page,
  tmp,
  video,
  photo,
  mode,
  serial = 0
const text = 'A short fixture caption.',
  ytTitle = 'A fictional upload'
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAOjyXfUAAAAASUVORK5CYII=',
  'base64',
)
const xRequest = () => ({ key: 'x-fixture-' + ++serial, text })
const ytRequest = () => ({
  key: 'youtube-fixture-' + ++serial,
  text,
  video,
  title: ytTitle,
  privacy: 'unlisted',
  audience: 'not-kids',
})
function fixture(program, args, html) {
  return html + '<script>(' + program.toString() + ')(' + JSON.stringify(args) + ')</script>'
}
function xHTML(detail) {
  if (detail)
    return (
      '<main><article data-testid="tweet"><div data-testid="User-Name"><a href="/fictional">Fictional</a></div><div data-testid="tweetText">' +
      text +
      '</div><a href="/fictional/status/1234"><time datetime="' +
      new Date().toISOString() +
      '"></time></a>' +
      (mode === 'image'
        ? '<div data-testid="tweetPhoto"><img src="data:image/png;base64,iVBORw0KGgo="></div>'
        : '') +
      '</article></main>'
    )
  return fixture(
    (mode) => {
      window.sends = 0
      const box = document.querySelector('[role=dialog]')
      document.querySelector('input').onchange = () => {
        const div = document.createElement('div')
        div.dataset.testid = 'attachments'
        div.innerHTML = '<img alt="Image preview" src="data:image/png;base64,iVBORw0KGgo=">'
        box.append(div)
      }
      document.querySelector('button').onclick = () => {
        window.sends++
        box.remove()
        if (mode !== 'no-notice')
          document.body.insertAdjacentHTML(
            'beforeend',
            '<div role="alert" data-testid="toast">Your post was sent. <a href="/fictional/status/1234">View</a></div>',
          )
      }
    },
    mode,
    '<nav><a data-testid="AppTabBar_Profile_Link" aria-label="Profile" href="/fictional">Profile</a></nav><div role="dialog">' +
      (mode === 'reply' ? '<span>Replying to @other</span>' : '') +
      '<div role="textbox" contenteditable="true" data-testid="tweetTextarea_0"></div><input type="file" data-testid="fileInput"><button data-testid="tweetButton">Post</button></div>',
  )
}
function ytHTML() {
  return fixture(
    ({ watch, mode }) => {
      window.uploads = 0
      window.sends = 0
      window.values = {}
      const slot = document.querySelector('#slot'),
        create = document.querySelector('#create')
      const link = '<a href="https://youtu.be/' + watch + '">https://youtu.be/' + watch + '</a>'
      create.onclick = () => {
        slot.innerHTML = '<button role="menuitem">Upload videos</button>'
        slot.firstChild.onclick = () => {
          slot.innerHTML =
            '<ytcp-uploads-dialog role="dialog" aria-label="Upload videos"><input type="file" name="Filedata" accept="video/*"></ytcp-uploads-dialog>'
          const box = slot.firstChild
          box.querySelector('input').onchange = () => {
            window.uploads++
            box.innerHTML =
              '<h2>Details</h2><div id="title-textarea"><div contenteditable="true">file</div></div><div id="description-textarea"><div contenteditable="true"></div></div><div role="radiogroup" id="audience"></div>' +
              link +
              '<button>Next</button>'
            function radios(parent, options, field) {
              for (const [id, label] of options) {
                const item = document.createElement('tp-yt-paper-radio-button')
                item.setAttribute('role', 'radio')
                item.setAttribute('name', id)
                item.setAttribute('aria-checked', 'false')
                item.textContent = label
                item.onclick = () => {
                  for (const c of parent.children)
                    c.setAttribute('aria-checked', String(c === item))
                  window.values[field] = id
                }
                parent.append(item)
              }
            }
            radios(
              box.querySelector('#audience'),
              [
                ['VIDEO_MADE_FOR_KIDS_MFK', "Yes, it's made for kids"],
                ['VIDEO_MADE_FOR_KIDS_NOT_MFK', "No, it's not made for kids"],
              ],
              'audience',
            )
            box.querySelector('button').onclick = () => {
              window.values.title = box.querySelector('#title-textarea').innerText
              window.values.text = box.querySelector('#description-textarea').innerText
              box.innerHTML =
                '<h2>' +
                (mode === 'unexpected' ? 'Review new terms' : 'Checks') +
                '</h2><button>Next</button>' +
                link
              box.querySelector('button').onclick = () => {
                box.innerHTML =
                  '<h2>Visibility</h2><div id="radios"></div>' + link + '<button>Save</button>'
                radios(
                  box.querySelector('#radios'),
                  [
                    ['PRIVATE', 'Private'],
                    ['UNLISTED', 'Unlisted'],
                    ['PUBLIC', 'Public'],
                  ],
                  'privacy',
                )
                box.querySelector('button').onclick = () => {
                  window.sends++
                  box.remove()
                  if (mode !== 'no-notice')
                    slot.innerHTML =
                      '<ytcp-video-publish-dialog role="dialog"><h2>Video published</h2>' +
                      link +
                      '</ytcp-video-publish-dialog>'
                }
              }
            }
          }
        }
      }
    },
    { watch, mode },
    '<style>ytcp-uploads-dialog,ytcp-video-publish-dialog,tp-yt-paper-radio-button {display:block} [contenteditable=true]{min-height:18px}</style><ytcp-navigation-drawer><a href="/channel/' +
      channel +
      '/videos">Content</a></ytcp-navigation-drawer><button id="create" aria-label="Create">Create</button><div id="slot"></div>',
  )
}
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'social-native-extra-'))
  process.env.META_POST_STATE_HOME = tmp
  photo = join(tmp, 'fixture.png')
  video = join(tmp, 'fixture.mp4')
  await writeFile(photo, png)
  await writeFile(
    video,
    Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom0000mp41')]),
  )
  const profile = join(tmp, 'chrome')
  ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    serviceWorkers: 'block',
    args: [
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      '--disable-background-networking',
    ],
  })
  process.env.META_POST_PORT = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(
    '\n',
  )[0]
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url())
    if (route.request().resourceType() !== 'document') return route.abort()
    if (u.origin === 'https://x.com')
      return route.fulfill({
        contentType: 'text/html',
        body: xHTML(u.pathname === '/fictional/status/1234'),
      })
    if (u.origin === 'https://studio.youtube.com')
      return route.fulfill({ contentType: 'text/html', body: ytHTML() })
    return route.abort()
  })
  page = ctx.pages()[0]
})
after(async () => {
  await ctx?.close()
  if (tmp) await rm(tmp, { recursive: true, force: true })
})
async function show(platform, scenario = 'ok') {
  mode = scenario
  await page.goto(platform === 'x' ? 'https://x.com/compose/post' : studio)
}
test('the public browser batch submits a top-level X photo once and verifies its own status link', async () => {
  await show('x', 'image')
  const args = [
    'publish',
    '--key',
    'routed-x-image',
    '--via',
    'browser',
    '--to',
    'x=' + handle,
    '--text',
    text,
    '--image',
    photo,
  ]
  const result = await runSocialPost(args)
  assert.equal(result.results[0].url, xURL, JSON.stringify(result))
  assert.equal((await runSocialPost(args)).results[0].url, xURL)
  assert.equal(await page.evaluate(() => window.sends), 1)
})
test('X rejects reply composition and switched profile before submitting', async () => {
  await show('x', 'reply')
  assert.equal((await api.preview(x, xRequest())).state, 'needs_input')
  await show('x')
  const r = xRequest(),
    ready = await api.preview(x, r)
  assert.equal(ready.state, 'ready', JSON.stringify(ready))
  await page.locator('nav a').evaluate((e) => {
    e.href = '/other'
  })
  assert.equal((await api.publish(x, r, ready)).safeToRetry, true)
  assert.equal(await page.evaluate(() => window.sends), 0)
})
test('an unconfirmed X submit remains pending and recovers only on its own matching post', async () => {
  await show('x', 'no-notice')
  const r = xRequest(),
    ready = await api.preview(x, r),
    result = await api.publish(x, r, ready)
  assert.equal(result.state, 'pending')
  assert.equal((await api.publish(x, r, ready)).state, 'pending')
  assert.equal(
    (await api.status(x, r, { ...result, observedUrl: 'https://x.com/other/status/1234' })).state,
    'pending',
  )
  assert.equal((await api.status(x, r, { ...result, observedUrl: xURL })).url, xURL)
  assert.equal(await page.evaluate(() => window.sends), 1)
})
test('Studio batch stages one MP4, confirms title, audience and visibility, saves once, and checks its video link', async () => {
  await show('youtube')
  const args = [
    'publish',
    '--via',
    'browser',
    '--key',
    'routed-studio',
    '--to',
    'youtube=' + channel,
    '--text',
    text,
    '--video',
    video,
    '--title',
    ytTitle,
    '--privacy',
    'unlisted',
    '--audience',
    'not-kids',
  ]
  const result = await runSocialPost(args)
  assert.equal(
    result.results[0].url,
    'https://www.youtube.com/watch?v=' + watch,
    JSON.stringify(result),
  )
  assert.deepEqual(await page.evaluate(() => window.values), {
    title: ytTitle,
    text,
    audience: 'VIDEO_MADE_FOR_KIDS_NOT_MFK',
    privacy: 'UNLISTED',
  })
  await runSocialPost(args)
  assert.deepEqual(await page.evaluate(() => [window.uploads, window.sends]), [1, 1])
})
test('Studio blocks missing audience, a switched channel and changed media before file selection', async () => {
  await show('youtube')
  assert.equal((await api.preview(yt, { ...ytRequest(), audience: undefined })).safeToRetry, true)
  const r = ytRequest(),
    ready = await api.preview(yt, r)
  assert.equal(ready.state, 'ready', JSON.stringify(ready))
  await page.evaluate(() => history.pushState(null, '', '/channel/UC' + 'b'.repeat(22) + '/videos'))
  assert.equal((await api.publish(yt, r, ready)).safeToRetry, true)
  assert.equal(await page.evaluate(() => window.uploads), 0)
  await show('youtube')
  const r2 = ytRequest(),
    ready2 = await api.preview(yt, r2)
  assert.equal(ready2.state, 'ready')
  const old = await readFile(video)
  try {
    await writeFile(video, Buffer.concat([old, Buffer.from('different')]))
    assert.equal((await api.publish(yt, r2, ready2)).safeToRetry, true)
    assert.equal(await page.evaluate(() => window.uploads), 0)
  } finally {
    await writeFile(video, old)
  }
})
test('an interrupted Studio upload retains its original ID and cannot upload again', async () => {
  await show('youtube', 'no-notice')
  const r = ytRequest(),
    ready = await api.preview(yt, r),
    result = await api.publish(yt, r, ready)
  assert.equal(result.state, 'pending', JSON.stringify(result))
  assert.equal((await api.publish(yt, r, ready)).state, 'pending')
  assert.equal(
    (
      await api.status(yt, r, {
        ...result,
        observedUrl: 'https://www.youtube.com/watch?v=' + watch,
      })
    ).state,
    'pending',
  )
  assert.deepEqual(await page.evaluate(() => [window.uploads, window.sends]), [1, 1])
})

test('unrecognized Studio steps retain the original draft without clicking through', async () => {
  await show('youtube', 'unexpected')
  const request = ytRequest()
  const ready = await api.preview(yt, request)
  const result = await api.publish(yt, request, ready)
  assert.equal(result.state, 'pending')
  assert.equal((await api.publish(yt, request, ready)).state, 'pending')
  assert.deepEqual(await page.evaluate(() => [window.uploads, window.sends]), [1, 0])
})
test('a conflicting Studio drawer stops the upload even when the address matches', async () => {
  await show('youtube')
  await page.locator('ytcp-navigation-drawer a').evaluate((link) => {
    link.href = '/channel/UC' + 'b'.repeat(22) + '/videos'
  })
  assert.equal((await api.preview(yt, ytRequest())).state, 'needs_input')
  assert.equal(await page.evaluate(() => window.uploads), 0)
})
