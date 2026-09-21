/* @jsx h */
import type { EngineInterface, Register, RenderElement, SessionMeasureInput } from 'claude-code'

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

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (await readDisabled($)) return r
    if ((await $.store.get(SHOWN_KEY).catch(() => undefined)) === false) shown = false
    await readAccount($)
    await readContext($)
    await $.command
      .register({
        name: 'usage-band',
        description: 'The usage line above the prompt: limit windows, context fill, cost (usage-band)',
        argumentHint: '[on | off]',
        immediate: true,
      })
      .catch((err) => $.ui.log(`usage-band: /usage-band not registered: ${err}`))
    return r
  })

  on('command.run', { command: 'usage-band' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
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
    return { text: `usage-band: no such argument "${arg}" — use on or off` }
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
            <Text dimColor>{account ? `usage · ${account} · no reading yet` : 'usage · no reading yet'}</Text>
            {rest}
          </Box>
        )
      }

      const { fiveHour, fiveHourResetsAt, sevenDay, ctxPercent, ctxTokens, usd } = reading
      const now = await $.clock.now()
      const left = fiveHourResetsAt !== undefined ? countdown(fiveHourResetsAt - now) : undefined

      // Each segment knows its width, so the line can shed its least useful parts, the delta first,
      // until it fits the band's columns on one row.
      type Segment = { key: string; width: number; node: RenderElement; drop: number }
      const seg = (key: string, text: string, node: RenderElement, drop = 0): Segment => ({ key, width: text.length, node, drop })
      const segments: Segment[] = [seg('usage', 'usage', <Text dimColor>usage</Text>)]
      if (account !== undefined) segments.push(seg('account', account, <Text color="cyan">{account}</Text>, 3))
      if (project !== undefined) segments.push(seg('project', project, <Text color="magenta">{project}</Text>, 2))
      if (model !== undefined) segments.push(seg('model', model, <Text dimColor>{model}</Text>, 4))
      if (fiveHour !== undefined) {
        const text = `5h ${Math.round(fiveHour)}%${left ? ` ↻${left}` : ''}`
        segments.push(
          seg(
            '5h',
            text,
            <Text>
              <Text dimColor>5h </Text>
              <Text bold color={heat(fiveHour)}>{`${Math.round(fiveHour)}%`}</Text>
              {left ? <Text dimColor>{` ↻${left}`}</Text> : null}
            </Text>,
          ),
        )
      }
      if (sevenDay !== undefined) {
        segments.push(
          seg(
            '7d',
            `7d ${Math.round(sevenDay)}%`,
            <Text>
              <Text dimColor>7d </Text>
              <Text bold color={heat(sevenDay)}>{`${Math.round(sevenDay)}%`}</Text>
            </Text>,
          ),
        )
      }
      if (ctxPercent !== undefined) {
        const tail = ctxTokens !== undefined ? ` ${tokens(ctxTokens)}` : ''
        segments.push(
          seg(
            'ctx',
            `ctx ${Math.round(ctxPercent)}%${tail}`,
            <Text>
              <Text dimColor>ctx </Text>
              <Text bold color={heat(ctxPercent)}>{`${Math.round(ctxPercent)}%`}</Text>
              {tail ? <Text dimColor>{tail}</Text> : null}
            </Text>,
          ),
        )
      }
      if (usd !== undefined) segments.push(seg('usd', `$${usd.toFixed(2)}`, <Text dimColor>{`$${usd.toFixed(2)}`}</Text>, 5))
      if (delta) {
        const text = `last ${tokens(delta.in)} in · ${tokens(delta.out)} out · ${tokens(delta.cache)} cache`
        segments.push(seg('last', text, <Text dimColor>{text}</Text>, 1))
      }
      if (ctxPercent !== undefined && ctxPercent >= NUDGE_AT) {
        segments.push(seg('nudge', '· /clear on a new task', <Text color="yellow">· /clear on a new task</Text>))
      }

      const width = (list: Segment[]) => list.reduce((n, s) => n + s.width, 0) + 2 * (list.length - 1)
      let shownSegments = segments
      while (width(shownSegments) > e.props.bodyColumns) {
        const droppable = shownSegments.filter((s) => s.drop > 0)
        if (!droppable.length) break
        const gone = droppable.reduce((a, b) => (a.drop < b.drop ? a : b))
        shownSegments = shownSegments.filter((s) => s !== gone)
      }

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2}>
            {shownSegments.map((s) => (
              <Box key={s.key}>{s.node}</Box>
            ))}
          </Box>
          {rest}
        </Box>
      )
    } catch (err) {
      $.ui.log(`usage-band: render failed: ${err}`)
      return next(e)
    }
  })
}
