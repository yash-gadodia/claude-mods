import type { EngineInterface, Register } from 'claude-code'

// Switching the Claude in Chrome extension between profiles without the approval click.
//
// Every profile with the extension is already connected at once. What costs a click is
// switch_browser, which broadcasts a pairing request to all of them and waits; its sibling
// select_browser takes a deviceId and, in its own words, selects "without broadcasting a pairing
// request". The model reaches for the first one only because it cannot tell which browser is which.
//
// It cannot tell because the extension's own names do not survive the round trip: measured on
// 17-09-2026, list_connected_browsers called the same three devices Browser 1/2/3 while
// select_browser echoed Browser 2/3/4 for those same ids, and a name set through switch_browser was
// reported by neither. So a name is not a key here. The deviceId is, and the map from a label to a
// deviceId is kept here, in a file a person can read and edit:
//
//   ~/.claude/chrome-browsers.json  { "default": "volty", "browsers": { "volty": "<deviceId>" } }
//
// A deviceId that is no longer connected is reported rather than silently skipped, because the
// recovery (/chromep pick, /chromep map) is a person's call and a wrong browser is worse than none.

const SERVER = 'claude-in-chrome'
const PREFIX = 'mcp__claude-in-chrome__'
// The three that steer the choice rather than act on a page; selecting underneath them would race.
const STEERING = new Set([`${PREFIX}list_connected_browsers`, `${PREFIX}select_browser`, `${PREFIX}switch_browser`])

type BrowserMap = { default?: string; browsers: Record<string, string> }

let mapPath: string | undefined
let selected: string | undefined
let tried = false

const text = (r: { content?: unknown }): string => {
  const blocks = Array.isArray(r.content) ? r.content : []
  return blocks
    .map((b) => (b && typeof b === 'object' && 'text' in b && typeof b.text === 'string' ? b.text : ''))
    .join('\n')
}

export const readMap = async ($: EngineInterface): Promise<BrowserMap> => {
  if (!mapPath) return { browsers: {} }
  const r = await $.process.run(['cat', mapPath], { timeoutMs: 5000 }).catch(() => undefined)
  if (!r || r.exitCode !== 0) return { browsers: {} }
  try {
    const parsed: unknown = JSON.parse(r.stdout)
    if (!parsed || typeof parsed !== 'object') return { browsers: {} }
    const raw = (parsed as { browsers?: unknown }).browsers
    const browsers: Record<string, string> = {}
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') browsers[k.toLowerCase()] = v
    }
    const fallback = (parsed as { default?: unknown }).default
    return { default: typeof fallback === 'string' ? fallback.toLowerCase() : undefined, browsers }
  } catch {
    return { browsers: {} }
  }
}

const writeMap = async ($: EngineInterface, map: BrowserMap): Promise<boolean> => {
  if (!mapPath) return false
  const r = await $.process
    .run(['tee', mapPath], { stdin: `${JSON.stringify(map, null, 2)}\n`, timeoutMs: 5000 })
    .catch((err) => {
      $.ui.log(`chrome-switch: map write failed: ${err}`)
      return undefined
    })
  return r?.exitCode === 0
}

const connected = async ($: EngineInterface): Promise<string[]> => {
  const r = await $.mcp.call(SERVER, 'list_connected_browsers').catch(() => undefined)
  if (!r) return []
  const match = /\[[\s\S]*?\]/.exec(text(r))
  if (!match) return []
  try {
    const parsed: unknown = JSON.parse(match[0])
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((b) =>
      b && typeof b === 'object' && 'deviceId' in b && typeof b.deviceId === 'string' ? [b.deviceId] : [],
    )
  } catch {
    return []
  }
}

const select = async ($: EngineInterface, deviceId: string): Promise<boolean> => {
  const r = await $.mcp.call(SERVER, 'select_browser', { deviceId }).catch((err) => {
    $.ui.log(`chrome-switch: select_browser failed: ${err}`)
    return undefined
  })
  if (!r || r.isError) return false
  selected = deviceId
  return true
}

const short = (deviceId: string) => deviceId.slice(0, 8)

// The first thing anyone does when a mod misbehaves is try to turn it off. `CLAUDE_MODS_DISABLE=all`,
// or a comma list naming this mod, makes every hook here a pass-through and registers no command.
const MOD = 'chrome-switch'
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
    const home = await $.env.get('HOME').catch(() => undefined)
    if (home) mapPath = `${home}/.claude/chrome-browsers.json`
    await $.command
      .register({
        name: 'chromep',
        description: 'Switch the Chrome profile Claude drives, with no approval click: /chromep volty (chrome-switch)',
        argumentHint: '[label | pick <n> | map <label> | default <label>]',
        immediate: true,
      })
      .catch((err) => $.ui.log(`chrome-switch: /chromep not registered: ${err}`))
    return r
  })

  on('command.run', { command: 'chromep' }, async ($, e) => {
    const args = e.args.trim().split(/\s+/).filter(Boolean)
    const verb = args[0]?.toLowerCase()
    const map = await readMap($)

    if (verb === 'map') {
      const wanted = args.slice(1).join(' ').toLowerCase()
      if (!wanted) return { text: 'chrome-switch: /chromep map <label> names the browser that is selected now' }
      if (!selected) return { text: 'chrome-switch: nothing selected yet this session — /chromep pick <n> first, then map it' }
      map.browsers[wanted] = selected
      if (!(await writeMap($, map))) return { text: `chrome-switch: could not write ${mapPath}` }
      return { text: `${wanted} → ${short(selected)}, saved to ${mapPath}` }
    }

    if (verb === 'default') {
      const wanted = args.slice(1).join(' ').toLowerCase()
      if (!wanted) return { text: `chrome default is ${map.default ?? 'unset'} — /chromep default <label> to set it` }
      if (!map.browsers[wanted]) return { text: `chrome-switch: no label "${wanted}" in the map — /chromep lists it` }
      map.default = wanted
      if (!(await writeMap($, map))) return { text: `chrome-switch: could not write ${mapPath}` }
      return { text: `chrome default is now ${wanted} — selected before the first browser call of a session` }
    }

    const live = await connected($)
    if (!live.length) return { text: 'chrome-switch: no browsers connected — is the extension running in any profile?' }

    if (verb === 'pick') {
      const n = Number(args[1])
      const deviceId = Number.isInteger(n) ? live[n - 1] : undefined
      if (!deviceId) return { text: `chrome-switch: pick 1..${live.length}` }
      if (!(await select($, deviceId))) return { text: `chrome-switch: could not select ${short(deviceId)}` }
      return { text: `selected ${short(deviceId)} — act in the browser to see which profile it is, then /chromep map <label>` }
    }

    const wanted = args.join(' ').toLowerCase()
    if (!wanted) {
      const labelled = new Map(Object.entries(map.browsers).map(([k, v]) => [v, k]))
      const rows = live
        .map((id, i) => `  ${i + 1}. ${labelled.get(id) ?? '(unmapped)'}  ${short(id)}${id === selected ? '  ← selected' : ''}${labelled.get(id) === map.default ? '  (default)' : ''}`)
        .join('\n')
      const missing = Object.entries(map.browsers)
        .filter(([, id]) => !live.includes(id))
        .map(([label, id]) => `  ${label} (${short(id)}) is mapped but not connected — /chromep pick <n> then /chromep map ${label}`)
        .join('\n')
      return { text: `connected chrome profiles — /chromep <label> switches, no approval click\n${rows}${missing ? `\n${missing}` : ''}` }
    }

    const deviceId = map.browsers[wanted]
    if (!deviceId) return { text: `chrome-switch: no label "${wanted}" in the map — /chromep lists what there is` }
    if (!live.includes(deviceId)) {
      return { text: `chrome-switch: ${wanted} (${short(deviceId)}) is not connected — open that Chrome profile, or re-map it with /chromep pick <n> then /chromep map ${wanted}` }
    }
    if (!(await select($, deviceId))) return { text: `chrome-switch: could not select ${wanted}` }
    $.ui.toast(`chrome: ${wanted}`, { timeoutMs: 3000 })
    return { text: `driving ${wanted}` }
  })

  // Matched on the server's prefix, so no other tool call passes through here at all.
  on('tool.call', { tool: /^mcp__claude-in-chrome__/ }, async ($, e, next) => {
    if (disabled) return next(e)
    // e.tool is McpToolName, a template the typings snapshot cannot narrow further for a server
    // it does not declare; widened, the names compare.
    const tool: string = e.tool

    // The list tool's own instructions send the model to switch_browser, which is the click. Naming
    // the map underneath the result points it at select_browser instead.
    if (tool === `${PREFIX}list_connected_browsers`) {
      const r = await next(e)
      if ('deny' in r && r.deny !== undefined) return r
      const map = await readMap($)
      const known = Object.entries(map.browsers)
      if (!known.length) return r
      return {
        ...r,
        context: [
          ...(r.context ?? []),
          `chrome-switch: these deviceIds are known — ${known.map(([l, id]) => `${l} = ${id}`).join(', ')}${map.default ? `; the default is ${map.default}` : ''}${selected ? `; ${short(selected)} is already selected this session` : ''}. Call select_browser with the right deviceId rather than switch_browser, which broadcasts a pairing request the person has to click.`,
        ],
      }
    }

    if (STEERING.has(tool) || tried || selected) return next(e)
    tried = true
    const map = await readMap($)
    const deviceId = map.default ? map.browsers[map.default] : undefined
    if (deviceId && (await select($, deviceId))) $.ui.toast(`chrome: ${map.default}`, { timeoutMs: 3000 })
    return next(e)
  })
}
