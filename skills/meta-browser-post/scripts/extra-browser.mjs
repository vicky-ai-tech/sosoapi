import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import {
  InputError,
  exclusive,
  loadIntent,
  normalized,
  privateDirectory,
  saveIntent,
  sha256,
} from './intent.mjs'
import { connectBrowser, launchBrowser, port, selectTab } from './native.mjs'

const origins = { x: 'https://x.com', youtube: 'https://studio.youtube.com' }
const channel = /^UC[\w-]{22}$/
const videoId = /^[\w-]{11}$/
const pending =
  'Inspect the original post or upload in its native tab. Use status with the same key.'
const need = (message) => {
  throw new InputError(message)
}
const checked = (value, message) => value || need(message)
const norm = (s) => normalized(s || '')
const forKey = (key) => sha256('native X or YouTube\0' + key).slice(0, 32)
const onceVisible = async (locator) => {
  const visible = locator.filter({ visible: true })
  return (await visible.count()) === 1 ? visible : null
}
const click = (element) => element.click({ timeout: 4500 })
const one = async (locator, hint) => checked(await onceVisible(locator), hint)
const inputText = (loc) => loc.evaluate((e) => e.value ?? e.innerText)
function checkOrigin(page, platform) {
  const u = new URL(page.url())
  checked(
    u.origin === origins[platform] && !u.username && !u.password,
    'Sign in on the exact native site in the selected tab.',
  )
  return u
}
function validate(target, request) {
  checked(request.key?.trim(), 'Supply a unique post key.')
  if (target.platform === 'x') {
    checked(/^@?[a-z0-9_]{1,15}$/i.test(target.account), 'Supply the exact X handle.')
    checked(
      (request.text?.trim() || request.image || request.video) && !(request.image && request.video),
      'Supply text or one approved X attachment.',
    )
  } else if (target.platform === 'youtube') {
    checked(
      channel.test(target.account),
      'Use the channel ID from the intended YouTube Studio /channel/UC… URL.',
    )
    checked(
      request.video &&
        !request.image &&
        request.title?.trim() &&
        request.title.length <= 100 &&
        ['private', 'unlisted', 'public'].includes(request.privacy) &&
        ['kids', 'not-kids'].includes(request.audience),
      'Supply one MP4, title, visibility and an explicit --audience kids or not-kids for YouTube Studio.',
    )
  } else need('Choose x or youtube.')
}
async function mediaFor(request) {
  const file = request.image || request.video
  if (!file) return null
  const fd = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const st = await fd.stat()
    checked(
      st.isFile() && st.size > 0 && st.size <= 32 * 1024 * 1024,
      'Choose one local JPEG, PNG or MP4 up to 32 MiB.',
    )
    const buffer = Buffer.alloc(st.size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await fd.read(buffer, offset, buffer.length - offset, offset)
      checked(bytesRead, 'Media changed during verification.')
      offset += bytesRead
    }
    const after = await fd.stat()
    checked(
      after.size === st.size && after.mtimeMs === st.mtimeMs,
      'Media changed during verification.',
    )
    const ext = extname(file).toLowerCase()
    const mimeType =
      request.video &&
      ext === '.mp4' &&
      buffer.toString('ascii', 4, 8) === 'ftyp' &&
      /^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/.test(buffer.toString('ascii', 8, 12))
        ? 'video/mp4'
        : request.image &&
            ext === '.png' &&
            buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
          ? 'image/png'
          : request.image &&
              ['.jpg', '.jpeg'].includes(ext) &&
              buffer.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
            ? 'image/jpeg'
            : null
    checked(mimeType, 'The file must be an MP4 video or a PNG/JPEG photo of the selected type.')
    return { file: { name: basename(file), buffer, mimeType }, hash: sha256(buffer) }
  } finally {
    await fd.close()
  }
}
async function scoped(tab, platform, previous, openMissing, fn) {
  const browser = await connectBrowser()
  try {
    const { page, id } = await selectTab(browser, platform, previous, openMissing)
    checkOrigin(page, platform)
    return await exclusive(tab, sha256('tab:' + port() + ':' + id).slice(0, 32), () => fn(page, id))
  } finally {
    await browser.close()
  }
}
async function xActor(page, account) {
  checkOrigin(page, 'x')
  const profile = page.locator('a[data-testid="AppTabBar_Profile_Link"]')
  const href = (await profile.count()) === 1 && (await profile.getAttribute('href'))
  const u = href && new URL(href, page.url())
  checked(
    u &&
      u.origin === origins.x &&
      !u.username &&
      !u.password &&
      u.pathname.replace(/^\/|\/$/g, '').toLowerCase() === account.replace(/^@/, '').toLowerCase(),
    'Select the exact requested X profile.',
  )
}
const xEditor = '[data-testid="tweetTextarea_0"][contenteditable="true"]'
const xAttachments = '[data-testid="attachments"]'
async function xComposer(page, account, canOpen) {
  await xActor(page, account)
  let u = checkOrigin(page, 'x')
  if (u.pathname !== '/compose/post' && canOpen && !(await page.getByRole('dialog').count())) {
    const launch = await one(
      page.locator('a[data-testid="SideNav_NewTweet_Button"][href="/compose/post"]'),
      'Open a fresh top-level X post.',
    )
    await click(launch)
    await page.waitForURL('https://x.com/compose/post', { timeout: 4000 })
    u = checkOrigin(page, 'x')
  }
  checked(
    u.pathname === '/compose/post' && !u.search && !u.hash,
    'Open a fresh top-level X post without reply, quote or community context.',
  )
  let box = await onceVisible(page.getByRole('dialog'))
  if (!box && !(await page.getByRole('dialog').count()))
    box = await onceVisible(page.locator('main [data-testid="primaryColumn"]'))
  checked(box, 'Show one X composer.')
  checked(
    (await box.locator('[contenteditable="true"][data-testid^="tweetTextarea_"]').count()) === 1 &&
      !(await box
        .locator(
          'article,[data-testid="card.wrapper"],[data-testid="pollCreator"],[data-testid="quoteTweet"],[data-testid="reply-context"],[data-testid="geoPlace"],[data-testid="AudienceSelector"] [aria-checked="true"]',
        )
        .filter({ visible: true })
        .count()) &&
      !(await box
        .getByText(/^(replying to|quoting|posting to a community|post to community)(?:\s|$)/i)
        .filter({ visible: true })
        .count()),
    'Only an ordinary top-level X post is supported.',
  )
  await noExtra(box)
  return { box, editor: await one(box.locator(xEditor), 'Show one X post editor.') }
}
async function noExtra(box) {
  const enabled = box.locator(
    '[role="switch"][aria-checked="true"],input[type="checkbox"]:checked,[role="checkbox"][aria-checked="true"],tp-yt-paper-checkbox[checked]',
  )
  for (const item of await enabled.filter({ visible: true }).all()) {
    const label = await item.evaluate((e) =>
      [e.getAttribute('aria-label'), e.labels?.[0]?.innerText, e.parentElement?.innerText].join(
        ' ',
      ),
    )
    checked(
      !/also (?:share|post)|cross.?post|promote|boost|premiere|schedule|facebook|instagram|threads|community/i.test(
        label,
      ),
      'Turn off the additional destination, promotion, schedule or premiere.',
    )
  }
}
function xLink(raw, account) {
  try {
    const u = new URL(raw, origins.x)
    const m = u.pathname.match(/^\/([\w]{1,15})\/status\/(\d{1,22})\/?$/)
    if (
      u.origin === origins.x &&
      !u.username &&
      !u.password &&
      m &&
      m[1].toLowerCase() === account.replace(/^@/, '').toLowerCase()
    )
      return origins.x + '/' + m[1] + '/status/' + m[2]
  } catch {
    /* unrelated URL */
  }
}
async function xNotice(page, account) {
  checkOrigin(page, 'x')
  const notice = await onceVisible(
    page.locator('[data-testid="toast"],[role="alert"],[role="status"]').filter({
      hasText: /^(?:your post (?:was|has been) sent|post sent)\.?\s*(?:View(?: post)?)?$/i,
    }),
  )
  if (!notice || (await notice.evaluate((e) => !!e.closest('article,[contenteditable="true"]'))))
    return null
  const link = await onceVisible(notice.getByRole('link', { name: /^view(?: post)?$/i }))
  return link && xLink(await link.getAttribute('href'), account)
}
async function xEvidence(page, i, raw, text) {
  const url = xLink(raw, i.account)
  if (!url || !i.sentAt) return
  const detail = await page.context().newPage()
  try {
    const response = await detail.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 })
    if (!response?.ok() || xLink(detail.url(), i.account) !== url) return
    const articles = detail.locator('article[data-testid="tweet"]')
    await articles
      .first()
      .waitFor({ timeout: 3000 })
      .catch(() => {})
    for (const card of await articles.filter({ visible: true }).all()) {
      const match = await card.evaluate(
        (el, arg) => {
          const own = (selector) =>
            [...el.querySelectorAll(selector)].filter(
              (e) =>
                e.closest('article') === el && !e.closest('[data-testid="quoteTweet"],blockquote'),
            )
          const same = (s) =>
            (s || '')
              .replace(/\r\n/g, '\n')
              .replace(/\u00a0/g, ' ')
              .trim()
          const byline = own('[data-testid="User-Name"] a[href]').some(
            (a) => a.origin === location.origin && a.pathname.toLowerCase() === '/' + arg.handle,
          )
          const dated = own('a[href] time[datetime]').some((t) => {
            const a = t.closest('a'),
              time = Date.parse(t.dateTime)
            return (
              a.origin === location.origin &&
              a.pathname.toLowerCase() === arg.path.toLowerCase() &&
              time >= arg.at - 2000 &&
              time <= arg.at + 300000
            )
          })
          const bodies = own('[data-testid="tweetText"]'),
            images = own('[data-testid="tweetPhoto"] img'),
            videos = own('[data-testid="videoPlayer"] video,video[data-testid="videoPlayer"]')
          return (
            byline &&
            dated &&
            (bodies.length === 0
              ? !arg.text
              : bodies.length === 1 && same(bodies[0].innerText) === same(arg.text)) &&
            (arg.media === 'image'
              ? images.length === 1 && !videos.length
              : arg.media === 'video'
                ? videos.length === 1
                : !images.length && !videos.length)
          )
        },
        {
          handle: i.account.replace(/^@/, '').toLowerCase(),
          path: new URL(url).pathname,
          at: i.sentAt,
          text,
          media: i.kind,
        },
      )
      if (match) return url
    }
  } finally {
    await detail.close()
  }
}
async function waitXMedia(box, kind) {
  const holder = box.locator(xAttachments)
  if (!kind) {
    checked(
      !(await holder.filter({ visible: true }).count()),
      'Remove existing attachments from the X composer.',
    )
    return
  }
  const media = holder.locator(kind === 'image' ? 'img[src]' : 'video')
  await media.first().waitFor({ timeout: 8000 })
  checked(
    (await media.count()) === 1 &&
      !(await holder
        .locator(kind === 'image' ? 'video' : 'img[src]')
        .filter({ visible: true })
        .count()) &&
      !(await box.getByRole('progressbar').filter({ visible: true }).count()),
    'Wait for exactly one completed X media preview.',
  )
}
async function publishX(page, i, request, media, save) {
  const { box, editor } = await xComposer(page, i.account, false)
  const prior = norm(await inputText(editor))
  checked(!prior || prior === norm(request.text), 'Open an empty X composer.')
  await waitXMedia(box, null)
  if (media) {
    const pick = box.locator('input[type="file"][data-testid="fileInput"]')
    checked((await pick.count()) === 1, 'Open the X media picker.')
    await pick.setInputFiles(media.file)
  }
  await editor.fill(request.text || '')
  await waitXMedia(box, i.kind)
  await xComposer(page, i.account, false)
  checked(
    norm(await inputText(editor)) === norm(request.text),
    'The X caption changed in the composer.',
  )
  checked(!(await xNotice(page, i.account)), 'Dismiss the old X confirmation before retrying.')
  const send = await one(
    box.getByRole('button', { name: /^Post$/i }).and(box.locator('[data-testid="tweetButton"]')),
    'Show one final X Post button.',
  )
  checked(await send.isEnabled(), 'The X Post button is unavailable.')
  i.state = 'pending'
  i.sentAt = Date.now()
  await save()
  await click(send)
  const until = Date.now() + 3200
  do {
    const candidate = (await xNotice(page, i.account)) || xLink(page.url(), i.account)
    if (candidate) {
      i.candidate = candidate
      await save()
      const verified = await xEvidence(page, i, candidate, request.text || '')
      if (verified) {
        i.url = verified
        i.state = 'published'
        await save()
      }
      break
    }
    await page.waitForTimeout(120)
  } while (Date.now() < until)
}
async function studioActor(page, account) {
  const u = checkOrigin(page, 'youtube')
  checked(
    u.pathname.match(/^\/channel\/(UC[\w-]{22})(?:\/|$)/)?.[1] === account,
    'Open YouTube Studio on the exact requested channel. Its /channel/UC… address must remain visible.',
  )
  const channels = await page.locator('ytcp-navigation-drawer a[href]').evaluateAll((links) =>
    links
      .map((link) => {
        const url = new URL(link.href)
        return ['https://studio.youtube.com', 'https://www.youtube.com'].includes(url.origin)
          ? url.pathname.match(/^\/channel\/(UC[\w-]{22})(?:\/|$)/)?.[1]
          : null
      })
      .filter(Boolean),
  )
  checked(
    channels.length && channels.every((id) => id === account),
    'The Studio channel navigation must also identify the requested channel.',
  )
}
const uploadBox = (page) => page.locator('ytcp-uploads-dialog')
const pickers = (page) =>
  page.locator(
    'ytcp-uploads-dialog input[type="file"], ytcp-uploads-file-picker input[type="file"]',
  )
async function studioPicker(page, account, canOpen) {
  await studioActor(page, account)
  if (!(await pickers(page).count()) && canOpen) {
    checked(
      !(await page.getByRole('dialog').filter({ visible: true }).count()),
      'Close the existing Studio dialog before a new upload.',
    )
    const create = await one(
      page.getByRole('button', { name: /^(?:create|create a video or post)$/i }),
      'Open Create → Upload videos in the intended Studio channel.',
    )
    await click(create)
    await studioActor(page, account)
    const upload = await one(
      page
        .getByRole('menuitem', { name: /^upload videos$/i })
        .or(page.locator('tp-yt-paper-item').filter({ hasText: /^\s*Upload videos\s*$/i })),
      'Select Upload videos in Studio.',
    )
    await click(upload)
    await pickers(page).first().waitFor({ state: 'attached', timeout: 4000 })
  }
  await studioActor(page, account)
  const box =
    (await onceVisible(uploadBox(page))) ||
    (await onceVisible(page.locator('ytcp-uploads-file-picker')))
  checked(
    box &&
      !(await box
        .locator('ytcp-video-metadata-editor,#title-textarea')
        .filter({ visible: true })
        .count()),
    'Open the empty Upload videos file picker, separate from any existing draft.',
  )
  const chooser = box.locator('input[type="file"]')
  checked(
    (await chooser.count()) === 1 && (await chooser.evaluate((e) => !e.files.length)),
    'Open a fresh Studio single-video upload picker.',
  )
  return { box, chooser }
}
function ytVideoId(raw) {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' || u.port || u.username || u.password) return
    const id =
      u.hostname === 'youtu.be' && /^\/[\w-]{11}\/?$/.test(u.pathname)
        ? u.pathname.split('/')[1]
        : ['youtube.com', 'www.youtube.com'].includes(u.hostname) && u.pathname === '/watch'
          ? u.searchParams.get('v')
          : null
    if (videoId.test(id || '')) return id
  } catch {
    /* not a native watch link */
  }
}
const ytURL = (id) => 'https://www.youtube.com/watch?v=' + id
async function dialogVideoId(box) {
  const hrefs = await box
    .locator('a[href]')
    .evaluateAll((nodes) =>
      nodes
        .filter((e) => e.getClientRects().length && !e.closest('[contenteditable="true"]'))
        .map((e) => e.href),
    )
  const ids = [...new Set(hrefs.map(ytVideoId).filter(Boolean))]
  return ids.length === 1 ? ids[0] : null
}
async function selectRadio(root, selector, label) {
  const all = root.locator(selector).or(root.getByRole('radio', { name: label }))
  const radio = await one(all, 'The exact Studio audience or visibility selection is unavailable.')
  const isChecked = () =>
    radio.evaluate(
      (e) =>
        e.getAttribute('aria-checked') === 'true' ||
        e.checked === true ||
        e.hasAttribute('checked'),
    )
  if (!(await isChecked())) await click(radio)
  checked(await isChecked(), 'Studio did not confirm the selected audience or visibility.')
  return isChecked
}
const visibilityRadios = (box) =>
  box.locator(
    'tp-yt-paper-radio-button[name="PRIVATE"],tp-yt-paper-radio-button[name="PUBLIC"],tp-yt-paper-radio-button[name="UNLISTED"],[role="radio"][name="PRIVATE"],[role="radio"][name="PUBLIC"],[role="radio"][name="UNLISTED"]',
  )
async function studioSuccess(page, i, request) {
  await studioActor(page, i.account)
  if (!i.videoId) return
  // A preassigned watch link in the upload wizard is only a draft.
  const modal = await onceVisible(page.locator('ytcp-video-publish-dialog,ytcp-video-share-dialog'))
  if (
    i.sentAt &&
    modal &&
    !(await uploadBox(page).filter({ visible: true }).count()) &&
    (await dialogVideoId(modal)) === i.videoId
  ) {
    const text = await modal.innerText()
    const titles = await modal
      .locator('h1,h2,[role="heading"],#dialog-title,#title')
      .filter({ visible: true })
      .allTextContents()
    if (
      titles.some((t) => /^video published$/i.test(t.trim())) ||
      (titles.some((t) => /^video (?:saved|uploaded)$/i.test(t.trim())) &&
        text.split(/\r?\n/).some((s) => s.trim().toLowerCase() === request.privacy))
    )
      return ytURL(i.videoId)
  }
  // A Studio Content row can reconcile after the publish confirmation is gone.
  // Title, ID, visibility, and channel all have to identify the original video.
  const rows = page.locator('ytcp-video-row').filter({ visible: true })
  for (const row of await rows.all()) {
    const title = await onceVisible(row.locator('a#video-title'))
    if (
      !title ||
      norm(await title.innerText()) !== norm(request.title) ||
      (await row
        .getByText(/^draft$/i, { exact: true })
        .filter({ visible: true })
        .count())
    )
      continue
    const u = new URL(await title.getAttribute('href'), page.url())
    if (u.origin !== origins.youtube || u.pathname !== '/video/' + i.videoId + '/edit') continue
    const visible = await onceVisible(row.locator('.tablecell-visibility,#visibility'))
    if (visible && norm(await visible.innerText()).toLowerCase() === request.privacy)
      return ytURL(i.videoId)
  }
}
async function publishYouTube(page, i, r, media, save) {
  const { box: picker, chooser } = await studioPicker(page, i.account, false)
  await noExtra(picker)
  // Choosing a file creates a server-side draft. Persist uncertainty before
  // attaching any bytes so a crash can never create another upload.
  i.state = 'pending'
  i.uploadAt = Date.now()
  await save()
  await studioActor(page, i.account)
  await chooser.setInputFiles(media.file)
  const box = uploadBox(page)
  const title = box.locator('#title-textarea [contenteditable="true"]')
  const description = box.locator('#description-textarea [contenteditable="true"]')
  await title.first().waitFor({ timeout: 12000 })
  await studioActor(page, i.account)
  // Uploaded file gets a video ID before publication. Pin it before moving on.
  const end = Date.now() + 8000
  while (!i.videoId && Date.now() < end) {
    i.videoId = await dialogVideoId(box)
    if (!i.videoId) await page.waitForTimeout(200)
  }
  checked(i.videoId, 'Open the original upload and verify its assigned video link.')
  await save()
  const titleField = await one(title, 'Open the Studio video details and review its title.')
  const descField = await one(description, 'Open the Studio video description.')
  await titleField.fill(r.title)
  await descField.fill(r.text || '')
  const forKids = r.audience === 'kids'
  const flag = forKids ? 'VIDEO_MADE_FOR_KIDS_MFK' : 'VIDEO_MADE_FOR_KIDS_NOT_MFK'
  const audienceChecked = await selectRadio(
    box,
    'tp-yt-paper-radio-button[name="' + flag + '"]',
    forKids ? /^yes,? it.?s made for kids/i : /^no,? it.?s not made for kids/i,
  )
  checked(
    (await audienceChecked()) &&
      norm(await inputText(titleField)) === norm(r.title) &&
      norm(await inputText(descField)) === norm(r.text),
    'Studio details changed before leaving the Details step.',
  )
  for (let n = 0; n < 4 && !(await visibilityRadios(box).filter({ visible: true }).count()); n++) {
    await studioActor(page, i.account)
    await noExtra(box)
    if (n > 0)
      checked(
        await box
          .getByRole('heading', { name: /^(video elements|checks)$/i })
          .or(
            box
              .locator(
                'ytcp-video-elements,ytcp-video-checks,ytcp-uploads-video-elements,ytcp-uploads-checks,#step-title',
              )
              .filter({ hasText: /video elements|checks/i }),
          )
          .filter({ visible: true })
          .count(),
        'Review the unexpected Studio step in the original upload.',
      )
    const next = await one(
      box.getByRole('button', { name: /^next$/i }),
      'Complete the required native Studio steps in this original upload.',
    )
    const old = await box.innerText()
    await click(next)
    const deadline = Date.now() + 2000
    while ((await box.innerText()) === old && Date.now() < deadline) await page.waitForTimeout(100)
  }
  checked(
    await visibilityRadios(box).filter({ visible: true }).count(),
    'Review the Visibility step in the original upload.',
  )
  const mode = r.privacy.toUpperCase()
  const visibilityChecked = await selectRadio(
    box,
    'tp-yt-paper-radio-button[name="' + mode + '"],[role="radio"][name="' + mode + '"]',
    new RegExp('^' + r.privacy + '$', 'i'),
  )
  const saveButton = await one(
    box.getByRole('button', { name: r.privacy === 'public' ? /^publish$/i : /^save$/i }),
    'Review the exact final Publish or Save button.',
  )
  await studioActor(page, i.account)
  await noExtra(box)
  checked(
    (await visibilityChecked()) &&
      (await dialogVideoId(box)) === i.videoId &&
      (await saveButton.isEnabled()) &&
      !(await page
        .locator('ytcp-video-publish-dialog,ytcp-video-share-dialog')
        .filter({ visible: true })
        .count()),
    'The final visibility or completion state is ambiguous.',
  )
  i.sentAt = Date.now()
  await save()
  await click(saveButton)
  const until = Date.now() + 4200
  do {
    const verified = await studioSuccess(page, i, r)
    if (verified) {
      i.state = 'published'
      i.url = verified
      await save()
      return
    }
    await page.waitForTimeout(150)
  } while (Date.now() < until)
}
const receipt = (i) => ({
  id: i.id,
  state: i.state,
  ...(i.url && { url: i.url }),
  ...(i.state === 'pending' && { next: pending }),
})
const retry = (e) => ({
  state: 'needs_input',
  safeToRetry: true,
  next:
    e instanceof InputError || e?.state?.startsWith('needs_')
      ? e.message
      : 'Inspect the original native tab, approved file and composer, then retry the same key.',
})
const requestDigest = (t, r) =>
  sha256(
    JSON.stringify([
      t.platform,
      t.account,
      r.key,
      r.text || '',
      r.image || '',
      r.video || '',
      r.title || '',
      r.audience || '',
      r.privacy || '',
    ]),
  )
export async function launchExtraBrowser(platform) {
  checked(Object.hasOwn(origins, platform), 'Choose x or youtube.')
  await launchBrowser(await privateDirectory(), platform)
  return { state: 'browser_closed' }
}
export function createExtraBrowserAdapter() {
  async function perform(mode, t, r, prior = {}) {
    const dir = await privateDirectory()
    const id = forKey(r.key)
    const fingerprint = requestDigest(t, r)
    return exclusive(dir, id, async () => {
      let i = await loadIntent(dir, id).catch((e) => {
        if (e.code !== 'ENOENT') throw e
      })
      if ((i && i.fingerprint !== fingerprint) || (prior.id && prior.id !== id))
        return retry(
          new InputError('Use the approved destination and unchanged request with this key.'),
        )
      if (i?.state === 'published' || (i?.state === 'pending' && mode !== 'status'))
        return receipt(i)
      const save = () => saveIntent(dir, i)
      try {
        validate(t, r)
        if (mode === 'status') {
          if (!i) return { state: 'pending', id, next: pending }
          if (i.state !== 'pending')
            return {
              ...retry(
                new InputError(
                  'This original intent has no native submission. Resume with the same key.',
                ),
              ),
              id,
            }
          return await scoped(dir, t.platform, i.tab, false, async (page) => {
            const raw = prior.observedUrl || i.candidate
            let verified
            if (t.platform === 'youtube') {
              if (!prior.observedUrl || (i.videoId && ytVideoId(prior.observedUrl) === i.videoId))
                verified = await studioSuccess(page, i, r)
            } else {
              const candidate =
                raw || (await xNotice(page, i.account)) || xLink(page.url(), i.account)
              if (candidate) verified = await xEvidence(page, i, candidate, r.text || '')
            }
            if (verified) {
              i.url = verified
              i.state = 'published'
              await save()
            }
            return receipt(i)
          })
        }
        const media = await mediaFor(r)
        if (i && (i.hash || null) !== (media?.hash || null))
          need('The media changed. Approve the new file with a new key.')
        if (mode === 'preview') {
          return await scoped(dir, t.platform, i?.tab || null, true, async (page, tab) => {
            if (t.platform === 'x') {
              const { box, editor } = await xComposer(page, t.account, true)
              await waitXMedia(box, null)
              checked(
                !norm(await inputText(editor)) || norm(await inputText(editor)) === norm(r.text),
                'Open an empty X composer.',
              )
            } else await studioPicker(page, t.account, true)
            i = {
              id,
              fingerprint,
              account: t.account,
              platform: t.platform,
              state: 'ready',
              tab,
              kind: r.image ? 'image' : r.video ? 'video' : null,
              hash: media?.hash || null,
            }
            await save()
            return receipt(i)
          })
        }
        checked(
          i?.state === 'ready' && prior.state === 'ready' && prior.id === id,
          'Preview this exact native destination first.',
        )
        return await scoped(dir, t.platform, i.tab, false, async (page) => {
          if (t.platform === 'x') await publishX(page, i, r, media, save)
          else await publishYouTube(page, i, r, media, save)
          return receipt(i)
        })
      } catch (e) {
        if (i?.state === 'pending') return receipt(i)
        return { ...retry(e), id }
      }
    })
  }
  return {
    preview: (target, request) => perform('preview', target, request),
    publish: (target, request, ready) => perform('publish', target, request, ready),
    status: (target, request, receipt) => perform('status', target, request, receipt),
  }
}
