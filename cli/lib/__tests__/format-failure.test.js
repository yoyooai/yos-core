import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatFailure } from '../format-failure.js';

/** The failure a user actually hit: a raw ENOENT with a stack on top of it. */
function enoent() {
  const err = new Error("ENOENT: no such file or directory, open '/home/u/yos/.yos/components.json'");
  err.code = 'ENOENT';
  err.errno = -2;
  err.syscall = 'open';
  err.path = '/home/u/yos/.yos/components.json';
  return err;
}

describe('what a user sees when a command fails', () => {
  it('leads with the message, not a stack', () => {
    const output = formatFailure(enoent(), {});
    assert.match(output, /^Error: ENOENT: no such file or directory/);
    assert.doesNotMatch(output, /\bat \S+:\d+/, 'stack frames leaked into the message');
  });

  it('keeps the path, which is usually the whole diagnosis', () => {
    assert.match(formatFailure(enoent(), {}), /path: \/home\/u\/yos\/\.yos\/components\.json/);
  });

  it('says how to get the stack back', () => {
    assert.match(formatFailure(enoent(), {}), /YOS_DEBUG=1/);
  });

  it('returns the full stack under YOS_DEBUG', () => {
    const output = formatFailure(enoent(), { YOS_DEBUG: '1' });
    assert.match(output, /\bat \S+/, 'debug output should include stack frames');
  });

  it('does not repeat a code that the message already carries', () => {
    const err = new Error('ENOENT: missing');
    err.code = 'ENOENT';
    assert.doesNotMatch(formatFailure(err, {}), /\(ENOENT\)/);
  });

  it('appends a code the message omits, so it stays searchable', () => {
    const err = new Error('connect failed');
    err.code = 'ECONNREFUSED';
    assert.match(formatFailure(err, {}), /connect failed \(ECONNREFUSED\)/);
  });

  it('handles a thrown non-error without crashing the handler', () => {
    // A handler that throws while reporting a failure loses the failure.
    assert.equal(formatFailure('just a string', {}), 'Error: just a string');
    assert.match(formatFailure(undefined, {}), /Error: undefined/);
  });
});
