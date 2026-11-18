import { ensureBrowserRuntime } from './skill-runtime.mjs'
import path from 'node:path'
import { InputError, accountKey, normalized, platforms, readPhoto } from './intent.mjs'

const nativeSites = { ...platforms, x: 'https://x.com/', youtube: 'https://studio.youtube.com/' }

const createNames = {
  facebook: /^(create (a )?post|what['’]s on your mind(?:, .*)?\??|建立貼文|發佈近況)$/i,
  instagram: /^(create|create new post|new post|建立|建立新貼文)$/i,
  threads: /^(create|new thread|start a thread|what['’]s new\??|新增串文|建立串文)$/i,
}
const finalNames = {
  facebook: /^(post|publish|發佈|發布)$/i,
  instagram: /^(share|分享)$/i,
  threads: /^(post|發佈|發布)$/i,
}
const nextNames = /^(next|continue|下一步|繼續)$/i
const alertSelector = '[role="status"], [role="alert"], [role="dialog"]'
const successText =
  /^(?:(?:your (?:post|thread) (?:has been |was )?(?:shared|published|posted)|(?:post|thread) (?:shared|published|posted))|(?:貼文|串文)已(?:分享|發佈|發布))[.!。！]?(?:\s*(?:view|see|go to) (?:your |the )?(?:post|thread)|\s*(?:查看|檢視)(?:貼文|串文))?$/i
const viewText = /^(?:view|see|go to) (?:your |the )?(?:post|thread)$|^(?:查看|檢視)(?:貼文|串文)$/i
export class NeedsInput extends Error {
  constructor(state, message) {
    super(message)
    this.state = state
  }
}
const need = (state, message) => {
  throw new NeedsInput(state, message)
}
export function port() {
  const n = Number(process.env.META_POST_PORT || 9222)
  if (!Number.isInteger(n) || n < 1024 || n > 65535)
    throw new InputError('META_POST_PORT must be a local port between 1024 and 65535.')
  return n
}
export async function launchBrowser(directory, platform) {
  const { chromium } = await ensureBrowserRuntime()
  const ctx = await chromium.launchPersistentContext(path.join(directory, 'chrome'), {
    channel: 'chrome',
    headless: false,
    args: [`--remote-debugging-port=${port()}`, '--remote-debugging-address=127.0.0.1'],
  })
  try {
    const page = ctx.pages()[0] || (await ctx.newPage())
    await page.goto(nativeSites[platform], { waitUntil: 'domcontentloaded' })
    console.log(
      JSON.stringify({
        state: 'browser_open',
        platform,
        port: port(),
        next: 'Sign in on the native website if needed. Leave this terminal open.',
      }),
    )
    await new Promise((resolve) => ctx.once('close', resolve))
  } finally {
    await ctx.close()
  }
}
export async function connectBrowser() {
  const { chromium } = await ensureBrowserRuntime()
  try {
    return await chromium.connectOverCDP(`http://127.0.0.1:${port()}`, { timeout: 4500 })
  } catch {
    need(
      'needs_browser',
      'Open a browser with the browser command or connect your own loopback Chrome debugging session.',
    )
  }
}
function onPlatform(url, platform) {
  try {
    const u = new URL(url),
      root = new URL(nativeSites[platform]).hostname.replace(/^www\./, '')
    return (
      u.protocol === 'https:' &&
      [root, 'www.' + root].includes(u.hostname) &&
      !u.port &&
      !u.username &&
      !u.password
    )
  } catch {
    return false
  }
}
export function postURL(url, platform) {
  if (!onPlatform(url, platform)) return null
  const u = new URL(url)
  if (platform === 'facebook' && ['/permalink.php', '/story.php'].includes(u.pathname)) {
    const post = u.searchParams.get('story_fbid'),
      page = u.searchParams.get('id')
    if (!post || !page) return null
    u.search = ''
    u.searchParams.set('story_fbid', post)
    u.searchParams.set('id', page)
  } else {
    const patterns = {
      facebook: /^\/[^/]+\/posts\/[^/]+\/?$/,
      instagram: /^\/(?:p|reel)\/[\w-]+\/?$/,
      threads: /^\/@[\w.]+\/post\/[\w-]+\/?$/,
    }
    if (!patterns[platform].test(u.pathname)) return null
    u.search = ''
  }
  u.hash = ''
  return u.href
}
async function tabId(page) {
  const s = await page.context().newCDPSession(page)
  try {
    return (await s.send('Target.getTargetInfo')).targetInfo.targetId
  } finally {
    await s.detach()
  }
}
export async function selectTab(browser, platform, previous, openIfMissing) {
  const context = browser.contexts()[0]
  if (!context) need('needs_browser', 'Open a regular Chrome window.')
  const pages = context.pages().filter((p) => onPlatform(p.url(), platform))
  let page
  if (previous) {
    for (const candidate of pages)
      if ((await tabId(candidate)) === previous) {
        page = candidate
        break
      }
  } else if (pages.length === 1) page = pages[0]
  else if (pages.length > 1) {
    const visible = []
    for (const p of pages)
      if (await p.evaluate(() => document.visibilityState === 'visible').catch(() => false))
        visible.push(p)
    if (visible.length === 1) page = visible[0]
  } else if (openIfMissing) {
    page = await context.newPage()
    await page.goto(nativeSites[platform], { waitUntil: 'domcontentloaded', timeout: 20000 })
  }
  if (!page)
    need(
      'needs_tab',
      previous
        ? 'Reopen the original tab, or use status with the actual post URL.'
        : 'Focus one native platform tab and retry.',
    )
  page.setDefaultTimeout(4500)
  return { page, id: await tabId(page) }
}
async function only(locator) {
  const candidates = locator.filter({ visible: true })
  return (await candidates.count()) === 1 ? candidates : null
}
const button = async (root, name) =>
  only(root.getByRole('button', { name }).or(root.getByRole('link', { name })))
const composeTitles = {
  facebook: /^(?:create (?:a )?post|new post|post settings|建立貼文|新增貼文|貼文設定)$/i,
  instagram: /^(?:create new post|new post|crop|edit|建立新貼文|新增貼文|裁切|編輯)$/i,
  threads: /^(?:new thread|create thread|新增串文|建立串文)$/i,
}
async function dialog(page, platform) {
  const box = await only(page.locator('[role="dialog"], dialog[open]'))
  if (!box) return null
  const title = (await box.getAttribute('aria-label')) || ''
  const headings = await box
    .locator('h1,h2,h3,[role="heading"],header')
    .filter({ visible: true })
    .allInnerTexts()
  const names = [title, ...headings].map((x) => x.trim())
  return names.some((n) => composeTitles[platform].test(n)) ? box : null
}
const editors = (root) =>
  root.locator(
    'textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"][data-lexical-editor="true"]',
  )
export async function composer(page, platform) {
  if (!onPlatform(page.url(), platform))
    need('needs_login', 'Complete sign-in on the native platform in the browser.')
  let box = await dialog(page, platform)
  if (box) return box
  if (await page.locator('[role="dialog"], dialog[open]').filter({ visible: true }).count())
    need(
      'needs_composer',
      'Close the other dialog and open a new top-level post. Replies and edits are separate actions.',
    )
  const ctl = await button(page, createNames[platform])
  if (ctl) {
    await ctl.click()
    await page
      .locator('[role="dialog"], dialog[open]')
      .first()
      .waitFor({ state: 'visible', timeout: 1700 })
      .catch(() => {})
  }
  box = await dialog(page, platform)
  if (box) return box
  if (platform === 'instagram') {
    const menu = await only(page.getByRole('menu'))
    const post = menu && (await only(menu.getByRole('menuitem', { name: /^(post|貼文)$/i })))
    if (post) {
      await post.click()
      await page
        .locator('[role="dialog"], dialog[open]')
        .first()
        .waitFor({ state: 'visible', timeout: 1700 })
        .catch(() => {})
      box = await dialog(page, platform)
      if (box) return box
    }
  }
  need(
    'needs_composer',
    'Open a new post on the intended account in this tab. Leave its composer visible and retry.',
  )
}
export async function verifyActor(page, root, platform, account) {
  // Use composer attribution and the signed-in profile control. Feed authors and user-entered captions are never identity evidence.
  const actor = accountKey(account)
  const result = await root.evaluate(
    (scope, { actor, platform }) => {
      const norm = (x) => (x || '').trim().replace(/^@/, '').toLowerCase()
      const visible = (e) => e.getClientRects().length > 0
      const profileMatches = (link) => {
        try {
          const u = new URL(link.href, location.href)
          return (
            u.origin === location.origin &&
            norm(decodeURIComponent(u.pathname.replace(/^\//, '').replace(/\/$/, ''))) === actor
          )
        } catch {
          return false
        }
      }
      const isAuthor = (e) =>
        visible(e) &&
        !e.closest('textarea,[contenteditable="true"],article,[role="article"],blockquote')
      const editor = scope.querySelector('textarea,[contenteditable="true"]')
      const beforeEditor = (e) =>
        !editor || Boolean(e.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING)
      const links = [...scope.querySelectorAll('a[href]')].filter(
        (e) =>
          isAuthor(e) && beforeEditor(e) && !e.closest('[role="listbox"],[role="menu"],footer'),
      )
      const viaComposer = links.some((a) => profileMatches(a))
      const conflictingHandle = links.some((a) => {
        const url = new URL(a.href, location.href)
        const handle = url.pathname.match(/^\/@?([\w.]+)\/?$/)?.[1]
        return (
          url.origin === location.origin &&
          handle &&
          norm(a.innerText) === norm(handle) &&
          norm(handle) !== actor
        )
      })
      if (platform !== 'facebook' && conflictingHandle) return false
      const nav = [
        ...document.querySelectorAll('nav a[href], [role="navigation"] a[href], header a[href]'),
      ].filter(isAuthor)
      const viaNav = nav.some(
        (a) =>
          profileMatches(a) &&
          /profile|個人檔案|個人主頁/i.test(
            [
              a.getAttribute('aria-label'),
              a.innerText,
              ...[...a.querySelectorAll('[aria-label],[alt],title')].map(
                (n) => n.getAttribute('aria-label') || n.getAttribute('alt') || n.textContent,
              ),
            ].join(' '),
          ),
      )
      const labels = [...scope.querySelectorAll('[aria-label],img[alt]')]
        .filter((e) => isAuthor(e) && beforeEditor(e))
        .map((e) => e.getAttribute('aria-label') || e.getAttribute('alt') || '')
      const explicit = labels
        .filter((x) => /^posting as (?:page[:：]? )?/i.test(x))
        .map((x) => norm(x.replace(/^posting as (?:page[:：]? )?/i, '')))
      const pictures = labels
        .map((label) => label.match(/^@?(.+?)(?:'s|’s) profile picture$/i)?.[1])
        .filter(Boolean)
        .map(norm)
      if (explicit.some((x) => x !== actor) || pictures.some((x) => x !== actor)) return false
      const labeled = labels.some((label) =>
        [
          'posting as ' + actor,
          actor + "'s profile picture",
          actor + '’s profile picture',
          '@' + actor + "'s profile picture",
          '以 ' + actor + ' 的身分發佈',
        ].includes(label.trim().toLowerCase()),
      )
      const pageSignal =
        labels.some(
          (v) =>
            /^(?:facebook page|posting as page)\s*[:：]?\s*/i.test(v) &&
            norm(v.replace(/^(?:facebook page|posting as page)\s*[:：]?\s*/i, '')) === actor,
        ) ||
        [...document.querySelectorAll('[role="navigation"],nav,header')]
          .filter(visible)
          .some((n) =>
            /manage page|page settings|管理粉絲專頁|粉絲專頁設定/i.test(n.innerText || ''),
          )
      return platform === 'facebook'
        ? pageSignal &&
            (viaComposer ||
              labeled ||
              labels.some((v) => norm(v.replace(/^posting as page\s*[:：]?\s*/i, '')) === actor))
        : viaComposer || viaNav || labeled
    },
    { actor, platform },
  )
  if (!result)
    need(
      'needs_account',
      `Select the requested ${platform === 'facebook' ? 'Facebook Page' : 'profile'} in the native site, or open its composer with the author visible.`,
    )
}
async function ensureNoCrosspost(box) {
  const enabled = box
    .getByRole('switch', { checked: true })
    .or(box.getByRole('checkbox', { checked: true }))
    .filter({ visible: true })
  for (const item of await enabled.all()) {
    const label = await item.evaluate((e) =>
      [e.getAttribute('aria-label'), e.labels?.[0]?.innerText, e.parentElement?.innerText].join(
        ' ',
      ),
    )
    if (
      /facebook|instagram|threads|cross.?post|also share|boost|promote|同時分享|推廣/i.test(label)
    )
      need('needs_destination', 'Disable the additional cross-post destination and retry.')
  }
}
const removeMedia = (box) =>
  box
    .getByRole('button', {
      name: /remove (?:photo|image|media|attachment)|移除(?:相片|圖片|附件|媒體)/i,
    })
    .filter({ visible: true })
const previews = (box) => box.locator('img[src],video[src]').filter({ visible: true })
async function mediaPreviews(box) {
  return previews(box).evaluateAll(
    (nodes) =>
      nodes.filter(
        (n) =>
          !n.closest('a[href],header,[role="heading"]') &&
          !/profile|avatar|頭像|大頭照/i.test(n.alt || '') &&
          (n.currentSrc?.startsWith('blob:') ||
            /preview|selected (?:photo|image)|相片預覽/i.test(n.alt || '')),
      ).length,
  )
}
async function mediaCount(box) {
  return Math.max(await removeMedia(box).count(), await mediaPreviews(box))
}
async function waitPhoto(box) {
  const until = Date.now() + 7000
  do {
    if (
      (await mediaCount(box)) === 1 &&
      !(await box
        .locator('[role="progressbar"],[aria-busy="true"]')
        .filter({ visible: true })
        .count())
    )
      return
    await box.page().waitForTimeout(160)
  } while (Date.now() < until)
  need(
    'needs_review',
    'A single completed image preview could not be verified. Inspect the composer; do not submit a caption alone.',
  )
}
export async function stage(page, box, intent) {
  const { platform, text, photo } = intent.input
  await verifyActor(page, box, platform, intent.input.account)
  await ensureNoCrosspost(box)
  // Start from a fresh composer so no previous attachment or audience choice can silently join this post.
  if ((await mediaCount(box)) > 0)
    need('needs_composer', 'Open an empty composer. It already contains media.')
  let editor = await only(editors(box))
  if (editor) {
    const prior = normalized(await editor.evaluate((e) => e.value ?? e.innerText))
    if (prior && prior !== normalized(text))
      need('needs_composer', 'This composer contains different text. Open an empty composer.')
  }
  if (photo) {
    const { buffer, sha256, mime } = await readPhoto(photo.path)
    if (sha256 !== photo.sha256)
      need('changed_media', 'The selected image changed. Preview it with a new key.')
    const chooser = box.locator('input[type="file"]')
    if ((await chooser.count()) !== 1) {
      const attach = await button(
        box,
        /^(?:photo\/video|add media|attach media|select from computer|相片\/影片|從電腦選擇)$/i,
      )
      if (!attach)
        need('needs_media_control', 'Open the image picker for this empty composer and retry.')
      const [pick] = await Promise.all([page.waitForEvent('filechooser'), attach.click()])
      await pick.setFiles({ name: path.basename(photo.path), mimeType: mime, buffer })
    } else await chooser.setInputFiles({ name: path.basename(photo.path), mimeType: mime, buffer })
  }
  if (photo) await waitPhoto(box)
  if (platform === 'instagram') {
    for (let n = 0; n < 3; n++) {
      editor = await only(editors(box))
      if (editor) break
      const next = await button(box, nextNames)
      if (!next) break
      await next.click()
      await editors(box)
        .first()
        .waitFor({ state: 'visible', timeout: 850 })
        .catch(() => {})
      box = (await dialog(page, platform)) || box
    }
  }
  editor = await only(editors(box))
  if (!editor) need('needs_composer', 'Show the caption editor in the native post composer.')
  await editor.fill(text)
  if (normalized(await editor.evaluate((e) => e.value ?? e.innerText)) !== normalized(text))
    need('needs_review', 'The native caption differs from the preview.')
  let send = await button(box, finalNames[platform])
  if (!send && platform === 'facebook') {
    const next = await button(box, nextNames)
    if (next) {
      await next.click()
      box = (await dialog(page, platform)) || box
      send = await button(box, finalNames[platform])
    }
  }
  await verifyActor(page, box, platform, intent.input.account)
  await ensureNoCrosspost(box)
  const finalEditor = await only(editors(box))
  if (
    finalEditor &&
    normalized(await finalEditor.evaluate((e) => e.value ?? e.innerText)) !== normalized(text)
  )
    need('needs_review', 'The native caption changed before submission.')
  if (photo) await waitPhoto(box)
  else if ((await mediaCount(box)) > 0) need('needs_review', 'Unexpected media is attached.')
  if (!send || !(await send.isEnabled()))
    need('needs_review', 'The native final submit control is unavailable or ambiguous.')
  return send
}
export async function confirmation(page, platform) {
  const notices = await only(page.locator(alertSelector).filter({ hasText: successText }))
  if (
    !notices ||
    (await notices.evaluate(
      (n) => !!n.closest('article,[role="article"],blockquote,[contenteditable="true"]'),
    ))
  )
    return null
  const view = await only(notices.getByRole('link', { name: viewText }))
  const href = view && (await view.getAttribute('href'))
  return { confirmed: true, url: href ? postURL(new URL(href, page.url()).href, platform) : null }
}

// Threads renders its timestamp as a permalink, including on layouts without an article
// or heading. Never combine a caption with a byline or timestamp from a different card.
async function threadsTextLinks(page, intent) {
  const { text, account } = intent.input
  const caption = normalized(text)
  if (!caption || intent.input.photo) return []
  const matches = page.getByText(caption, { exact: true })
  await matches
    .first()
    .waitFor({ state: 'attached', timeout: 3500 })
    .catch(() => {})
  return matches.evaluateAll(
    (elements, { actor, caption, start, profile }) => {
      const urls = new Set()
      const contentCard = 'article,[role="article"],[data-pressable-container="true"]'
      const card = contentCard + ',[data-virtualized]'
      const excluded = 'blockquote,[role="comment"],[contenteditable="true"],[role="dialog"]'
      const stop = 'main,[role="main"],[role="region"],[role="feed"],body,html'
      const norm = (s) =>
        (s || '')
          .replace(/\u00a0/g, ' ')
          .replace(/\r\n/g, '\n')
          .trim()
      function postScope(element, boundary) {
        for (
          let node = element.parentElement;
          node && !node.matches(stop);
          node = node.parentElement
        ) {
          if (node.querySelector('time[datetime]')) return node
          if (node === boundary) break
        }
        return null
      }
      for (const element of elements) {
        if (
          !element.getClientRects().length ||
          norm(element.innerText) !== caption ||
          element.closest(excluded + ',a,[role="link"],button,[role="button"]')
        )
          continue
        const boundary = element.closest(card)
        // On the profile, each top-level timeline item has its own card boundary.
        if (profile && !boundary) continue
        const outer = boundary?.parentElement?.closest(card)
        // Signed-in timelines wrap the post's pressable card in a virtualized
        // list item. A separate byline/timestamp outside the card signals a nested post.
        if (
          outer &&
          (!outer.matches('[data-virtualized]') ||
            outer.matches(contentCard) ||
            outer.parentElement?.closest(card) ||
            [...outer.querySelectorAll('time[datetime]')].some((t) => !boundary.contains(t)))
        )
          continue
        if (!element.closest('[lang],[dir="auto"],article,[role="article"]')) continue
        const scope = postScope(element, boundary)
        const times = scope?.querySelectorAll('time[datetime]')
        if (times?.length !== 1) continue
        const time = times[0]
        const link = time.closest('a[href]')
        if (
          !link ||
          !time.getClientRects().length ||
          time.closest(card) !== boundary ||
          link.closest(excluded) ||
          !(time.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
        )
          continue
        const url = new URL(link.href)
        const parts = url.pathname.replace(/\/$/, '').split('/')
        if (
          url.origin !== location.origin ||
          parts.length !== 4 ||
          parts[1].toLowerCase() !== '@' + actor ||
          parts[2] !== 'post' ||
          !/^[\w-]+$/.test(parts[3])
        )
          continue
        const stamp = Date.parse(time.dateTime)
        if (
          !Number.isFinite(stamp) ||
          stamp < start - 1500 ||
          stamp > Math.min(start + 60000, Date.now() + 1500)
        )
          continue
        const author = [...scope.querySelectorAll('a[href]')].some((a) => {
          const u = new URL(a.href)
          return (
            a.getClientRects().length &&
            !a.closest(excluded) &&
            a.closest(card) === boundary &&
            Boolean(a.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) &&
            u.origin === location.origin &&
            u.pathname.replace(/\/$/, '').toLowerCase() === '/@' + actor &&
            norm(a.innerText).replace(/^@/, '').toLowerCase() === actor
          )
        })
        if (author) urls.add(url.origin + '/' + parts.slice(1).join('/'))
      }
      return [...urls]
    },
    {
      actor: accountKey(account),
      caption,
      start: Date.parse(intent.submittedAt),
      profile: !postURL(page.url(), 'threads'),
    },
  )
}

export async function findThreadsPermalink(context, intent) {
  const actor = accountKey(intent.input.account)
  if (
    intent.input.platform !== 'threads' ||
    !/^[a-z0-9_.]+$/.test(actor) ||
    !normalized(intent.input.text) ||
    intent.input.photo ||
    !Number.isFinite(Date.parse(intent.submittedAt))
  )
    return null
  const url = new URL('/@' + actor, nativeSites.threads)
  const page = await context.newPage()
  let links
  try {
    const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 10000 })
    const landed = new URL(page.url())
    if (
      !response?.ok() ||
      landed.origin !== url.origin ||
      landed.pathname.toLowerCase().replace(/\/$/, '') !== url.pathname
    )
      return null
    links = await threadsTextLinks(page, intent)
  } finally {
    await page.close()
  }
  if (links.length !== 1) return null
  return (await verifyPost(context, intent, links[0])) ? links[0] : null
}

export async function verifyPost(context, intent, candidate, { fromReceipt = false } = {}) {
  const { platform, account, text, photo } = intent.input
  const link = postURL(candidate, platform)
  if (!link || !intent.submittedAt) return false
  if (
    platform === 'threads' &&
    accountKey(new URL(link).pathname.split('/')[1]) !== accountKey(account)
  )
    return false
  const page = await context.newPage()
  try {
    const res = await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 15000 })
    if (!res?.ok() || postURL(page.url(), platform) !== link) return false
    if (platform === 'threads' && text && !photo) {
      const links = await threadsTextLinks(page, intent)
      // A timestamp linked to another post must not fall through to the older
      // semantic article layout, which has no permalink on its time element.
      if (links.length || (await page.locator('a[href] time[datetime]').count()))
        return links.length === 1 && links[0] === link.replace(/\/$/, '')
    }
    const articles = page.locator('article,[role="article"]')
    await articles
      .first()
      .waitFor({ timeout: 4000 })
      .catch(() => {})
    const card = articles.filter({ visible: true }).first()
    if (!(await card.count())) return false
    return await card.evaluate(
      (e, { actor, caption, start, requireTime, hasPhoto }) => {
        const norm = (s) =>
          (s || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\r\n/g, '\n')
            .trim()
        const lower = (s) => norm(s).replace(/^@/, '').toLowerCase()
        const belongsToPost = (n) =>
          n.closest('article,[role="article"]') === e && !n.closest('blockquote,[role="comment"]')
        const byline = [...e.querySelectorAll('header,[role="heading"],h2,h3')].find(belongsToPost)
        if (!byline) return false
        const author = [
          ...byline.querySelectorAll('a[href]'),
          ...(byline.matches('a[href]') ? [byline] : []),
        ].some((a) => {
          const u = new URL(a.href, location.href)
          return (
            u.origin === location.origin &&
            (lower(a.innerText) === actor ||
              lower(u.pathname.replace(/^\//, '').replace(/\/$/, '')) === actor)
          )
        })
        const body =
          !caption ||
          [...e.querySelectorAll('div,span,p,h1')].some(
            (n) => belongsToPost(n) && norm(n.innerText) === norm(caption),
          )
        const t = [...e.querySelectorAll('time[datetime]')]
          .find(belongsToPost)
          ?.getAttribute('datetime')
        const time = t ? Date.parse(t) : NaN
        return (
          author &&
          body &&
          (!hasPhoto ||
            [...e.querySelectorAll('img[src],video')].some(
              (n) =>
                belongsToPost(n) &&
                !byline.contains(n) &&
                !/profile|avatar|頭像/i.test(n.alt || ''),
            )) &&
          (!requireTime ||
            (caption &&
              Number.isFinite(time) &&
              time >= start - 1500 &&
              time <= start + 10 * 60 * 1000 &&
              time <= Date.now() + 1500))
        )
      },
      {
        actor: accountKey(account),
        caption: text,
        start: Date.parse(intent.submittedAt),
        requireTime: !fromReceipt,
        hasPhoto: Boolean(photo),
      },
    )
  } finally {
    await page.close()
  }
}
