import { describe, expect, it } from 'vitest'
import { isDeploy, sanitise } from '../hooks/detect.ts'

// Real deploys. A miss here means a deploy goes unverified and the model is free to claim it worked.
const DEPLOYS = [
  'git push',
  'git push origin main',
  'git push --force-with-lease origin feature/x',
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
]

describe('isDeploy', () => {
  it.each(DEPLOYS)('detects %j', command => {
    expect(isDeploy(command)).toBe(true)
  })

  it.each(NOT_DEPLOYS)('does not fire on %j', command => {
    expect(isDeploy(command)).toBe(false)
  })
})

describe('sanitise', () => {
  it('removes a single-quoted span', () => {
    expect(sanitise("echo 'git push'")).not.toMatch(/git\s+push/)
  })

  it('removes a double-quoted span but keeps what follows', () => {
    const out = sanitise('echo "hello" && git push')
    expect(out).not.toMatch(/hello/)
    expect(out).toMatch(/git\s+push/)
  })

  it('removes a heredoc body with a quoted marker', () => {
    expect(sanitise("cat <<'EOF'\ngit push\nEOF")).not.toMatch(/git\s+push/)
  })

  it('removes an unterminated heredoc rather than trusting it', () => {
    expect(sanitise('cat <<EOF\ngit push')).not.toMatch(/git\s+push/)
  })

  it('keeps an escaped quote from ending the span early', () => {
    expect(sanitise('echo "a \\" git push"')).not.toMatch(/git\s+push/)
  })

  it('leaves a bare command untouched', () => {
    expect(sanitise('git push origin main')).toMatch(/git\s+push\s+origin\s+main/)
  })
})
