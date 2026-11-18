#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import {
  InputError,
  createIntent,
  exclusive,
  loadIntent,
  privateDirectory,
  requirePlatform,
  saveIntent,
  sha256,
} from './intent.mjs'
import {
  composer,
  confirmation,
  connectBrowser,
  launchBrowser,
  NeedsInput,
  port,
  postURL,
  selectTab,
  stage,
  verifyActor,
  verifyPost,
} from './native.mjs'

const help = `meta-post browser PLATFORM
meta-post preview PLATFORM --account NAME --key KEY --text CAPTION [--image FILE]
meta-post publish --id ID
meta-post status --id ID [--url OBSERVED_POST_URL]
PLATFORM is facebook (Page), instagram (feed image), or threads. A preview keeps text and media local. Publish prepares the composer and submits once. Use status after an uncertain result.`
const receipt = (i, extra = {}) => ({
  id: i.id,
  platform: i.input.platform,
  account: i.input.account,
  state: i.state,
  ...(i.url ? { url: i.url } : {}),
  ...extra,
})
const terminal = (i) => i.state === 'published' || i.state === 'pending'
async function withBrowser(action) {
  const browser = await connectBrowser()
  try {
    return await action(browser)
  } finally {
    await browser.close()
  }
}
export async function run(argv) {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      account: { type: 'string' },
      text: { type: 'string' },
      image: { type: 'string' },
      key: { type: 'string' },
      id: { type: 'string' },
      url: { type: 'string' },
    },
  })
  if (v.help || !positionals.length) return { usage: help }
  const [command, platform] = positionals
  const accepted = {
    browser: [],
    preview: ['account', 'text', 'image', 'key'],
    publish: ['id'],
    status: ['id', 'url'],
  }
  if (
    !Object.hasOwn(accepted, command) ||
    Object.keys(v).some((k) => !accepted[command].includes(k)) ||
    positionals.length !== (['browser', 'preview'].includes(command) ? 2 : 1)
  )
    throw new InputError(help)
  const dir = await privateDirectory()
  if (command === 'browser') {
    await launchBrowser(dir, requirePlatform(platform))
    return { state: 'browser_closed' }
  }
  if (command === 'preview') {
    const i = await createIntent(dir, platform, v)
    if (terminal(i)) return receipt(i)
    try {
      return await exclusive(dir, i.id, async () => {
        const current = await loadIntent(dir, i.id)
        if (terminal(current)) return receipt(current)
        current.state = 'preview'
        delete current.tab
        await saveIntent(dir, current)
        return withBrowser(async (b) => {
          const { page, id } = await selectTab(b, platform, null, true)
          const box = await composer(page, platform)
          await verifyActor(page, box, platform, i.input.account)
          current.tab = id
          current.state = 'ready'
          await saveIntent(dir, current)
          return receipt(current, {
            caption: current.input.text,
            image: current.input.photo ? { sha256: current.input.photo.sha256 } : null,
          })
        })
      })
    } catch (e) {
      if (e instanceof NeedsInput) return receipt(i, { state: e.state, next: e.message })
      throw e
    }
  }
  const original = await loadIntent(dir, v.id)
  if (command === 'status') {
    if (!original.submittedAt || original.url) return receipt(original)
    if (v.url && !postURL(v.url, original.input.platform))
      throw new InputError('Supply the observed native permalink for this platform.')
    try {
      return await withBrowser(async (b) => {
        let candidate = v.url
        if (!candidate) {
          const { page } = await selectTab(b, original.input.platform, original.tab, false)
          const notice = await confirmation(page, original.input.platform)
          candidate =
            notice?.url ||
            (page.url() !== original.beforeURL && postURL(page.url(), original.input.platform))
        }
        if (!candidate || !(await verifyPost(b.contexts()[0], original, candidate)))
          return receipt(original, {
            next: 'Inspect this account’s published post. Pass its actual permalink to status if available.',
          })
        const url = postURL(candidate, original.input.platform)
        return exclusive(dir, original.id, async () => {
          const current = await loadIntent(dir, original.id)
          current.url = url
          current.state = 'published'
          await saveIntent(dir, current)
          return receipt(current)
        })
      })
    } catch (e) {
      if (e instanceof NeedsInput) return receipt(original, { next: e.message })
      throw e
    }
  }
  return exclusive(dir, original.id, async () => {
    const i = await loadIntent(dir, original.id)
    if (terminal(i)) return receipt(i)
    if (i.state !== 'ready' || !i.tab)
      throw new NeedsInput('needs_preview', 'Run preview and verify the native account first.')
    try {
      return await withBrowser(async (b) => {
        const { page, id } = await selectTab(b, i.input.platform, i.tab, false)
        return exclusive(dir, sha256('tab:' + port() + ':' + id).slice(0, 32), async () => {
          const box = await composer(page, i.input.platform)
          const submit = await stage(page, box, i)
          if (await confirmation(page, i.input.platform))
            throw new NeedsInput(
              'needs_review',
              'Dismiss the previous post confirmation and review the empty composer before retrying.',
            )
          // Persist uncertainty before the external click. A crash, a timeout or a repeat invocation cannot submit again.
          i.state = 'pending'
          i.submittedAt = new Date().toISOString()
          i.beforeURL = page.url()
          await saveIntent(dir, i)
          try {
            await submit.click({ timeout: 4500 })
          } catch {
            return receipt(i, {
              next: 'Inspect the account for this post; use status with its observed link.',
            })
          }
          const deadline = Date.now() + 4500
          do {
            const confirmed = await confirmation(page, i.input.platform)
            const navigated = page.url() !== i.beforeURL && postURL(page.url(), i.input.platform)
            const candidate = confirmed?.url || navigated
            if (confirmed || (navigated && (await verifyPost(page.context(), i, navigated)))) {
              i.state = 'published'
              if (
                candidate &&
                (await verifyPost(page.context(), i, candidate, {
                  fromReceipt: Boolean(confirmed?.url),
                }))
              )
                i.url = candidate
              await saveIntent(dir, i)
              return receipt(
                i,
                i.url
                  ? {}
                  : { next: 'Use status with the observed post permalink to verify the link.' },
              )
            }
            await page.waitForTimeout(250)
          } while (Date.now() < deadline)
          return receipt(i, {
            next: 'Check the native outcome; pass its permalink to status. Keep the same intent.',
          })
        })
      })
    } catch (e) {
      if (i.submittedAt)
        return receipt(i, { next: 'Use status for this intent to reconcile the native outcome.' })
      i.state = 'preview'
      delete i.tab
      await saveIntent(dir, i)
      if (e instanceof NeedsInput) return receipt(i, { state: e.state, next: e.message })
      throw e
    }
  })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await run(process.argv.slice(2))
    console.log(JSON.stringify(result))
    if (
      result.state?.startsWith('needs_') ||
      result.state === 'pending' ||
      result.state === 'changed_media'
    )
      process.exitCode = 3
  } catch (e) {
    console.error(
      JSON.stringify({
        state: e instanceof NeedsInput ? e.state : 'error',
        detail:
          e instanceof NeedsInput || e instanceof InputError
            ? e.message
            : 'Operation failed; inspect the native tab.',
      }),
    )
    process.exitCode = 1
  }
}
