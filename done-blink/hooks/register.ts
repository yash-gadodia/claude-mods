import type { EngineInterface, Register } from 'claude-code'

// The tab spinner is too small to notice from another tab. When a main turn lands, a detached
// shell loop blinks the iTerm2 tab orange (on and off every half second) until the next prompt
// or a ceiling of seconds, whichever comes first, then puts the colour back. The escape goes
// straight to the tmux client's tty when there is one, so tmux needs no allow-passthrough; outside
// tmux it goes to the nearest ancestor's tty. A stale session just stops on its own.

const MOD = 'done-blink'
const ENABLED_KEY = 'done-blink:enabled'
const SECONDS_KEY = 'done-blink:seconds'
const DEFAULT_SECONDS = 180
const MAX_SECONDS = 900

const TTY = `
tty_of() {
  if [ -n "$TMUX" ] && [ -n "$TMUX_PANE" ]; then t=$(tmux display -p -t "$TMUX_PANE" '#{client_tty}' 2>/dev/null); [ -n "$t" ] && { echo "$t"; return; }; fi
  p=$PPID
  for i in 1 2 3 4 5 6; do
    t=$(ps -o tty= -p "$p" 2>/dev/null | tr -d ' ')
    case "$t" in ''|'??') p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' '); [ -n "$p" ] && [ "$p" != 1 ] || return;; *) echo "/dev/$t"; return;; esac
  done
}
T=$(tty_of); [ -n "$T" ] && [ -w "$T" ] || exit 0
F="\${TMPDIR:-/tmp}/done-blink.$(basename "$T")"
off=$(printf '\\033]6;1;bg;*;default\\a')
`

const START = `${TTY}
printf %s "$2" > "$F"
nohup sh -c '
T=$1 F=$2 N=$3 S=$4 off=$5 i=0
on=$(printf "\\033]6;1;bg;red;brightness;255\\a\\033]6;1;bg;green;brightness;140\\a\\033]6;1;bg;blue;brightness;0\\a")
while [ $i -lt $S ] && [ "$(cat "$F" 2>/dev/null)" = "$N" ]; do
  printf %s "$on" > "$T"; sleep 0.5; printf %s "$off" > "$T"; sleep 0.5; i=$((i+1))
done
printf %s "$off" > "$T"
[ "$(cat "$F" 2>/dev/null)" = "$N" ] && rm -f "$F"
' _ "$T" "$F" "$2" "$1" "$off" >/dev/null 2>&1 </dev/null &
`

const STOP = `${TTY}
rm -f "$F"
printf %s "$off" > "$T"
`

let disabled = false
let enabled = true
let seconds = DEFAULT_SECONDS
let nonce = 0

const readDisabled = async ($: EngineInterface): Promise<boolean> => {
  const raw = (await $.env.get('CLAUDE_MODS_DISABLE').catch(() => undefined)) ?? ''
  disabled = raw.split(',').map(v => v.trim()).some(v => v === 'all' || v === MOD)
  return disabled
}

const sh = ($: EngineInterface, script: string, args: string[]) =>
  $.process.run(['sh', '-c', script, MOD, ...args], { timeoutMs: 5000 }).catch(err => {
    $.ui.log(`${MOD}: ${err}`)
    return undefined
  })

const start = ($: EngineInterface) => {
  nonce += 1
  return sh($, START, [String(seconds), `${nonce}-${Date.now()}`])
}

const stop = ($: EngineInterface) => {
  if (nonce === 0) return Promise.resolve(undefined)
  nonce = 0
  return sh($, STOP, [])
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (await readDisabled($)) return r
    enabled = (await $.store.get(ENABLED_KEY).catch(() => undefined)) !== false
    const stored = await $.store.get(SECONDS_KEY).catch(() => undefined)
    if (typeof stored === 'number' && stored > 0) seconds = Math.min(stored, MAX_SECONDS)
    await $.command
      .register({
        name: 'done-blink',
        description: 'Blink the iTerm2 tab when a turn lands (done-blink)',
        argumentHint: '[on | off | status | <seconds>]',
        immediate: true,
      })
      .catch(err => $.ui.log(`${MOD}: /done-blink not registered: ${err}`))
    return r
  })

  on('command.run', { command: 'done-blink' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      enabled = arg === 'on'
      await $.store.set(ENABLED_KEY, enabled).catch(err => $.ui.log(`${MOD}: store write failed: ${err}`))
      if (!enabled) await stop($)
      return { text: `done-blink ${arg}` }
    }
    if (/^\d+$/.test(arg)) {
      seconds = Math.min(Math.max(Number(arg), 1), MAX_SECONDS)
      await $.store.set(SECONDS_KEY, seconds).catch(err => $.ui.log(`${MOD}: store write failed: ${err}`))
      return { text: `done-blink blinks for up to ${seconds}s` }
    }
    if (arg === '' || arg === 'status') return { text: `done-blink is ${enabled ? 'on' : 'off'}, up to ${seconds}s per turn` }
    return { text: `done-blink: "${arg}" is not on, off, status or a number of seconds` }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (disabled || !enabled || e.agentId !== undefined || e.reason === 'aborted') return r
    await start($)
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    if (!disabled && enabled) await stop($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!disabled && enabled) await stop($)
    return next(e)
  })
}
