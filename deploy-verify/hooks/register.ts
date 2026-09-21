import type { Register, EngineInterface } from 'claude-code'
import { isDeploy, isCiOnly, isPush, isGh, pushBranch, RUN_URL } from './detect.ts'

// A deploy is not done when the push exits 0, it is done when the live URL serves the change.
// This mod closes that gap mechanically: after a deploy command succeeds it waits for the GitHub
// Actions run the push started (when the repo has one), then fetches the target with cache-busting
// and appends the verdict to the tool result as context the model must read.
//
// Per-repo config lives at <repo>/.claude/deploy-verify.json:
//   { "url": "https://example.com", "match": "v3.10.10" }
//   { "url": "https://example.com", "matchFile": "VERSION" }
//   { "targets": [ { "url": "...", "match": "..." }, ... ] }
// `match` may be omitted, in which case a 200 with a non-empty body is the whole test.

// A hook that outruns its budget is dropped by the engine: core's result is used and everything
// the hook returned is discarded. `$` calls are free but `$.clock.sleep` is not, so the in-call
// check retries every RETRY_MS while the budget allows, and a slow CDN is waited out by a timer
// afterwards, outside any hook's budget.
const RETRY_MS = 4000
const WATCH_MS = 15000
const WATCH_TICKS = 12
const CI_POLL_MS = 15000
const CI_CAP_MS = 20 * 60 * 1000
const CI_NO_RUN_MS = 3 * 60 * 1000
const CLOCK_SKEW_MS = 10000

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

type Probe = { ok: boolean; status: string; line: string }

const probe = async ($: EngineInterface, root: string, target: Target): Promise<Probe> => {
  const needle = await wanted($, root, target)
  const now = await $.clock.now()
  const r = await fetchLive($, bust(target.url, now)).catch(err => ({ error: `${err}` }))
  if ('error' in r) return { ok: false, status: 'curl', line: `NOT VERIFIED ${target.url} — curl failed: ${r.error}` }
  const status = r.stdout.match(/__STATUS__(\d{3})\s*$/)?.[1] ?? '000'
  const body = r.stdout.replace(/\n?__STATUS__\d{3}\s*$/, '')
  if (status !== '200') return { ok: false, status, line: `NOT VERIFIED ${target.url} — HTTP ${status}` }
  if (!needle) return { ok: true, status, line: `VERIFIED ${target.url} — HTTP 200, ${body.length} bytes (no match string configured)` }
  if (body.includes(needle)) return { ok: true, status, line: `VERIFIED live: ${target.url} served "${needle}"` }
  return { ok: false, status, line: `NOT VERIFIED ${target.url} — HTTP 200 but "${needle}" not in the ${body.length} bytes returned` }
}

const probeAll = async ($: EngineInterface, root: string, targets: Target[]) => {
  const out: Probe[] = []
  for (const target of targets) out.push(await probe($, root, target))
  return out
}

// Retries inside the hook while its budget allows one more wait; `remaining` reads the budget fresh.
const probeWithin = async ($: EngineInterface, root: string, targets: Target[], remaining: () => number) => {
  let waited = 0
  let probes = await probeAll($, root, targets)
  while (probes.some(p => !p.ok) && remaining() > RETRY_MS + 1500) {
    await $.clock.sleep(RETRY_MS)
    waited += RETRY_MS
    probes = await probeAll($, root, targets)
  }
  return probes.map(p => (p.ok && waited ? { ...p, line: `${p.line} after ${waited / 1000}s` } : p))
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

// One watch at a time: a CI poll, then a live poll, each a self-rearming `$.clock.after`.
// Cancelled by the next deploy and by /deploy-verify stop.
// A tick awaits curl or gh for up to 25s; a stop that lands mid-await bumps the epoch, and the
// old loop sees its token is stale after every await and steps out instead of re-arming over
// the new watcher. A tick that throws ends its chain: logged, state cleared, no follow-up.
let watcher: { cancel: () => void } | undefined
let epoch = 0

const stopWatch = () => {
  epoch++
  watcher?.cancel()
  watcher = undefined
}

const arm = ($: EngineInterface, token: number, ms: number, tick: () => Promise<void>) => {
  watcher = $.clock.after(ms, () => {
    tick().catch(err => {
      $.ui.log(`deploy-verify: watcher stopped on an error: ${err}`)
      if (token !== epoch) return
      watcher = undefined
      followUpArmed = false
    })
  })
}

// A mod cannot hold a turn open, so a watch that ends unverified after the model has answered
// arrives as the next prompt. One per deploy: armed by the deploy, spent by the first unverified
// end, and held until the deploying turn has completed.
let turnBusy = false
let followUpArmed = false
let pendingFollowUp: string | undefined

const armFollowUp = () => {
  turnBusy = true
  followUpArmed = true
  pendingFollowUp = undefined
}

const submitLater = ($: EngineInterface, text: string) =>
  $.clock.after(0, () => {
    $.prompt.submit({ text }).catch(err => $.ui.log(`deploy-verify: follow-up not submitted: ${err}`))
  })

const unverified = ($: EngineInterface, lines: string[]) => {
  if (!followUpArmed) return
  followUpArmed = false
  const text = [
    'deploy-verify: the live check for the last deploy never passed.',
    ...lines.map(l => `  ${l}`),
    'Tell the user the deploy is NOT verified, with these lines as the evidence, and ask how to proceed.',
  ].join('\n')
  if (turnBusy) pendingFollowUp = text
  else submitLater($, text)
}

// Keeps curling after the tool call has already answered, so a CDN that catches up a minute later
// still says so. Toasts only when a target's HTTP status changes between polls, and at the end.
const watchLive = ($: EngineInterface, root: string, targets: Target[], prior: string[] = []) => {
  stopWatch()
  const token = epoch
  let left = WATCH_TICKS
  let lastStatus: string[] | undefined
  const tick = async () => {
    left--
    const probes = await probeAll($, root, targets)
    if (token !== epoch) return
    const was = lastStatus
    if (was) probes.forEach((p, i) => was[i] !== p.status && $.ui.toast(`deploy-verify: ${targets[i]?.url} went HTTP ${was[i]} → ${p.status}`))
    lastStatus = probes.map(p => p.status)
    const lines = [...prior, ...probes.map(p => p.line)]
    if (probes.every(p => p.ok)) {
      watcher = undefined
      await record($, lines)
      $.ui.toast(`deploy-verify: live now — ${probes[0]?.line}`, { timeoutMs: 15000 })
      return
    }
    if (left <= 0) {
      watcher = undefined
      await record($, lines)
      $.ui.toast(`deploy-verify: still not live after ${Math.round((WATCH_MS * WATCH_TICKS) / 60000)} minutes — ${probes.find(p => !p.ok)?.line}`, { timeoutMs: 15000 })
      unverified($, lines)
      return
    }
    arm($, token, WATCH_MS, tick)
  }
  arm($, token, WATCH_MS, tick)
}

type Run = { databaseId: number; status: string; conclusion: string | null; createdAt: string; url: string; headBranch: string }

// Only the deploying branch's runs: an unfiltered `on: push` workflow also runs for every other
// ref pushed meanwhile (mini-offload force-pushes _offload/<branch>), and the newest of those
// would otherwise stand in for the deploy's.
const listRuns = async ($: EngineInterface, root: string, branch: string | undefined): Promise<Run[] | undefined> => {
  const r = await $.process
    .run(
      ['gh', 'run', 'list', '--json', 'databaseId,status,conclusion,createdAt,url,headBranch', '--limit', '15', ...(branch ? ['--branch', branch] : [])],
      { cwd: root, timeoutMs: 20000 },
    )
    .catch(() => undefined)
  if (!r || r.exitCode !== 0) return undefined
  try {
    return (JSON.parse(r.stdout) as Run[]).filter(run => !branch || run.headBranch === branch)
  } catch {
    return undefined
  }
}

const headBranch = async ($: EngineInterface, root: string) => {
  const r = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeoutMs: 10000 }).catch(() => undefined)
  const name = r?.exitCode === 0 ? r.stdout.trim() : ''
  return name && name !== 'HEAD' ? name : undefined
}

// Watches the GitHub Actions run the deploy started: the newest run on the deploying branch
// created at or after the push (10s of clock skew allowed), or the one a `gh` command printed.
// Success hands over to the live check; failure is the verdict, and no live check is made.
const watchCi = ($: EngineInterface, root: string, targets: Target[], since: number, url: string | undefined, branch: string | undefined) => {
  stopWatch()
  const token = epoch
  let last: string | undefined
  let warned = false
  const finish = async (lines: string[], ok: boolean) => {
    watcher = undefined
    await record($, lines)
    if (!ok) {
      unverified($, lines)
      return
    }
    if (!targets.length) return
    watchLive($, root, targets, lines)
  }
  const tick = async () => {
    const now = await $.clock.now()
    const runs = await listRuns($, root, url ? undefined : branch)
    if (token !== epoch) return
    if (!runs && !warned) {
      warned = true
      $.ui.log('deploy-verify: `gh run list` failed; is gh logged in?')
    }
    const id = url?.match(/actions\/runs\/(\d+)/)?.[1]
    const run = runs?.find(r => (id ? `${r.databaseId}` === id : Date.parse(r.createdAt) >= since - CLOCK_SKEW_MS))
    if (!run) {
      if (now - since >= CI_NO_RUN_MS) {
        await finish([`CI: no GitHub Actions run appeared within ${CI_NO_RUN_MS / 60000} minutes of ${url ?? 'the push'}; checking live directly`], true)
        return
      }
      arm($, token, CI_POLL_MS, tick)
      return
    }
    const state = run.status === 'completed' ? (run.conclusion ?? 'completed') : run.status
    if (last !== undefined && last !== state) $.ui.toast(`deploy-verify: CI ${last} → ${state} (${run.url})`)
    last = state
    if (run.status !== 'completed') {
      if (now - since >= CI_CAP_MS) {
        await finish([`NOT VERIFIED — CI still ${state} after ${CI_CAP_MS / 60000} minutes: ${run.url}; no live check was made`], false)
        return
      }
      arm($, token, CI_POLL_MS, tick)
      return
    }
    if (run.conclusion === 'success') {
      await finish([`CI passed: ${run.url}`], true)
      return
    }
    await finish([`NOT VERIFIED — CI failed for ${run.url} (${run.conclusion}); no live check was made`], false)
  }
  arm($, token, CI_POLL_MS, tick)
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

  on('command.run', { command: 'deploy-verify' }, async ($, e, next) => {
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
      stopWatch()
      return { text: 'deploy-verify: watcher stopped' }
    }
    const probes = await probeWithin($, root, targets, () => next.budget.remainingMs)
    const lines = probes.map(p => p.line)
    await record($, lines)
    if (probes.some(p => !p.ok)) {
      watchLive($, root, targets)
      return { text: [...lines, '', `still checking every ${WATCH_MS / 1000}s for the next ${Math.round((WATCH_MS * WATCH_TICKS) / 60000)} minutes; a toast will say when it lands (/deploy-verify stop ends it)`].join('\n') }
    }
    return { text: lines.join('\n') }
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

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (disabled || e.agentId !== undefined) return r
    turnBusy = false
    if (pendingFollowUp !== undefined) {
      submitLater($, pendingFollowUp)
      pendingFollowUp = undefined
    }
    return r
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (disabled) return next(e)
    const deploy = isDeploy(e.command)
    const ciOnly = !deploy && isCiOnly(e.command)
    if (!deploy && !ciOnly) return next(e)
    const since = await $.clock.now()
    const r = await next(e)
    if ('deny' in r) return r

    const add = (...lines: string[]) => ({ ...r, context: [...(r.context ?? []), lines.join('\n')] })

    // Advisories are throttled; verdicts below are not.
    const advise = async (...lines: string[]) => ((await fresh($, lines.join('\n'))) ? add(...lines) : r)

    if (r.isError) {
      if (ciOnly) return r
      return advise(
        'deploy-verify: the deploy command did not succeed. Do not report a deploy as done.',
        'Report the failure with its output, then stop or fix it — whichever the user asked for.',
      )
    }

    const repo = await $.session.repo().catch(() => null)
    const root = repo?.root ?? (await $.session.cwd())
    const config = await readConfig($, root)
    const targets = config ? targetsOf(config) : []

    const url = isGh(e.command) ? `${r.result.stdout}\n${r.result.stderr}`.match(RUN_URL)?.[0] : undefined
    const ciTrigger = isPush(e.command) || url !== undefined
    const hasCi = ciTrigger && (await $.fs.exists(`${root}/.github/workflows`).catch(() => false))

    if (hasCi) {
      const live = ciOnly ? [] : targets
      const branch = url ? undefined : (pushBranch(e.command) ?? (await headBranch($, root)))
      armFollowUp()
      watchCi($, root, live, since, url, branch)
      await record($, [`CI PENDING for ${url ?? 'the push'} — watching GitHub Actions, then ${live.length ? 'the live URL' : ciOnly ? 'nothing (a pull request deploys nothing)' : 'nothing (no verify target configured)'}`])
      return add(
        `deploy-verify: this repo has GitHub Actions workflows, so the run for ${url ?? 'this push'} is being watched (polling every ${CI_POLL_MS / 1000}s, up to ${CI_CAP_MS / 60000} minutes) before any live check.`,
        'NOTHING is verified yet. Say the command exited 0 and that CI and the live site are still being checked.',
        live.length
          ? 'When CI passes the live URL is checked with cache-busting; the verdict lands in your context, and a follow-up prompt arrives if it never passes.'
          : ciOnly
            ? 'The pull request deploys nothing, so no live check follows; the CI verdict lands in your context.'
            : `No live URL is configured; write ${root}/.claude/deploy-verify.json as {"url":"https://…","match":"<string that proves the new version>"} to check one after CI.`,
      )
    }

    if (ciOnly) return r

    if (!targets.length) {
      return advise(
        'deploy-verify: no verify target configured for this repo, so NOTHING about the live site has been checked.',
        'You MUST NOT say "deployed successfully" or "live". Say the command exited 0 and the live site is unverified.',
        `To make this automatic, write ${root}/.claude/deploy-verify.json as {"url":"https://…","match":"<string that proves the new version>"}.`,
      )
    }

    $.ui.status('verifying live deploy…')
    const probes = await probeWithin($, root, targets, () => next.budget.remainingMs)
    $.ui.status(undefined)

    const lines = probes.map(p => p.line)
    await record($, lines)
    if (probes.some(p => !p.ok)) {
      armFollowUp()
      watchLive($, root, targets)
      return add(
        'deploy-verify ran the live check and it did NOT pass:',
        ...lines.map(v => `  ${v}`),
        'Report exactly this: "deploy succeeded but live content not yet showing — likely CDN", and ask the user to hard-refresh.',
        `Do not claim the deploy is verified. A watcher is now retrying every ${WATCH_MS / 1000}s for ${Math.round((WATCH_MS * WATCH_TICKS) / 60000)} minutes; it toasts when it lands and sends a follow-up prompt if it never does.`,
      )
    }

    stopWatch()
    $.ui.toast('deploy-verify: live content confirmed')
    return add(
      'deploy-verify checked the live URL(s) with cache-busting and they pass:',
      ...lines.map(v => `  ${v}`),
      'Quote the matched string back to the user as the evidence.',
    )
  }).catch(async ($, e, next) => {
    const r = await next(e)
    if ('deny' in r || !(isDeploy(e.command) || isCiOnly(e.command))) return r
    $.ui.log(`deploy-verify: the check failed (${next.error.message ?? next.error.kind})`)
    return {
      ...r,
      context: [
        ...(r.context ?? []),
        `deploy-verify failed to check this deploy (${next.error.kind}); NOTHING about CI or the live site is known. Do not claim the deploy verified; run /deploy-verify to check by hand.`,
      ],
    }
  })
}
