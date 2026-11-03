/** Windows PowerShell must discover its own modules, not inherit PowerShell 7's
 * module search path from the process which launched DSH. Scope this to the
 * child environment; never mutate the host or the user's global settings. */
export function windowsPowerShellEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
}
