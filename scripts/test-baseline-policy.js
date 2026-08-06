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
    // TD-84: the floor has to be raised whenever tests are added, or the new
    // ones sit outside it and can be deleted without anything going red. That
    // was a rule in a document; documents do not fail builds. It is now
    // mechanical (see assertBaselineIsCurrent), and the room to be sloppy is a
    // declared number rather than nobody noticing — declared here so it lands
    // inside the approval digest below and cannot be widened quietly.
    if (policy.baselines[name].driftAllowance !== undefined) {
      requireNonNegativeInteger(policy.baselines[name].driftAllowance, `${name}.driftAllowance`);
    }
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
  return assertBaselineIsCurrent('Jest', passed, baseline);
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
  return assertBaselineIsCurrent('Node', summary.passed, baseline);
}

/**
 * The floor has to keep up with reality.
 *
 * TD-84: `minimumPassed` is a floor, which is the right design — but it was
 * raised by hand, with one line in a process document asking people to remember.
 * Anyone adding tests and forgetting leaves those tests outside the floor: they
 * can be deleted and the gate stays green, which is the exact hole the floor
 * exists to close, reopened a few tests at a time.
 *
 * So: passing MORE than the floor is now a failure too, and the message carries
 * the number to write down. The debt entry suggested making this advisory; a
 * hint nobody reads is how this debt survived in the first place, so it fails.
 *
 * `driftAllowance` is the escape hatch for a suite whose count genuinely moves
 * between runs. It defaults to 0, lives inside the digest-locked baselines, and
 * therefore cannot be widened without the approval digest changing.
 *
 * @param {string} name - 'jest' | 'node'
 * @param {number} passed - tests that actually passed this run
 * @param {{ minimumPassed: number, driftAllowance?: number }} baseline
 * @returns {number} passed, so callers can chain
 */
export function assertBaselineIsCurrent(name, passed, baseline) {
  const floor = baseline.minimumPassed;
  const allowance = baseline.driftAllowance ?? 0;
  if (passed > floor + allowance) {
    throw new Error(
      `${name} passed ${passed} tests but the approved floor is ${floor}`
      + (allowance > 0 ? ` (+${allowance} allowed drift)` : '')
      + `. Tests were added without raising the floor, so the new ones are not protected by it: `
      + `set baselines.${name}.minimumPassed to ${passed} in scripts/test-baselines.json `
      + `and refresh approvedDigest.`
    );
  }
  return passed;
}
