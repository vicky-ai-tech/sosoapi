#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { InputError, requirePlatform } from './intent.mjs'
import { chooseRoute, parseTargets, runBatch } from './batch.mjs'

const help = [
  'social-post preview|publish --key KEY [--via browser|api] --to PLATFORM=ACCOUNT [--to ...] --text CAPTION [--image FILE | --video FILE] [--workspace NAME_OR_ID] [--title TITLE --privacy private|unlisted|public --audience kids|not-kids]',
  'social-post publish|status --key KEY',
  'social-post status --key KEY --to PLATFORM=ACCOUNT --url OBSERVED_BROWSER_PERMALINK',
  'social-post route [--via browser|api]',
  'social-post browser PLATFORM',
  'Platforms: Facebook Page, Instagram, Threads, X, YouTube. Browser uses native sites; API uses a connected workspace. Preview checks all destinations. Publish submits approved content once per destination.',
].join('\n')

async function loadNative() {
  const { ensureBrowserRuntime } = await import('./skill-runtime.mjs')
  await ensureBrowserRuntime()
  return (await import('./meta-post.mjs')).run
}
function nativeOutcome(result) {
  if (['ready', 'published', 'pending'].includes(result.state)) return result
  return {
    state: 'needs_input',
    next: result.next || 'Review the native composer, then run publish with the same batch key.',
    ...(result.id ? { id: result.id } : {}),
    // Native needs-input receipts are issued before the native pending-before-click marker.
    safeToRetry: true,
  }
}
const extraPlatform = (platform) => platform === 'x' || platform === 'youtube'

async function defaultAdapter(via) {
  if (via === 'api') return (await import('./api-post.mjs')).createApiAdapter()
  const run = await loadNative()
  let extra
  const extraAdapter = async () => {
    extra ??= (await import('./extra-browser.mjs')).createExtraBrowserAdapter()
    return extra
  }
  return {
    async preview(target, request) {
      if (extraPlatform(target.platform)) return (await extraAdapter()).preview(target, request)
      if (request.video) {
        return {
          state: 'needs_input',
          next: 'Native Threads, Facebook Page and Instagram support one image in this skill. Review the requested video with a separately selected route.',
        }
      }
      const args = [
        'preview',
        target.platform,
        '--account=' + target.account,
        '--text=' + request.text,
        '--key=' + request.key,
      ]
      if (request.image) args.push('--image=' + request.image)
      const result = await run(args)
      if (result.state === 'needs_browser')
        result.next =
          'Open the skill browser with social-post browser ' +
          target.platform +
          ', sign in if needed, then retry the same batch.'
      return nativeOutcome(result)
    },
    async publish(target, request, ready) {
      if (extraPlatform(target.platform))
        return (await extraAdapter()).publish(target, request, ready)
      return nativeOutcome(await run(['publish', '--id', ready.id]))
    },
    async status(target, request, receipt) {
      if (extraPlatform(target.platform))
        return (await extraAdapter()).status(target, request, receipt)
      const args = ['status', '--id', receipt.id]
      if (receipt.observedUrl) args.push('--url=' + receipt.observedUrl)
      const result = await run(args)
      // A native ready/preview record has no external submission marker. The
      // batch could have stopped between reserving its slot and invoking native.
      if (result.state === 'ready' || result.state === 'preview') {
        return {
          state: 'needs_input',
          id: receipt.id,
          safeToRetry: true,
          next: 'The native intent has no submission. Resume with the original publish key.',
        }
      }
      return nativeOutcome(result)
    },
  }
}

export async function runSocialPost(argv, adapterFor = defaultAdapter) {
  const { positionals, values, tokens } = parseArgs({
    args: argv,
    allowPositionals: true,
    tokens: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      via: { type: 'string' },
      key: { type: 'string' },
      to: { type: 'string', multiple: true },
      text: { type: 'string' },
      image: { type: 'string' },
      video: { type: 'string' },
      workspace: { type: 'string' },
      title: { type: 'string' },
      privacy: { type: 'string' },
      audience: { type: 'string' },
      url: { type: 'string' },
    },
  })
  if (values.help || !argv.length || (argv.length === 1 && argv[0] === 'help'))
    return { usage: help }
  const [command, platform] = positionals
  const seen = new Set()
  for (const token of tokens.filter((t) => t.kind === 'option')) {
    if (token.name !== 'to' && seen.has(token.name))
      throw new InputError('Supply each option once, except --to.')
    seen.add(token.name)
  }
  const contentKeys = ['text', 'image', 'video', 'workspace', 'title', 'privacy', 'audience']
  const options = {
    route: ['via'],
    browser: [],
    preview: ['key', 'via', 'to', ...contentKeys],
    publish: ['key', 'via', 'to', ...contentKeys],
    status: ['key', 'to', 'url'],
  }
  if (
    !Object.hasOwn(options, command) ||
    Object.keys(values).some((key) => !options[command].includes(key)) ||
    positionals.length !== (command === 'browser' ? 2 : 1)
  )
    throw new InputError(help)
  if (command === 'browser') {
    if (extraPlatform(platform))
      return (await import('./extra-browser.mjs')).launchExtraBrowser(platform)
    requirePlatform(platform)
    return (await loadNative())(['browser', platform])
  }
  if (command === 'route') return chooseRoute(values.via)
  if (!values.key?.trim())
    throw new InputError('Provide a unique --key for this post. Keep it for recovery.')
  const targets = values.to ? parseTargets(values.to) : undefined
  if (command === 'status') {
    if ((targets || values.url) && (!values.url || targets?.length !== 1)) {
      throw new InputError(
        'Use one exact --to and its --url together to reconcile a native permalink.',
      )
    }
    return runBatch(
      {
        command,
        key: values.key,
        observation: targets && { ...targets[0], url: values.url },
      },
      adapterFor,
    )
  }
  let input
  if (targets || contentKeys.some((k) => Object.hasOwn(values, k))) {
    if (!targets?.length || (!values.text?.trim() && !values.image && !values.video)) {
      throw new InputError('Provide at least one --to and an approved caption or media file.')
    }
    if (
      (values.title || values.privacy || values.audience) &&
      !targets.some((target) => target.platform === 'youtube')
    )
      throw new InputError('--title, --privacy and --audience describe the YouTube video.')
    if (values.audience !== undefined && !['kids', 'not-kids'].includes(values.audience))
      throw new InputError('Choose kids or not-kids for the YouTube audience.')
    if (values.image && values.video)
      throw new InputError('Choose one image or video for this post.')
    input = { text: values.text || '' }
    for (const k of ['image', 'video']) if (values[k]) input[k] = path.resolve(values[k])
    for (const k of ['workspace', 'title', 'privacy', 'audience'])
      if (values[k]) input[k] = values[k]
  }
  return runBatch({ command, key: values.key, via: values.via, input, targets }, adapterFor)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runSocialPost(process.argv.slice(2))
    console.log(JSON.stringify(result))
    if (result.state && !['ready', 'published', 'browser_closed'].includes(result.state))
      process.exitCode = 3
  } catch (error) {
    const detail =
      error instanceof InputError || error.code?.startsWith('ERR_PARSE_ARGS')
        ? error.message
        : error.code === 'ENOENT'
          ? 'An input or dependency was not found.'
          : 'Could not complete this operation. Check the original batch before retrying.'
    console.error(JSON.stringify({ state: 'error', detail }))
    process.exitCode = 1
  }
}
