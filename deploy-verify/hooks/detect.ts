// Deploy detection, kept free of `$` so it can be tested directly. The loader follows `$` only
// into functions of the module that registers hooks, so pure logic is what may live in its own file.

export const DEPLOY = [
  /(^|[^\w./-])git(\s+-\S+(\s+\S+)?)*\s+push(\s|$)/,
  /\bwrangler\s+(pages\s+)?deploy\b/,
  /\bvercel\b.*--prod\b/,
  /\bnetlify\s+deploy\b.*--prod\b/,
  /\brailway\s+up\b/,
  /\b(fly|flyctl)\s+deploy\b/,
  /\b(npm|pnpm|yarn|bun)\s+run\s+deploy\b/,
  /\bgcloud\s+run\s+deploy\b/,
  /\bgh\s+workflow\s+run\b/,
  /\bgh\s+pr\s+merge\b/,
  /\bgh\s+run\s+rerun\b/,
  /\bmake\s+deploy\b/,
]

// Opens a pull request: nothing is deployed, but CI runs on it, so its run is watched and reported.
export const CI_ONLY = [/\bgh\s+pr\s+create\b/]

const DRY_RUN = /\bpush\b.*(--dry-run|\s-n\b)/

// A command is not a deploy because the words appear somewhere in it. `echo "git push"`, a commit
// message quoting one, and `grep -r "wrangler deploy"` all match a naive pattern, and each one
// fires a verification against a site nothing was deployed to. So only what the shell would
// actually execute is tested: heredoc bodies go first (their markers may themselves be quoted),
// then quoted spans, then comments. A deploy hidden inside quotes — `ssh host "git push"` — is
// missed by this, which is the right way round: a missed check costs a reminder, a phantom check
// costs trust in the verdict.
export const sanitise = (command: string): string =>
  command
    .replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm, ' ')
    .replace(/<<-?\s*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1[\s\S]*$/, ' ')
    .replace(/'[^']*'/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
    .replace(/(^|\s)#[^\n]*/g, '$1 ')

// Each segment of the line counts on its own, so `echo ok && git push` is a push and a dry run
// only turns off the push it is in.
export const segments = (command: string): string[] => sanitise(command).split(/&&|\|\|?|;|\n/)

const matches = (patterns: RegExp[], command: string) =>
  segments(command).some(s => patterns.some(re => re.test(s)) && !DRY_RUN.test(s))

export const isDeploy = (command: string) => matches(DEPLOY, command)

export const isCiOnly = (command: string) => !isDeploy(command) && matches(CI_ONLY, command)

export const isPush = (command: string) => segments(command).some(s => DEPLOY[0]!.test(s) && !DRY_RUN.test(s))

// `gh` prints the run or pull request it created; a `git push` prints neither, its run is found by time.
export const isGh = (command: string) => segments(command).some(s => /\bgh\s+(pr|workflow|run)\s/.test(s))

export const RUN_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(actions\/runs|pull)\/\d+/

// The branch a push lands on: the refspec's destination when the command names one, else unknown
// (the caller asks git for HEAD). `git push -u origin feat` and `git push origin main:prod` both work.
export const pushBranch = (command: string): string | undefined => {
  const segment = segments(command).find(s => DEPLOY[0]!.test(s) && !DRY_RUN.test(s))
  if (!segment) return undefined
  const words = segment.slice(segment.search(/\bpush(\s|$)/) + 4).trim().split(/\s+/).filter(w => w && !w.startsWith('-'))
  const refspec = words[1]
  if (!refspec) return undefined
  const dst = refspec.replace(/^\+/, '').split(':').pop() ?? ''
  return dst.replace(/^refs\/heads\//, '') || undefined
}
