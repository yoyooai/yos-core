import crypto from 'node:crypto';
import fs from 'node:fs';

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

export function loadApprovedTestBaselines(filePath) {
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`could not read test baselines: ${error.message}`);
  }
  if (policy.version !== 1 || !policy.baselines || typeof policy.baselines !== 'object') {
    throw new Error('test baselines have an unsupported schema');
  }
  for (const name of ['jest', 'node']) {
    requireNonNegativeInteger(policy.baselines[name]?.minimumPassed, `${name}.minimumPassed`);
  }
  const actualDigest = crypto.createHash('sha256')
    .update(JSON.stringify(policy.baselines))
    .digest('hex');
  if (policy.approvedDigest !== actualDigest) {
    throw new Error(`test baseline approval digest mismatch: expected ${policy.approvedDigest}, got ${actualDigest}`);
  }
  return policy.baselines;
}

export function verifyJestResult(result, baseline) {
  const passed = requireNonNegativeInteger(result?.numPassedTests, 'Jest numPassedTests');
  const failed = requireNonNegativeInteger(result?.numFailedTests, 'Jest numFailedTests');
  const pending = requireNonNegativeInteger(result?.numPendingTests, 'Jest numPendingTests');
  const todo = requireNonNegativeInteger(result?.numTodoTests, 'Jest numTodoTests');
  if (passed < baseline.minimumPassed) {
    throw new Error(`Jest passed ${passed} tests, below approved minimum ${baseline.minimumPassed}`);
  }
  if (failed || pending || todo) {
    throw new Error(`Jest result contains non-passing tests: failed ${failed}, pending ${pending}, todo ${todo}`);
  }
  return passed;
}

export function parseNodeTapSummary(output) {
  const names = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
  const values = {};
  for (const name of names) {
    const matches = [...String(output).matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
    if (matches.length === 0) throw new Error(`missing TAP summary field: ${name}`);
    values[name] = Number(matches.at(-1)[1]);
  }
  return {
    tests: values.tests,
    passed: values.pass,
    failed: values.fail,
    cancelled: values.cancelled,
    skipped: values.skipped,
    todo: values.todo,
  };
}

export function verifyNodeTapResult(output, baseline) {
  const summary = parseNodeTapSummary(output);
  if (summary.passed < baseline.minimumPassed) {
    throw new Error(`Node passed ${summary.passed} tests, below approved minimum ${baseline.minimumPassed}`);
  }
  if (summary.failed || summary.cancelled || summary.skipped || summary.todo) {
    throw new Error(`Node result contains non-passing tests: failed ${summary.failed}, cancelled ${summary.cancelled}, skipped ${summary.skipped}, todo ${summary.todo}`);
  }
  return summary.passed;
}
