import type { Register, EngineInterface } from 'claude-code'

// "Do NOT merge PRs unless I explicitly say merge." A merge is a deploy with no approval gate
// behind it, so this mod denies the Bash merge verbs unless the latest human message contains
// the word merge. "ship", "push", "deploy" and "land" authorise landing work on the branch, not
// merging it; the user expects to press merge themselves.

const MOD = 'merge-gate'
const ENABLED_KEY = 'merge-gate:enabled'
const HUMAN_ORIGINS: readonly string[] = ['composer', 'bridge', 'sdk']
const TRUNK = ['main', 'master']

const GIT = String.raw`(^|[\s&;|('"])git(\s+-\S+(\s+\S+)?)*\s+`
const PR_MERGE = new RegExp(String.raw`(pulls/[0-9]+/merge|merge_requests/[0-9]+/merge|(^|[\s&;|('"])["']?gh["']?\s+pr\s+merge(\s|$|["'])|(^|[\s&;|('"])gh\s+api\s[^|;&]*/merge(\s|$|["']))`, 'm')
const GIT_MERGE = new RegExp(GIT + String.raw`merge(\s|$|["'])`, 'm')
const GIT_MERGE_LOCAL = new RegExp(GIT + String.raw`merge\s+--(abort|continue|quit)(\s|$)`, 'm')
const GIT_PUSH = new RegExp(GIT + String.raw`push(\s|$|["'])`, 'm')
const INERT = /^(echo|printf|grep|rg|ag|cat|less|head|tail)\b|^git(\s+-\S+(\s+\S+)?)*\s+(commit|log|show|grep)\b/
const GIT_VALUED = ['-C', '-c', '--git-dir', '--work-tree', '--namespace']
const SAYS_MERGE = /\bmerge\b/i
const NEGATED = /\b(don'?t|do not|never|no|not)\s+(\w+\s+)?merge\b/i
const GRANT_COUNT = /\bmerge\s*[x*]\s*([0-9]+)\b|\b([0-9]+)\s+merges\b/i
const GRANT_EACH = /\bmerge\s+(after|between|per|each|every)\b|\b(after|between)\s+each\b[^.]{0,40}\bmerge\b/i
const GRANT_EACH_USES = 5

let latest: string | undefined
let grantUses = 0
let enabled = true

// Only a segment that prints or records text is dropped; a quoted merge anywhere else (bash -c, eval) runs.
const executable = (command: string) =>
  command
    .split(/&&|\|\||;|\||\n/)
    .filter(seg => !INERT.test(seg.replace(/^[\s(]*(\w+=\S*\s+)*/, '')))
    .join(' ; ')

const saysMerge = (text: string) => {
  const t = text.replace(/\bmerge-gate\b/gi, '')
  return SAYS_MERGE.test(t) && !NEGATED.test(t)
}

const grantOf = (text: string): number => {
  const m = text.replace(/\n/g, ' ').match(GRANT_COUNT)
  const n = Number(m?.[1] ?? m?.[2])
  if (n > 0) return n
  return GRANT_EACH.test(text) ? GRANT_EACH_USES : 0
}

// Every branch a `git push` in the command writes to; undefined when one is left to git's default.
const pushTargets = (command: string): string[] | undefined => {
  const tokens = command.replace(/\n/g, ' ; ').split(/\s+/).filter(Boolean)
  const targets: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'git') continue
    i++
    while (tokens[i]?.startsWith('-')) i += GIT_VALUED.includes(tokens[i] ?? '') ? 2 : 1
    if (tokens[i] !== 'push') continue
    i++
    let remote = false
    let named = false
    for (; i < tokens.length && !['&&', '||', ';', '|'].includes(tokens[i] ?? ''); i++) {
      const token = tokens[i] ?? ''
      if (['--repo', '--push-option', '--receive-pack', '--exec', '-o'].includes(token)) i++
      else if (token.startsWith('-')) continue
      else if (!remote) remote = true
      else {
        named = true
        targets.push(token.replace(/^\+/, '').split(':').pop()?.replace(/^refs\/heads\//, '') ?? '')
      }
    }
    if (!named) return undefined
  }
  return targets
}

const git = async ($: EngineInterface, args: string[]) => {
  const run = await $.process.run(['git', ...args])
  return run.exitCode === 0 ? run.stdout.trim() : undefined
}

const hasPrFlow = async ($: EngineInterface) => /github|gitlab|bitbucket/i.test((await git($, ['remote', 'get-url', 'origin'])) ?? '')

const isMerge = async ($: EngineInterface, command: string): Promise<boolean> => {
  const bare = executable(command)
  if (PR_MERGE.test(bare)) return true
  if (GIT_MERGE.test(bare) && !GIT_MERGE_LOCAL.test(bare)) return TRUNK.includes((await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? '')
  if (!GIT_PUSH.test(bare)) return false
  const targets = pushTargets(bare)
  if (!targets?.some(t => TRUNK.includes(t))) return false
  const branch = await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return branch !== undefined && !TRUNK.includes(branch) && (await hasPrFlow($))
}

// Tracked prompts are exact; after a resume the transcript stands in, every user message counted as human.
const latestHuman = async ($: EngineInterface): Promise<string | undefined> => {
  if (latest !== undefined) return latest
  const messages = await $.session.messages()
  return messages.filter(m => m.role === 'user' && !m.toolResults?.length && m.text.trim() !== '').at(-1)?.text
}

const DENIED = [
  'merge-gate: Yash has not said merge in his latest message. Ask him, or he says \'merge\' and this passes.',
  '"ship", "push", "deploy" and "land" do not count: stop at the push, report the PR state, and let him merge.',
].join('\n')

// The first thing anyone does when a mod misbehaves is try to turn it off. `CLAUDE_MODS_DISABLE=all`,
// or a comma list naming this mod, makes every hook here a pass-through and registers no command.
let disabled = false
const readDisabled = async ($: EngineInterface): Promise<boolean> => {
  const raw = (await $.env.get('CLAUDE_MODS_DISABLE').catch(() => undefined)) ?? ''
  disabled = raw
    .split(',')
    .map(v => v.trim())
    .some(v => v === 'all' || v === MOD)
  return disabled
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (await readDisabled($)) return r
    enabled = (await $.store.get(ENABLED_KEY).catch(() => undefined)) !== false
    await $.command
      .register({
        name: 'merge-gate',
        description: 'Deny Bash merges unless the latest message says merge (merge-gate)',
        argumentHint: '[on | off | status]',
        immediate: true,
      })
      .catch(err => $.ui.log(`merge-gate: /merge-gate not registered: ${err}`))
    return r
  })

  on('command.run', { command: 'merge-gate' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      enabled = arg === 'on'
      await $.store.set(ENABLED_KEY, enabled).catch(err => $.ui.log(`merge-gate: store write failed: ${err}`))
      return { text: `merge-gate ${arg}` }
    }
    if (arg === '' || arg === 'status') {
      return { text: `merge-gate is ${enabled ? 'on' : 'off'}; latest message ${latest === undefined ? 'unknown' : saysMerge(latest) ? 'says merge' : 'does not say merge'}${grantUses ? `; ${grantUses} granted merge(s) left` : ''}` }
    }
    return { text: `merge-gate: "${arg}" is not on, off, or status` }
  })

  on('prompt.submit', ($, e, next) => {
    if (disabled || !HUMAN_ORIGINS.includes(e.origin.kind)) return next(e)
    latest = e.text
    grantUses = grantOf(e.text) || grantUses
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (disabled || !enabled || !(await isMerge($, e.command))) return next(e)
    const text = await latestHuman($)
    const said = text !== undefined && saysMerge(text)
    if (!said && grantUses === 0) return { deny: DENIED }
    if (grantUses > 0) grantUses--
    if (!said) $.ui.log(`merge-gate: allowed by a standing grant, ${grantUses} left`)
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : { deny: 'merge-gate check failed; blocking until it works. To get past it: /merge-gate off, or CLAUDE_MODS_DISABLE=merge-gate.' }))
}
