import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:4200', { waitUntil: 'networkidle0', timeout: 20000 });

  await page.evaluate(() => {
    const maId = crypto.randomUUID();
    const ma2Id = crypto.randomUUID();
    const upId = 'up1';
    const pId = 'p1';
    const ap1Id = 'ap1';

    const data = {
      ueberProjekte: [{
        id: upId, name: 'Firma ABC GmbH', beschreibung: '', erstelltAm: '2026-01-01',
        unternehmensTyp: 'kmu',
        projekte: [{
          id: pId, name: 'Website Redesign', beschreibung: '',
          startDatum: '2026-02-01', endDatum: '2026-06-30', status: 'aktiv', sollKosten: 50000,
          arbeitspakete: [
            { id: ap1Id, name: 'Entwicklung', beschreibung: '', status: 'in_bearbeitung',
              startDatum: '2026-02-01', endDatum: '2026-06-30', unterArbeitspakete: [] }
          ]
        }]
      }],
      mitarbeiter: [
        {
          id: maId, name: 'Max Mustermann', position: 'Dev', wochenStunden: 40,
          jahresUrlaub: 30, feiertagePflicht: true, jahresgehalt: 65000, lohnnebenkosten: 15000,
          blockierungen: [
            { id: crypto.randomUUID(), typ: 'urlaub', von: '2026-02-16', bis: '2026-02-20', notiz: 'Winterurlaub' },
            { id: crypto.randomUUID(), typ: 'krank', von: '2026-02-09', bis: '2026-02-10', notiz: '' },
            { id: crypto.randomUUID(), typ: 'feiertag', von: '2026-02-12', bis: '2026-02-12', notiz: 'Rosenmontag' }
          ]
        },
        {
          id: ma2Id, name: 'Anna Schmidt', position: 'Design', wochenStunden: 32,
          jahresUrlaub: 28, feiertagePflicht: false, jahresgehalt: 52000, lohnnebenkosten: 12000,
          blockierungen: [
            { id: crypto.randomUUID(), typ: 'urlaub', von: '2026-02-18', bis: '2026-02-20', notiz: '' },
            { id: crypto.randomUUID(), typ: 'feiertag', von: '2026-02-12', bis: '2026-02-13', notiz: 'Karneval' }
          ]
        }
      ],
      zuweisungen: [
        {
          id: crypto.randomUUID(), mitarbeiterId: maId, projektId: pId, ueberProjektId: upId,
          prozentAnteil: 50, von: '2026-02-01', bis: '2026-06-30',
          arbeitspaketVerteilung: [{ arbeitspaketId: ap1Id, prozentAnteil: 100 }]
        },
        {
          id: crypto.randomUUID(), mitarbeiterId: ma2Id, projektId: pId, ueberProjektId: upId,
          prozentAnteil: 30, von: '2026-02-01', bis: '2026-06-30',
          arbeitspaketVerteilung: [{ arbeitspaketId: ap1Id, prozentAnteil: 100 }]
        }
      ],
      feiertage: [
        { datum: '2026-01-01', name: 'Neujahr' },
        { datum: '2026-02-23', name: 'Test-Feiertag' }
      ],
      exportLog: [], exportCounter: 0
    };
    localStorage.setItem('novarix_data', JSON.stringify(data));

  });

  // Login via UI (offline fallback mode uses seed data, but we already set localStorage)
  await page.type('#login-email', 'test@test.de');
  await page.type('#login-password', 'test');
  await page.click('#login-btn');
  await new Promise(r => setTimeout(r, 3000));

  async function nav(hash) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await new Promise(r => setTimeout(r, 800));
  }

  // Get MA IDs from localStorage for navigation
  const { maId: testMaId, ma2Id: testMa2Id } = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('novarix_data'));
    return { maId: data.mitarbeiter[0].id, ma2Id: data.mitarbeiter[1].id };
  });

  // 1. Projekt-Kalender February — should show blocked days (urlaub, krank, feiertag)
  await nav('#/projekt-kalender/up1/p1');
  await page.screenshot({ path: './temporary screenshots/blocked-01-projekt-cal.png', fullPage: true });
  console.log('Screenshot 1: Projekt-Kalender with blocked days (incl. Feiertag)');

  // 2. AP-Kalender February — Feiertag blockierungen should block the AP distribution
  await nav('#/ap-kalender/up1/p1/ap1');
  await page.screenshot({ path: './temporary screenshots/blocked-02-ap-cal.png', fullPage: true });
  console.log('Screenshot 2: AP-Kalender with blocked days (incl. Feiertag)');

  // 3. MA-Kalender for Max — should show amber Feiertag on Feb 12
  await nav(`#/mitarbeiter-kalender/${testMaId}`);
  await page.screenshot({ path: './temporary screenshots/blocked-03-ma-cal-max.png', fullPage: true });
  console.log('Screenshot 3: MA-Kalender Max with custom Feiertag (Rosenmontag)');

  // 4. MA-Kalender for Anna (feiertagePflicht=false) — should show amber Feiertag on Feb 12-13
  await nav(`#/mitarbeiter-kalender/${testMa2Id}`);
  await page.screenshot({ path: './temporary screenshots/blocked-04-ma-cal-anna.png', fullPage: true });
  console.log('Screenshot 4: MA-Kalender Anna with custom Feiertag (Karneval, no govt holidays)');

  // 5. Verify CalcEngine counts feiertag blockierungen as blocked days
  const calcCheck = await page.evaluate((mid) => {
    const CalcEngine = window.CalcEngine || window._CalcEngine;
    if (!CalcEngine) return 'CalcEngine not found on window';
    const blocked = CalcEngine.getBlockedDays(mid, '2026-02-01', '2026-02-28');
    // Max: urlaub 16-20 (5 days) + krank 09-10 (2 days) + feiertag 12 (1 day) + govt feiertag 23 (1 day) = 9
    return { blocked, expected: 9 };
  }, testMaId);
  console.log('CalcEngine check Max:', JSON.stringify(calcCheck));

  const calcCheck2 = await page.evaluate((mid) => {
    const CalcEngine = window.CalcEngine || window._CalcEngine;
    if (!CalcEngine) return 'CalcEngine not found on window';
    const blocked = CalcEngine.getBlockedDays(mid, '2026-02-01', '2026-02-28');
    // Anna (feiertagePflicht=false): urlaub 18-20 (3 days) + feiertag 12-13 (2 days) = 5
    return { blocked, expected: 5 };
  }, testMa2Id);
  console.log('CalcEngine check Anna:', JSON.stringify(calcCheck2));

  if (errors.length > 0) console.log('JS ERRORS:', errors);
  else console.log('No JS errors!');

  await browser.close();
  console.log('Done!');
})();
