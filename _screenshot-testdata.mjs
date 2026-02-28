import puppeteer from 'puppeteer';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(__dirname, 'temporary screenshots');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const BACKEND = process.env.NOVARIX_API || 'https://novarix-backend-production.up.railway.app/api/v1';
const FRONTEND = process.env.NOVARIX_FRONTEND || 'https://project-documentation-nu.vercel.app';
const EMAIL = process.env.NOVARIX_EMAIL;
const PW = process.env.NOVARIX_PASSWORD;
if (!EMAIL || !PW) { console.error('Set NOVARIX_EMAIL and NOVARIX_PASSWORD env vars'); process.exit(1); }

// ─── Helper: Backend API ──────────────────────────────────────────
async function api(path, token) {
  const res = await fetch(`${BACKEND}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  return res.json();
}

// ─── Fetch all data from backend & transform to frontend localStorage format ──
async function buildLocalStorageData() {
  const login = await fetch(`${BACKEND}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PW }),
    signal: AbortSignal.timeout(15000),
  }).then(r => r.json());
  const token = login.accessToken;
  console.log('Backend login OK:', login.user?.name);

  // Fetch all entities
  const upRes = await api('/ueberprojekte', token);
  const ueberProjekte = upRes.data || upRes;

  const maRes = await api('/mitarbeiter', token);
  const allMitarbeiter = maRes.data || maRes;

  const ftRes = await api('/feiertage', token);
  const feiertage = (ftRes.data || ftRes).map(f => ({ datum: f.datum?.slice(0, 10), name: f.name }));

  // IDs for navigation
  const ids = { upId: null, pId: null, apIds: [], maIds: [] };

  // Build nested ÜP structure
  const frontendUPs = [];
  const allZuweisungen = [];

  for (const up of ueberProjekte) {
    ids.upId = up.id;
    const projRes = await api(`/ueberprojekte/${up.id}/projekte`, token);
    const projekte = projRes.data || projRes;

    const frontendProjekte = [];
    for (const p of projekte) {
      ids.pId = p.id;
      const apRes = await api(`/projekte/${p.id}/arbeitspakete`, token);
      const rawAPs = apRes.data || apRes;

      // Build nested AP tree
      const topLevel = rawAPs.filter(a => !a.parentId);
      const nested = topLevel.map(ap => {
        ids.apIds.push(ap.id);
        const children = rawAPs.filter(c => c.parentId === ap.id).map(c => ({
          id: c.id, name: c.name, beschreibung: c.beschreibung || '',
          status: c.status || 'offen',
          startDatum: c.startDatum?.slice(0, 10) || '', endDatum: c.endDatum?.slice(0, 10) || '',
        }));
        return {
          id: ap.id, name: ap.name, beschreibung: ap.beschreibung || '',
          status: ap.status || 'offen',
          startDatum: ap.startDatum?.slice(0, 10) || '', endDatum: ap.endDatum?.slice(0, 10) || '',
          unterPakete: children.length > 0 ? children : undefined,
        };
      });

      // Fetch zuweisungen
      const zwRes = await api(`/projekte/${p.id}/zuweisungen`, token);
      const zuweisungen = zwRes.data || zwRes;
      for (const zw of zuweisungen) {
        let apVert = [];
        try {
          const avRes = await api(`/zuweisungen/${zw.id}/ap-verteilung`, token);
          apVert = (avRes.data || avRes || []).map(av => ({
            arbeitspaketId: av.arbeitspaketId, prozent: av.prozentAnteil || av.prozent,
          }));
        } catch { }

        allZuweisungen.push({
          id: zw.id, mitarbeiterId: zw.mitarbeiterId, projektId: p.id, ueberProjektId: up.id,
          prozentAnteil: zw.prozentAnteil,
          von: zw.von?.slice(0, 10) || '', bis: zw.bis?.slice(0, 10) || '',
          arbeitspaketVerteilung: apVert,
        });
      }

      frontendProjekte.push({
        id: p.id, name: p.name, beschreibung: p.beschreibung || '',
        status: p.status || 'aktiv',
        startDatum: p.startDatum?.slice(0, 10) || '', endDatum: p.endDatum?.slice(0, 10) || '',
        budget: p.budget || undefined, arbeitspakete: nested,
      });
    }

    frontendUPs.push({
      id: up.id, name: up.name, beschreibung: up.beschreibung || '',
      unternehmensTyp: up.unternehmensTyp || 'kmu', projekte: frontendProjekte,
    });
  }

  // Build mitarbeiter with blockierungen
  const frontendMA = [];
  for (const ma of allMitarbeiter) {
    ids.maIds.push(ma.id);
    let blockierungen = [];
    try {
      const bRes = await api(`/mitarbeiter/${ma.id}/blockierungen`, token);
      blockierungen = (bRes.data || bRes || []).map(b => ({
        id: b.id, typ: b.typ,
        von: b.von?.slice(0, 10) || '', bis: b.bis?.slice(0, 10) || '', notiz: b.notiz || '',
      }));
    } catch { }

    frontendMA.push({
      id: ma.id, name: ma.name, position: ma.position || '',
      wochenStunden: ma.wochenStunden || 40, jahresUrlaub: ma.jahresUrlaub || 30,
      feiertagePflicht: true, gehalt: ma.jahresgehalt || 0, lohnnebenkosten: ma.lohnnebenkosten || 0,
      blockierungen,
    });
  }

  const data = {
    ueberProjekte: frontendUPs, mitarbeiter: frontendMA, zuweisungen: allZuweisungen,
    feiertage, exportLog: [], exportCounter: 0, aenderungsLog: [],
  };

  return { data, ids };
}

// ─── Main ─────────────────────────────────────────────────────────
(async () => {
  console.log('Fetching data from backend...');
  const { data: localStorageData, ids } = await buildLocalStorageData();
  console.log(`\nData: ${localStorageData.ueberProjekte.length} companies, ${localStorageData.mitarbeiter.length} workers, ${localStorageData.zuweisungen.length} assignments, ${localStorageData.feiertage.length} holidays`);
  console.log(`IDs: upId=${ids.upId?.slice(0,8)}…, pId=${ids.pId?.slice(0,8)}…, ${ids.apIds.length} APs, ${ids.maIds.length} MAs`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  // Load page to set up localStorage
  console.log('\nLoading frontend...');
  await page.goto(FRONTEND, { waitUntil: 'networkidle2', timeout: 30000 });

  // Inject data + bypass login
  await page.evaluate((dataJSON) => {
    localStorage.setItem('novarix_data', dataJSON);
    sessionStorage.setItem('novarix_session', 'active');
  }, JSON.stringify(localStorageData));

  // Reload to pick up data
  await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));

  // Helper: navigate via Router and wait
  async function nav(hash, label) {
    await page.evaluate((h) => {
      window.location.hash = h;
      if (typeof Router !== 'undefined' && Router.resolve) Router.resolve();
    }, hash);
    await new Promise(r => setTimeout(r, 2000));
    console.log(`  Navigated to: ${label}`);
  }

  // ── 01: Dashboard ──
  await nav('#/dashboard', 'Dashboard');
  await page.screenshot({ path: join(dir, 'testdata-01-dashboard.png') });
  console.log('  Screenshot: dashboard');

  // ── 02: Company detail (Über-Projekt) ──
  await nav(`#/ueberprojekt/${ids.upId}`, 'Über-Projekt: TechNova');
  await page.screenshot({ path: join(dir, 'testdata-02-company.png') });
  console.log('  Screenshot: company detail');

  // ── 03: Project detail ──
  await nav(`#/projekt/${ids.upId}/${ids.pId}`, 'Projekt: CloudPilot');
  await page.screenshot({ path: join(dir, 'testdata-03-project.png') });
  console.log('  Screenshot: project detail');

  // ── 04: Projekt-Kalender (timeline/plan) ──
  await nav(`#/projekt-kalender/${ids.upId}/${ids.pId}`, 'Projekt-Kalender');
  await page.screenshot({ path: join(dir, 'testdata-04-plan.png'), fullPage: true });
  console.log('  Screenshot: plan/timeline');

  // ── 05: Mitarbeiter list ──
  await nav('#/mitarbeiter', 'Mitarbeiter');
  await page.screenshot({ path: join(dir, 'testdata-05-mitarbeiter.png') });
  console.log('  Screenshot: mitarbeiter list');

  // ── 06: Mitarbeiter calendar (first worker) ──
  if (ids.maIds.length > 0) {
    await nav(`#/mitarbeiter-kalender/${ids.maIds[0]}`, 'Mitarbeiter-Kalender');
    await page.screenshot({ path: join(dir, 'testdata-06-ma-kalender.png'), fullPage: true });
    console.log('  Screenshot: mitarbeiter calendar');
  }

  // ── 07: AP-Kalender (first AP) ──
  if (ids.apIds.length > 0) {
    await nav(`#/ap-kalender/${ids.upId}/${ids.pId}/${ids.apIds[0]}`, 'AP-Kalender');
    await page.screenshot({ path: join(dir, 'testdata-07-ap-kalender.png'), fullPage: true });
    console.log('  Screenshot: AP calendar');
  }

  // ── 08: Back to project, click Zuweisungen tab ──
  await nav(`#/projekt/${ids.upId}/${ids.pId}`, 'Projekt (Zuweisungen)');
  await new Promise(r => setTimeout(r, 1000));
  // Click Zuweisungen tab
  const clickedZuw = await page.evaluate(() => {
    const tabs = document.querySelectorAll('button, [role="tab"]');
    for (const t of tabs) {
      if (t.textContent.trim().includes('Zuweisungen') && t.offsetParent !== null) {
        t.click();
        return true;
      }
    }
    return false;
  });
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: join(dir, 'testdata-08-zuweisungen.png'), fullPage: true });
  console.log(`  Screenshot: zuweisungen (tab clicked: ${clickedZuw})`);

  // ── 09: Kosten tab ──
  const clickedKosten = await page.evaluate(() => {
    const tabs = document.querySelectorAll('button, [role="tab"]');
    for (const t of tabs) {
      if (t.textContent.trim().includes('Kosten') && t.offsetParent !== null) {
        t.click();
        return true;
      }
    }
    return false;
  });
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: join(dir, 'testdata-09-kosten.png'), fullPage: true });
  console.log(`  Screenshot: kosten (tab clicked: ${clickedKosten})`);

  // ── 10: Feiertage ──
  await nav('#/feiertage', 'Feiertage');
  await page.screenshot({ path: join(dir, 'testdata-10-feiertage.png') });
  console.log('  Screenshot: feiertage');

  console.log('\nDone! All screenshots saved to "temporary screenshots/"');
  await browser.close();
})();
