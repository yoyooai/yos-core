import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const {
  classifyInstallOutcome,
  INSTALL_OK,
  INSTALL_NOT_RUNNING,
  INSTALL_DEGRADED,
} = await import('../install-outcome.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADD_COMMAND = path.resolve(HERE, '../../commands/add.js');

describe('install outcome', () => {
  it('celebrates only a clean install', () => {
    assert.equal(classifyInstallOutcome({ serviceRunning: true, postInstallDegraded: false }), INSTALL_OK);
    // A component that declares no service is not a failed one.
    assert.equal(classifyInstallOutcome({ serviceRunning: null, postInstallDegraded: false }), INSTALL_OK);
    assert.equal(classifyInstallOutcome({}), INSTALL_OK);
  });

  // The regression this file exists for: nothing fetched, hook ends non-zero,
  // and the install still signed off as "installed successfully!".
  it('refuses to report success when the post-install hook failed', () => {
    assert.equal(
      classifyInstallOutcome({ serviceRunning: true, postInstallDegraded: true }),
      INSTALL_DEGRADED,
    );
    assert.equal(
      classifyInstallOutcome({ serviceRunning: null, postInstallDegraded: true }),
      INSTALL_DEGRADED,
    );
  });

  it('reports a dead service ahead of a degraded add-on', () => {
    assert.equal(
      classifyInstallOutcome({ serviceRunning: false, postInstallDegraded: true }),
      INSTALL_NOT_RUNNING,
    );
    assert.equal(
      classifyInstallOutcome({ serviceRunning: false, postInstallDegraded: false }),
      INSTALL_NOT_RUNNING,
    );
  });

  // Classifying correctly is worthless if `yos add` never records that the hook
  // failed, or prints the celebration regardless of the verdict. Both were true
  // before this fix, so both are pinned here.
  it('wires the hook failure through add.js instead of swallowing it', () => {
    const source = fs.readFileSync(ADD_COMMAND, 'utf8');

    // The catch around the post-install hook must record the failure.
    assert.match(
      source,
      /catch\s*\{\s*postInstallDegraded\s*=\s*true/,
      'add.js must record a failed post-install hook, not swallow it',
    );

    // The closing summary must be driven by the classifier.
    assert.match(
      source,
      /classifyInstallOutcome\(\{\s*serviceRunning,\s*postInstallDegraded\s*\}\)/,
      'add.js must decide its closing line via classifyInstallOutcome',
    );

    // "installed successfully!" must not be reachable without consulting it.
    const successLine = source.indexOf('installed successfully!');
    const classifyCall = source.indexOf('classifyInstallOutcome({ serviceRunning, postInstallDegraded })');
    assert.ok(successLine > -1 && classifyCall > -1, 'both the classifier call and the success line must exist');
    assert.ok(
      classifyCall < successLine,
      'the success line must come after the classifier decides, never before it',
    );
  });
});
