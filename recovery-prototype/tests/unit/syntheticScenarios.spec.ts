// The synthetic paid-run conversations name the submitting business as the seller. Case
// E2E-PAID-20261016025019 was submitted by client A (Synthetic Autos A) with the academy scenario,
// whose seller lines were fixed to "Synthetic Academy B": a fixture mismatch, not a tenant fault.
import { expect, test } from '@playwright/test';
// @ts-expect-error plain .mjs module without type declarations
import { SCENARIOS, scenarioText, sellerName } from '../../supabase/scripts/synthetic-scenarios.mjs';

const OTHER_SELLERS = ['Synthetic Autos A', 'Synthetic Academy B', 'Synthetic Realty C'];

test('every scenario names the given business as the seller, and no other synthetic business', () => {
  for (const name of Object.keys(SCENARIOS)) {
    const text = scenarioText(name, '20261016', 'Synthetic Bakery Z') as string;
    const sellerLines = text.split('\n').filter((l) => !l.includes('Synthetic Prospect'));
    expect(sellerLines.length, name).toBeGreaterThan(0);
    expect(sellerLines.every((l) => /^\[[^\]]+\] Synthetic Bakery Z: /.test(l)), name).toBe(true);
    for (const other of OTHER_SELLERS) expect(text, `${name} / ${other}`).not.toContain(other);
  }
});

test('without a business name each scenario keeps its own default seller (unchanged text)', () => {
  expect(scenarioText('car-price', 's')).toContain('] Synthetic Autos A: 9,500 is already a very good price.');
  expect(scenarioText('academy-price', 's', '')).toContain('] Synthetic Academy B: The fee is 250,000.');
  expect(scenarioText('declined', 's', null)).toContain('] Synthetic Realty C: Good morning');
  expect(scenarioText('real-customer-chat', 's', 'X')).toBeNull();
});

test('a business name cannot break the chat-line format', () => {
  expect(sellerName('  Synthetic\nAutos [A]: ')).toBe('Synthetic Autos A');
  expect(sellerName('x'.repeat(200))).toHaveLength(80);
  for (const bad of ['', '  ', ':[]', null, undefined, 42]) expect(sellerName(bad)).toBeNull();
});
