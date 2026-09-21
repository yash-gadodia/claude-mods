/* @jsx h */
import type { EngineInterface, Register } from 'claude-code'

// A gym timer for each turn. Submitting a prompt starts "3 · 2 · 1 · GO" (450ms a beat), then
// the clock runs a second at a time until the turn lands and the split is written next to the
// session's average and longest. The timer only ticks while a turn is running.

const BEAT_MS = 450
const SHOWN_KEY = 'wod-timer:shown'

let shown = true
let phase: 'idle' | 'count' | 'run' = 'idle'
let beat = 0
let startedAt = 0
let last: number | undefined
let splits: number[] = []
let tick: { cancel: () => void } | undefined

const COUNT = ['3', '2', '1', 'GO']

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

const stop = () => {
  tick?.cancel()
  tick = undefined
}

function startRun($: EngineInterface) {
  phase = 'run'
  stop()
  tick = $.clock.every(1000, () => $.ui.invalidate('ui.render'))
  $.ui.invalidate('ui.render')
}

function land($: EngineInterface, counts: boolean) {
  stop()
  if (phase !== 'idle' && counts) {
    last = Date.now() - startedAt
    splits.push(last)
  }
  phase = 'idle'
  $.ui.invalidate('ui.render')
}

// The first thing anyone does when a mod misbehaves is try to turn it off. `CLAUDE_MODS_DISABLE=all`,
// or a comma list naming this mod, makes every hook here a pass-through and registers no command.
const MOD = 'wod-timer'
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
    await $.command
      .register({
        name: 'wod-timer',
        description: '3-2-1-GO on submit and a running clock per turn (wod-timer)',
        argumentHint: '[on | off]',
        immediate: true,
      })
      .catch((err) => $.ui.log(`wod-timer: /wod-timer not registered: ${err}`))
    return r
  })

  on('command.run', { command: 'wod-timer' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      shown = false
      stop()
      await $.store.set(SHOWN_KEY, false).catch(() => undefined)
      $.ui.invalidate('ui.render')
      return { text: 'wod timer off' }
    }
    if (arg === 'on' || arg === '') {
      shown = true
      await $.store.set(SHOWN_KEY, true).catch(() => undefined)
      $.ui.invalidate('ui.render')
      return { text: 'wod timer on' }
    }
    return { text: `wod-timer: no such argument "${arg}" — use on or off` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (disabled) return next(e)
    if (shown) {
      startedAt = Date.now()
      phase = 'count'
      beat = 0
      stop()
      tick = $.clock.every(BEAT_MS, () => {
        beat += 1
        if (beat >= COUNT.length) {
          if (phase === 'count') startRun($)
          return
        }
        $.ui.invalidate('ui.render')
      })
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (disabled) return next(e)
    // A turn the timer did not see submitted (a plugin's own prompt, a resumed session) still
    // gets a clock, but never a countdown mid-run.
    if (shown && phase === 'idle') {
      startedAt = Date.now()
      startRun($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (disabled) return next(e)
    const r = await next(e)
    land($, true)
    return r
  })

  on('turn.abort', async ($, e, next) => {
    if (disabled) return next(e)
    const r = await next(e)
    land($, false)
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (disabled) return next(e)
    if (!shown || e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    try {
      const { Box, Text } = await $.ui.resolve(e)
      const rest = await next(e)
      let line
      if (phase === 'count') {
        const word = COUNT[Math.min(beat, COUNT.length - 1)]!
        const colour = word === 'GO' ? 'green' : word === '1' ? 'yellow' : '#dd3b2a'
        line = (
          <Text>
            <Text dimColor>timer  </Text>
            {COUNT.slice(0, beat).map((w, i) => (
              <Text key={`${i}`} dimColor>{`${w} · `}</Text>
            ))}
            <Text bold color={colour}>{word}</Text>
          </Text>
        )
      } else if (phase === 'run') {
        line = (
          <Text>
            <Text dimColor>timer  </Text>
            <Text bold color="green">{clock(Date.now() - startedAt)}</Text>
            <Text dimColor> running</Text>
          </Text>
        )
      } else if (last !== undefined) {
        const avg = splits.reduce((a, b) => a + b, 0) / splits.length
        const longest = Math.max(...splits)
        line = (
          <Text>
            <Text dimColor>timer  </Text>
            <Text dimColor>split </Text>
            <Text bold>{clock(last)}</Text>
            <Text dimColor>{` · avg ${clock(avg)} · longest ${clock(longest)} · ${splits.length} turns`}</Text>
          </Text>
        )
      } else {
        line = <Text dimColor>timer  ready · 3, 2, 1 on your next prompt</Text>
      }
      return (
        <Box flexDirection="column">
          {line}
          {rest}
        </Box>
      )
    } catch (err) {
      $.ui.log(`wod-timer: render failed: ${err}`)
      return next(e)
    }
  })
}
