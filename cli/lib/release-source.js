import { readEnvFile } from './env.js';

const GITHUB_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * The machine's own configuration, for values the shell does not export.
 *
 * The installer records the release repository in ~/yos/.env, but the CLI is
 * invoked from a plain shell that never loads that file — so `yos upgrade
 * --self` reported "YOS_RELEASE_REPO is not configured" on a machine where it
 * was configured. The process environment still wins, so an explicit
 * YOS_RELEASE_REPO=... in front of a command overrides the recorded value.
 */
function fromMachineConfig(envName) {
  try {
    return readEnvFile().get(envName)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function resolveGitHubRepo(envName, env, label) {
  const repo = env[envName]?.trim() || (env === process.env ? fromMachineConfig(envName) : undefined);
  if (!repo) {
    return {
      success: false,
      error: `${label}_source_not_configured`,
      message: `${envName} is not configured`,
    };
  }
  if (!GITHUB_REPO_PATTERN.test(repo)) {
    return {
      success: false,
      error: `invalid_${label}_source`,
      message: `${envName} must use the GitHub owner/repository format`,
    };
  }
  return { success: true, repo };
}

export function resolveReleaseRepo(env = process.env) {
  return resolveGitHubRepo('YOS_RELEASE_REPO', env, 'release');
}

export function resolveRegistryRepo(env = process.env) {
  return resolveGitHubRepo('YOS_REGISTRY_REPO', env, 'registry');
}
