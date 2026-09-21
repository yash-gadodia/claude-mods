/* @jsx h */
import type { EngineInterface, Register, SessionMeasureInput } from 'claude-code'

// The limit windows and this session's context fill on one line above the prompt.
//
// session.measure pushes what the last API response already reported, after each turn and whenever a
// limit window moves a whole point, so it costs no request and no tokens and the render hook, which
// runs on every keystroke, never reads anything. Before the first response there is no reading at all.
//
// The nudge exists because long windows are where the money goes: /usage says most of the spend
// happens above 150k context, and a dim band is easy to stop seeing, so each new tenth of the
// window past the threshold also toasts once.

const NUDGE_AT = 55
const SHOWN_KEY = 'usage-band:shown'
const SGD_KEY = 'usage-band:sgd'
let SGD_RATE = 1.3

type Reading = {
  fiveHour?: number
  fiveHourResetsAt?: number
  sevenDay?: number
  ctxPercent?: number
  ctxTokens?: number
  usd?: number
}

type Delta = { in: number; out: number; cache: number }

let reading: Reading | undefined
let delta: Delta | undefined
let account: string | undefined
let model: string | undefined
let project: string | undefined
let shown = true
let sgdShown = true
let nudgedAt = 0

// Which login the figures belong to. $.session.usage() does not carry it, and the same terminal
// switches accounts mid-session with /login, so it is re-read each turn from the file the CLI
// writes the logged-in account into.
const readAccount = async ($: EngineInterface): Promise<void> => {
  const home = await $.env.get('HOME').catch(() => undefined)
  if (!home) return
  const raw = await $.fs.read(`${home}/.claude.json`).catch(() => undefined)
  if (typeof raw !== 'string') return
  const found = accountIn(raw)
  if (found) account = found.email
}

// The CLI rewrites this file, so a half-written one is unreadable rather than a logout: undefined
// keeps the account as it was, a parsed file without an email is a logout.
export const accountIn = (raw: string): { email: string | undefined } | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const email = (parsed as { oauthAccount?: { emailAddress?: unknown } } | null)?.oauthAccount?.emailAddress
  return { email: typeof email === 'string' ? email : undefined }
}

// The model can change mid-session with /model and the folder is fixed, but both are one cheap
// in-process read, so they go with the account each turn rather than keeping their own state.
const readContext = async ($: EngineInterface): Promise<void> => {
  model = await $.session.model().catch(() => undefined)
  const cwd = await $.session.cwd().catch(() => undefined)
  project = cwd ? cwd.split('/').filter(Boolean).at(-1) : undefined
}

type Usage = Pick<SessionMeasureInput, 'context' | 'rateLimits' | 'cost'>

const take = (u: Usage): void => {
  const window = (kind: string) => u.rateLimits.find((l) => l.kind === kind)
  const resetsAt = Date.parse(window('five_hour')?.resetsAt ?? '')
  reading = {
    fiveHour: window('five_hour')?.percentUsed,
    fiveHourResetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
    sevenDay: window('seven_day')?.percentUsed,
    ctxPercent: u.context.percent,
    ctxTokens: u.context.tokens,
    usd: u.cost?.usd,
  }
}

const read = async ($: EngineInterface): Promise<void> => {
  const u = await $.session.usage().catch(() => undefined)
  if (u) take(u)
}

const nudge = ($: EngineInterface): void => {
  const percent = reading?.ctxPercent
  if (percent === undefined) return
  // A clear or a compact drops the fill, and the nudge arms itself again from there.
  if (percent < nudgedAt) nudgedAt = 0
  if (percent >= NUDGE_AT && percent >= nudgedAt + 10) {
    nudgedAt = Math.floor(percent / 10) * 10
    $.ui.toast(`context ${Math.round(percent)}% · /clear if the next thing is a new task, /compact to keep going`, {
      timeoutMs: 8000,
    })
  }
}

type Part = { text: string; dim?: boolean; bold?: boolean; color?: string }
type Segment = { parts: Part[]; drop: number }

const family = (id: string) => /opus|sonnet|fable|haiku/.exec(id)?.[0] ?? id.replace(/^claude-/, '').replace(/\[1m\]$/, '')

const GAP = '  '
const width = (list: Segment[]) => list.reduce((n, s) => n + s.parts.reduce((m, p) => m + p.text.length, 0), 0) + GAP.length * Math.max(0, list.length - 1)

// The whole line as one string, measured against the band's columns and shed by priority until it
// fits: the turn delta, project, account, then the model to its family word, then cost, then the
// nudge. The windows and the context fill are never shed. The "usage" label goes under 60 columns.
export const layout = (state: {
  account?: string
  project?: string
  model?: string
  reading: Reading
  delta?: Delta
  now: number
  columns: number
}): Part[] => {
  const { fiveHour, fiveHourResetsAt, sevenDay, ctxPercent, ctxTokens, usd } = state.reading
  const left = fiveHourResetsAt !== undefined ? countdown(fiveHourResetsAt - state.now) : undefined
  const segments: Segment[] = []
  if (state.columns >= 60) segments.push({ parts: [{ text: 'usage', dim: true }], drop: 0 })
  if (state.account !== undefined) segments.push({ parts: [{ text: state.account, color: 'cyan' }], drop: 3 })
  if (state.project !== undefined) segments.push({ parts: [{ text: state.project, color: 'magenta' }], drop: 2 })
  if (state.model !== undefined) segments.push({ parts: [{ text: state.model, dim: true }], drop: 4 })
  if (fiveHour !== undefined) {
    segments.push({
      parts: [{ text: '5h ', dim: true }, { text: `${Math.round(fiveHour)}%`, bold: true, color: heat(fiveHour) }, ...(left ? [{ text: ` ↻${left}`, dim: true }] : [])],
      drop: 0,
    })
  }
  if (sevenDay !== undefined) {
    segments.push({ parts: [{ text: '7d ', dim: true }, { text: `${Math.round(sevenDay)}%`, bold: true, color: heat(sevenDay) }], drop: 0 })
  }
  if (ctxPercent !== undefined) {
    segments.push({
      parts: [
        { text: 'ctx ', dim: true },
        { text: `${Math.round(ctxPercent)}%`, bold: true, color: heat(ctxPercent) },
        ...(ctxTokens !== undefined ? [{ text: ` ${tokens(ctxTokens)}`, dim: true }] : []),
      ],
      drop: 0,
    })
  }
  if (usd !== undefined) segments.push({ parts: [{ text: `$${usd.toFixed(2)}`, dim: true }], drop: 5 })
  if (state.delta) {
    const d = state.delta
    segments.push({ parts: [{ text: `last ${tokens(d.in)} in · ${tokens(d.out)} out · ${tokens(d.cache)} cache`, dim: true }], drop: 1 })
  }
  if (ctxPercent !== undefined && ctxPercent >= NUDGE_AT) segments.push({ parts: [{ text: '· /clear on a new task', color: 'yellow' }], drop: 6 })

  let kept = segments
  let shortened = false
  while (width(kept) > state.columns) {
    const droppable = kept.filter((s) => s.drop > 0)
    if (!droppable.length) break
    const gone = droppable.reduce((a, b) => (a.drop < b.drop ? a : b))
    if (gone.drop === 4 && !shortened && state.model !== undefined) {
      shortened = true
      kept = kept.map((s) => (s === gone ? { parts: [{ text: family(state.model ?? ''), dim: true }], drop: 4 } : s))
      continue
    }
    kept = kept.filter((s) => s !== gone)
  }
  return kept.flatMap((s, i) => (i ? [{ text: GAP, dim: true }, ...s.parts] : s.parts))
}

export const countdown = (ms: number) => {
  const m = Math.max(0, Math.ceil(ms / 60000))
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

const heat = (percent: number) => (percent >= 75 ? 'red' : percent >= 50 ? 'yellow' : 'green')

const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)

// The first thing anyone does when a mod misbehaves is try to turn it off. `CLAUDE_MODS_DISABLE=all`,
// or a comma list naming this mod, makes every hook here a pass-through and registers no command.
const MOD = 'usage-band'
let disabled = false
const readDisabled = async ($: EngineInterface): Promise<boolean> => {
  const raw = (await $.env.get('CLAUDE_MODS_DISABLE').catch(() => undefined)) ?? ''
  disabled = raw
    .split(',')
    .map(v => v.trim())
    .some(v => v === 'all' || v === MOD)
  return disabled
}

export const register: Register = (on, options) => {
  const rate = Number(options.sgdRate)
  if (Number.isFinite(rate) && rate > 0) SGD_RATE = rate

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (await readDisabled($)) return r
    if ((await $.store.get(SHOWN_KEY).catch(() => undefined)) === false) shown = false
    if ((await $.store.get(SGD_KEY).catch(() => undefined)) === false) sgdShown = false
    await readAccount($)
    await readContext($)
    await $.command
      .register({
        name: 'usage-band',
        description: 'The usage line above the prompt: limit windows, context fill, cost (usage-band)',
        argumentHint: '[on | off | sgd on | sgd off]',
        immediate: true,
      })
      .catch((err) => $.ui.log(`usage-band: /usage-band not registered: ${err}`))
    return r
  })

  on('command.run', { command: 'usage-band' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'sgd on' || arg === 'sgd off') {
      sgdShown = arg === 'sgd on'
      await $.store.set(SGD_KEY, sgdShown).catch(() => undefined)
      $.ui.invalidate('ui.render')
      return { text: sgdShown ? `S$ footer label on (rate ${SGD_RATE}, set sgdRate in /config)` : 'S$ footer label off' }
    }
    if (arg === 'off') {
      shown = false
      await $.store.set(SHOWN_KEY, false).catch(() => undefined)
      $.ui.invalidate('ui.render')
      return { text: 'usage band off' }
    }
    if (arg === 'on' || arg === '') {
      shown = true
      await $.store.set(SHOWN_KEY, true).catch(() => undefined)
      await read($)
      $.ui.invalidate('ui.render')
      return { text: 'usage band on' }
    }
    return { text: `usage-band: no such argument "${arg}" — use on, off, sgd on or sgd off` }
  })

  on('session.measure', async ($, e, next) => {
    if (disabled) return next(e)
    const r = await next(e)
    if (!shown) return r
    take(e)
    nudge($)
    $.ui.invalidate('ui.render')
    return r
  })

  // The last turn's own token counts come with the turn, not the measurement; the account, model and
  // folder are re-read here because a turn is when any of them can have changed.
  on('turn.complete', async ($, e, next) => {
    if (disabled) return next(e)
    const r = await next(e)
    if (!shown || e.agentId) return r
    if (e.usage) {
      delta = {
        in: e.usage.input_tokens,
        out: e.usage.output_tokens,
        cache: e.usage.cache_read_input_tokens + e.usage.cache_creation_input_tokens,
      }
    }
    await readAccount($)
    await readContext($)
    $.ui.invalidate('ui.render')
    return r
  })

  // The session's cost in dollars that mean something here, as a footer mode label beside `focus`.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (disabled || !shown || !sgdShown || reading?.usd === undefined) return next(e)
    const label = `S$${(reading.usd * SGD_RATE).toFixed(2)}`
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } })
  })

  // A render hook that throws unmounts the module and takes the whole mod with it, so a bad frame
  // falls back to the band as it was rather than costing the session its usage line.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (disabled) return next(e)
    if (!shown || e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    try {
      const { Box, Text } = await $.ui.resolve(e)
      const rest = await next(e)

      if (!reading) {
        return (
          <Box flexDirection="column">
            <Text dimColor wrap="truncate">{account ? `usage · ${account} · no reading yet` : 'usage · no reading yet'}</Text>
            {rest}
          </Box>
        )
      }

      const now = await $.clock.now()
      const parts = layout({ account, project, model, reading, delta, now, columns: e.props.bodyColumns || 80 })
      return (
        <Box flexDirection="column">
          <Text wrap="truncate">
            {parts.map((p, i) => (
              <Text key={String(i)} dimColor={p.dim} bold={p.bold} color={p.color}>
                {p.text}
              </Text>
            ))}
          </Text>
          {rest}
        </Box>
      )
    } catch (err) {
      $.ui.log(`usage-band: render failed: ${err}`)
      return next(e)
    }
  })
}
