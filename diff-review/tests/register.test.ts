import { describe, expect, mock, test, tier, type Engine } from 'claude-code/testing'
import type { CommandRunInput, On, RenderInput, SessionStartInput } from 'claude-code'
import { fit, sedTargets } from '../hooks/register.tsx'

tier('user')

const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }

const HINT: RenderInput<'PromptHint'> = {
  component: 'PromptHint',
  surface: 'terminal',
  requestId: 'hint',
  viewport: { columns: 160, rows: 40, isFullscreen: true },
  props: { isDraft: false, isWorking: false, hint: '' },
}

const PANE: RenderInput<'Pane'> = {
  component: 'Pane',
  surface: 'terminal',
  requestId: 'diff-review',
  viewport: { columns: 160, rows: 40 },
  props: { title: 'diff', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
}

const DIFF = ['diff --git a/app.ts b/app.ts', '--- a/app.ts', '+++ b/app.ts', '@@ -1 +1 @@', '-const a = 1', '+const a = 2'].join('\n') + '\n'

const run = (args: string): CommandRunInput => ({
  command: 'diff-review', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 },
})

function world(on: On, opts: { env?: Record<string, string>; tracked?: boolean; exists?: boolean; failWrite?: boolean; applyFails?: boolean } = {}) {
  mock.store(on, {})
  mock.env(on, opts.env ?? {})
  const runs: string[][] = []
  const stdins: string[] = []
  const opened: string[] = []
  const toasts: string[] = []
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', ($, e) => (e.tool === 'Write' && opts.failWrite ? { result: 'nope', isError: true } : { result: 'edited' }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    if (e.init?.stdin !== undefined) stdins.push(e.init.stdin)
    if (e.argv[1] === 'apply') return { value: { exitCode: opts.applyFails ? 1 : 0, stdout: '', stderr: opts.applyFails ? 'patch does not apply' : '' } }
    if (e.argv[1] === 'ls-files') return { value: { exitCode: opts.tracked === false ? 1 : 0, stdout: '', stderr: '' } }
    if (e.argv[1] === 'diff') return { value: { exitCode: 0, stdout: DIFF, stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('fs.read', () => ({ value: 'hello\nworld\n' }))
  on('fs.exists', () => ({ value: opts.exists ?? true }))
  on('ui.open', ($, e) => { opened.push(e.id); return { value: undefined } })
  on('ui.close', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.render', { component: 'PromptHint' }, () => ({ type: 'Text', children: ['hint'] }))
  return { runs, stdins, opened, toasts, clock }
}

const textOf = (tree: unknown): string => {
  if (typeof tree === 'string') return tree
  if (Array.isArray(tree)) return tree.map(textOf).join('')
  if (typeof tree !== 'object' || !tree) return ''
  const props = Reflect.get(tree, 'props') as Record<string, unknown> | undefined
  const lead = ['label', 'source'].map(k => (typeof props?.[k] === 'string' ? props[k] : '')).join('')
  return `${lead}\n${textOf(Reflect.get(tree, 'children') ?? [])}`
}

const edit = ($: Engine, file_path = '/work/app.ts') =>
  $.tool.call({ tool: 'Edit', file_path, old_string: '1', new_string: '2' })

describe('diff-review', () => {
  test('an Edit adds the file to the pane with its git diff and opens the pane', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.ui.render(HINT)
    await edit($)
    expect(w.runs).toEqual([
      ['git', 'ls-files', '--error-unmatch', '--', '/work/app.ts'],
      ['git', 'diff', '--unified=3', '--', '/work/app.ts'],
    ])
    expect(w.opened).toEqual(['diff-review'])
    const drawn = textOf(await $.ui.render(PANE))
    expect(drawn).toContain('app.ts')
    expect(drawn).toContain('-const a = 1\n+const a = 2')
    expect(drawn).toContain('keep')
    expect(drawn).toContain('revert')
  })

  test('keep removes the file from the pane and runs no git', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.ui.render(HINT)
    await edit($)
    await $.ui.render(PANE)
    const before = w.runs.length
    expect(await $.ui.press({ plugin: 'diff-review', key: 'keep:1' })).toEqual({ element: 'keep:1' })
    expect(w.runs.length).toBe(before)
    expect(textOf(await $.ui.render(PANE))).toContain('no edits this turn')
  })

  test('revert applies the stored hunk in reverse and toasts', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.ui.render(HINT)
    await edit($)
    await $.ui.render(PANE)
    expect(await $.ui.press({ plugin: 'diff-review', key: 'revert:1' })).toEqual({ element: 'revert:1' })
    expect(w.runs.at(-1)).toEqual(['git', 'apply', '-R', '--unidiff-zero', '--'])
    expect(w.stdins).toEqual([DIFF])
    expect(w.toasts).toEqual(['reverted app.ts'])
    expect(textOf(await $.ui.render(PANE))).toContain('no edits this turn')
  })

  test('a hunk that no longer applies is left alone', async ($, on) => {
    const w = world(on, { applyFails: true })
    await $.session.start(SESSION)
    await $.ui.render(HINT)
    await edit($)
    await $.ui.render(PANE)
    await $.ui.press({ plugin: 'diff-review', key: 'revert:1' })
    expect(w.toasts).toEqual(['hunk no longer applies; nothing changed'])
    expect(textOf(await $.ui.render(PANE))).toContain('app.ts')
  })

  test('a file the tool created is deleted only on a second press within ten seconds', async ($, on) => {
    const w = world(on, { tracked: false, exists: false })
    await $.session.start(SESSION)
    await $.ui.render(HINT)
    await $.tool.call({ tool: 'Write', file_path: '/work/new.ts', content: 'x' })
    const drawn = textOf(await $.ui.render(PANE))
    expect(drawn).toContain('+++ b/new.ts')
    expect(drawn).toContain('delete\n')
    await $.ui.press({ plugin: 'diff-review', key: 'revert:1' })
    expect(w.toasts[0]).toMatch(/press revert again within 10s/)
    expect(w.runs.some(r => r[0] === 'rm')).toBe(false)
    expect(textOf(await $.ui.render(PANE))).toContain('revert again to delete')
    await w.clock.advance(10000)
    expect(textOf(await $.ui.render(PANE))).not.toContain('revert again to delete')
    await $.ui.press({ plugin: 'diff-review', key: 'revert:1' })
    expect(w.runs.some(r => r[0] === 'rm'), 'a press after the window arms again').toBe(false)
    await $.ui.press({ plugin: 'diff-review', key: 'revert:1' })
    expect(w.runs.at(-1)).toEqual(['rm', '--', '/work/new.ts'])
    expect(w.toasts.at(-1)).toBe('deleted new.ts')
    expect(textOf(await $.ui.render(PANE))).toContain('no edits this turn')
  })

  test('an untracked file that existed before shows as added with no revert', async ($, on) => {
    const w = world(on, { tracked: false, exists: true })
    await $.session.start(SESSION)
    await $.ui.render(HINT)
    await edit($, '/work/.env')
    const drawn = textOf(await $.ui.render(PANE))
    expect(drawn).toContain('+++ b/.env')
    expect(drawn).toContain('untracked, existed before: no revert')
    expect(drawn).not.toContain('revert\n')
    await expect($.ui.press({ plugin: 'diff-review', key: 'revert:1' })).rejects.toThrow(/no Button/)
    expect(w.runs.some(r => r[0] === 'rm' || r[1] === 'apply')).toBe(false)
  })

  test('the pane does not open when the surface is not interactive', async ($, on) => {
    const w = world(on)
    await $.session.start({ ...SESSION, isInteractive: false })
    await $.ui.render(HINT)
    await edit($)
    expect(w.opened).toEqual([])
    expect(textOf(await $.ui.render(PANE))).toContain('app.ts')
  })

  test('the pane does not open on a narrow terminal, and /diff-review open places it', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.ui.render({ ...HINT, viewport: { columns: 120, rows: 40, isFullscreen: true } })
    await edit($)
    expect(w.opened).toEqual([])
    expect((await $.command.run(run('open'))).text).toBe('diff-review pane open, 1 file(s) this turn')
    expect(w.opened).toEqual(['diff-review'])
  })

  test('files list newest first, a second edit of one file replaces its entry, a new turn clears', async ($, on) => {
    world(on)
    await $.session.start(SESSION)
    await $.ui.render(HINT)
    await edit($, '/work/a.ts')
    await edit($, '/work/b.ts')
    await edit($, '/work/a.ts')
    const drawn = textOf(await $.ui.render(PANE))
    expect(drawn.indexOf('a.ts')).toBeLessThan(drawn.indexOf('b.ts'))
    expect(drawn.match(/a\.tskeep/g)).toHaveLength(1)
    await $.turn.start({ text: 'next', turnId: 't2' })
    expect(textOf(await $.ui.render(PANE))).toContain('no edits this turn')
  })

  test('a failed edit is not tracked', async ($, on) => {
    world(on, { tracked: false, exists: false, failWrite: true })
    await $.session.start(SESSION)
    await $.ui.render(HINT)
    await $.tool.call({ tool: 'Write', file_path: '/work/new.ts', content: 'x' })
    expect(textOf(await $.ui.render(PANE))).toContain('no edits this turn')
    await edit($, '/work/new.ts')
    const drawn = textOf(await $.ui.render(PANE))
    expect(drawn).toContain('+++ b/new.ts')
    expect(drawn).toContain('+hello\n+world')
  })

  test('a Bash sed -i tracks its files', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)
    await $.ui.render(HINT)
    await $.tool.call({ tool: 'Bash', command: "sed -i '' 's/a b/c/' lib/x.ts && echo done" })
    expect(w.runs[0]).toEqual(['git', 'ls-files', '--error-unmatch', '--', '/work/lib/x.ts'])
    expect(textOf(await $.ui.render(PANE))).toContain('lib/x.ts')
  })

  test('CLAUDE_MODS_DISABLE=diff-review is a pass-through', async ($, on) => {
    const w = world(on, { env: { CLAUDE_MODS_DISABLE: 'diff-review' } })
    await $.session.start(SESSION)
    await $.ui.render(HINT)
    await edit($)
    expect(w.runs).toEqual([])
    expect(w.opened).toEqual([])
  })

  test('sedTargets and fit', () => {
    expect(sedTargets("sed -i 's/x/y/' a.ts b.ts")).toEqual(['a.ts', 'b.ts'])
    expect(sedTargets("sed -i.bak -e 's/x/y/' a.ts")).toEqual(['a.ts'])
    expect(sedTargets('sed -n 1p a.ts')).toEqual([])
    expect(sedTargets('grep -i foo a.ts')).toEqual([])
    expect(sedTargets("sed -i 's/x/y/' *.ts src/a?.ts \"$F\" b.ts")).toEqual(['b.ts'])
    const long = Array.from({ length: 50 }, (_, i) => `+line ${i}`).join('\n')
    expect(fit(long, 10)).toBe(`${Array.from({ length: 10 }, (_, i) => `+line ${i}`).join('\n')}\n… (40 more lines)`)
    expect(fit(long, 100)).toBe(long)
    expect(fit('x'.repeat(20000), 100).length).toBeLessThanOrEqual(10000)
  })
})
