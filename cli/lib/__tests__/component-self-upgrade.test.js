import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { formatC4Reply, readOptionalCoreChangelog } = await import('../../commands/component.js');

describe('optional self-upgrade changelog', () => {
  it('does not make another network request when the package download failed', () => {
    let readCalled = false;
    const result = readOptionalCoreChangelog({ success: false, error: 'offline' }, '0.1.0', {
      readChangelog: () => {
        readCalled = true;
        return 'unexpected';
      },
    });

    assert.equal(readCalled, false);
    assert.equal(result.changelog, null);
    assert.equal(result.warning, 'Update notes unavailable; continuing without them.');
  });

  it('reads update notes only from the already-downloaded package', () => {
    const result = readOptionalCoreChangelog({ success: true, tempDir: '/tmp/new-core' }, '0.1.0', {
      readChangelog: (dir) => {
        assert.equal(dir, '/tmp/new-core');
        return '# Changelog\n\n## 0.2.0\n- fixed\n';
      },
      filterChangelog: (content, current) => {
        assert.equal(current, '0.1.0');
        return content.includes('fixed') ? '- fixed' : null;
      },
    });

    assert.deepEqual(result, { changelog: '- fixed', warning: null });
  });

  it('fails open with a fixed message when local update notes cannot be read', () => {
    const result = readOptionalCoreChangelog({ success: true, tempDir: '/tmp/new-core' }, '0.1.0', {
      readChangelog: () => {
        throw new Error('/private/path should not escape');
      },
    });

    assert.deepEqual(result, {
      changelog: null,
      warning: 'Update notes unavailable; continuing without them.',
    });
  });
});

describe('self-upgrade recovery reply', () => {
  it('reports an incomplete rollback with version, skill, backup, and recovery details', () => {
    const reply = formatC4Reply('self-upgrade', {
      success: false,
      failedStep: 6,
      error: 'dependency failed',
      rollback: {
        attempted: true,
        performed: false,
        steps: [{ action: 'restore_previous_core', success: false }],
      },
      manualRecovery: {
        message: 'Core remains at 0.4.13; it was not rolled back to 0.4.12. Core Skills were restored from the transaction backup.',
        backupDir: '/tmp/yos-core-backup-test',
        command: 'yos upgrade --self --recover "/tmp/yos-core-backup-test"',
      },
    });

    assert.match(reply, /Core remains at 0\.4\.13/);
    assert.match(reply, /not rolled back to 0\.4\.12/);
    assert.match(reply, /Core Skills were restored/);
    assert.match(reply, /\/tmp\/yos-core-backup-test/);
    assert.match(reply, /yos upgrade --self --recover/);
  });
});
