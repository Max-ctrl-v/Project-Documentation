import { writeFileSync } from 'fs';

const BASE = process.env.NOVARIX_API || 'https://novarix-backend-production.up.railway.app/api/v1';
const EMAIL = process.env.NOVARIX_EMAIL;
const PW = process.env.NOVARIX_PASSWORD;
if (!EMAIL || !PW) { console.error('Set NOVARIX_EMAIL and NOVARIX_PASSWORD env vars'); process.exit(1); }

const login = await fetch(BASE + '/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PW }),
}).then(r => r.json());

const backup = await fetch(BASE + '/backup/export', {
  headers: { Authorization: 'Bearer ' + login.accessToken },
}).then(r => r.json());

const d = backup.data;

const ueberProjekte = (d.ueberProjekte || []).map(up => {
  const projekte = (d.projekte || []).filter(p => p.ueberProjektId === up.id).map(p => {
    const rawAPs = (d.arbeitspakete || []).filter(a => a.projektId === p.id);
    const topLevel = rawAPs.filter(a => !a.parentId);
    const arbeitspakete = topLevel.map(ap => {
      const children = rawAPs.filter(c => c.parentId === ap.id).map(c => ({
        id: c.id, name: c.name, beschreibung: c.beschreibung || '',
        status: c.status || 'offen',
        startDatum: (c.startDatum || '').slice(0, 10),
        endDatum: (c.endDatum || '').slice(0, 10),
      }));
      return {
        id: ap.id, name: ap.name, beschreibung: ap.beschreibung || '',
        status: ap.status || 'offen',
        startDatum: (ap.startDatum || '').slice(0, 10),
        endDatum: (ap.endDatum || '').slice(0, 10),
        ...(children.length > 0 ? { unterPakete: children } : {}),
      };
    });
    return {
      id: p.id, name: p.name, beschreibung: p.beschreibung || '',
      status: p.status || 'aktiv',
      startDatum: (p.startDatum || '').slice(0, 10),
      endDatum: (p.endDatum || '').slice(0, 10),
      budget: p.budget || undefined,
      arbeitspakete,
    };
  });
  return {
    id: up.id, name: up.name, beschreibung: up.beschreibung || '',
    unternehmensTyp: up.unternehmensTyp || 'kmu',
    projekte,
  };
});

const mitarbeiter = (d.mitarbeiter || []).map(ma => {
  const blockierungen = (d.blockierungen || []).filter(b => b.mitarbeiterId === ma.id).map(b => ({
    id: b.id, typ: b.typ,
    von: (b.von || '').slice(0, 10), bis: (b.bis || '').slice(0, 10), notiz: b.notiz || '',
  }));
  return {
    id: ma.id, name: ma.name, position: ma.position || '',
    wochenStunden: ma.wochenStunden || 40, jahresUrlaub: ma.jahresUrlaub || 30,
    feiertagePflicht: ma.feiertagePflicht !== false,
    gehalt: ma.jahresgehalt || 0, lohnnebenkosten: ma.lohnnebenkosten || 0,
    blockierungen,
  };
});

const zuweisungen = (d.zuweisungen || []).map(zw => {
  const apVert = (d.apVerteilungen || []).filter(av => av.zuweisungId === zw.id).map(av => ({
    arbeitspaketId: av.arbeitspaketId, prozent: av.prozentAnteil || av.prozent,
  }));
  return {
    id: zw.id, mitarbeiterId: zw.mitarbeiterId,
    projektId: zw.projektId, ueberProjektId: zw.ueberProjektId,
    prozentAnteil: zw.prozentAnteil,
    von: (zw.von || '').slice(0, 10), bis: (zw.bis || '').slice(0, 10),
    arbeitspaketVerteilung: apVert,
  };
});

const feiertage = (d.feiertage || []).map(f => ({
  datum: (f.datum || '').slice(0, 10), name: f.name,
}));

const result = {
  ueberProjekte, mitarbeiter, zuweisungen, feiertage,
  exportLog: [], exportCounter: 0, aenderungsLog: [],
};

writeFileSync('seed-data.json', JSON.stringify(result));
console.log('seed-data.json written:', JSON.stringify(result).length, 'bytes');
console.log(ueberProjekte.length, 'companies,', mitarbeiter.length, 'workers,', zuweisungen.length, 'assignments');
