import { readEnvFile } from './env.js';
import { ENV_FILE } from './config.js';

const GITHUB_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * The machine's own configuration, for values the shell does not export.
 *
 * The installer records the release repository in ~/yos/.env, but the CLI is
 * invoked from a plain shell that never loads that file — so `yos upgrade
 * --self` reported "YOS_RELEASE_REPO is not configured" on a machine where it
 * was configured. The process environment still wins, so an explicit
 * YOS_RELEASE_REPO=... in front of a command overrides the recorded value.
 *
 * Returns where the value came from as well as the value: the repair a customer
 * needs differs depending on the answer (see repairAdvice).
 *
 * @returns {{ value: string, origin: 'file' }|undefined}
 */
function fromMachineConfig(envName) {
  try {
    const value = readEnvFile().get(envName)?.trim();
    return value ? { value, origin: 'file' } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where to send someone whose configured value is wrong.
 *
 * Why the origin has to be in the message (TD-19, re-confirmed on a real run
 * 2026-08-06): this value resolves from two places — the process environment
 * and the recorded ~/yos/.env — and the old message named the variable as if it
 * were always the former. A customer whose bad value sat in ~/yos/.env would
 * `export YOS_RELEASE_REPO=...`, watch that one command succeed, and find the
 * next one broken again, because the file still held the value actually being
 * read. Naming the variable but not its source is the same "technically true,
 * practically misleading" failure this codebase keeps turning up: say which of
 * the two places to edit.
 */
function repairAdvice(envName, origin) {
  return origin === 'file'
    ? `Repair: edit ${ENV_FILE} and set ${envName}=owner/repository`
    : `Repair: export ${envName}=owner/repository`;
}

function resolveGitHubRepo(envName, env, label) {
  const direct = env[envName]?.trim();
  const found = direct
    ? { value: direct, origin: 'env' }
    : (env === process.env ? fromMachineConfig(envName) : undefined);

  if (!found) {
    return {
      success: false,
      error: `${label}_source_not_configured`,
      // Both places are named: either works, and someone told only about the
      // environment variable will set it for exactly one command.
      message: `${envName} is not configured. Repair: export ${envName}=owner/repository, `
        + `or record it in ${ENV_FILE}`,
    };
  }
  if (!GITHUB_REPO_PATTERN.test(found.value)) {
    const where = found.origin === 'file'
      ? `got "${found.value}", recorded in ${ENV_FILE}`
      : `got "${found.value}"`;
    return {
      success: false,
      error: `invalid_${label}_source`,
      message: `${envName} must use the GitHub owner/repository format (${where}). `
        + repairAdvice(envName, found.origin),
    };
  }
  return { success: true, repo: found.value };
}

export function resolveReleaseRepo(env = process.env) {
  return resolveGitHubRepo('YOS_RELEASE_REPO', env, 'release');
}

export function resolveRegistryRepo(env = process.env) {
  return resolveGitHubRepo('YOS_REGISTRY_REPO', env, 'registry');
}
