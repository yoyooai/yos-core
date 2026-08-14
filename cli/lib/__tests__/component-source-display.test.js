import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeRemoteSource, resolveTarget } from '../components.js';

describe('component source display', () => {
  it('shows the effective distribution shelf for an official registry component', () => {
    const source = describeRemoteSource({
      repo: 'yoyooai/yos-components',
      subdir: 'channels/001_feishu',
      isThirdParty: false,
      fromRegistry: true,
    }, { YOS_DIST_BASE: 'https://mirror.example/dist/' });

    assert.equal(source.sourceHeading, 'Package source:');
    assert.equal(source.sourceLabel, 'https://mirror.example/dist');
    assert.equal(source.sourceReplyLabel, 'Package source');
    assert.equal(source.sourceRepositoryLabel, 'https://github.com/yoyooai/yos-components (channels/001_feishu)');
  });

  it('uses the built-in shelf when no override is configured', () => {
    const source = describeRemoteSource({
      repo: 'yoyooai/yos-components',
      isThirdParty: false,
      fromRegistry: true,
    }, {});

    assert.equal(source.sourceLabel, 'https://yoyooai.com/dist');
    assert.match(source.sourceRepositoryLabel, /github\.com\/yoyooai\/yos-components/);
  });

  it('keeps an explicit or third-party GitHub source labelled as GitHub', () => {
    for (const input of [
      { repo: 'third-party/tool', isThirdParty: true, fromRegistry: true },
      { repo: 'yoyooai/yos-components', isThirdParty: false, fromRegistry: false },
    ]) {
      const source = describeRemoteSource(input, { YOS_DIST_BASE: 'https://mirror.example/dist' });
      assert.equal(source.sourceHeading, 'Repository:');
      assert.match(source.sourceLabel, /^https:\/\/github\.com\//);
      assert.equal(source.sourceRepositoryLabel, null);
    }
  });

  it('wires the shelf presentation through real registry resolution', async () => {
    const previousRegistry = process.env.YOS_REGISTRY_REPO;
    const previousDist = process.env.YOS_DIST_BASE;
    process.env.YOS_REGISTRY_REPO = '';
    process.env.YOS_DIST_BASE = 'https://chosen.example/dist';
    try {
      const official = await resolveTarget('feishu@0.1.7');
      assert.equal(official.sourceLabel, 'https://chosen.example/dist');
      assert.match(official.sourceRepositoryLabel, /channels\/001_feishu/);

      const explicit = await resolveTarget('yoyooai/yos-components@feishu-v0.1.7');
      assert.equal(explicit.sourceHeading, 'Repository:');
      assert.equal(explicit.sourceRepositoryLabel, null);
    } finally {
      if (previousRegistry === undefined) delete process.env.YOS_REGISTRY_REPO;
      else process.env.YOS_REGISTRY_REPO = previousRegistry;
      if (previousDist === undefined) delete process.env.YOS_DIST_BASE;
      else process.env.YOS_DIST_BASE = previousDist;
    }
  });
});
