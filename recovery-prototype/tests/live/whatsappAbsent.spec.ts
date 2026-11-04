// The prototype's own build (no WhatsApp preview flag) has no WhatsApp route, link or Meta script.
import { expect, test } from '@playwright/test';
import { MockSupabase, USERS } from './mockSupabase';

test('prototype build: no WhatsApp page, link or Meta script', async ({ page }) => {
  await new MockSupabase().install(page.context());
  await page.goto('/login');
  await page.getByLabel('Email').fill(USERS.client.email);
  await page.getByLabel('Password').fill(USERS.client.password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/app\/client$/);
  await expect(page.getByRole('button', { name: 'Connect or manage WhatsApp' })).toHaveCount(0);
  await page.goto('/app/client/whatsapp');
  await expect(page.getByText(/not found/i).first()).toBeVisible();
  expect(await page.evaluate(() => [...document.scripts].some((s) => s.src.includes('facebook')))).toBe(false);
});
