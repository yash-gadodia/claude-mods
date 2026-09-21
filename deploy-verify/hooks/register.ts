import type { Register, EngineInterface } from 'claude-code'
import { isDeploy } from './detect.ts'

// A deploy is not done when the push exits 0, it is done when the live URL serves the change.
// This mod closes that gap mechanically: after a deploy command succeeds it fetches the target
// with cache-busting and appends the verdict to the tool result as context the model must read.
//
// Per-repo config lives at <repo>/.claude/deploy-verify.json:
//   { "url": "https://example.com", "match": "v3.10.10" }
//   { "url": "https://example.com", "matchFile": "VERSION" }
//   { "targets": [ { "url": "...", "match": "..." }, ... ] }
// `match` may be omitted, in which case a 200 with a non-empty body is the whole test.

// A hook that blocks for ~10s or more is dropped by the engine: core's result is used and
// everything the hook returned is discarded, silently — a command.run hook is told it went
// unanswered. So the in-call check gets two tries and about six seconds, and a slow CDN is waited
// out by a timer afterwards, which reports itself with a toast.
const ATTEMPTS = [0, 4000]
// the background watcher: one curl every 15s for three minutes, outside any hook's budget
const WATCH_MS = 15000
const WATCH_TICKS = 12

type Target = { url: string; match?: string; matchFile?: string }
type Config = { url?: string; match?: string; matchFile?: string; targets?: Target[] }

const readConfig = async ($: EngineInterface, root: string): Promise<Config | undefined> => {
  const path = `${root}/.claude/deploy-verify.json`
  if (!(await $.fs.exists(path).catch(() => false))) return undefined
  try {
    return JSON.parse(await $.fs.read(path)) as Config
  } catch (err) {
    $.ui.log(`deploy-verify: ${path} is not valid JSON: ${err}`)
    return undefined
  }
}

const targetsOf = (config: Config): Target[] =>
  config.targets?.length ? config.targets : config.url ? [{ url: config.url, match: config.match, matchFile: config.matchFile }] : []

const wanted = async ($: EngineInterface, root: string, target: Target): Promise<string | undefined> => {
  if (target.match) return target.match
  if (!target.matchFile) return undefined
  const path = target.matchFile.startsWith('/') ? target.matchFile : `${root}/${target.matchFile}`
  const text = await $.fs.read(path).catch(() => '')
  return text.trim().split('\n')[0]?.trim() || undefined
}

const bust = (url: string, now: number) => `${url}${url.includes('?') ? '&' : '?'}cb=${now}`

const fetchLive = async ($: EngineInterface, url: string) =>
  $.process.run(
    [
      'curl', '-sS', '-L', '--max-time', '20',
      '-H', 'Cache-Control: no-cache',
      '-H', 'Pragma: no-cache',
      '-w', '\n__STATUS__%{http_code}',
      url,
    ],
    { timeoutMs: 25000 },
  )

const checkOne = async ($: EngineInterface, root: string, target: Target, schedule: readonly number[] = ATTEMPTS): Promise<string> => {
  const needle = await wanted($, root, target)
  let last = 'no response'
  for (const [index, wait] of schedule.entries()) {
    if (wait) await $.clock.sleep(wait)
    const now = await $.clock.now()
    const r = await fetchLive($, bust(target.url, now)).catch(err => {
      last = `curl failed: ${err}`
      return undefined
    })
    if (!r) continue
    const status = r.stdout.match(/__STATUS__(\d{3})\s*$/)?.[1] ?? '000'
    const body = r.stdout.replace(/\n?__STATUS__\d{3}\s*$/, '')
    if (status !== '200') {
      last = `HTTP ${status}`
      continue
    }
    if (!needle) return `VERIFIED ${target.url} — HTTP 200, ${body.length} bytes (no match string configured)`
    if (body.includes(needle)) {
      const attemptNote = index ? ` after ${Math.round(schedule.slice(0, index + 1).reduce((a, b) => a + b, 0) / 1000)}s` : ''
      return `VERIFIED live: ${target.url} served "${needle}"${attemptNote}`
    }
    last = `HTTP 200 but "${needle}" not in the ${body.length} bytes returned`
  }
  return `NOT VERIFIED ${target.url} — ${last}`
}

let watcher: { cancel: () => void } | undefined

// Keeps curling after the tool call has already answered, so a CDN that catches up a minute later
// still says so. Cancelled by the next deploy, and by a pass.
const watch = ($: EngineInterface, root: string, targets: Target[]) => {
  watcher?.cancel()
  let left = WATCH_TICKS
  const timer = $.clock.every(WATCH_MS, () => {
    void (async () => {
      left--
      const verdicts: string[] = []
      for (const target of targets) verdicts.push(await checkOne($, root, target, [0]))
      const failed = verdicts.filter(v => v.startsWith('NOT VERIFIED'))
      if (!failed.length) {
        timer.cancel()
        watcher = undefined
        await record($, verdicts)
        $.ui.toast(`deploy-verify: live now — ${verdicts[0]}`, { timeoutMs: 15000 })
        return
      }
      if (left <= 0) {
        timer.cancel()
        watcher = undefined
        $.ui.toast(`deploy-verify: still not live after ${Math.round((WATCH_MS * WATCH_TICKS) / 60000)} minutes — ${failed[0]}`, { timeoutMs: 15000 })
      }
    })()
  })
  watcher = timer
}

// A band draws for the person; a context block draws for the model. The last live check goes into
// the first user message's context under this name, replacing its own previous copy rather than
// accumulating, and `$.ui.invalidate('prompt.context')` refreshes it after every check. This is the
// difference between evidence the model can talk around and evidence it cannot.
const CONTEXT_BLOCK = 'deployVerify'
let lastVerdict: { lines: string[]; at: number } | undefined

const record = async ($: EngineInterface, lines: string[]) => {
  lastVerdict = { lines, at: await $.clock.now() }
  $.ui.invalidate('prompt.context')
}

const ago = (then: number, now: number) => {
  const mins = Math.round((now - then) / 60000)
  return mins < 1 ? 'just now' : mins === 1 ? '1 minute ago' : `${mins} minutes ago`
}

// Hook advisories repeat. The same "no target configured" paragraph lands on every deploy in a repo
// that has none, and each copy costs context to say what the last one said. Each advisory is hashed
// and suppressed for a cooldown. Verdicts are never throttled: a verdict is evidence, and it differs.
const ADVISORY_COOLDOWN_MS = 10 * 60 * 1000
const advised = new Map<string, number>()

const digest = (text: string) => {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return `${h}`
}

const fresh = async ($: EngineInterface, text: string): Promise<boolean> => {
  const key = digest(text)
  const now = await $.clock.now()
  const seen = advised.get(key)
  if (seen !== undefined && now - seen < ADVISORY_COOLDOWN_MS) return false
  advised.set(key, now)
  return true
}

// The first thing anyone does when a mod misbehaves is try to turn it off. `CLAUDE_MODS_DISABLE=all`,
// or a comma list naming this mod, makes every hook here a pass-through and registers no command.
const MOD = 'deploy-verify'
let disabled = false
const readDisabled = async ($: EngineInterface): Promise<boolean> => {
  const raw = (await $.env.get('CLAUDE_MODS_DISABLE').catch(() => undefined)) ?? ''
  disabled = raw
    .split(',')
    .map(v => v.trim())
    .some(v => v === 'all' || v === MOD)
  return disabled
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (await readDisabled($)) return r
    await $.command
      .register({
        name: 'deploy-verify',
        description: 'Check the live URL for this repo now, waiting out a slow CDN (deploy-verify)',
        argumentHint: '[check | status | stop]',
        immediate: true,
      })
      .catch(err => $.ui.log(`deploy-verify: /deploy-verify not registered: ${err}`))
    return r
  })

  on('command.run', { command: 'deploy-verify' }, async ($, e) => {
    const repo = await $.session.repo().catch(() => null)
    const root = repo?.root ?? (await $.session.cwd())
    const config = await readConfig($, root)
    const targets = config ? targetsOf(config) : []
    if (!targets.length) {
      return {
        text: [
          `deploy-verify: no ${root}/.claude/deploy-verify.json, so deploys here are never checked.`,
          '',
          'Write one of:',
          '  { "url": "https://example.com", "match": "v1.2.3" }',
          '  { "url": "https://example.com", "matchFile": "VERSION" }',
          '  { "targets": [ { "url": "...", "match": "..." } ] }',
        ].join('\n'),
      }
    }
    if (e.args.trim().toLowerCase() === 'status') {
      const rows = await Promise.all(targets.map(async t => `  ${t.url} — expects ${(await wanted($, root, t)) ?? 'HTTP 200 only'}`))
      return { text: [`deploy-verify checks ${targets.length} target(s) after every deploy command:`, ...rows].join('\n') }
    }
    if (e.args.trim().toLowerCase() === 'stop') {
      watcher?.cancel()
      watcher = undefined
      return { text: 'deploy-verify: watcher stopped' }
    }
    const verdicts: string[] = []
    for (const target of targets) verdicts.push(await checkOne($, root, target))
    const failed = verdicts.filter(v => v.startsWith('NOT VERIFIED'))
    if (failed.length) {
      watch($, root, targets)
      return { text: [...verdicts, '', `still checking every ${WATCH_MS / 1000}s for the next ${Math.round((WATCH_MS * WATCH_TICKS) / 60000)} minutes; a toast will say when it lands (/deploy-verify stop ends it)`].join('\n') }
    }
    return { text: verdicts.join('\n') }
  })

  on('prompt.context', async ($, e, next) => {
    const below = await next(e)
    if (disabled || !lastVerdict) return below
    const now = await $.clock.now()
    const text = [
      `Last live deploy check, ${ago(lastVerdict.at, now)}:`,
      ...lastVerdict.lines.map(v => `  ${v}`),
      'This is the only evidence about the live site in this session. Do not describe the deploy as',
      'verified unless a line above starts with VERIFIED, and do not re-state an older claim over it.',
    ].join('\n')
    return { ...below, blocks: [...below.blocks.filter(b => b.name !== CONTEXT_BLOCK), { name: CONTEXT_BLOCK, text }] }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (disabled) return next(e)
    const r = await next(e)
    if (!isDeploy(e.command) || 'deny' in r) return r

    const add = (...lines: string[]) => ({ ...r, context: [...(r.context ?? []), lines.join('\n')] })

    // Advisories are throttled; verdicts below are not.
    const advise = async (...lines: string[]) => ((await fresh($, lines.join('\n'))) ? add(...lines) : r)

    if (r.isError) {
      return advise(
        'deploy-verify: the deploy command did not succeed. Do not report a deploy as done.',
        'Report the failure with its output, then stop or fix it — whichever the user asked for.',
      )
    }

    const repo = await $.session.repo().catch(() => null)
    const root = repo?.root ?? (await $.session.cwd())
    const config = await readConfig($, root)
    const targets = config ? targetsOf(config) : []

    if (!targets.length) {
      return advise(
        'deploy-verify: no verify target configured for this repo, so NOTHING about the live site has been checked.',
        'You MUST NOT say "deployed successfully" or "live". Say the command exited 0 and the live site is unverified.',
        `To make this automatic, write ${root}/.claude/deploy-verify.json as {"url":"https://…","match":"<string that proves the new version>"}.`,
      )
    }

    $.ui.status('verifying live deploy…')
    const verdicts: string[] = []
    for (const target of targets) verdicts.push(await checkOne($, root, target))
    $.ui.status(undefined)

    const failed = verdicts.filter(v => v.startsWith('NOT VERIFIED'))
    await record($, verdicts)
    if (failed.length) {
      watch($, root, targets)
      $.ui.toast(`deploy-verify: ${failed.length} of ${verdicts.length} target(s) not showing the change yet — still watching`)
      return add(
        'deploy-verify ran the live check and it did NOT pass:',
        ...verdicts.map(v => `  ${v}`),
        'Report exactly this: "deploy succeeded but live content not yet showing — likely CDN", and ask the user to hard-refresh.',
        `Do not claim the deploy is verified. The check only waited about six seconds; a watcher is now retrying every ${WATCH_MS / 1000}s for ${Math.round((WATCH_MS * WATCH_TICKS) / 60000)} minutes and will toast when it lands.`,
      )
    }

    watcher?.cancel()
    watcher = undefined
    $.ui.toast('deploy-verify: live content confirmed')
    return add(
      'deploy-verify checked the live URL(s) with cache-busting and they pass:',
      ...verdicts.map(v => `  ${v}`),
      'Quote the matched string back to the user as the evidence.',
    )
  })
}
