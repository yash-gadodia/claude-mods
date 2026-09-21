/* @jsx h */
import type { EngineInterface, Register } from 'claude-code'

// Every code block and quoted draft in the last answer, as a pressable button above the prompt.
//
// A press runs pbcopy in the plugin's own environment: no model turn, no tokens, no waiting for a
// reply that says "copied". Digits press from an empty composer, the mouse presses anywhere.
//
// The band only ever shows the last answer, so each block is also appended to a stash file that
// outlives the session; /stash lists it and /stash 7 puts an old one back on the clipboard, which is
// the part a clipboard manager cannot do (it holds what was copied, not what was offered).
//
// 0 toggles WhatsApp mode: the copy is wrapped in a triple-backtick fence, which Telegram renders
// as a native click-to-copy block and WhatsApp as monospace.

const MAX_BLOCKS = 6
const STASH_KEEP = 60
const LABEL_WIDTH = 20
const WA_KEY = 'copy-band:wa'

type Block = { label: string; text: string }

let blocks: Block[] = []
let wa = false
let stashPath: string | undefined
let stashed = 0

const clean = (text: string) => text.replace(/\s+$/, '').replace(/^\n+/, '')

// The first line says more than the language does, so the language is dropped unless the block had
// no fence to announce it (a quoted draft) or no first line worth reading.
const label = (text: string, lang: string) => {
  const first = (text.split('\n').find((l) => l.trim()) ?? '').trim()
  const head = lang === 'draft' || !first ? `${lang} ${first}`.trim() : first
  return head.length > LABEL_WIDTH ? `${head.slice(0, LABEL_WIDTH - 1)}…` : head
}

// Fenced blocks of any language, plus runs of quoted lines, which is how a draft message arrives.
export const parse = (answer: string): Block[] => {
  const found: Block[] = []
  const add = (raw: string, lang: string) => {
    const text = clean(raw)
    if (text.length < 3) return
    if (found.some((b) => b.text === text)) return
    found.push({ label: label(text, lang), text })
  }

  let fence: string | undefined
  let lang = ''
  let body: string[] = []
  let quote: string[] = []
  const flushQuote = () => {
    if (quote.length) add(quote.join('\n'), 'draft')
    quote = []
  }

  for (const line of answer.split('\n')) {
    const open = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence !== undefined) {
      const mark = open?.[1]
      if (mark && mark[0] === fence[0] && mark.length >= fence.length && !(open?.[2] ?? '').trim()) {
        add(body.join('\n'), lang)
        fence = undefined
        body = []
        continue
      }
      body.push(line)
      continue
    }
    if (open?.[1]) {
      flushQuote()
      fence = open[1]
      lang = (open[2] ?? '').trim()
      body = []
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      quote.push(line.replace(/^\s*>\s?/, ''))
      continue
    }
    flushQuote()
  }
  if (fence !== undefined) add(body.join('\n'), lang)
  flushQuote()

  return found.slice(0, MAX_BLOCKS)
}

const wrap = (text: string) => (wa ? `\`\`\`\n${text}\n\`\`\`` : text)

const copy = async ($: EngineInterface, block: Block): Promise<void> => {
  const payload = wrap(block.text)
  const r = await $.process
    .run(['pbcopy'], { stdin: payload, timeoutMs: 5000 })
    .catch((err) => {
      $.ui.toast(`copy failed: ${err}`, { timeoutMs: 6000 })
      return undefined
    })
  if (!r || r.exitCode !== 0) return
  $.ui.toast(`copied ${payload.length} chars${wa ? ' (whatsapp)' : ''} · ${block.label}`, { timeoutMs: 3000 })
}

// tee appends without a shell, so nothing here is quoted into one. One JSON object per line.
const stash = async ($: EngineInterface, entries: Block[]): Promise<void> => {
  if (!stashPath || !entries.length) return
  const at = await $.clock.now().catch(() => Date.now())
  const lines = entries.map((b) => JSON.stringify({ at, label: b.label, text: b.text })).join('\n')
  await $.process.run(['tee', '-a', stashPath], { stdin: `${lines}\n`, timeoutMs: 5000 }).catch((err) =>
    $.ui.log(`copy-band: stash write failed: ${err}`),
  )
}

const readStash = async ($: EngineInterface): Promise<Block[]> => {
  if (!stashPath) return []
  const r = await $.process.run(['tail', '-n', String(STASH_KEEP), stashPath], { timeoutMs: 5000 }).catch(() => undefined)
  if (!r || r.exitCode !== 0) return []
  const out: Block[] = []
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as { label?: unknown; text?: unknown }
      if (typeof entry.text === 'string' && typeof entry.label === 'string') out.push({ label: entry.label, text: entry.text })
    } catch {
      // A truncated line from a killed write is skipped rather than costing the whole stash.
    }
  }
  return out.reverse()
}

// The blocks of one transcript message, memoised: a render hook runs on every frame the message is
// drawn in, and parsing the same markdown each time would cost the scrollback its speed.
const inlineCache = new Map<string, Block[]>()
const inlineById = new Map<string, Block[]>()
const blocksFor = (text: string): Block[] => {
  const hit = inlineCache.get(text)
  if (hit) return hit
  const found = parse(text)
  if (inlineCache.size > 200) {
    inlineCache.clear()
    inlineById.clear()
  }
  inlineCache.set(text, found)
  inlineById.set(digest(text), found)
  return found
}

// A stable address for a Button drawn in the transcript, where many messages draw a row each and a
// repeated key would collide between them.
const digest = (text: string) => {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// The Button a press names, by its key: the band's `copy:N`, the transcript's `inline:<digest>:N`.
const blockAt = (element: string): Block | undefined => {
  const band = /^copy:(\d+)$/.exec(element)
  if (band) return blocks[Number(band[1])]
  const inline = /^inline:([^:]+):(\d+)$/.exec(element)
  if (inline) return inlineById.get(inline[1] ?? '')?.[Number(inline[2])]
  return undefined
}

// The status line under the prompt outlives a collapsed band, so the count of what is on offer
// stays on screen when the buttons do not.
const status = ($: EngineInterface): void => {
  if (!blocks.length) return $.ui.status(undefined)
  $.ui.status(`copy · ${blocks.length} in the band (1-${blocks.length}) · ${Math.min(stashed, STASH_KEEP)} stashed (/stash)`)
}

// The first thing anyone does when a mod misbehaves is try to turn it off. `CLAUDE_MODS_DISABLE=all`,
// or a comma list naming this mod, makes every hook here a pass-through and registers no command.
const MOD = 'copy-band'
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
    if ((await $.store.get(WA_KEY).catch(() => undefined)) === true) wa = true
    const home = await $.env.get('HOME').catch(() => undefined)
    if (home) {
      const dir = `${home}/.claude/copy-stash`
      const made = await $.process.run(['mkdir', '-p', dir], { timeoutMs: 5000 }).catch(() => undefined)
      if (made?.exitCode === 0) {
        stashPath = `${dir}/stash.jsonl`
        stashed = (await readStash($)).length
      }
    }
    await $.command
      .register({
        name: 'stash',
        description: 'Copy a block from the stash: /stash lists, /stash 7 copies, /stash wa toggles the WhatsApp wrap (copy-band)',
        argumentHint: '[n | wa [n]]',
        immediate: true,
      })
      .catch((err) => $.ui.log(`copy-band: /stash not registered: ${err}`))
    return r
  })

  on('command.run', { command: 'stash' }, async ($, e) => {
    const args = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const toggle = args[0] === 'wa'
    const rest = toggle ? args.slice(1) : args

    if (toggle && !rest.length) {
      wa = !wa
      await $.store.set(WA_KEY, wa).catch(() => undefined)
      $.ui.invalidate('ui.render')
      return { text: `whatsapp wrap ${wa ? 'on' : 'off'} — copies are fenced with \`\`\`` }
    }

    const entries = await readStash($)
    if (!entries.length) return { text: 'copy stash is empty — it fills as answers come in' }

    const pick = rest[0]
    if (pick === undefined) {
      const list = entries
        .slice(0, 20)
        .map((b, i) => `${String(i + 1).padStart(2)}. ${b.label}${b.text.includes('\n') ? ` (${b.text.split('\n').length} lines)` : ''}`)
        .join('\n')
      return { text: `copy stash, newest first — /stash <n>${wa ? '' : ', /stash wa <n> to fence it'}\n${list}` }
    }

    const n = Number(pick)
    const block = Number.isInteger(n) ? entries[n - 1] : undefined
    if (!block) return { text: `copy-band: no stash entry ${pick} — /stash lists what there is` }

    const was = wa
    if (toggle) wa = true
    await copy($, block)
    wa = was
    return { text: `copied: ${block.label}` }
  })

  on('turn.complete', async ($, e, next) => {
    if (disabled) return next(e)
    const r = await next(e)
    // A subagent's turn carries an agentId and never reaches the person's screen.
    if (e.agentId) return r
    const found = parse(e.answer)
    if (!found.length) {
      if (blocks.length) {
        blocks = []
        status($)
        $.ui.invalidate('ui.render')
      }
      return r
    }
    blocks = found
    await stash($, found)
    stashed += found.length
    status($)
    $.ui.invalidate('ui.render')
    return r
  })

  // A press is answered here rather than in the Button closures: a closure handle belongs to one
  // drawing, and a press that lands during a redraw is dropped by core, while the hook still sees
  // the event and its key.
  on('ui.press', { plugin: MOD }, async ($, e, next) => {
    if (disabled) return next(e)
    if (e.element === 'copy:wa') {
      wa = !wa
      await $.store.set(WA_KEY, wa).catch(() => undefined)
      $.ui.invalidate('ui.render')
      return { element: e.element }
    }
    const block = blockAt(e.element)
    if (!block) return next(e)
    await copy($, block)
    return { element: e.element }
  })

  // A render hook that throws unmounts the module, so a bad frame falls back to the band as it was.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (disabled) return next(e)
    if (!blocks.length || e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    try {
      const { Box, Text, Button } = await $.ui.resolve(e)
      const rest = await next(e)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2}>
            <Text dimColor>copy</Text>
            {blocks.map((block, i) => (
              <Button key={`copy:${i}`} hotkey={String(i + 1)} label={block.label} onPress={() => undefined} />
            ))}
            <Button key="copy:wa" hotkey="0" dimColor={!wa} label={wa ? 'wa on' : 'wa'} onPress={() => undefined} />
          </Box>
          {rest}
        </Box>
      )
    } catch (err) {
      $.ui.log(`copy-band: render failed: ${err}`)
      return next(e)
    }
  })

  // The same buttons, drawn under the message that holds the code rather than above the prompt. The
  // band only ever shows the last answer; this row stays where it was written, which is where a
  // mouse goes looking for it. A hotkey is refused outside the band, so this row is mouse-only.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (disabled) return next(e)
    if (e.surface !== 'terminal') return next(e)
    const found = blocksFor(e.props.text)
    if (!found.length) return next(e)
    try {
      const { Box, Text, Button } = await $.ui.resolve(e)
      const rest = await next(e)
      const id = digest(e.props.text)
      return (
        <Box flexDirection="column">
          {rest}
          <Box flexDirection="row" columnGap={2}>
            <Text dimColor>copy</Text>
            {found.map((block, i) => (
              <Button key={`inline:${id}:${i}`} dimColor label={block.label} onPress={() => undefined} />
            ))}
          </Box>
        </Box>
      )
    } catch (err) {
      $.ui.log(`copy-band: inline render failed: ${err}`)
      return next(e)
    }
  })
}
