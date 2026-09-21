import { describe, expect, mock, test, tier, type Engine } from 'claude-code/testing'
import type { CommandRunInput, On, PromptSuggestInput, SessionStartInput, TurnCompleteInput } from 'claude-code'

tier('user')

const session: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const SUGGESTION = 'run the tests and show the output'

const run = (args: string): CommandRunInput => ({
  command: 'receipt', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
})

const complete = (answer: string, turnId = 't1'): TurnCompleteInput => ({ answer, durationMs: 65_000, isAborted: false, turnId, reason: 'answer' })

const suggestion = (text: string): PromptSuggestInput => ({ text, origin: { kind: 'suggestion' } })

const spinner = () => ({
  surface: 'terminal' as const,
  component: 'Spinner' as const,
  requestId: 'agent-main',
  viewport: { columns: 80, rows: 24 },
  props: { word: 'Cooking', message: null, suffix: '…', mode: 'requesting' as const },
})

const footer = (requestId = 'turn-1', word = 'Cooked') => ({
  surface: 'terminal' as const,
  component: 'TurnDuration' as const,
  requestId,
  viewport: { columns: 80, rows: 24 },
  props: { word, durationMs: 65_000 },
})

const group = (command: string, isExpanded = false) => ({
  surface: 'terminal' as const,
  component: 'ToolGroup' as const,
  requestId: 'group-1',
  viewport: { columns: 80, rows: 24 },
  props: { calls: [{ tool: 'Bash', input: { command }, isRunning: false, isErrored: false, isInterrupted: false }], isActive: false, isExpanded },
})

const textOf = (tree: unknown): string => {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(textOf).join('')
  if (typeof tree !== 'object' || !tree) return ''
  return textOf(Reflect.get(tree, 'children') ?? [])
}

function world(on: On, env: Record<string, string> = {}) {
  mock.store(on, {})
  mock.env(on, env)
  const suggested: string[] = []
  const drawn: { component: string; props: Record<string, unknown> }[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  let failNext = false
  on('tool.call', () => {
    if (!failNext) return { result: 'ran' }
    failNext = false
    return { result: 'boom', isError: true as const }
  })
  on('prompt.suggest', ($, e) => { suggested.push(e.text); return { isShown: true } })
  on('ui.render', ($, e) => {
    drawn.push({ component: e.component, props: e.props as Record<string, unknown> })
    return { type: 'Text', props: {}, children: ['STOCK'] }
  })
  return { suggested, drawn, lastDrawn: () => drawn.at(-1)!, failNext: () => { failNext = true } }
}

const edit = ($: Engine, n: number) => $.tool.call({ tool: 'Edit', file_path: `/work/${n}.ts`, old_string: 'a', new_string: 'b' })
const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })

describe('receipt', () => {
  test('three edits and no run prepend a warning to the footer word', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    for (let i = 0; i < 3; i++) await edit($, i)
    await $.turn.complete(complete('done'))
    await $.ui.render(footer())
    expect(w.lastDrawn().props.word).toBe('3 edits · 0 runs ⚠ no run · Cooked')
  })

  test('the footer keeps the word a plugin above already rewrote', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await edit($, 1)
    await $.turn.complete(complete('done'))
    await $.ui.render(footer('turn-1', 'turn 7 · 1:05 · AMRAP 12:40 · Baked'))
    const word = String(w.lastDrawn().props.word)
    expect(word).toBe('1 edits · 0 runs ⚠ no run · turn 7 · 1:05 · AMRAP 12:40 · Baked')
    expect(word.endsWith('· Baked')).toBe(true)
  })

  test('a footer with runs and a curl carries no warning', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await edit($, 1)
    await bash($, 'npm test')
    await bash($, 'curl -s https://example.com')
    await $.turn.complete(complete('done'))
    await $.ui.render(footer())
    expect(w.lastDrawn().props.word).toBe('1 edits · 1 runs · 1 curl · Cooked')
  })

  test('the footer keeps its own turn after the next turn starts', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.turn.start({ text: 'a', turnId: 't1' })
    await edit($, 1)
    await $.turn.complete(complete('done'))
    await $.ui.render(footer('turn-1'))
    expect(w.lastDrawn().props.word).toBe('1 edits · 0 runs ⚠ no run · Cooked')
    await $.turn.start({ text: 'b', turnId: 't2' })
    await bash($, 'go test ./...')
    await $.ui.render(footer('turn-1'))
    expect(w.lastDrawn().props.word).toBe('1 edits · 0 runs ⚠ no run · Cooked')
  })

  test('sed -i and a redirect count as edits; bash write with a run is fine', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.turn.start({ text: 'a', turnId: 't1' })
    await bash($, "sed -i '' 's/a/b/' x.ts")
    await bash($, 'echo hi > out.txt')
    await bash($, 'ls 2>/dev/null')
    await $.turn.complete(complete('done'))
    await $.ui.render(footer())
    expect(w.lastDrawn().props.word).toBe('2 edits · 0 runs ⚠ no run · Cooked')
  })

  test('a claim without a run flags the spinner until something runs', async ($, on) => {
    world(on)
    await $.session.start(session)
    await $.turn.start({ text: 'deploy', turnId: 't1' })
    await edit($, 1)
    await $.turn.complete(complete('Deployed and verified, it works now.'))
    const before = await $.ui.render(spinner())
    expect(before).toBeDefined()
    await $.turn.start({ text: 'ok', turnId: 't2' })
    expect(textOf(await $.ui.render(spinner()))).toBe('STOCK')
  })

  test('the spinner message reads unverified claim pending while flagged', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.turn.start({ text: 'deploy', turnId: 't1' })
    await $.turn.complete(complete('Fixed.'))
    await $.ui.render(spinner())
    expect(w.lastDrawn().props.message).toBe(null)
    expect(w.lastDrawn().props.word).toBe('unverified claim pending · Cooking')
    await $.ui.render({ ...spinner(), props: { ...spinner().props, message: 'Compacting' } })
    expect(w.lastDrawn().props.message).toBe('unverified claim pending · Compacting')
    expect(w.lastDrawn().props.word).toBe('Cooking')
    await $.turn.start({ text: 'prove it', turnId: 't2' })
    await bash($, 'npx vitest run')
    await $.ui.render(spinner())
    expect(w.lastDrawn().props.message).toBe(null)
  })

  test('a turn with a test run and a claim sets no spinner flag', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.turn.start({ text: 'fix', turnId: 't1' })
    await edit($, 1)
    await bash($, 'npm test')
    await $.turn.complete(complete('tests pass, fixed'))
    await $.ui.render(spinner())
    expect(w.lastDrawn().props.message).toBe(null)
  })

  test('rm -rf and its kin expand the tool group; a plain ls stays folded', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    for (const command of ['rm -rf build', 'rm -r -f build', 'git push -f origin main', 'git push origin main --force', 'git reset --hard HEAD~1', 'psql -c "DROP TABLE users"', 'kubectl delete pod x']) {
      await $.ui.render(group(command))
      expect(w.lastDrawn().props.isExpanded, command).toBe(true)
    }
    await $.ui.render(group('ls -la'))
    expect(w.lastDrawn().props.isExpanded).toBe(false)
  })

  test('the suggestion appears only after an edit without a run', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.turn.start({ text: 'a', turnId: 't1' })
    await edit($, 1)
    await bash($, 'cargo test')
    await $.turn.complete(complete('done'))
    expect(w.suggested).toEqual([])
    await $.prompt.suggest(suggestion('continue'))
    expect(w.suggested).toEqual(['continue'])
    await $.turn.start({ text: 'b', turnId: 't2' })
    await edit($, 2)
    await $.turn.complete(complete('done'))
    expect(w.suggested).toEqual(['continue', SUGGESTION])
    await $.prompt.suggest(suggestion('continue'))
    expect(w.suggested.at(-1)).toBe(SUGGESTION)
  })

  test('quoted, heredoc and grepped runner names are not runs, curls or edits', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.turn.start({ text: 'deploy', turnId: 't1' })
    await $.turn.complete(complete('Fixed.'))
    await $.turn.start({ text: 'a', turnId: 't2' })
    for (const command of ['echo "npm test"', 'cat vitest.config.ts', 'grep -rn pytest .', 'git commit -m "make build green"', 'grep curl README.md', 'echo "a > b"', 'ls 2>/dev/null', 'cat <<EOF\nnpm test\ncurl x\nEOF']) await bash($, command)
    expect((await $.command.run(run('status'))).text).toMatch(/this turn: 0 edits · 0 runs · 0 curl · 0 reads · 0 destructive; last turn: .*; unverified claim pending$/)
    await $.turn.complete(complete('done'))
    await $.ui.render(spinner())
    expect(w.lastDrawn().props.word).toBe('unverified claim pending · Cooking')
  })

  test('runners as the first word, through npx, and the writer list count', async ($, on) => {
    world(on)
    await $.session.start(session)
    await $.turn.start({ text: 'a', turnId: 't1' })
    for (const command of ['npx vitest run', 'FOO=1 pytest -q', 'bun run test:unit', 'cd x && cargo test', 'claude plugin test .']) await bash($, command)
    for (const command of ['tee out.ts', 'cp a.ts b.ts', 'mv a.ts b.ts', 'touch new.ts', 'echo hi >> f.txt', 'cat <<EOF > f.ts\nnpm test\nEOF', "sed -i '' 's/a/b/' x.ts"]) await bash($, command)
    await bash($, 'curl -s https://example.com | jq .')
    expect((await $.command.run(run('status'))).text).toMatch(/this turn: 7 edits · 5 runs · 1 curl/)
  })

  test('an errored Edit is not counted', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.turn.start({ text: 'a', turnId: 't1' })
    w.failNext()
    await edit($, 1)
    await edit($, 2)
    expect((await $.command.run(run('status'))).text).toMatch(/this turn: 1 edits/)
  })

  test('a turn with no edits suggests nothing', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.turn.start({ text: 'a', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/work/x.ts' })
    await $.turn.complete(complete('here is what I found'))
    expect(w.suggested).toEqual([])
  })

  test('/receipt off restores the stock drawings and persists; status reports the tally', async ($, on) => {
    const w = world(on)
    await $.session.start(session)
    await $.turn.start({ text: 'a', turnId: 't1' })
    await edit($, 1)
    expect((await $.command.run(run('status'))).text).toMatch(/^receipt is on; this turn: 1 edits · 0 runs/)
    expect((await $.command.run(run('off'))).text).toBe('receipt off')
    await $.turn.complete(complete('fixed'))
    await $.ui.render(footer())
    expect(w.lastDrawn().props.word).toBe('Cooked')
    await $.ui.render(spinner())
    expect(w.lastDrawn().props.message).toBe(null)
    await $.ui.render(group('rm -rf build'))
    expect(w.lastDrawn().props.isExpanded).toBe(false)
    expect((await $.command.run(run('status'))).text).toMatch(/^receipt is off/)
    await $.command.run(run('on'))
    expect((await $.command.run(run('status'))).text).toMatch(/^receipt is on/)
  })

  test('CLAUDE_MODS_DISABLE=receipt is a pass-through', async ($, on) => {
    const w = world(on, { CLAUDE_MODS_DISABLE: 'receipt' })
    await $.session.start(session)
    await $.turn.start({ text: 'a', turnId: 't1' })
    await edit($, 1)
    await $.turn.complete(complete('fixed'))
    await $.ui.render(footer())
    expect(w.lastDrawn().props.word).toBe('Cooked')
    await $.ui.render(spinner())
    expect(w.lastDrawn().props.message).toBe(null)
    await $.ui.render(group('rm -rf build'))
    expect(w.lastDrawn().props.isExpanded).toBe(false)
    expect(w.suggested).toEqual([])
  })
})
