import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'
import type { Args, CommandRunInput, On, RenderInput, SessionStartInput } from 'claude-code'

import { efName } from '../hooks/register'

tier('user')

const MIN = 60 * 1000
const REFRESH = 15 * MIN

const session: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }

const money = (args: string): CommandRunInput => ({
  command: 'money', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
})

const bandAt = (bodyColumns: number): RenderInput<'AbovePrompt'> => ({
  component: 'AbovePrompt',
  surface: 'terminal',
  requestId: 'band',
  viewport: { columns: bodyColumns, rows: 40, isFullscreen: false },
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns, scroll: { offset: 0, bodyRows: 20 }, view: {} },
})
const band = bandAt(160)

const ANSWER = 'NW<120000|900000|60000|823000|2026-09-20>NW\nFIN<2500|31|2026-09-21|900 Freshkitchen>FIN\nEF<12300>EF\n'

const footer: RenderInput<'SessionMode'> = {
  component: 'SessionMode',
  surface: 'terminal',
  requestId: 'footer',
  viewport: { columns: 160, rows: 40, isFullscreen: false },
  props: { modes: ['focus'] },
}

const textOf = (tree: unknown): string => {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(textOf).join('')
  if (typeof tree !== 'object' || !tree) return ''
  return textOf(Reflect.get(tree, 'children') ?? [])
}

function world(on: On, answer = ANSWER) {
  const runs: Args<'process.run'>[] = []
  const logs: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, {})
  mock.env(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: [''] }))
  on('ui.render', { component: 'SessionMode' }, ($, e) => ({ type: 'Text', children: [e.props.modes.join(' & ')] }))
  on('process.run', ($, e) => {
    runs.push(e)
    return { value: { exitCode: 0, stdout: answer, stderr: '' } }
  })
  return { runs, clock, logs }
}

describe('timer', () => {
  test('the start primes one fetch and arms one timer, which re-arms once after each fire', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await w.clock.settle()
    expect(w.runs).toHaveLength(1)
    expect(w.runs[0]!.argv.slice(0, 5)).toEqual(['ssh', '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes'])
    await w.clock.advance(REFRESH - 1)
    expect(w.runs).toHaveLength(1)
    await w.clock.advance(1)
    expect(w.runs).toHaveLength(2)
    await w.clock.advance(REFRESH)
    expect(w.runs).toHaveLength(3)
  })

  test('/money off stops the timer and nothing runs until /money on', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await w.clock.settle()
    expect(await $.command.run(money('off'))).toEqual({ text: 'money band off' })
    await w.clock.advance(3 * REFRESH)
    expect(w.runs).toHaveLength(1)
    const r = await $.command.run(money('on'))
    expect(r.text).toMatch(/^net worth {9}S\$257,000/)
    expect(w.runs).toHaveLength(2)
    await w.clock.advance(REFRESH)
    expect(w.runs).toHaveLength(3)
  })

  test('/money refresh re-arms rather than forking a second timer', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await w.clock.settle()
    await $.command.run(money('refresh'))
    expect(w.runs).toHaveLength(2)
    await w.clock.advance(REFRESH)
    expect(w.runs).toHaveLength(3)
    await w.clock.advance(REFRESH)
    expect(w.runs).toHaveLength(4)
  })

  // fetchMoney's own process.run is caught inside it; its clock read is the call that can reject,
  // and this plugin sits beneath money-band to refuse the second one.
  const clockOffOnce: Plugin = {
    name: 'clock-off-once',
    tier: 'append',
    register(on) {
      let reads = 0
      on('clock.now', ($, e, next) => (++reads === 2 ? { deny: 'clock off' } : next(e)))
    },
  }

  test('a refresh that rejects is logged once and the next one still comes', { plugins: [clockOffOnce] }, async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await w.clock.settle()
    await w.clock.advance(REFRESH)
    expect(w.runs).toHaveLength(2)
    expect(w.logs).toEqual([expect.stringMatching(/^money-band: refresh failed, trying again in 15m: .*clock off/)])
    await w.clock.advance(REFRESH)
    expect(w.runs).toHaveLength(3)
    expect(w.logs).toHaveLength(1)
  })

  test('the band draws the figures the databases answered', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await w.clock.settle()
    const line = textOf(await $.ui.render(band))
    expect(line).toContain('net S$257k')
    expect(line).toContain('liquid S$120k')
    expect(line).toContain('debt S$823k')
    expect(line).toContain('spent this month S$2.5k')
    expect(line).toContain('· 2026-09-20')
  })

  test('a narrow band sheds the date, spend, debt, cpf and the label, and keeps net and liquid', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await w.clock.settle()
    for (const columns of [40, 50, 80]) {
      const line = textOf(await $.ui.render(bandAt(columns)))
      expect(line.length).toBeLessThanOrEqual(columns)
      expect(line).toContain('net S$257k')
      expect(line).toContain('liquid S$120k')
    }
    expect(textOf(await $.ui.render(bandAt(40)))).toBe('money  net S$257k  liquid S$120k')
    expect(textOf(await $.ui.render(bandAt(50)))).toBe('money  net S$257k  liquid S$120k  cpf S$60.0k')
    expect(textOf(await $.ui.render(bandAt(80)))).toBe('money  net S$257k  liquid S$120k  cpf S$60.0k  debt S$823k')
    expect(textOf(await $.ui.render(bandAt(90)))).toBe('money  net S$257k  liquid S$120k  cpf S$60.0k  debt S$823k  spent this month S$2.5k')
  })

  test('the footer carries the emergency fund over its target, and nothing when the account answered empty', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await w.clock.settle()
    expect(w.runs).toHaveLength(1)
    expect(textOf(await $.ui.render(footer))).toBe('focus & EF 41%')
    await $.command.run(money('off'))
    expect(textOf(await $.ui.render(footer))).toBe('focus')
  })

  test('an empty emergency-fund answer draws no footer label', async ($, on) => {
    const w = world(on, ANSWER.replace('EF<12300>EF', 'EF<>EF'))
    await $.session.start(session)
    await w.clock.settle()
    expect(textOf(await $.ui.render(band))).toContain('net S$257k')
    expect(textOf(await $.ui.render(footer))).toBe('focus')
  })

  test('the emergency-fund query names the account without wildcards and takes the largest of several matches', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await w.clock.settle()
    const script = w.runs[0]!.argv.at(-1)!
    expect(script).toContain("instr(lower(a.name), lower('UOB One')) > 0")
    expect(script).not.toContain('LIKE')
    expect(script).toContain('ORDER BY b.balance_sgd DESC LIMIT 1')
  })
})

describe('efAccount', () => {
  test('a name a shell could read is refused, so it never reaches the ssh argv', async () => {
    expect(efName('UOB One')).toBe('UOB One')
    expect(efName(" Bob's Bank & Trust ")).toBe("Bob's Bank & Trust")
    expect(efName('$(rm -rf ~)')).toBe(undefined)
    expect(efName('a"b')).toBe(undefined)
    expect(efName('`id`')).toBe(undefined)
    expect(efName('UOB%')).toBe(undefined)
    expect(efName('')).toBe(undefined)
    expect(efName(3)).toBe(undefined)
  })
})
