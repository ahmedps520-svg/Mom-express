// End-to-end smoke test: drives Mom (on a phone-sized screen) and the runner
// (on a desktop-sized screen) through a full delivery against a deployed copy
// of the app, checking that each change shows up live on the other screen.
// Run it with no requests in progress. It leaves its test requests in history.
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
  // A new device shows the sign-in screen in Arabic.
  await page.goto('./');
  await page.getByLabel('اسم المستخدم').fill(username);
  await page.getByLabel('كلمة المرور', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'دخول' }).click();
}

const step = (msg) => console.log(`• ${msg}`);

try {
  const mom = await open('mom', { ...devices['iPhone 13'], hasTouch: true });
  const runner = await open('runner', { viewport: { width: 1360, height: 900 } });
  const momHome = () => mom.getByRole('heading', { name: 'ماذا تحتاجين؟' });
  const momHero = (name) => mom.locator('.m-hero-title', { hasText: name });

  step('Sign-in screen (Arabic) checks what was typed');
  await mom.goto('./');
  await mom.getByRole('button', { name: 'دخول' }).waitFor();
  await snap(mom, '01-mom-login');
  await mom.getByRole('button', { name: 'دخول' }).click();
  await mom.getByText('اكتبي اسم المستخدم.').waitFor();

  step('Wrong password is rejected');
  await mom.getByLabel('اسم المستخدم').fill(process.env.MOM_USER);
  await mom.getByLabel('كلمة المرور', { exact: true }).fill('definitely-wrong');
  await mom.getByRole('button', { name: 'دخول' }).click();
  await mom.getByText('اسم المستخدم أو كلمة المرور غير صحيحة.').waitFor();

  step('Both sign in: Mom gets her Arabic app, the runner the English dashboard');
  await signIn(mom, process.env.MOM_USER, process.env.MOM_PASS);
  await momHome().waitFor();
  if ((await mom.evaluate(() => document.documentElement.dir)) !== 'rtl') throw new Error('Mom’s app is not right-to-left');
  await snap(mom, '02-mom-home');
  await signIn(runner, process.env.RUNNER_USER, process.env.RUNNER_PASS);
  await runner.getByRole('heading', { name: /^New requests/ }).waitFor();
  await runner.locator('.conn-dot.live').first().waitFor();
  if ((await runner.evaluate(() => document.documentElement.dir)) !== 'ltr') throw new Error('Runner’s app is not left-to-right');
  await snap(runner, '03-runner-dashboard');

  step('Mom taps Water, picks where she is, marks it urgent with a note, and sends');
  await mom.getByRole('link', { name: 'ماء' }).click();
  await mom.getByRole('heading', { name: 'كوب ماء' }).waitFor();
  await mom.getByRole('radio', { name: 'غرفتي' }).click();
  await mom.getByRole('button', { name: 'مستعجل' }).click();
  await mom.getByRole('button', { name: 'ملاحظة' }).click();
  await mom.getByLabel('ملاحظة').fill('الكوب الأزرق');
  await snap(mom, '04-mom-send');
  await mom.getByRole('button', { name: 'أرسل' }).click();
  await momHero('تم إرسال طلبك').waitFor();
  await snap(mom, '05-mom-sent');

  step('Runner sees it instantly');
  const water = runner.getByRole('article', { name: /كوب ماء/ });
  await water.waitFor({ timeout: 5000 });
  await snap(runner, '06-runner-new-request');

  step('Runner accepts with a 5 minute ETA; Mom sees it in Arabic without refreshing');
  await water.getByRole('button', { name: 'Accept' }).click();
  await runner.getByRole('button', { name: /^5\s*min$/ }).click();
  await runner.getByText('Request accepted').first().waitFor();
  await momHero('وافق على طلبك').waitFor({ timeout: 5000 });
  await mom.getByText(/يصل خلال حوالي ٥ دقائق/).waitFor();

  step('Runner starts, then changes the ETA; Mom sees each change');
  if (await water.getByRole('button', { name: 'Mark delivered' }).count()) throw new Error('Deliver offered before start');
  await water.getByRole('button', { name: 'Start delivery' }).click();
  await momHero('في الطريق إليك').waitFor({ timeout: 5000 });
  await water.getByRole('button', { name: 'Update ETA' }).click();
  await runner.getByRole('button', { name: /^15\s*min$/ }).click();
  await mom.getByText(/يصل خلال حوالي ١[٤٥] دقيقة/).waitFor({ timeout: 5000 });
  await snap(mom, '07-mom-on-the-way');

  step('Runner delivers; Mom sees it arrive');
  await water.getByRole('button', { name: 'Mark delivered' }).click();
  await momHero('وصل طلبك').waitFor({ timeout: 5000 });
  await snap(mom, '08-mom-delivered');

  step('Mom writes her own request and cancels it; the runner is told');
  await mom.goto('send/other');
  await mom.getByLabel('ماذا تحتاجين؟').fill('شاحن الهاتف');
  await mom.getByRole('radio', { name: 'الصالة' }).click();
  await mom.getByRole('button', { name: 'أرسل' }).click();
  await momHero('تم إرسال طلبك').waitFor();
  await runner.getByRole('article', { name: /شاحن الهاتف/ }).waitFor({ timeout: 5000 });
  await mom.getByRole('button', { name: 'إلغاء الطلب' }).click();
  await snap(mom, '09-mom-cancel-confirm');
  await mom.getByRole('button', { name: 'نعم، ألغيه' }).click();
  await momHero('أُلغي الطلب').waitFor();
  await runner.getByRole('article', { name: /شاحن الهاتف/ }).waitFor({ state: 'detached', timeout: 5000 });

  step('Runner declines a request with a reason; Mom is told');
  await mom.goto('send/food');
  await mom.getByRole('radio', { name: 'المطبخ' }).click();
  await mom.getByRole('button', { name: 'أرسل' }).click();
  await momHero('تم إرسال طلبك').waitFor();
  const food = runner.getByRole('article', { name: /شيء آكله/ });
  await food.getByRole('button', { name: 'Decline' }).click();
  await runner.getByRole('button', { name: 'We’re out of it' }).click();
  await runner.getByRole('dialog').getByRole('button', { name: 'Decline request' }).click();
  await momHero('لا يستطيع إحضاره الآن').waitFor({ timeout: 5000 });
  await mom.getByText(/We’re out of it/).first().waitFor();
  await snap(mom, '10-mom-declined');

  step('History and settings');
  await mom.goto('history');
  await mom.getByRole('heading', { name: 'طلباتي' }).waitFor();
  await mom.locator('.m-past').first().waitFor();
  await snap(mom, '11-mom-history');
  await mom.goto('settings');
  await mom.getByRole('heading', { name: 'الإعدادات' }).waitFor();
  await snap(mom, '12-mom-settings');
  await runner.goto('history');
  await runner.locator('.history-row').first().waitFor();

  step('Offline: a new request is kept on the phone, clearly marked, and sent on reconnect');
  await runner.goto('./');
  await runner.getByRole('heading', { name: /^New requests/ }).waitFor();
  await mom.goto('./');
  await momHome().waitFor();
  await mom.context().setOffline(true);
  await mom.locator('.m-banner-off').waitFor({ timeout: 10000 });
  await mom.getByRole('link', { name: 'شيء آخر' }).click();
  await mom.getByLabel('ماذا تحتاجين؟').fill('بسكويت');
  await mom.getByRole('radio', { name: 'المطبخ' }).click();
  await mom.getByRole('button', { name: 'أرسل' }).click();
  await momHome().waitFor();
  await mom.locator('.m-outbox', { hasText: 'بسكويت' }).waitFor();
  await snap(mom, '13-mom-offline-outbox');
  if (await runner.getByRole('article', { name: /بسكويت/ }).count()) throw new Error('Runner saw an unsent request');

  step('Offline: reloading still opens the app from the phone');
  await mom.reload();
  await momHome().waitFor();
  await mom.locator('.m-outbox', { hasText: 'بسكويت' }).waitFor();

  await mom.context().setOffline(false);
  await runner.getByRole('article', { name: /بسكويت/ }).waitFor({ timeout: 30000 });
  await mom.locator('.m-outbox').waitFor({ state: 'detached', timeout: 10000 });
  if ((await runner.getByRole('article', { name: /بسكويت/ }).count()) !== 1) throw new Error('Offline request was duplicated');

  step('Tidy up: the runner declines the last test request');
  const biscuits = runner.getByRole('article', { name: /بسكويت/ });
  await biscuits.getByRole('button', { name: 'Decline' }).click();
  await runner.getByRole('dialog').getByRole('button', { name: 'Decline request' }).click();
  await biscuits.waitFor({ state: 'detached', timeout: 10000 });

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
