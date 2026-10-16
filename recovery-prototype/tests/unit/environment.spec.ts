import { expect, test } from '@playwright/test';
import { DEMO_RULE_SUBMIT, headerView } from '../../src/live/environment';

test('only a signed-in founder gets the staging header; every other state gets the demo header', () => {
  expect(headerView('FOUNDER')).toBe('founder');
  for (const r of ['CLIENT', 'NONE', null, undefined, '', 'founder']) expect(headerView(r as string | null | undefined)).toBe('demo');
});

test('the submission rule forbids real customer data in plain words', () => {
  expect(DEMO_RULE_SUBMIT).toMatch(/sample conversations only/i);
  expect(DEMO_RULE_SUBMIT).toMatch(/never paste or upload a real customer/i);
});
