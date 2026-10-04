import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campaignUrl } from './campaign-url.mjs';

test('campaign links have fixed origin, canonical paths and bounded attribution', () => {
  assert.equal(campaignUrl('renewal-checklist', 'community', 'renewal'),
    'https://living-cost-manager.gamja.top/guide/renewal-checklist/?utm_source=community&utm_medium=referral&utm_campaign=renewal-checklist');
});

test('rejects arbitrary identifying input and prototype properties', () => {
  for (const value of ['person@example.test', 'https://evil.test', '__proto__', 'constructor', '', 'social&email=private']) {
    assert.throws(() => campaignUrl(value, 'community'));
    assert.throws(() => campaignUrl('local-first', value));
    assert.throws(() => campaignUrl('local-first', 'community', value));
  }
});
