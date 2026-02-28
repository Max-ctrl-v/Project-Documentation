import puppeteer from 'puppeteer';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(__dirname, 'temporary screenshots');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  page.on('console', msg => {
    if (!msg.text().includes('tailwindcss') && !msg.text().includes('Password field'))
      console.log('  [PAGE]', msg.text());
  });

  // Use localhost since it has the latest code immediately
  console.log('Loading localhost...');
  await page.goto('http://localhost:4200', { waitUntil: 'networkidle2', timeout: 15000 });

  // Inject seed data + bypass login
  const seedData = await (await fetch('http://localhost:4200/seed-data.json')).text();
  await page.evaluate((data) => {
    localStorage.setItem('novarix_data', data);
    sessionStorage.setItem('novarix_session', JSON.stringify({ email: 'm.nodes@novaris-consulting.de', name: 'M. Nodes', role: 'admin' }));
  }, seedData);
  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1500));

  // Navigate to project detail
  const ids = await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('novarix_data'));
    const up = d.ueberProjekte[0];
    const p = up.projekte[0];
    return { upId: up.id, pId: p.id };
  });

  await page.evaluate((upId, pId) => {
    window.location.hash = '#/projekt/' + upId + '/' + pId;
    if (typeof Router !== 'undefined') Router.resolve();
  }, ids.upId, ids.pId);
  await new Promise(r => setTimeout(r, 2000));

  // Screenshot: project with tabs visible
  await page.screenshot({ path: join(dir, 'extern-01-tabs.png') });
  console.log('Screenshot: project tabs (should show Externe Entwicklung)');

  // Click on Externe Entwicklung tab
  const clicked = await page.evaluate(() => {
    const tabs = document.querySelectorAll('.plan-tab');
    for (const t of tabs) {
      if (t.textContent.includes('Externe Entwicklung')) {
        t.click();
        return t.textContent.trim();
      }
    }
    return false;
  });
  console.log('Clicked tab:', clicked);
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: join(dir, 'extern-02-empty.png') });
  console.log('Screenshot: empty state');

  // Click "Neue Externe Entwicklung" button
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const b of btns) {
      if (b.textContent.includes('Neue Externe Entwicklung') && b.offsetParent !== null) {
        b.click();
        return;
      }
    }
  });
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: join(dir, 'extern-03-modal.png') });
  console.log('Screenshot: modal open');

  // Type a name
  await page.waitForSelector('.modal-content .form-input', { timeout: 5000 });
  await page.type('.modal-content .form-input', 'API-Integration CloudPilot Backend');
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: join(dir, 'extern-04-filled.png') });
  console.log('Screenshot: modal filled');

  // Click Erstellen
  await page.evaluate(() => {
    const btns = document.querySelectorAll('.modal-content button');
    for (const b of btns) {
      if (b.textContent.includes('Erstellen')) { b.click(); return; }
    }
  });
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: join(dir, 'extern-05-created.png') });
  console.log('Screenshot: entry created');

  console.log('\nDone!');
  await browser.close();
})();
