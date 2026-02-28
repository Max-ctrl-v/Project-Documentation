import puppeteer from 'puppeteer';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(__dirname, 'temporary screenshots');

// Accounts from env: NOVARIX_TEST_ACCOUNTS='email:password:role,email:password:role,...'
const envAccounts = process.env.NOVARIX_TEST_ACCOUNTS;
if (!envAccounts) { console.error('Set NOVARIX_TEST_ACCOUNTS env var (format: email:password:role,...)'); process.exit(1); }
const accounts = envAccounts.split(',').map(a => {
  const [email, password, role] = a.trim().split(':');
  return { email, password, role };
});

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080'],
  });

  for (const acc of accounts) {
    console.log(`\n=== Testing: ${acc.email} (${acc.role}) ===`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    await page.goto('http://localhost:4200', { waitUntil: 'networkidle2', timeout: 15000 });
    await page.type('#login-email', acc.email);
    await page.type('#login-password', acc.password);
    await page.click('#login-btn');
    await new Promise(r => setTimeout(r, 3000));

    const state = await page.evaluate(() => {
      const overlay = document.getElementById('login-overlay');
      const userInfo = document.getElementById('sidebar-user-info');
      const data = JSON.parse(localStorage.getItem('novarix_data') || '{}');
      return {
        loggedIn: overlay?.style.display === 'none',
        userInfo: userInfo?.textContent || '',
        companies: data.ueberProjekte?.length || 0,
        error: document.getElementById('login-error')?.textContent || '',
      };
    });

    const suffix = acc.email.split('@')[0].replace('.', '-');
    await page.screenshot({ path: join(dir, `auth-${suffix}.png`) });

    if (state.loggedIn) {
      console.log(`  OK — Logged in. User: "${state.userInfo}", Companies: ${state.companies}`);
    } else {
      console.log(`  FAILED — Error: "${state.error}"`);
    }

    await page.close();
  }

  console.log('\nAll accounts tested.');
  await browser.close();
})();
