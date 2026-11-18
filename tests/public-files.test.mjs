import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// All probe content is synthetic, held in a disposable local Git repository.
test('public preflight rejects hidden history, staged secrets, and private file types without printing content', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'public-file-test-'))
  const git = (...args) => execFileSync('git', args, { cwd: tmp, stdio: 'pipe' }).toString().trim()
  const write = (name, body) => writeFileSync(path.join(tmp, name), body)
  const check = (base) =>
    spawnSync(process.execPath, ['check.mjs', base], { cwd: tmp, encoding: 'utf8' })
  try {
    git('init')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    copyFileSync(
      new URL('../scripts/check-public.mjs', import.meta.url),
      path.join(tmp, 'check.mjs'),
    )
    write('.public-files', '.public-files\ncheck.mjs\nnotes.md\n')
    write('notes.md', 'Reviewed public text.')
    git('add', '.')
    git('commit', '-m', 'baseline')
    const base = git('rev-parse', 'HEAD')
    assert.equal(check(base).status, 0)
    write('internal.md', 'Synthetic fixture.')
    git('add', 'internal.md')
    write('.public-files', '.public-files\ncheck.mjs\nnotes.md\ninternal.md\n')
    assert.equal(check(base).status, 1)
    git('commit', '-m', 'unlisted fixture')
    git('add', '.public-files')
    assert.equal(check(base).status, 1)
    git('reset', '--hard', base)
    const fake = 'gh' + 'p_' + 'x'.repeat(36)
    write('notes.md', fake)
    git('add', 'notes.md')
    let result = check(base)
    assert.equal(result.status, 1)
    assert.ok(!result.stderr.includes(fake))
    git('commit', '-m', 'fake fixture')
    write('notes.md', 'Reviewed public text.')
    git('commit', '-am', 'remove fixture')
    assert.equal(check(base).status, 1)
    write('session.json', '{}')
    git('add', 'session.json')
    result = check(git('rev-parse', 'HEAD'))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /session\.json/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
