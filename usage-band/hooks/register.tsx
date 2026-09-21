/* @jsx h */
import type { EngineInterface, Register } from 'claude-code'

// The limit windows and this session's context fill on one line above the prompt.
//
// $.session.usage() reads what the last API response already reported, so it costs no request and
// no tokens; it is refreshed on turn.complete rather than inside the render hook, which runs on
// every keystroke. Before the first response of a session there is no reading at all.
//
// The nudge exists because long windows are where the money goes: /usage says most of the spend
// happens above 150k context, and a dim band is easy to stop seeing, so each new tenth of the
// window past the threshold also toasts once.

const NUDGE_AT = 55
const SHOWN_KEY = 'usage-band:shown'

type Reading = {
  fiveHour?: number
  sevenDay?: number
  ctxPercent?: number
  ctxTokens?: number
  usd?: number
}

let reading: Reading | undefined
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
  if (!raw) return
  const email = JSON.parse(raw)?.oauthAccount?.emailAddress
  account = typeof email === 'string' ? email : undefined
}

// The model can change mid-session with /model and the folder is fixed, but both are one cheap
// in-process read, so they go with the account each turn rather than keeping their own state.
const readContext = async ($: EngineInterface): Promise<void> => {
  model = await $.session.model().catch(() => undefined)
  const cwd = await $.session.cwd().catch(() => undefined)
  project = cwd ? cwd.split('/').filter(Boolean).at(-1) : undefined
}

const read = async ($: EngineInterface): Promise<void> => {
  const u = await $.session.usage().catch(() => undefined)
  if (!u) return
  const window = (kind: string) => u.rateLimits.find((l) => l.kind === kind)?.percentUsed
  reading = {
    fiveHour: window('five_hour'),
    sevenDay: window('seven_day'),
    ctxPercent: u.context.percent,
    ctxTokens: u.context.tokens,
    usd: u.cost?.usd,
  }
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

  on('turn.complete', async ($, e, next) => {
    if (disabled) return next(e)
    const r = await next(e)
    if (!shown) return r
    await read($)
    await readAccount($)
    await readContext($)
    const percent = reading?.ctxPercent
    if (percent !== undefined) {
      // A clear or a compact drops the fill, and the nudge arms itself again from there.
      if (percent < nudgedAt) nudgedAt = 0
      if (percent >= NUDGE_AT && percent >= nudgedAt + 10) {
        nudgedAt = Math.floor(percent / 10) * 10
        $.ui.toast(`context ${Math.round(percent)}% · /clear if the next thing is a new task, /compact to keep going`, {
          timeoutMs: 8000,
        })
      }
    }
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

      const { fiveHour, sevenDay, ctxPercent, ctxTokens, usd } = reading
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2}>
            <Text dimColor>usage</Text>
            {account !== undefined ? <Text color="cyan">{account}</Text> : null}
            {project !== undefined ? <Text color="magenta">{project}</Text> : null}
            {model !== undefined ? <Text dimColor>{model}</Text> : null}
            {fiveHour !== undefined ? (
              <Text>
                <Text dimColor>5h </Text>
                <Text bold color={heat(fiveHour)}>{`${Math.round(fiveHour)}%`}</Text>
              </Text>
            ) : null}
            {sevenDay !== undefined ? (
              <Text>
                <Text dimColor>7d </Text>
                <Text bold color={heat(sevenDay)}>{`${Math.round(sevenDay)}%`}</Text>
              </Text>
            ) : null}
            {ctxPercent !== undefined ? (
              <Text>
                <Text dimColor>ctx </Text>
                <Text bold color={heat(ctxPercent)}>{`${Math.round(ctxPercent)}%`}</Text>
                {ctxTokens !== undefined ? <Text dimColor>{` ${tokens(ctxTokens)}`}</Text> : null}
              </Text>
            ) : null}
            {usd !== undefined ? <Text dimColor>{`$${usd.toFixed(2)}`}</Text> : null}
            {ctxPercent !== undefined && ctxPercent >= NUDGE_AT ? (
              <Text color="yellow">· /clear on a new task</Text>
            ) : null}
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
