import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';

import { buildHealthCheckContent } from '../health-check-message.js';

describe('health check notification target', () => {
  test('uses only the explicitly configured administrator target', () => {
    const content = buildHealthCheckContent({
      YOS_ADMIN_CHANNEL: 'feishu',
      YOS_ADMIN_ENDPOINT: 'oc_admin'
    });
    assert.match(content, /feishu/);
    assert.match(content, /oc_admin/);
    assert.doesNotMatch(content, /whoever|normally work with|use your judgment/i);
  });

  test('logs only when no administrator target is configured', () => {
    const content = buildHealthCheckContent({});
    assert.match(content, /No administrator alert target is configured/i);
    assert.match(content, /log/i);
    assert.doesNotMatch(content, /notify whoever|normally work with|use your judgment/i);
  });

  test('the activity monitor routes health checks through the explicit-target builder', () => {
    const monitor = fs.readFileSync(new URL('../monitor.js', import.meta.url), 'utf8');
    assert.match(monitor, /const content = buildHealthCheckContent\(process\.env\);/);
    assert.doesNotMatch(monitor, /use your judgment to notify whoever/i);
  });
});
