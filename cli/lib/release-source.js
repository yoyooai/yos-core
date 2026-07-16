const GITHUB_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function resolveGitHubRepo(envName, env, label) {
  const repo = env[envName]?.trim();
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
