// End-to-end smoke test: drives Mom (on a phone-sized screen) and the runner
// (on a desktop-sized screen) through a full delivery against a deployed copy
// of the app, checking that each change shows up live on the other screen.
// Run it with no requests in progress; it leaves its test requests in history.
//
//   BASE_URL=https://<owner>.github.io/Mom-express/ MOM_USER=mom MOM_PASS=... RUNNER_USER=... RUNNER_PASS=... \
//     node scripts/e2e-smoke.mjs [screenshot-dir]
//
// Needs Playwright with Chromium installed (it isn't a project dependency).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const { chromium, devices } = createRequire(import.meta.url)('playwright');

// Pages below are opened relative to this, so it must end with a slash.
const BASE = (process.env.BASE_URL ?? 'http://localhost:5173/').replace(/\/?$/, '/');
const shots = process.argv[2];
if (shots) fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch();
const errors = [];
const pages = [];

async function open(name, options) {
  const context = await browser.newContext({ ...options, baseURL: BASE });
  const page = await context.newPage();
  pages.push([name, page]);
  // Expected: a 400 for the wrong-password check, and failed requests while
  // the test deliberately takes the browser offline.
  page.on(
    'console',
    (msg) =>
      msg.type() === 'error' &&
      !/status of 400|ERR_INTERNET_DISCONNECTED|Failed to fetch|WebSocket/.test(msg.text()) &&
      errors.push(`[${name}] ${msg.text()}`),
  );
  page.on('pageerror', (err) => errors.push(`[${name}] ${err.message}`));
  return page;
}

async function snap(page, name) {
  if (!shots) return;
  await page.waitForTimeout(450); // let entrance animations settle
  await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}

async function signIn(page, username, password) {
  await page.goto('./');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

const step = (msg) => console.log(`• ${msg}`);

try {
  const mom = await open('mom', { ...devices['iPhone 13'], hasTouch: true });
  const runner = await open('runner', { viewport: { width: 1360, height: 900 } });

  step('Sign-in screen');
  await mom.goto('./');
  await mom.getByRole('button', { name: 'Sign in' }).waitFor();
  await snap(mom, '01-mom-login');
  await mom.getByRole('button', { name: 'Sign in' }).click();
  await mom.getByText('Enter your username.').waitFor();

  step('Wrong password is rejected');
  await mom.getByLabel('Username').fill(process.env.MOM_USER);
  await mom.getByLabel('Password', { exact: true }).fill('definitely-wrong');
  await mom.getByRole('button', { name: 'Sign in' }).click();
  await mom.getByText('That username and password don’t match.').waitFor();

  step('Both sign in');
  await signIn(mom, process.env.MOM_USER, process.env.MOM_PASS);
  await mom.getByText('What can we bring you?').waitFor();
  await snap(mom, '02-mom-home-empty');
  await runner.goto('./');
  await runner.getByRole('button', { name: 'Sign in' }).waitFor();
  await snap(runner, '03-runner-login-desktop');
  await signIn(runner, process.env.RUNNER_USER, process.env.RUNNER_PASS);
  await runner.getByRole('heading', { name: /^New requests/ }).waitFor();
  await runner.locator('.conn-dot.live').first().waitFor();
  await snap(runner, '04-runner-dashboard-empty');

  step('Mom uses the Water shortcut, edits it, and sends');
  await mom.getByRole('button', { name: 'Water' }).click();
  await mom.getByLabel('What do you need?').waitFor();
  if ((await mom.getByLabel('What do you need?').inputValue()) !== 'Glass of water') throw new Error('Quick request did not pre-fill');
  await mom.getByLabel('What do you need?').fill('');
  await mom.getByRole('button', { name: 'Send request' }).click();
  await mom.getByText('Tell us what you need.').waitFor();
  await mom.getByLabel('What do you need?').fill('Glass of water');
  await mom.getByRole('button', { name: 'Bedroom' }).click();
  await mom.getByRole('button', { name: /Urgent/ }).click();
  await mom.getByLabel('Notes for your runner').fill('The blue glass, please');
  await snap(mom, '05-mom-new-request');
  await mom.getByRole('button', { name: 'Send request' }).click();
  await mom.getByRole('heading', { name: 'Waiting for your runner' }).waitFor();
  await snap(mom, '06-mom-tracking-pending');

  step('Runner sees it instantly');
  await runner.getByRole('article', { name: /Glass of water/ }).waitFor({ timeout: 5000 });
  await snap(runner, '07-runner-new-request');

  step('Runner accepts with a 5 minute ETA');
  await runner.getByRole('article', { name: /Glass of water/ }).getByRole('button', { name: 'Accept' }).click();
  await runner.getByRole('heading', { name: 'Accept and set an ETA' }).waitFor();
  await snap(runner, '08-runner-eta-sheet');
  await runner.getByRole('button', { name: /^5\s*min$/ }).click();
  await runner.getByText('Request accepted').first().waitFor();

  step('Mom sees the acceptance and the countdown without refreshing');
  await mom.getByRole('heading', { name: /is on it/ }).waitFor({ timeout: 5000 });
  await mom.getByText(/Arriving in about 5 minutes/).waitFor();
  await snap(mom, '09-mom-tracking-accepted');

  step('Runner cannot deliver before starting (button not offered), then starts');
  const card = runner.getByRole('article', { name: /Glass of water/ });
  if (await card.getByRole('button', { name: 'Mark delivered' }).count()) throw new Error('Deliver offered before start');
  await card.getByRole('button', { name: 'Start delivery' }).click();
  await mom.getByRole('heading', { name: 'On the way!' }).waitFor({ timeout: 5000 });
  await snap(mom, '10-mom-tracking-on-the-way');
  await snap(runner, '11-runner-in-progress');

  step('Runner updates the ETA; Mom sees the new estimate');
  await card.getByRole('button', { name: 'Update ETA' }).click();
  await runner.getByRole('button', { name: /^15\s*min$/ }).click();
  await mom.getByText(/Arriving in about 15 minutes/).waitFor({ timeout: 5000 });

  step('Runner delivers; both see it finished');
  await card.getByRole('button', { name: 'Mark delivered' }).click();
  await mom.getByRole('heading', { name: 'Delivered!' }).waitFor({ timeout: 5000 });
  await snap(mom, '12-mom-delivered');
  await runner.getByRole('heading', { name: /Recently finished/ }).waitFor();
  await snap(runner, '13-runner-after-delivery');

  step('Mom makes a custom request and cancels it; runner is told');
  await mom.goto('new');
  await mom.getByLabel('What do you need?').fill('Phone charger');
  await mom.getByRole('button', { name: 'Living room' }).click();
  await mom.getByRole('button', { name: 'Send request' }).click();
  await mom.getByRole('heading', { name: 'Waiting for your runner' }).waitFor();
  await runner.getByRole('article', { name: /Phone charger/ }).waitFor({ timeout: 5000 });
  await mom.getByRole('button', { name: 'Cancel request' }).click();
  await snap(mom, '14-mom-cancel-confirm');
  await mom.getByRole('dialog').getByRole('button', { name: 'Cancel request' }).click();
  await mom.getByRole('heading', { name: 'Request cancelled' }).waitFor();
  await runner.getByRole('article', { name: /Phone charger/ }).waitFor({ state: 'detached', timeout: 5000 });

  step('Runner declines a request with a reason; Mom is told');
  await mom.goto('new?quick=snack');
  await mom.getByRole('button', { name: 'Kitchen' }).click();
  await mom.getByRole('button', { name: 'Send request' }).click();
  await mom.getByRole('heading', { name: 'Waiting for your runner' }).waitFor();
  const snack = runner.getByRole('article', { name: /A snack/ });
  await snack.getByRole('button', { name: 'Decline' }).click();
  await runner.getByRole('button', { name: 'We’re out of it' }).click();
  await snap(runner, '15-runner-decline-sheet');
  await runner.getByRole('dialog').getByRole('button', { name: 'Decline request' }).click();
  await mom.getByRole('heading', { name: 'Request declined' }).waitFor({ timeout: 5000 });
  await mom.getByText(/We’re out of it/).first().waitFor();
  await snap(mom, '16-mom-declined');

  step('History, notifications and settings');
  await mom.goto('history');
  await mom.getByRole('heading', { name: 'History' }).waitFor();
  await mom.locator('.history-row').first().waitFor();
  await snap(mom, '17-mom-history');
  await mom.getByRole('button', { name: 'Declined' }).click();
  await mom.locator('.chip[aria-pressed="true"]', { hasText: 'Declined' }).waitFor();
  await mom.waitForTimeout(300);
  if ((await mom.locator('.history-row').count()) !== 1) throw new Error('Declined filter shows the wrong number of rows');
  await mom.goto('notifications');
  await mom.locator('.notif').first().waitFor();
  await snap(mom, '18-mom-notifications');
  await mom.goto('settings');
  await mom.getByRole('heading', { name: 'Settings' }).waitFor();
  await snap(mom, '19-mom-settings');
  await mom.goto('./');
  await mom.getByText('What can we bring you?').waitFor();
  await snap(mom, '20-mom-home-with-history');
  await runner.goto('history');
  await runner.locator('.history-row').first().waitFor();
  await snap(runner, '21-runner-history');

  step('Offline: a new request is kept on the device, clearly marked, and sent on reconnect');
  await runner.goto('./');
  await runner.getByRole('heading', { name: /^New requests/ }).waitFor();
  await mom.goto('./');
  await mom.getByText('What can we bring you?').waitFor();
  await mom.context().setOffline(true);
  await mom.locator('.topbar .conn-dot.offline, .topbar .conn-dot.reconnecting').first().waitFor({ timeout: 10000 });
  await mom.getByRole('link', { name: 'New request' }).first().click();
  await mom.getByLabel('What do you need?').fill('Biscuits');
  await mom.getByRole('button', { name: 'Kitchen' }).click();
  await mom.getByRole('button', { name: 'Send request' }).click();
  await mom.getByRole('heading', { name: 'Waiting to send' }).waitFor();
  await mom.getByText('Not sent yet', { exact: true }).first().waitFor();
  await snap(mom, '22-mom-offline-outbox');
  if (await runner.getByRole('article', { name: /Biscuits/ }).count()) throw new Error('Runner saw an unsent request');

  step('Offline: reloading still opens the app from the device');
  await mom.reload();
  await mom.getByText('What can we bring you?').waitFor();
  await mom.getByText(/You’re offline/).waitFor();
  await mom.getByRole('heading', { name: 'Waiting to send' }).waitFor();
  await snap(mom, '23-mom-offline-reload');

  await mom.context().setOffline(false);
  await mom.locator('.topbar .conn-dot.live').first().waitFor({ timeout: 20000 });
  await runner.getByRole('article', { name: /Biscuits/ }).waitFor({ timeout: 20000 });
  await mom.getByRole('heading', { name: 'Waiting to send' }).waitFor({ state: 'detached', timeout: 10000 });
  if ((await runner.getByRole('article', { name: /Biscuits/ }).count()) !== 1) throw new Error('Offline request was duplicated');

  console.log(errors.length ? `\nConsole errors:\n${errors.join('\n')}` : '\nNo console errors.');
  console.log('\nSmoke test passed.');
} catch (err) {
  console.error('\nSmoke test FAILED:', err.message);
  if (shots) for (const [name, page] of pages) await page.screenshot({ path: path.join(shots, `failure-${name}.png`), fullPage: true }).catch(() => {});
  if (errors.length) console.error(`Console errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
