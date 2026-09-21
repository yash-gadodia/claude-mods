import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { Args, On, RenderInput, SessionStartInput, TurnCompleteInput } from 'claude-code'

import { parse } from '../hooks/register'

tier('user')

const session: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }

const band: RenderInput<'AbovePrompt'> = {
  component: 'AbovePrompt',
  surface: 'terminal',
  requestId: 'band',
  viewport: { columns: 160, rows: 40, isFullscreen: false },
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 160, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}

const message = (text: string): RenderInput<'AssistantMessage'> => ({
  component: 'AssistantMessage',
  surface: 'terminal',
  requestId: 'm1',
  viewport: { columns: 160, rows: 40, isFullscreen: false },
  props: { text, isFirstOfReply: true },
})

type AnsweredTurn = Exclude<TurnCompleteInput, { reason: 'refusal' }>
const turn = (answer: string, over: Partial<AnsweredTurn> = {}): TurnCompleteInput => ({
  answer, durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer', ...over,
})

const ANSWER = 'Run this:\n\n```sh\nbrew install jq\n```\n\nThen the draft:\n\n> hi team, deploy is done\n'

function world(on: On, stash = '') {
  const runs: Args<'process.run'>[] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  mock.clock(on, { now: 1000 })
  mock.store(on, {})
  mock.env(on, { HOME: '/home/yash' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.status', ($, e) => { statuses.push(e.text); return { value: undefined } })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: [''] }))
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => ({ type: 'Text', children: [e.props.text] }))
  on('process.run', ($, e) => {
    runs.push(e)
    const stdout = e.argv[0] === 'tail' ? stash : ''
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  return { runs, toasts, statuses }
}

const stdinOf = (run: Args<'process.run'>) => run.init?.stdin

describe('parse', () => {
  test('finds fenced blocks and quoted drafts', async () => {
    expect(parse(ANSWER)).toEqual([
      { label: 'brew install jq', text: 'brew install jq' },
      { label: 'draft hi team, depl…', text: 'hi team, deploy is done' },
    ])
  })
})

describe('press', () => {
  test('a press on a band button by its id runs pbcopy and toasts', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn(ANSWER))
    await $.ui.render(band)
    const r = await $.ui.press({ plugin: 'copy-band', key: 'copy:0' })
    expect(r).toEqual({ element: 'copy:0' })
    const pbcopy = w.runs.filter(run => run.argv[0] === 'pbcopy')
    expect(pbcopy).toHaveLength(1)
    expect(stdinOf(pbcopy[0]!)).toBe('brew install jq')
    expect(w.toasts.at(-1)).toBe('copied 15 chars · brew install jq')
  })

  test('the wa button fences the next copy', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn(ANSWER))
    await $.ui.render(band)
    await $.ui.press({ plugin: 'copy-band', key: 'copy:wa' })
    await $.ui.press({ plugin: 'copy-band', key: 'copy:1' })
    const pbcopy = w.runs.filter(run => run.argv[0] === 'pbcopy')
    expect(stdinOf(pbcopy[0]!)).toBe('```\nhi team, deploy is done\n```')
    expect(w.toasts.at(-1)).toMatch(/\(whatsapp\)/)
  })

  test('an inline button under the message copies that message\'s block', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    const drawn = await $.ui.render(message(ANSWER))
    const key = JSON.stringify(drawn).match(/"inline:[a-z0-9]+:1"/)?.[0].slice(1, -1)
    expect(key).toBeDefined()
    await $.ui.press({ plugin: 'copy-band', key: key! })
    const pbcopy = w.runs.filter(run => run.argv[0] === 'pbcopy')
    expect(stdinOf(pbcopy[0]!)).toBe('hi team, deploy is done')
  })

  test('an unknown id is passed on', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.turn.complete(turn(ANSWER))
    await $.ui.render(band)
    await $.ui.press({ plugin: 'copy-band', key: 'copy:7' }).catch(() => undefined)
    expect(w.runs.filter(run => run.argv[0] === 'pbcopy')).toHaveLength(0)
  })
})

describe('status', () => {
  test('the status line carries the band and stash counts, and clears with the band', async ($, on) => {
    const old = [{ at: 1, label: 'x', text: 'old one' }, { at: 2, label: 'y', text: 'old two' }].map(e => JSON.stringify(e)).join('\n')
    const w = world(on, old)
    await $.session.start(session)
    await $.turn.complete(turn(ANSWER))
    expect(w.statuses.at(-1)).toBe('copy · 2 in the band (1-2) · 4 stashed (/stash)')
    await $.turn.complete(turn('nothing to copy here'))
    expect(w.statuses.at(-1)).toBe(undefined)
  })
})
