import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const doctorModule = await import('../../commands/doctor.js');

describe('doctor capability health group', () => {
  it('runs health only in doctor and isolates one provider failure', () => {
    assert.equal(typeof doctorModule.evaluateCapabilityHealth, 'function');
    const called = [];
    const result = doctorModule.evaluateCapabilityHealth({
      healthChecks: [
        { providerId: 'healthy', capabilityId: 'communication.message', path: '/fixture/healthy.js' },
        { providerId: 'broken', capabilityId: 'communication.message', path: '/fixture/broken.js' },
      ],
      providers: [
        { id: 'legacy', declarationStatus: 'undeclared', status: 'installed' },
      ],
    }, {
      runHealth(check) {
        called.push(check.providerId);
        return check.providerId === 'healthy'
          ? { status: 0, stdout: '{"status":"ok"}' }
          : { status: 7, stderr: 'private failure text' };
      },
    });

    assert.deepEqual(called, ['healthy', 'broken']);
    assert.equal(result.status, 'degraded');
    assert.equal(result.checks.find(({ providerId }) => providerId === 'healthy').status, 'pass');
    const broken = result.checks.find(({ providerId }) => providerId === 'broken');
    assert.equal(broken.status, 'degraded');
    assert.equal(broken.errorCode, 'capability_health_failed');
    assert.doesNotMatch(JSON.stringify(result), /private failure text/);
    assert.equal(result.undeclaredProviders, 1);
  });

  it('does not report legacy undeclared providers as unhealthy', () => {
    const result = doctorModule.evaluateCapabilityHealth({
      healthChecks: [],
      providers: [{ id: 'legacy', declarationStatus: 'undeclared', status: 'installed' }],
    });
    assert.equal(result.status, 'pass');
    assert.equal(result.undeclaredProviders, 1);
    assert.deepEqual(result.checks, []);
  });

  it('adds one Capabilities group without hiding unrelated diagnostics', () => {
    assert.equal(typeof doctorModule.buildDiagnosticJson, 'function');
    const diagnostic = doctorModule.buildDiagnosticJson({
      system: {
        tmux: { installed: true, version: '3.4' },
        pm2: { installed: true, version: '6.0.0' },
        network: { reachable: true, proxy: null },
      },
      ai: { cli: { installed: true, version: '1' }, auth: true, authStatus: 'success', autonomous: true, networkSkipped: false },
      services: { running: true, total: 1, procs: [{ name: 'scheduler', pm2_env: { status: 'online' } }], session: true },
      capabilities: {
        status: 'degraded',
        checks: [{ providerId: 'broken', capabilityId: 'communication.message', status: 'degraded', errorCode: 'capability_health_failed' }],
        undeclaredProviders: 1,
      },
    }, { success: true, version: '0.1.13' });

    assert.equal(diagnostic.groups.system.passed, true);
    assert.equal(diagnostic.groups.services.passed, true);
    assert.equal(diagnostic.groups.capabilities.status, 'degraded');
    assert.equal(diagnostic.issues.filter(({ id }) => id.startsWith('capability_')).length, 1);
  });
});
