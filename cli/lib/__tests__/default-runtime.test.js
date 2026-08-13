import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  RUNTIME_CHOICES,
  printInitHelp,
  selectRuntime,
} from '../../commands/init.js';
import { showHelp as showRuntimeHelp } from '../../commands/runtime.js';

const originalRuntime = process.env.YOS_RUNTIME;

afterEach(() => {
  if (originalRuntime === undefined) delete process.env.YOS_RUNTIME;
  else process.env.YOS_RUNTIME = originalRuntime;
});

describe('default runtime selection', () => {
  test('uses Codex when no explicit or existing runtime is present', () => {
    assert.equal(selectRuntime({}), 'codex');
  });

  test('keeps an explicit Claude selection ahead of the default', () => {
    assert.equal(selectRuntime({ requestedRuntime: 'claude', existingRuntime: 'codex' }), 'claude');
  });

  test('keeps YOS_RUNTIME=claude ahead of an existing config and the default', () => {
    process.env.YOS_RUNTIME = 'claude';
    assert.equal(selectRuntime({ requestedRuntime: process.env.YOS_RUNTIME, existingRuntime: 'codex' }), 'claude');
  });

  test('keeps an existing Claude config ahead of the default', () => {
    assert.equal(selectRuntime({ existingRuntime: 'claude' }), 'claude');
  });

  test('maps the interactive default and invalid choices to Codex', () => {
    assert.deepEqual(RUNTIME_CHOICES.map(({ value }) => value), ['codex', 'claude']);
    assert.equal(selectRuntime({ interactiveChoice: 1 }), 'codex');
    assert.equal(selectRuntime({ interactiveChoice: 2 }), 'claude');
    assert.equal(selectRuntime({ interactiveChoice: 0 }), 'codex');
    assert.equal(selectRuntime({ interactiveChoice: 99 }), 'codex');
  });

  test('documents Codex rather than Claude as the default', () => {
    const originalLog = console.log;
    let output = '';
    console.log = (line = '') => { output += `${line}\n`; };
    try {
      printInitHelp();
      showRuntimeHelp();
    } finally {
      console.log = originalLog;
    }
    assert.match(output, /codex \(default\) or claude/);
    assert.doesNotMatch(output, /claude \(default\)/);
    assert.match(output, /Codex CLI \(OpenAI\) — default/);
    assert.doesNotMatch(output, /Claude Code \(Anthropic\) — default/);
  });
});
