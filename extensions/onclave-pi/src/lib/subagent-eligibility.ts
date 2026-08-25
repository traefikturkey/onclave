export function isPiSubagent(environment: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(environment.PI_SUBAGENT_RUN_ID?.trim() || environment.PI_SUBAGENT_TREE_RUN_ID?.trim());
}
