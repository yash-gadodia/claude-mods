import { describe, expect, mock, test, tier, type Engine } from 'claude-code/testing'
import type { ModelCompleteRequest, On, PromptContextBlock, SessionMessage, ToolCheckInput } from 'claude-code'

import { bashTargets } from '../hooks/register'

tier('user')

type World = {
  env?: Record<string, string>
  messages?: SessionMessage[]
  review?: string
  answer?: string
  cwdFails?: boolean
}

// Beneath the mod: an in-memory store and clock, Haiku answering `review`, a dialog answering
// `answer`, and a transcript of `messages`; every allow, deny, abort and status line is recorded.
const world = (on: On, options: World = {}) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.store(on, {})
  mock.env(on, options.env ?? {})
  const asked: ModelCompleteRequest[] = []
  const aborted: string[] = []
  const status: Array<string | undefined> = []
  const logs: string[] = []
  const commands: string[] = []
  let dialogs = 0
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => {
    if (options.cwdFails) return { deny: 'cwd exploded' }
    return { value: '/repo' }
  })
  on('session.messages', () => ({ value: options.messages ?? [] }))
  on('command.register', ($, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.abort', ($, e) => {
    aborted.push(e.turnId)
    return { value: undefined }
  })
  on('model.complete', ($, e) => {
    asked.push(e)
    if (options.review === undefined) return { deny: 'api down' }
    return { value: options.review }
  })
  on('ui.status', ($, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('tool.call', ($, e) => {
    const call = e as unknown as { tool: string; questions?: Array<{ question: string }> }
    if (call.tool !== 'AskUserQuestion') throw new Error(`no ${call.tool} here`)
    dialogs++
    const q = call.questions?.[0]?.question ?? ''
    return { result: { answers: { [q]: options.answer ?? 'Continue, this is in scope' } } }
  })
  return { clock, asked, aborted, status, logs, commands, options, dialogs: () => dialogs }
}

let ids = 0
const edit = (file: string, text = `line for ${file}`): ToolCheckInput => ({
  tool: 'Edit',
  input: { file_path: `/repo/${file}`, old_string: 'a', new_string: text },
  tool_use_id: `u${++ids}`,
})

const start = async ($: Engine, interactive: boolean) => {
  await $.session.start({ cwd: '/repo', surface: interactive ? 'terminal' : null, isInteractive: interactive })
  await $.prompt.submit({ text: 'Fix the login redirect bug', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'Fix the login redirect bug', turnId: 't1' })
}

const editsUpTo = async ($: Engine, n: number) => {
  for (let i = 1; i <= n; i++) expect((await $.tool.check(edit(`f${i}.ts`))).decision).toBe('allow')
}

const context = async ($: Engine) =>
  (await $.prompt.context({ blocks: [], instructionFiles: [] })).blocks.find((b: PromptContextBlock) => b.name === 'scopeGuard')?.text ?? ''

describe('scope-guard', () => {
  test('a headless turn: the fifth file is denied with the restate message and the turn is ended', async ($, on) => {
    const w = world(on)
    await start($, false)
    await $.command.run({ command: 'scope', args: 'judge off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    await editsUpTo($, 4)
    const fifth = await $.tool.check(edit('f5.ts'))
    expect(fifth.decision).toBe('deny')
    expect(fifth.reason).toMatch(/already touched 4 files \(f1\.ts, f2\.ts, f3\.ts, f4\.ts\) and f5\.ts would take it past the threshold of 4/)
    expect(fifth.reason).toMatch(/Restate: \(1\) the goal in one sentence/)
    expect(w.asked).toEqual([])
    expect(w.aborted).toEqual([])
    await w.clock.advance(250)
    expect(w.aborted).toEqual(['t1'])
    expect((await $.tool.check(edit('f6.ts'))).decision).toBe('deny')
    expect(w.aborted).toEqual(['t1'])
    expect(await context($)).toMatch(/already been stopped 2 times/)
  })

  test('the same file edited twice counts once', async ($, on) => {
    world(on, { review: '{"ok": false}' })
    await start($, false)
    await editsUpTo($, 4)
    expect((await $.tool.check(edit('f4.ts', 'again'))).decision).toBe('allow')
    expect((await $.tool.check(edit('f5.ts'))).decision).toBe('deny')
  })

  test('the judge saying ok lets the edit through, raises the bar by one, and says so in the context', async ($, on) => {
    const w = world(on, { review: '{"ok": true}' })
    await start($, false)
    await editsUpTo($, 4)
    expect((await $.tool.check(edit('f5.ts', 'redirect fix'))).decision).toBe('allow')
    expect(w.asked.length).toBe(1)
    expect(w.asked[0]?.model).toBe('claude-haiku-4-5-20251001')
    expect(w.asked[0]?.prompt).toMatch(/"goal":"Fix the login redirect bug"/)
    expect(w.asked[0]?.prompt).toMatch(/"filesTouchedSoFar":\["f1\.ts","f2\.ts","f3\.ts","f4\.ts"\]/)
    expect(w.asked[0]?.prompt).toMatch(/"nextFile":"f5\.ts","edit":"redirect fix"/)
    expect(await context($)).toMatch(/judge found the edit to f5\.ts within the goal and raised this turn's threshold to 5, once/)
    const sixth = await $.tool.check(edit('f6.ts'))
    expect(sixth.decision).toBe('deny')
    expect(w.asked.length).toBe(1)
    await $.turn.start({ text: 'next', turnId: 't2' })
    expect(await context($)).not.toMatch(/judge/)
  })

  test('the judge saying no, or failing, falls through to the deny', async ($, on) => {
    const w = world(on, { review: '{"ok": false, "reason": "unrelated file"}' })
    await start($, false)
    await editsUpTo($, 4)
    expect((await $.tool.check(edit('f5.ts'))).decision).toBe('deny')
    expect(w.logs.at(-1)).toMatch(/judge on f5\.ts: unrelated file/)
    await $.turn.start({ text: 'again', turnId: 't2' })
    w.options.review = undefined
    await editsUpTo($, 4)
    expect((await $.tool.check(edit('f5.ts'))).decision).toBe('deny')
    expect(w.logs.at(-1)).toMatch(/judge failed: .*api down/)
    expect(w.asked.length).toBe(2)
  })

  test('the judge trims the edit to 1500 characters', async ($, on) => {
    const w = world(on, { review: '{"ok": true}' })
    await start($, false)
    await editsUpTo($, 4)
    await $.tool.check(edit('f5.ts', 'x'.repeat(4000)))
    expect(w.asked[0]?.prompt).toMatch(/"edit":"x{1500}"/)
  })

  test('an interactive session asks; Stop denies, Continue doubles the bar', async ($, on) => {
    const w = world(on, { review: '{"ok": false}', answer: `Stop — I'll restate the goal` })
    await start($, true)
    await editsUpTo($, 4)
    const fifth = await $.tool.check(edit('f5.ts'))
    expect(fifth.decision).toBe('deny')
    expect(fifth.reason).toMatch(/Restate/)
    expect(w.dialogs()).toBe(1)
    await w.clock.advance(1000)
    expect(w.aborted).toEqual([])
    await $.turn.start({ text: 'again', turnId: 't2' })
    w.options.answer = 'Continue, this is in scope'
    await editsUpTo($, 4)
    expect((await $.tool.check(edit('f5.ts'))).decision).toBe('allow')
    expect(w.dialogs()).toBe(2)
    await editsUpTo($, 8)
    expect(w.dialogs()).toBe(2)
    w.options.answer = `Stop — I'll restate the goal`
    expect((await $.tool.check(edit('f9.ts'))).decision).toBe('deny')
    expect(w.dialogs()).toBe(3)
  })

  test('a resume rebuilds the goal and the count from the transcript', async ($, on) => {
    const use = (i: number) => ({ tool_use_id: `p${i}`, tool: 'Edit', input: { file_path: `/repo/old${i}.ts`, old_string: 'a', new_string: 'b' } })
    const messages: SessionMessage[] = [
      { role: 'user', text: 'Rename the config loader', toolUses: [] },
      { role: 'assistant', text: 'ok', toolUses: [use(1), use(2)] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'p1', text: 'ok', isError: false }, { tool_use_id: 'p2', text: 'ok', isError: false }] },
      { role: 'assistant', text: '', toolUses: [use(3), { tool_use_id: 'r1', tool: 'Read', input: { file_path: '/repo/x.ts' } }, use(3)] },
    ]
    world(on, { messages, review: '{"ok": false}' })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const status = await $.command.run({ command: 'scope', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    expect(status.text).toMatch(/goal: Rename the config loader/)
    expect(status.text).toMatch(/edited 3 file\(s\):\n  old1\.ts\n  old2\.ts\n  old3\.ts/)
    expect((await $.tool.check(edit('f4.ts'))).decision).toBe('allow')
    expect((await $.tool.check(edit('f5.ts'))).decision).toBe('deny')
  })

  test('a hook failure denies with the way to disable', async ($, on) => {
    const w = world(on, { review: '{"ok": true}' })
    await start($, false)
    w.options.cwdFails = true
    await editsUpTo($, 4)
    const fifth = await $.tool.check(edit('f5.ts'))
    expect(fifth.decision).toBe('deny')
    expect(fifth.reason).toMatch(/scope-guard errored \(throw: .*cwd exploded/)
    expect(fifth.reason).toMatch(/\/scope off .* or CLAUDE_MODS_DISABLE=scope-guard/)
  })

  test('a query without a call id and a non-editing tool are not counted', async ($, on) => {
    world(on, { review: '{"ok": false}' })
    await start($, false)
    for (let i = 0; i < 6; i++) {
      expect((await $.tool.check({ tool: 'Edit', input: { file_path: `/repo/q${i}.ts` } })).decision).toBe('allow')
      expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: `b${i}` })).decision).toBe('allow')
    }
    await editsUpTo($, 4)
    expect((await $.tool.check(edit('f5.ts'))).decision).toBe('deny')
  })

  test('CLAUDE_MODS_DISABLE=scope-guard passes every edit through and registers no command', async ($, on) => {
    const w = world(on, { env: { CLAUDE_MODS_DISABLE: 'other,scope-guard' } })
    await start($, false)
    await editsUpTo($, 9)
    expect(w.commands).toEqual([])
    expect(w.asked).toEqual([])
    expect(await context($)).toBe('')
  })
})

const bash = (command: string): ToolCheckInput => ({ tool: 'Bash', input: { command }, tool_use_id: `b${++ids}` })

describe('bash edits', () => {
  test('bashTargets reads the files a command writes', () => {
    const t = (c: string) => bashTargets(c, '/repo')
    expect(t(`sed -i '' 's/a/b/' x.ts`)).toEqual(['/repo/x.ts'])
    expect(t(`sed -i.bak -e 's/a/b/' a.ts b.ts`)).toEqual(['/repo/a.ts', '/repo/b.ts'])
    expect(t(`sed -n '1,5p' file.ts`)).toEqual([])
    expect(t(`cat > y.ts <<'EOF'\nline with > z.ts inside\nEOF`)).toEqual(['/repo/y.ts'])
    expect(t(`cat <<EOF >> ./notes.md\n> quoted\nEOF\n`)).toEqual(['/repo/notes.md'])
    expect(t(`grep foo > /tmp/out`)).toEqual([])
    expect(t(`grep foo src > /private/tmp/x/out 2>/dev/null`)).toEqual([])
    expect(t(`echo "> file"; echo '>> other'`)).toEqual([])
    expect(t(`npm test 2>&1 | tee -a /repo/logs/test.log`)).toEqual(['/repo/logs/test.log'])
    expect(t(`cp a.ts b.ts && mv c.ts d/e.ts; touch f.ts g.ts`)).toEqual(['/repo/b.ts', '/repo/d/e.ts', '/repo/f.ts', '/repo/g.ts'])
    expect(t(`FOO=1 sudo tee /etc/hosts`)).toEqual(['/etc/hosts'])
    expect(t(`echo hi > "$OUT"; echo hi > $HOME/x; ls > -`)).toEqual([])
    expect(t(`git status && cat x.ts | grep y`)).toEqual([])
  })

  test('bash writes count like Edit targets and hit the same threshold', async ($, on) => {
    const w = world(on, { review: '{"ok": false}' })
    await start($, false)
    expect((await $.tool.check(bash(`sed -i '' 's/a/b/' f1.ts`))).decision).toBe('allow')
    expect((await $.tool.check(bash(`cat > f2.ts <<'EOF'\nhello\nEOF`))).decision).toBe('allow')
    expect((await $.tool.check(bash(`grep foo > /tmp/out`))).decision).toBe('allow')
    expect((await $.tool.check(bash(`cp f1.ts f3.ts`))).decision).toBe('allow')
    expect((await $.tool.check(edit('f4.ts'))).decision).toBe('allow')
    expect((await $.tool.check(bash(`echo x >> f4.ts`))).decision).toBe('allow')
    const status = await $.command.run({ command: 'scope', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    expect(status.text).toMatch(/edited 4 file\(s\):\n  f1\.ts\n  f2\.ts\n  f3\.ts\n  f4\.ts/)
    const fifth = await $.tool.check(bash(`tee f5.ts`))
    expect(fifth.decision).toBe('deny')
    expect(fifth.reason).toMatch(/f5\.ts would take it past the threshold of 4/)
    expect(w.asked[0]?.prompt).toMatch(/"nextFile":"f5\.ts","edit":"tee f5\.ts"/)
    await w.clock.advance(250)
    expect(w.aborted).toEqual(['t1'])
  })

  test('one bash call naming two new files past the bar is judged and denied as one', async ($, on) => {
    const w = world(on, { review: '{"ok": true}' })
    await start($, false)
    await editsUpTo($, 3)
    expect((await $.tool.check(bash(`touch f4.ts f5.ts`))).decision).toBe('allow')
    expect(w.asked.length).toBe(1)
    expect(await context($)).toMatch(/edit to f4\.ts, f5\.ts within the goal and raised this turn's threshold to 5/)
    expect((await $.tool.check(edit('f6.ts'))).decision).toBe('deny')
  })
})
