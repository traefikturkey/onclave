export const ONCLAVE_ROOT_CAPABILITY_ENV = "ONCLAVE_PI_ROOT_CAPABILITY";
export const ONCLAVE_SUBAGENT_SENTINEL_ENV = "ONCLAVE_PI_SUBAGENT_INELIGIBLE";

export function isPiSubagent(environment: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(environment.PI_SUBAGENT_RUN_ID?.trim() || environment.PI_SUBAGENT_TREE_RUN_ID?.trim() || environment[ONCLAVE_SUBAGENT_SENTINEL_ENV]?.trim());
}

export function initializeRootCapability(environment: NodeJS.ProcessEnv = process.env): boolean {
  return !isPiSubagent(environment) && Boolean(environment[ONCLAVE_ROOT_CAPABILITY_ENV]?.trim());
}
