import { describe, expect, test, tier } from 'claude-code/testing'
import { isCiOnly, isDeploy, isGh, isPush, pushBranch, RUN_URL, sanitise } from '../hooks/detect.ts'

tier('user')

// Real deploys. A miss here means a deploy goes unverified and the model is free to claim it worked.
const DEPLOYS = [
  'git push',
  'git push origin main',
  'git push --force-with-lease origin feature/x',
  'git -C ../x push',
  'git -C /repo push origin main',
  'echo ok && git push',
  'git push --dry-run; git push',
  'wrangler deploy',
  'wrangler pages deploy ./dist',
  'vercel --prod',
  'netlify deploy --prod --dir=dist',
  'railway up',
  'fly deploy',
  'flyctl deploy --remote-only',
  'npm run deploy',
  'bun run deploy',
  'gcloud run deploy api --region asia-southeast1',
  'gh workflow run release.yml',
  'gh pr merge 12 --squash',
  'gh run rerun 123',
  'make deploy',
  'bun run build && git push origin main',
]

// The clean baseline: commands that mention a deploy without being one. These are the cases that
// matter, because a false positive curls a live URL nothing was pushed to and then reports a
// verdict about it — which is worse than not checking at all.
const NOT_DEPLOYS = [
  'echo "git push"',
  "echo 'git push origin main'",
  'grep -rn "git push" .',
  'grep -r "wrangler deploy" docs/',
  'rg "npm run deploy" --files-with-matches',
  'git commit -m "document how git push triggers the deploy"',
  "git commit -m 'railway up is the deploy command'",
  'cat <<\'EOF\' > notes.md\nRun git push to deploy.\nEOF',
  'git commit -m "$(cat <<\'EOF\'\nAdd release notes\n\nmake deploy is now the entrypoint\nEOF\n)"',
  'git status',
  'git log --oneline -5',
  'git pull --rebase',
  'npm run build',
  'npm run test',
  'vercel ls',
  'echo "deploy" # git push happens later',
  '# make deploy',
  'sed -i "" "s/git push/git push --tags/" README.md',
  'git push --dry-run',
  'git push -n origin main',
  'git push --dry-run origin main && echo done',
  'gh pr create --fill',
  'gh pr view 12',
]

describe('isDeploy', () => {
  for (const command of DEPLOYS) test(`detects ${JSON.stringify(command)}`, () => expect(isDeploy(command)).toBe(true))
  for (const command of NOT_DEPLOYS) test(`does not fire on ${JSON.stringify(command)}`, () => expect(isDeploy(command)).toBe(false))
})

describe('shape of the trigger', () => {
  test('a push is a push, a gh command is not', () => {
    expect(isPush('git -C ../x push')).toBe(true)
    expect(isPush('echo ok && git push')).toBe(true)
    expect(isPush('git push -n')).toBe(false)
    expect(isPush('gh pr merge 12')).toBe(false)
    expect(isGh('gh pr merge 12')).toBe(true)
    expect(isGh('gh workflow run x.yml')).toBe(true)
    expect(isGh('git push')).toBe(false)
  })

  test('gh pr create runs CI without deploying', () => {
    expect(isCiOnly('gh pr create --fill')).toBe(true)
    expect(isCiOnly('gh pr merge 12')).toBe(false)
    expect(isCiOnly('echo "gh pr create"')).toBe(false)
  })

  test('the branch a push lands on', () => {
    expect(pushBranch('git push origin main')).toBe('main')
    expect(pushBranch('git push -u origin feat/a')).toBe('feat/a')
    expect(pushBranch('git push --force-with-lease origin feature/x')).toBe('feature/x')
    expect(pushBranch('git push origin main:prod')).toBe('prod')
    expect(pushBranch('git push origin +refs/heads/main')).toBe('main')
    expect(pushBranch('git -C ../x push origin main')).toBe('main')
    expect(pushBranch('bun run build && git push origin main')).toBe('main')
    expect(pushBranch('git push')).toBeUndefined()
    expect(pushBranch('git push origin')).toBeUndefined()
    expect(pushBranch('git push --dry-run origin main')).toBeUndefined()
  })

  test('the run or pull request URL gh prints', () => {
    expect('https://github.com/o/r/actions/runs/42'.match(RUN_URL)?.[0]).toBe('https://github.com/o/r/actions/runs/42')
    expect('Created https://github.com/o/r/pull/7\n'.match(RUN_URL)?.[0]).toBe('https://github.com/o/r/pull/7')
    expect('✓ Created workflow_dispatch event for x.yml at main'.match(RUN_URL)).toBe(null)
  })
})

describe('sanitise', () => {
  test('removes a single-quoted span', () => {
    expect(sanitise("echo 'git push'")).not.toMatch(/git\s+push/)
  })

  test('removes a double-quoted span but keeps what follows', () => {
    const out = sanitise('echo "hello" && git push')
    expect(out).not.toMatch(/hello/)
    expect(out).toMatch(/git\s+push/)
  })

  test('removes a heredoc body with a quoted marker', () => {
    expect(sanitise("cat <<'EOF'\ngit push\nEOF")).not.toMatch(/git\s+push/)
  })

  test('removes an unterminated heredoc rather than trusting it', () => {
    expect(sanitise('cat <<EOF\ngit push')).not.toMatch(/git\s+push/)
  })

  test('keeps an escaped quote from ending the span early', () => {
    expect(sanitise('echo "a \\" git push"')).not.toMatch(/git\s+push/)
  })

  test('leaves a bare command untouched', () => {
    expect(sanitise('git push origin main')).toMatch(/git\s+push\s+origin\s+main/)
  })
})
