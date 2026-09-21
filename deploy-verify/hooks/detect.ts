// Deploy detection, kept free of `$` so it can be tested directly. The loader follows `$` only
// into functions of the module that registers hooks, so pure logic is what may live in its own file.

export const DEPLOY = [
  /\bgit\s+push\b/,
  /\bwrangler\s+(pages\s+)?deploy\b/,
  /\bvercel\b[^|;]*--prod\b/,
  /\bnetlify\s+deploy\b[^|;]*--prod\b/,
  /\brailway\s+up\b/,
  /\b(fly|flyctl)\s+deploy\b/,
  /\b(npm|pnpm|yarn|bun)\s+run\s+deploy\b/,
  /\bgcloud\s+run\s+deploy\b/,
  /\bgh\s+workflow\s+run\b/,
  /\bmake\s+deploy\b/,
]

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

export const isDeploy = (command: string) => DEPLOY.some(re => re.test(sanitise(command)))
