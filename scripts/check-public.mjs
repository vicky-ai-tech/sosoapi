import { execFileSync } from 'node:child_process'

// Inspect Git objects, including files added and deleted within the outgoing history.
// Report the path and category only. Never echo a matching value or file contents.
const git = (...args) => execFileSync('git', args, { maxBuffer: 24 * 1024 * 1024 })
const base = process.argv[2] || 'refs/remotes/origin/main'
if (!/^[\w./-]+$/.test(base) || base.startsWith('-')) throw new Error('Expected a Git base ref.')
const baseId = git('rev-parse', '--verify', base + '^{commit}')
  .toString()
  .trim()
const proposed = process.argv[3] || 'HEAD'
if (proposed !== 'HEAD' && !/^[0-9a-f]{40}$/.test(proposed))
  throw new Error('Expected a full proposed commit object ID.')
const headId = git('rev-parse', '--verify', proposed + '^{commit}')
  .toString()
  .trim()
const heads = git('rev-list', headId, '^' + baseId)
  .toString()
  .trim()
  .split(/\s+/)
  .filter(Boolean)
const readList = (object) => new Set(git('show', object).toString('utf8').trim().split('\n'))
const stagedList = readList(':.public-files')
// A legacy base can be checked while the guard is staged for the first time.
// Every outgoing head must carry its own reviewed manifest.
const headHasList = git('ls-tree', '--name-only', headId, '--', '.public-files').length > 0
const publicList = headHasList || heads.length ? readList(headId + ':.public-files') : stagedList
const problems = new Set(),
  scanned = new Set(),
  contents = new Set()
const fail = (file, reason) => problems.add(`${JSON.stringify(file)} (${reason})`)
function scan(file, oid, mode, allowed) {
  if (!allowed.has(file)) fail(file, 'outside the reviewed public file list')
  if (!['100644', '100755'].includes(mode)) fail(file, 'non-regular file')
  if (
    !/^[A-Za-z0-9_./-]+$/.test(file) ||
    /(?:^|\/)(?:\.env|\.auth|cookies?|storage[-_]?state|secrets?|credentials?|sessions?|chrome-profile|node_modules)(?:\.|\/|$)/i.test(
      file,
    ) ||
    /\.(?:pem|key|p12|pfx|sqlite|db|log|har|zip|pdf|docx?|xlsx?|png|jpe?g|mp4|mov)$/i.test(file)
  )
    fail(file, 'private or generated file type')
  scanned.add(file)
  if (contents.has(oid)) return
  contents.add(oid)
  if (Number(git('cat-file', '-s', oid).toString()) > 1024 * 1024) {
    fail(file, 'large file requires separate review')
    return
  }
  const bytes = git('cat-file', 'blob', oid)
  if (bytes.includes(0)) {
    fail(file, 'binary content')
    return
  }
  const txt = bytes.toString('utf8')
  const patterns = [
    /-----BEGIN (?:[\w ]+ )?PRIVATE KEY-----/,
    /\b(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{40,}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[\w-]{30,}|xox[baprs]-[\w-]{12,}|(?:EAA|EAAB)[a-zA-Z0-9]{70,})\b/,
    /\beyJ[A-Za-z0-9_-]{14,}\.eyJ[A-Za-z0-9_-]{14,}\.[A-Za-z0-9_-]{10,}/,
    /(?:access_token|refresh_token|client_secret|password|sessionid|c_user|xs)["']?\s*[:=]\s*["'][^\s"'<>]{12,}["']/i,
    /(?:\/Users\/[^/\s]+\/|\/private\/var\/folders\/|[A-Z]:\\Users\\[^\\\s]+\\)/,
  ]
  if (patterns.some((re) => re.test(txt))) fail(file, 'sensitive content signature')
}
function rows(data, stage, allowed) {
  for (const entry of data.toString().split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t')
    const [mode, second, third] = entry.slice(0, tab).split(' ')
    const file = entry.slice(tab + 1)
    if (stage && third !== '0') {
      fail(file, 'unmerged index')
      continue
    }
    scan(file, stage ? second : third, mode, allowed)
  }
}
for (const head of new Set([headId, ...heads]))
  rows(git('ls-tree', '-r', '-z', head), false, publicList)
rows(git('ls-files', '--stage', '-z'), true, stagedList)
if (problems.size) {
  for (const problem of problems) console.error(problem)
  process.exitCode = 1
} else
  console.log(
    `Public-file check passed for ${scanned.size} paths, ${contents.size} blobs and ${heads.length} outgoing commits. Review the diff for confidential prose and personal data before pushing.`,
  )
