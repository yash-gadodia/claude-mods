import { describe, expect, mock, test, tier, type Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { CHALK_CELLS, NOREP_CELLS } from '../hooks/register'

tier('user')

const SESSION = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }
const BAND = 'band-1'

const band = (bodyColumns = 80) => ({
  surface: 'terminal' as const,
  component: 'AbovePrompt' as const,
  requestId: BAND,
  viewport: { columns: bodyColumns, rows: 24 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
})

function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => { store.set(e.key, e.value); return { value: undefined } })
  mock.env(on, {})
  const blits: { requestId: string; key: string; cells: string }[] = []
  const invalidations: string[] = []
  const toasts: string[] = []
  const errors = new Set<string>()
  let denyBlit: string | undefined
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.invalidate', ($, e) => { invalidations.push(e.event); return { value: undefined } })
  on('ui.blit', ($, e) => {
    if ('cells' in e) blits.push({ requestId: e.requestId, key: e.key, cells: e.cells })
    return { value: denyBlit === undefined ? {} : { deny: denyBlit } }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['STOCK'] }))
  on('tool.call', ($, e) => (errors.has(e.tool) ? { isError: true as const, result: 'boom', text: 'boom' } : { result: 'done' }))
  return { clock, store, blits, invalidations, toasts, errors, denyBlits: (r: string) => { denyBlit = r } }
}

const texts = (tree: RenderElement): string[] => {
  const out: string[] = []
  const walk = (node: unknown) => {
    if (typeof node === 'string') out.push(node)
    else if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === 'object') {
      const el = node as { children?: unknown; props?: { children?: unknown } }
      walk(el.children)
      walk(el.props?.children)
    }
  }
  walk(tree)
  return out
}

const rasterOf = (tree: RenderElement) => {
  let found: { cells: string; columns: number; rows: number } | undefined
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const el = node as { type?: string; props?: Record<string, unknown>; children?: unknown }
    if (el.type === 'Raster') found = el.props as { cells: string; columns: number; rows: number }
    if (Array.isArray(el.children)) el.children.forEach(walk)
  }
  walk(tree)
  return found
}

const lines = (tree: RenderElement): string[] => {
  const out: string[] = []
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const el = node as { type?: string; children?: unknown }
    if (el.type === 'Text') { out.push(texts(el as RenderElement).join('')); return }
    if (Array.isArray(el.children)) el.children.forEach(walk)
  }
  walk(tree)
  return out.filter(l => l !== 'STOCK')
}

const edit = ($: Engine, n: number) =>
  $.tool.call({ tool: 'Edit', file_path: '/work/app.ts', old_string: `${n}`, new_string: `${n + 1}` })

describe('wod-band', () => {
  test('draws one 13x3 Raster and a caption, no per-cell Text', async ($, on) => {
    world(on)
    await $.session.start(SESSION)
    const tree = await $.ui.render(band())
    const raster = rasterOf(tree)
    expect(raster).toBeDefined()
    expect(raster!.columns).toBe(13)
    expect(raster!.rows).toBe(3)
    expect(texts(tree).join('')).toMatch(/round 1 · thrusters 0\/5/)
    expect(texts(tree).join('')).toMatch(/0 reps · /)
  })

  test('a turn with three Edit calls yields three thrusters', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.ui.render(band())
    await $.turn.start({ text: 'go', turnId: 't1' })
    await edit($, 1)
    await edit($, 2)
    await edit($, 3)
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    const text = texts(await $.ui.render(band())).join('')
    expect(text).toMatch(/round 1 · thrusters 3\/5/)
    expect(text).toMatch(/3 reps · 3 thrusters · 0 burpees · 0 pull-ups · 3 all-time/)
    expect(text).toMatch(/· rep!/)
    expect(w.blits.at(-1)?.cells).toBe(CHALK_CELLS)
    expect(w.store.get('wod-band:lifetime-reps')).toBe(3)
  })

  test('Bash is a burpee, Read a pull-up, and a round closes with a toast', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.ui.render(band())
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.tool.call({ tool: 'Read', file_path: '/work/a' })
    await edit($, 1)
    await edit($, 2)
    await edit($, 3)
    const text = texts(await $.ui.render(band())).join('')
    expect(text).toMatch(/round 2 · thrusters 0\/5/)
    expect(text).toMatch(/5 reps · 3 thrusters · 1 burpees · 1 pull-ups/)
    expect(w.toasts).toEqual(['round 1 done'])
  })

  test('an isError Bash yields the no-rep frame and no rep', async ($, on) => {
    const w = world(on)
    w.errors.add('Bash')
    await $.session.start(SESSION)
    await $.ui.render(band())
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: 'false' })
    expect(w.blits.at(-1)?.cells).toBe(NOREP_CELLS)
    const text = texts(await $.ui.render(band())).join('')
    expect(text).toMatch(/· no rep!/)
    expect(text).toMatch(/0 reps · /)
    await w.clock.advance(280 * 6)
    expect(w.blits.at(-1)?.cells).not.toBe(NOREP_CELLS)
  })

  test('frames advance by blit, the caption by at most one invalidate a second', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.ui.render(band())
    await $.turn.start({ text: 'go', turnId: 't1' })
    const blitsBefore = w.blits.length
    const invBefore = w.invalidations.length
    await w.clock.advance(280 * 10)
    expect(w.blits.length - blitsBefore).toBe(10)
    expect(w.blits.every(b => b.requestId === BAND && b.key === 'wod')).toBe(true)
    expect(w.invalidations.length - invBefore).toBeLessThanOrEqual(3)
  })

  test('a denied blit drops the site until the next render', async ($, on) => {
    const w = world(on)
    w.denyBlits('not mounted')
    await $.session.start(SESSION)
    await $.ui.render(band())
    await $.turn.start({ text: 'go', turnId: 't1' })
    await w.clock.advance(280 * 5)
    expect(w.blits.length).toBe(1)
  })

  test('fits 40, 55 and 80 columns', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await edit($, 1)
    await w.clock.advance(280 * 3)
    for (const cols of [40, 55, 80]) {
      const tree = await $.ui.render(band(cols))
      const shown = lines(tree)
      const sprite = rasterOf(tree) !== undefined
      expect(sprite, `${cols} columns`).toBe(cols >= 45)
      const cap = sprite ? cols - 15 : cols
      for (const l of shown) expect(l.length, `${cols} columns: "${l}"`).toBeLessThanOrEqual(cap)
      if (cols === 40) {
        expect(shown).toHaveLength(1)
        expect(shown[0]).toMatch(/^AMRAP \d+:\d\d · r1 · thrusters 1\/5/)
      }
      if (cols === 55) expect(shown.at(-1)).toBe('1 reps')
      if (cols === 80) expect(shown.at(-1)).toBe('1 reps · 1 thrusters · 0 burpees · 0 pull-ups · 1 all-time')
    }
  })
})
