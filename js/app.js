    // =========================================================================
    // AuthSystem — Login / Session / Password Reset
    // =========================================================================
    const AuthSystem = {
      _sessionKey: 'novarix_session',

      _hasBackend() {
        return typeof AuthAPI !== 'undefined' && typeof apiFetch === 'function';
      },

      getCurrentUser() {
        try {
          const raw = sessionStorage.getItem(this._sessionKey);
          if (!raw || raw === 'active') return null;
          return JSON.parse(raw);
        } catch { return null; }
      },

      isAdmin() {
        const user = this.getCurrentUser();
        return user && user.role === 'admin';
      },

      async init() {
        // Try auto-login via HttpOnly refresh cookie
        if (this._hasBackend()) {
          try {
            const ok = await refreshTokens();
            if (ok) {
              const me = await AuthAPI.me();
              sessionStorage.setItem(this._sessionKey, JSON.stringify({
                email: me.email, name: me.name, role: me.role,
              }));
              try { await this._syncFromBackend(); } catch (syncErr) {
                console.warn('Daten-Sync fehlgeschlagen:', syncErr.message);
              }
              this._showApp();
              this._updateSidebarUser();
              Router.init();
              return;
            }
          } catch (e) {
            console.warn('Auto-login fehlgeschlagen:', e.message);
          }
          // Auto-login failed — clear state so login form works fresh
          TokenManager.clear();
          sessionStorage.removeItem(this._sessionKey);
        }

        // Pre-load seed data on first visit
        await this._loadSeedIfEmpty();

        // Check for password reset token in URL
        const hashStr = window.location.hash || '';
        if (hashStr.startsWith('#/reset-password')) {
          const params = new URLSearchParams(hashStr.split('?')[1] || '');
          const token = params.get('token');
          if (token) {
            this._showLogin();
            this.showReset();
            this._resetStep = 'newpw';
            this._resetToken = token;
            document.getElementById('reset-email').parentElement.style.display = 'none';
            document.getElementById('reset-new-pw').style.display = 'block';
            return;
          }
        }

        // Check session
        const user = this.getCurrentUser();
        if (user) {
          this._showApp();
          this._updateSidebarUser();
          Router.init();
        } else {
          this._showLogin();
        }
      },

      _showApp() {
        document.getElementById('login-overlay').style.display = 'none';
        document.getElementById('app').style.display = 'flex';
      },

      _showLogin() {
        document.getElementById('login-overlay').style.display = 'flex';
        document.getElementById('app').style.display = 'none';
        // Auto-focus email field after animation
        setTimeout(() => {
          const emailInput = document.getElementById('login-email');
          if (emailInput) emailInput.focus();
        }, 100);
      },

      _updateSidebarUser() {
        const row = document.getElementById('sidebar-user-row');
        const infoEl = document.getElementById('sidebar-user-info');
        const avatarEl = document.getElementById('sidebar-user-avatar');
        const user = this.getCurrentUser();
        if (row && infoEl && user) {
          const initials = (user.name || user.email || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
          avatarEl.textContent = initials;
          infoEl.textContent = `${user.name} (${user.role === 'admin' ? 'Admin' : 'Benutzer'})`;
          row.style.display = 'flex';
        }
        // Admin-only sidebar links
        const spLink = document.getElementById('sidebar-sitzungsprotokoll');
        if (spLink) spLink.style.display = (user && user.role === 'admin') ? 'flex' : 'none';
      },

      showLogin() {
        document.getElementById('login-form').style.display = 'block';
        document.getElementById('reset-form').style.display = 'none';
        document.getElementById('login-error').style.display = 'none';
      },

      showReset() {
        document.getElementById('login-form').style.display = 'none';
        document.getElementById('reset-form').style.display = 'block';
        document.getElementById('reset-message').style.display = 'none';
        document.getElementById('reset-new-pw').style.display = 'none';
        document.getElementById('reset-email').value = '';
        document.getElementById('reset-new-password').value = '';
        this._resetStep = 'email';
      },

      _resetStep: 'email',

      async handleLogin() {
        const email = document.getElementById('login-email').value.trim().toLowerCase();
        const password = document.getElementById('login-password').value;
        const errorEl = document.getElementById('login-error');
        const loginBtn = document.getElementById('login-btn');

        if (!email || !password) {
          errorEl.textContent = 'Bitte E-Mail und Passwort eingeben.';
          errorEl.style.display = 'block';
          return;
        }

        if (loginBtn) { loginBtn.disabled = true; loginBtn.textContent = 'Anmelden...'; }
        errorEl.style.display = 'none';

        // ── Try backend login first ──
        if (this._hasBackend()) {
          try {
            const user = await AuthAPI.login(email, password);
            // Backend login successful — store session
            sessionStorage.setItem(this._sessionKey, JSON.stringify({
              email: user.email, name: user.name, role: user.role,
            }));
            // Sync data from backend (non-fatal — login still succeeds)
            try { await this._syncFromBackend(); } catch (syncErr) {
              console.warn('Daten-Sync fehlgeschlagen, nutze lokale Daten:', syncErr.message);
              await this._loadSeedIfEmpty();
            }
            if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = 'Anmelden'; }
            this._showApp();
            this._updateSidebarUser();
            Router.init();
            return;
          } catch (e) {
            // Auth error (wrong credentials, rate limited, etc.) — show message
            if (e.status && e.status !== 0) {
              if (e.status === 429) {
                errorEl.textContent = 'Zu viele Login-Versuche. Bitte warten Sie einige Minuten.';
              } else {
                errorEl.textContent = e.message || 'E-Mail oder Passwort ist falsch.';
              }
              errorEl.style.display = 'block';
              document.getElementById('login-password').value = '';
              if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = 'Anmelden'; }
              return;
            }
            // Network error (no status) — fall through to seed data
            console.warn('Backend nicht erreichbar, nutze lokale Daten:', e.message);
          }
        }

        // ── Fallback: load seed data and allow access (offline mode) ──
        await this._loadSeedIfEmpty();
        sessionStorage.setItem(this._sessionKey, JSON.stringify({
          email, name: email.split('@')[0], role: 'viewer',
        }));

        if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = 'Anmelden'; }
        this._showApp();
        this._updateSidebarUser();
        Router.init();
      },

      // ── Load seed data from static JSON if localStorage is empty ──
      async _loadSeedIfEmpty() {
        try {
          const existing = localStorage.getItem('novarix_data');
          if (existing) {
            const parsed = JSON.parse(existing);
            if (parsed.ueberProjekte && parsed.ueberProjekte.length > 0) return; // already has data
          }
          const res = await fetch('/seed-data.json');
          if (!res.ok) return;
          const seed = await res.json();
          if (seed && seed.ueberProjekte && seed.ueberProjekte.length > 0) {
            localStorage.setItem('novarix_data', JSON.stringify(seed));
            console.log('Seed-Daten geladen:', seed.ueberProjekte.length, 'Firmen');
          }
        } catch (e) {
          console.warn('Seed-Daten nicht verfügbar:', e.message);
        }
      },

      // ── Sync: Backend-Daten → localStorage ──
      async _syncFromBackend() {
        try {
          const backup = await apiFetch('/backup/export');
          const d = backup.data || backup;

          // Transform flat relational data → nested localStorage format
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
                  ...(children.length > 0 ? { unterArbeitspakete: children } : {}),
                };
              });
              return {
                id: p.id, name: p.name, beschreibung: p.beschreibung || '',
                status: p.status || 'aktiv',
                startDatum: (p.startDatum || '').slice(0, 10),
                endDatum: (p.endDatum || '').slice(0, 10),
                budget: p.budget ? Number(p.budget) : undefined,
                sollKosten: (p.sollKosten || p.budget) ? Number(p.sollKosten || p.budget) : undefined,
                arbeitspakete,
              };
            });
            return {
              id: up.id, name: up.name, beschreibung: up.beschreibung || '',
              unternehmensTyp: up.unternehmensTyp || 'kmu',
              nurAdmin: up.nurAdmin || false,
              projekte,
            };
          });

          const mitarbeiter = (d.mitarbeiter || []).map(ma => {
            const blockierungen = (d.blockierungen || []).filter(b => b.mitarbeiterId === ma.id).map(b => ({
              id: b.id, typ: b.typ,
              von: (b.von || '').slice(0, 10),
              bis: (b.bis || '').slice(0, 10),
              notiz: b.notiz || '',
            }));
            return {
              id: ma.id, name: ma.name, position: ma.position || '',
              wochenStunden: Number(ma.wochenStunden) || 40, jahresUrlaub: Number(ma.jahresUrlaub) || 30,
              feiertagePflicht: ma.feiertagePflicht !== false,
              jahresgehalt: Number(ma.jahresgehalt) || 0, lohnnebenkosten: Number(ma.lohnnebenkosten) || 0,
              blockierungen,
            };
          });

          const zuweisungen = (d.zuweisungen || []).map(zw => {
            const apVert = (d.apVerteilungen || []).filter(av => av.zuweisungId === zw.id).map(av => ({
              arbeitspaketId: av.arbeitspaketId,
              prozentAnteil: av.prozentAnteil != null ? Number(av.prozentAnteil) : Number(av.prozent || 0),
            }));
            return {
              id: zw.id, mitarbeiterId: zw.mitarbeiterId,
              projektId: zw.projektId, ueberProjektId: zw.ueberProjektId,
              prozentAnteil: Number(zw.prozentAnteil) || 0,
              von: (zw.von || '').slice(0, 10),
              bis: (zw.bis || '').slice(0, 10),
              arbeitspaketVerteilung: apVert,
            };
          });

          const feiertage = (d.feiertage || []).map(f => ({
            datum: (f.datum || '').slice(0, 10), name: f.name,
          }));

          const localData = {
            ueberProjekte, mitarbeiter, zuweisungen, feiertage,
            exportLog: d.exportLog || [],
            exportCounter: Array.isArray(d.exportCounter) ? (d.exportCounter[0]?.count || 0) : (d.exportCounter || 0),
            aenderungsLog: (d.aenderungsLog || []).slice(0, 500).map(l => ({
              id: l.id, zeitpunkt: l.zeitpunkt, aktion: l.aktion,
              entitaet: l.entitaet, entitaetId: l.entitaetId,
              name: l.name || '', details: l.details || '',
              vorherJson: l.vorherJson || null,
              nachherJson: l.nachherJson || null,
            })),
          };

          localStorage.setItem('novarix_data', JSON.stringify(localData));
          console.log('Sync OK:', ueberProjekte.length, 'Firmen,', mitarbeiter.length, 'MA,', zuweisungen.length, 'Zuweisungen');
        } catch (e) {
          console.warn('Backend-Sync fehlgeschlagen:', e.message);
        }
      },

      async handleReset() {
        const msgEl = document.getElementById('reset-message');

        if (this._resetStep === 'email') {
          const email = document.getElementById('reset-email').value.trim().toLowerCase();
          if (!email) {
            msgEl.style.display = 'block'; msgEl.style.background = '#FEF2F2'; msgEl.style.border = '1px solid #FECACA'; msgEl.style.color = '#DC2626';
            msgEl.textContent = 'Bitte E-Mail eingeben.';
            return;
          }
          try {
            await AuthAPI.forgotPassword(email);
          } catch { /* always show success to prevent enumeration */ }
          msgEl.style.display = 'block'; msgEl.style.background = '#F0FDF4'; msgEl.style.border = '1px solid #BBF7D0'; msgEl.style.color = '#166534';
          msgEl.textContent = 'Wenn ein Konto mit dieser E-Mail existiert, wurde ein Reset-Link gesendet.';
        } else if (this._resetStep === 'newpw') {
          const pw = document.getElementById('reset-new-password').value;
          if (!pw || pw.length < 8) {
            msgEl.style.display = 'block'; msgEl.style.background = '#FEF2F2'; msgEl.style.border = '1px solid #FECACA'; msgEl.style.color = '#DC2626';
            msgEl.textContent = 'Passwort muss mindestens 8 Zeichen haben.';
            return;
          }
          try {
            await AuthAPI.resetPassword(this._resetToken, pw);
            msgEl.style.display = 'block'; msgEl.style.background = '#F0FDF4'; msgEl.style.border = '1px solid #BBF7D0'; msgEl.style.color = '#166534';
            msgEl.textContent = 'Passwort erfolgreich zurückgesetzt. Sie werden zum Login weitergeleitet...';
            setTimeout(() => { window.location.hash = ''; this.showLogin(); }, 2000);
          } catch (e) {
            msgEl.style.display = 'block'; msgEl.style.background = '#FEF2F2'; msgEl.style.border = '1px solid #FECACA'; msgEl.style.color = '#DC2626';
            msgEl.textContent = e.message || 'Ungültiger oder abgelaufener Reset-Token.';
          }
        }
      },

      logout() {
        sessionStorage.removeItem(this._sessionKey);
        if (this._hasBackend()) AuthAPI.logout().catch(() => {});
        this._showLogin();
        document.getElementById('login-email').value = '';
        document.getElementById('login-password').value = '';
        document.getElementById('login-error').style.display = 'none';
        const el = document.getElementById('sidebar-user-info');
        if (el) el.style.display = 'none';
      }
    };

    // Enter key triggers login/reset
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && document.getElementById('login-overlay').style.display === 'flex') {
        if (document.getElementById('login-form').style.display !== 'none') {
          AuthSystem.handleLogin();
        } else {
          AuthSystem.handleReset();
        }
      }
    });

    // =========================================================================
    // DataStore — localStorage abstraction
    // =========================================================================
    const DataStore = {
      _key: 'novarix_data',

      _defaults() {
        return {
          ueberProjekte: [],
          mitarbeiter: [],
          zuweisungen: [],
          feiertage: [],
          exportLog: [],
          exportCounter: 0,
          aenderungsLog: [],
        };
      },

      _read() {
        try {
          const raw = localStorage.getItem(this._key);
          if (!raw) return this._defaults();
          const data = JSON.parse(raw);
          // Ensure all keys exist (migration-safe)
          const defaults = this._defaults();
          for (const k of Object.keys(defaults)) {
            if (!(k in data)) data[k] = defaults[k];
          }
          return data;
        } catch {
          return this._defaults();
        }
      },

      _write(data) {
        try {
          localStorage.setItem(this._key, JSON.stringify(data));
        } catch (e) {
          console.error('DataStore write failed:', e);
          alert('Fehler beim Speichern: Speicher voll oder blockiert. Bitte erstelle ein Backup.');
        }
      },

      // Fire-and-forget backend sync — keeps DB in sync with localStorage edits
      _pushToBackend(fn) {
        if (!window.DataStoreAPI || !window.TokenManager?.getToken()) return;
        fn().catch(e => console.warn('Backend-Sync fehlgeschlagen:', e.message));
      },

      getAll() { return this._read(); },

      // Über-Projekte
      getUeberProjekte() { return this._read().ueberProjekte; },
      getUeberProjekt(id) { return this.getUeberProjekte().find(u => u.id === id) || null; },
      saveUeberProjekt(up) {
        const data = this._read();
        const idx = data.ueberProjekte.findIndex(u => u.id === up.id);
        const isNew = idx < 0;
        if (idx >= 0) data.ueberProjekte[idx] = up;
        else data.ueberProjekte.push(up);
        this.logChange(isNew ? 'erstellt' : 'geändert', 'Firma', up.id, up.name, undefined, data);
        this._pushToBackend(() => DataStoreAPI.saveUeberProjekt(isNew ? { ...up, _isNew: true } : up));
      },
      deleteUeberProjekt(id) {
        const data = this._read();
        const up = data.ueberProjekte.find(u => u.id === id);
        if (up) {
          const projektIds = (up.projekte || []).map(p => p.id);
          data.zuweisungen = data.zuweisungen.filter(z => z.ueberProjektId !== id);
          data.ueberProjekte = data.ueberProjekte.filter(u => u.id !== id);
          this.logChange('gelöscht', 'Firma', id, up.name, undefined, data);
        } else {
          this._write(data);
        }
        this._pushToBackend(() => DataStoreAPI.deleteUeberProjekt(id));
      },

      // Projekte (nested in ÜP)
      getProjekt(ueberProjektId, projektId) {
        const up = this.getUeberProjekt(ueberProjektId);
        if (!up) return null;
        return (up.projekte || []).find(p => p.id === projektId) || null;
      },
      findProjektWithParent(projektId) {
        const ups = this.getUeberProjekte();
        for (const up of ups) {
          const p = (up.projekte || []).find(p => p.id === projektId);
          if (p) return { ueberProjekt: up, projekt: p };
        }
        return null;
      },
      saveProjekt(ueberProjektId, projekt) {
        const up = this.getUeberProjekt(ueberProjektId);
        if (!up) return;
        if (!up.projekte) up.projekte = [];
        const idx = up.projekte.findIndex(p => p.id === projekt.id);
        const isNew = idx < 0;
        if (idx >= 0) up.projekte[idx] = projekt;
        else up.projekte.push(projekt);
        // Save without triggering ÜP log (direct write)
        const data = this._read();
        const uidx = data.ueberProjekte.findIndex(u => u.id === up.id);
        if (uidx >= 0) data.ueberProjekte[uidx] = up;
        this.logChange(isNew ? 'erstellt' : 'geändert', 'Projekt', projekt.id, projekt.name, `in ${up.name}`, data);
        this._pushToBackend(() => DataStoreAPI.saveProjekt(ueberProjektId, isNew ? { ...projekt, _isNew: true } : projekt));
      },
      deleteProjekt(ueberProjektId, projektId) {
        const data = this._read();
        const up = data.ueberProjekte.find(u => u.id === ueberProjektId);
        let pName = projektId;
        if (up) {
          const p = (up.projekte || []).find(p => p.id === projektId);
          if (p) pName = p.name;
          up.projekte = (up.projekte || []).filter(p => p.id !== projektId);
          data.zuweisungen = data.zuweisungen.filter(z => z.projektId !== projektId);
        }
        this.logChange('gelöscht', 'Projekt', projektId, pName, up ? `aus ${up.name}` : '', data);
        this._pushToBackend(() => DataStoreAPI.deleteProjekt(ueberProjektId, projektId));
      },

      // Mitarbeiter
      getMitarbeiter() { return this._read().mitarbeiter; },
      getMitarbeiterById(id) { return this.getMitarbeiter().find(m => m.id === id) || null; },
      saveMitarbeiter(ma) {
        const data = this._read();
        const idx = data.mitarbeiter.findIndex(m => m.id === ma.id);
        const isNew = idx < 0;
        if (idx >= 0) data.mitarbeiter[idx] = ma;
        else data.mitarbeiter.push(ma);
        this.logChange(isNew ? 'erstellt' : 'geändert', 'Mitarbeiter', ma.id, ma.name, undefined, data);
        this._pushToBackend(() => DataStoreAPI.saveMitarbeiter(isNew ? { ...ma, _isNew: true } : ma));
      },
      deleteMitarbeiter(id) {
        const data = this._read();
        const ma = data.mitarbeiter.find(m => m.id === id);
        data.mitarbeiter = data.mitarbeiter.filter(m => m.id !== id);
        data.zuweisungen = data.zuweisungen.filter(z => z.mitarbeiterId !== id);
        if (ma) {
          this.logChange('gelöscht', 'Mitarbeiter', id, ma.name, undefined, data);
        } else {
          this._write(data);
        }
        this._pushToBackend(() => DataStoreAPI.deleteMitarbeiter(id));
      },

      // Zuweisungen
      getZuweisungen() { return this._read().zuweisungen; },
      getZuweisung(id) { return this.getZuweisungen().find(z => z.id === id) || null; },
      getZuweisungenForProjekt(projektId) { return this.getZuweisungen().filter(z => z.projektId === projektId); },
      getZuweisungenForMitarbeiter(maId) { return this.getZuweisungen().filter(z => z.mitarbeiterId === maId); },
      saveZuweisung(zw) {
        const data = this._read();
        const idx = data.zuweisungen.findIndex(z => z.id === zw.id);
        const isNew = idx < 0;
        if (idx >= 0) data.zuweisungen[idx] = zw;
        else data.zuweisungen.push(zw);
        const ma = (data.mitarbeiter || []).find(m => m.id === zw.mitarbeiterId);
        this.logChange(isNew ? 'erstellt' : 'geändert', 'Zuweisung', zw.id, ma ? ma.name : 'Unbekannt', `${zw.prozentAnteil}%, ${zw.von} – ${zw.bis}`, data);
        this._pushToBackend(() => DataStoreAPI.saveZuweisung(zw.projektId, isNew ? { ...zw, _isNew: true } : zw));
      },
      deleteZuweisung(id) {
        const data = this._read();
        const zw = data.zuweisungen.find(z => z.id === id);
        data.zuweisungen = data.zuweisungen.filter(z => z.id !== id);
        if (zw) {
          const ma = (data.mitarbeiter || []).find(m => m.id === zw.mitarbeiterId);
          this.logChange('gelöscht', 'Zuweisung', id, ma ? ma.name : 'Unbekannt', undefined, data);
        } else {
          this._write(data);
        }
        this._pushToBackend(() => DataStoreAPI.deleteZuweisung(id));
      },

      // Feiertage
      getFeiertage() { return this._read().feiertage; },
      saveFeiertage(list) {
        const data = this._read();
        data.feiertage = list;
        this._write(data);
      },
      addFeiertag(ft) {
        const data = this._read();
        data.feiertage.push(ft);
        this._write(data);
        this._pushToBackend(() => DataStoreAPI.addFeiertag(ft));
      },
      deleteFeiertag(datum) {
        const data = this._read();
        const ft = data.feiertage.find(f => f.datum === datum);
        data.feiertage = data.feiertage.filter(f => f.datum !== datum);
        this._write(data);
        if (ft && ft.id) this._pushToBackend(() => DataStoreAPI.deleteFeiertag(ft.id));
      },

      // Externe Entwicklungen (nested in Projekt)
      getExterneEntwicklungen(ueberProjektId, projektId) {
        const p = this.getProjekt(ueberProjektId, projektId);
        return p ? (p.externeEntwicklungen || []) : [];
      },
      saveExterneEntwicklung(ueberProjektId, projektId, entry) {
        const up = this.getUeberProjekt(ueberProjektId);
        if (!up) return;
        const p = (up.projekte || []).find(pr => pr.id === projektId);
        if (!p) return;
        if (!p.externeEntwicklungen) p.externeEntwicklungen = [];
        const idx = p.externeEntwicklungen.findIndex(e => e.id === entry.id);
        const isNew = idx < 0;
        if (idx >= 0) p.externeEntwicklungen[idx] = entry;
        else p.externeEntwicklungen.push(entry);
        const data = this._read();
        const uidx = data.ueberProjekte.findIndex(u => u.id === up.id);
        if (uidx >= 0) {
          const pidx = (data.ueberProjekte[uidx].projekte || []).findIndex(pr => pr.id === projektId);
          if (pidx >= 0) data.ueberProjekte[uidx].projekte[pidx] = p;
        }
        this.logChange(isNew ? 'erstellt' : 'geändert', 'Externe Entwicklung', entry.id, entry.name, undefined, data);
      },
      deleteExterneEntwicklung(ueberProjektId, projektId, entryId) {
        const data = this._read();
        const up = data.ueberProjekte.find(u => u.id === ueberProjektId);
        if (!up) return;
        const p = (up.projekte || []).find(pr => pr.id === projektId);
        if (!p || !p.externeEntwicklungen) return;
        const entry = p.externeEntwicklungen.find(e => e.id === entryId);
        p.externeEntwicklungen = p.externeEntwicklungen.filter(e => e.id !== entryId);
        if (entry) {
          this.logChange('gelöscht', 'Externe Entwicklung', entryId, entry.name, undefined, data);
        } else {
          this._write(data);
        }
      },

      // Export log
      getExportLog() { return this._read().exportLog; },
      addExportEntry(entry) {
        const data = this._read();
        data.exportLog.push(entry);
        this._write(data);
      },
      nextDokumentNummer() {
        const data = this._read();
        data.exportCounter = (data.exportCounter || 0) + 1;
        const year = new Date().getFullYear();
        const nr = String(data.exportCounter).padStart(4, '0');
        this._write(data);
        return `CLX-${year}-${nr}`;
      },

      // Änderungsprotokoll (GoBD)
      getAenderungsLog() { return this._read().aenderungsLog || []; },
      logChange(aktion, entitaet, entitaetId, name, details, _data) {
        const data = _data || this._read();
        if (!data.aenderungsLog) data.aenderungsLog = [];
        data.aenderungsLog.push({
          id: crypto.randomUUID(),
          zeitpunkt: new Date().toISOString(),
          aktion, entitaet, entitaetId, name,
          details: details || ''
        });
        this._write(data);
      },

      // Check if record was previously exported (GoBD)
      getExportsForRecord(referenzId) {
        return (this._read().exportLog || []).filter(e => e.referenzId === referenzId);
      },

      // SHA-256 hash for data integrity (GoBD)
      async hashData(str) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
        return 'H' + Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase().slice(0, 16);
      },

      // Full export / import
      exportJSON() { return JSON.stringify(this._read(), null, 2); },
      importJSON(jsonString) {
        const parsed = JSON.parse(jsonString);
        const defaults = this._defaults();
        for (const k of Object.keys(defaults)) {
          if (!(k in parsed)) parsed[k] = defaults[k];
        }
        this._write(parsed);
      },
    };

    // =========================================================================
    // CalcEngine — date/workday/percentage calculations
    // =========================================================================
    const CalcEngine = {
      isWeekday(date) {
        const d = date.getDay();
        return d !== 0 && d !== 6;
      },

      countWeekdays(von, bis) {
        const start = new Date(von);
        const end = new Date(bis);
        let count = 0;
        const cur = new Date(start);
        while (cur <= end) {
          if (this.isWeekday(cur)) count++;
          cur.setDate(cur.getDate() + 1);
        }
        return count;
      },

      getBlockedDays(mitarbeiterId, von, bis) {
        const ma = DataStore.getMitarbeiterById(mitarbeiterId);
        if (!ma) return 0;
        const start = new Date(von);
        const end = new Date(bis);
        const blockedDates = new Set();

        // Personal blockierungen
        for (const b of (ma.blockierungen || [])) {
          const bStart = new Date(b.von);
          const bEnd = new Date(b.bis);
          const cur = new Date(bStart);
          while (cur <= bEnd) {
            if (cur >= start && cur <= end && this.isWeekday(cur)) {
              blockedDates.add(cur.toISOString().slice(0, 10));
            }
            cur.setDate(cur.getDate() + 1);
          }
        }

        // Global Feiertage — nur wenn für diesen MA aktiviert
        if (ma.feiertagePflicht) {
          for (const ft of DataStore.getFeiertage()) {
            const d = new Date(ft.datum);
            if (d >= start && d <= end && this.isWeekday(d)) {
              blockedDates.add(ft.datum);
            }
          }
        }

        return blockedDates.size;
      },

      calculate(mitarbeiterId, projektProzent, von, bis, apVerteilung) {
        const werktage = this.countWeekdays(von, bis);
        const blockiert = this.getBlockedDays(mitarbeiterId, von, bis);
        const verfuegbar = werktage - blockiert;
        const projektTage = Math.round((verfuegbar * (projektProzent / 100)) * 10) / 10;
        const apTage = (apVerteilung || []).map(ap => ({
          arbeitspaketId: ap.arbeitspaketId,
          prozent: ap.prozentAnteil,
          tage: projektTage * (ap.prozentAnteil / 100),
        }));
        return {
          werktage,
          blockiert,
          verfuegbar,
          projektTage,
          apTage,
        };
      },

      getDailyRate(mitarbeiterId) {
        const ma = DataStore.getMitarbeiterById(mitarbeiterId);
        if (!ma) return 0;
        const totalCost = (Number(ma.jahresgehalt) || 0) + (Number(ma.lohnnebenkosten) || 0);
        if (totalCost === 0) return 0;
        // Dynamische Berechnung: Werktage = (wochenStunden/8) * 52 - jahresUrlaub - Feiertage
        const wochenTage = Number(ma.wochenStunden || 40) / 8;
        const basisTage = Math.round(wochenTage * 52);
        const urlaubsTage = ma.jahresUrlaub || 30;
        const feiertagCount = ma.feiertagePflicht ? DataStore.getFeiertage().length : 0;
        const arbeitsTage = Math.max(basisTage - urlaubsTage - feiertagCount, 1);
        return totalCost / arbeitsTage;
      },

      calculateCosts(mitarbeiterId, projektProzent, von, bis, apVerteilung) {
        const calc = this.calculate(mitarbeiterId, projektProzent, von, bis, apVerteilung);
        const dailyRate = this.getDailyRate(mitarbeiterId);
        return {
          ...calc,
          dailyRate,
          projektKosten: Math.round(calc.projektTage * dailyRate * 100) / 100,
          apKosten: calc.apTage.map(at => ({
            ...at,
            kosten: Math.round(at.tage * dailyRate * 100) / 100,
          })),
        };
      },
    };

    // =========================================================================
    // Format decimal days as "X Tage Y Stunden" (1 day = 8 hours)
    // =========================================================================
    function formatTageStunden(decimalDays) {
      if (!decimalDays || decimalDays <= 0) return '0 Tage';
      let fullDays = Math.floor(decimalDays);
      let hours = Math.round((decimalDays - fullDays) * 8);
      if (hours >= 8) { fullDays++; hours = 0; }
      const parts = [];
      if (fullDays > 0) parts.push(`${fullDays} ${fullDays === 1 ? 'Tag' : 'Tage'}`);
      if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'Stunde' : 'Stunden'}`);
      return parts.length > 0 ? parts.join(' ') : '0 Tage';
    }

    // =========================================================================
    // Urlaubsbudget
    // =========================================================================
    function getUrlaubstageBudget(mitarbeiterId, jahr) {
      const ma = DataStore.getMitarbeiterById(mitarbeiterId);
      if (!ma) return { anspruch: 0, genommen: 0, verbleibend: 0 };
      const anspruch = ma.jahresUrlaub || 30;
      const jahresStart = `${jahr}-01-01`;
      const jahresEnde = `${jahr}-12-31`;
      let genommen = 0;
      for (const b of (ma.blockierungen || [])) {
        if (b.typ !== 'urlaub') continue;
        const von = b.von > jahresStart ? b.von : jahresStart;
        const bis = b.bis < jahresEnde ? b.bis : jahresEnde;
        if (von <= bis) genommen += CalcEngine.countWeekdays(von, bis);
      }
      return { anspruch, genommen, verbleibend: anspruch - genommen };
    }

    // =========================================================================
    // Helpers
    // =========================================================================
    function el(tag, attrs, ...children) {
      const e = document.createElement(tag);
      if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
          if (k === 'style' && typeof v === 'object') {
            Object.assign(e.style, v);
          } else if (k.startsWith('on') && typeof v === 'function') {
            e.addEventListener(k.slice(2).toLowerCase(), v);
          } else if (k === 'className') {
            e.className = v;
          } else if (k === 'dataset') {
            for (const [dk, dv] of Object.entries(v)) e.dataset[dk] = dv;
          } else {
            e.setAttribute(k, v);
          }
        }
      }
      for (const c of children) {
        if (typeof c === 'string') e.appendChild(document.createTextNode(c));
        else if (c) e.appendChild(c);
      }
      return e;
    }

    // SVG trash icon helper (replaces emoji)
    function trashIcon() {
      const span = el('span', { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } });
      span.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';
      return span;
    }

    // Breadcrumb chevron separator
    function breadcrumbChevron() {
      const span = el('span', { className: 'breadcrumb-sep' });
      span.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
      return span;
    }

    function formatDate(d) {
      if (!d) return '–';
      const parts = d.split('-');
      return `${parts[2]}.${parts[1]}.${parts[0]}`;
    }

    function formatEuro(amount) {
      if (amount === 0 || amount == null) return '–';
      return amount.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }

    function statusLabel(s) {
      const map = {
        aktiv: 'Aktiv',
        abgeschlossen: 'Abgeschlossen',
        geplant: 'Geplant',
        offen: 'Offen',
        in_bearbeitung: 'In Bearbeitung',
      };
      return map[s] || s;
    }

    // --- AP Tree Helpers ---
    function flattenAPs(aps, depth, parentId) {
      depth = depth || 0; parentId = parentId || null;
      const result = [];
      for (const ap of (aps || [])) {
        result.push(Object.assign({}, ap, { _depth: depth, _parentId: parentId }));
        if (ap.unterArbeitspakete && ap.unterArbeitspakete.length > 0) {
          result.push(...flattenAPs(ap.unterArbeitspakete, depth + 1, ap.id));
        }
      }
      return result;
    }

    function findApInTree(aps, apId) {
      for (const ap of (aps || [])) {
        if (ap.id === apId) return ap;
        if (ap.unterArbeitspakete) {
          const found = findApInTree(ap.unterArbeitspakete, apId);
          if (found) return found;
        }
      }
      return null;
    }

    function removeApFromTree(aps, apId) {
      for (let i = 0; i < aps.length; i++) {
        if (aps[i].id === apId) { aps.splice(i, 1); return true; }
        if (aps[i].unterArbeitspakete && removeApFromTree(aps[i].unterArbeitspakete, apId)) return true;
      }
      return false;
    }

    // =========================================================================
    // Modal
    // =========================================================================
    function openModal(title, contentFn) {
      const root = document.getElementById('modal-root');
      const backdrop = el('div', { className: 'modal-backdrop' });
      const content = el('div', { className: 'modal-content shadow-floating' });

      const closeBtn = el('button', { className: 'modal-close-btn', onClick: () => closeModal(backdrop), 'aria-label': 'Schließen' });
      closeBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      const header = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' } },
        el('h2', { style: { fontSize: '20px', margin: '0', fontFamily: '"DM Serif Display", serif', color: '#063838' } }, title),
        closeBtn
      );
      content.appendChild(header);

      const body = el('div');
      contentFn(body, () => closeModal(backdrop));
      content.appendChild(body);

      backdrop.appendChild(content);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(backdrop); });
      function escHandler(e) {
        if (e.key === 'Escape') closeModal(backdrop);
      }
      document.addEventListener('keydown', escHandler);
      backdrop._escHandler = escHandler;
      root.appendChild(backdrop);
      requestAnimationFrame(() => backdrop.classList.add('visible'));
    }

    function closeModal(backdrop) {
      if (backdrop._escHandler) document.removeEventListener('keydown', backdrop._escHandler);
      backdrop.classList.remove('visible');
      setTimeout(() => backdrop.remove(), 200);
    }

    // =========================================================================
    // Confirm dialog
    // =========================================================================
    function confirmDialog(message, onConfirm) {
      openModal('Bestätigung', (body, close) => {
        body.appendChild(el('p', { style: { color: '#475569', marginBottom: '24px' } }, message));
        const btns = el('div', { style: { display: 'flex', gap: '12px', justifyContent: 'flex-end' } },
          el('button', { className: 'btn-secondary', onClick: close }, 'Abbrechen'),
          el('button', { className: 'btn-danger', onClick: () => { close(); onConfirm(); } }, 'Löschen')
        );
        body.appendChild(btns);
      });
    }

    // =========================================================================
    // Router
    // =========================================================================
    const Router = {
      routes: {},

      register(pattern, handler) {
        this.routes[pattern] = handler;
      },

      navigate(hash) {
        window.location.hash = hash;
      },

      resolve() {
        const hash = window.location.hash || '#/dashboard';
        const main = document.getElementById('main-content');
        main.innerHTML = '';

        // Close mobile sidebar on navigation
        const sidebar = document.querySelector('.sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        if (sidebar) sidebar.classList.remove('mobile-open');
        if (overlay) overlay.classList.remove('visible');

        // Update sidebar active state
        document.querySelectorAll('.sidebar-link').forEach(link => {
          link.classList.remove('active');
          if (hash.startsWith(link.getAttribute('href'))) {
            link.classList.add('active');
          }
        });

        // Match routes
        for (const [pattern, handler] of Object.entries(this.routes)) {
          const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, '([^/]+)') + '$');
          const match = hash.match(regex);
          if (match) {
            const params = match.slice(1);
            handler(main, ...params);
            return;
          }
        }

        // Fallback
        this.routes['#/dashboard'](main);
      },

      _initialized: false,
      init() {
        if (!this._initialized) {
          window.addEventListener('hashchange', () => this.resolve());
          this._initialized = true;
        }
        this.resolve();
      },
    };

    // =========================================================================
    // Views
    // =========================================================================

    // --- Dashboard ---
    function renderDashboard(container) {
      const allUps = DataStore.getUeberProjekte();
      const isAdmin = AuthSystem.isAdmin();
      const ups = allUps.filter(u => !u.nurAdmin || isAdmin);
      const mas = DataStore.getMitarbeiter();
      const zws = DataStore.getZuweisungen();

      // Header
      const header = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '32px' } },
        el('div', null,
          el('h1', { style: { fontSize: '28px', margin: '0', color: '#063838' } }, 'Dashboard'),
          el('p', { style: { color: '#64748B', fontSize: '14px', margin: '4px 0 0' } }, 'Übersicht aller Firmen und Statistiken')
        ),
        el('button', { className: 'btn-primary', onClick: () => openUeberProjektModal() },
          '+ Neue Firma'
        )
      );
      container.appendChild(header);

      // Stats
      const totalProjekte = ups.reduce((n, u) => n + (u.projekte || []).length, 0);
      const stats = [
        { label: 'Firmen', value: ups.length, color: '#0D7377', bg: '#F0FDFD', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0D7377" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' },
        { label: 'Projekte', value: totalProjekte, color: '#0FA8A3', bg: '#F0FDFD', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0FA8A3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>' },
        { label: 'Mitarbeiter', value: mas.length, color: '#F59E0B', bg: '#FFFBEB', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>' },
        { label: 'Zuweisungen', value: zws.length, color: '#2BC8C4', bg: '#F0FDFD', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2BC8C4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>' },
      ];
      const statsRow = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '32px' } });
      for (const s of stats) {
        const iconDiv = el('div', { className: 'stat-card-icon', style: { background: s.bg } });
        iconDiv.innerHTML = s.icon;
        statsRow.appendChild(
          el('div', { className: 'card', style: { borderTop: `3px solid ${s.color}` } },
            el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
              iconDiv,
              el('div', null,
                el('p', { style: { fontSize: '12px', fontWeight: '600', color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 2px' } }, s.label),
                el('p', { style: { fontSize: '28px', fontWeight: '700', color: '#063838', margin: '0', fontFamily: '"DM Serif Display", serif' } }, String(s.value))
              )
            )
          )
        );
      }
      container.appendChild(statsRow);

      // Über-Projekte grid
      if (ups.length === 0) {
        container.appendChild(renderEmptyState(
          'Noch keine Firmen',
          'Erstelle deine erste Firma, um Kundenprojekte zu verwalten.',
          '+ Firma erstellen',
          () => openUeberProjektModal()
        ));
      } else {
        const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '16px' } });
        for (const up of ups) {
          const pCount = (up.projekte || []).length;
          const typLabel = up.unternehmensTyp === 'grossunternehmen' ? 'Großunternehmen' : 'KMU';
          const typColor = up.unternehmensTyp === 'grossunternehmen' ? '#6366F1' : '#0D7377';
          const card = el('div', { className: 'card card-clickable', tabindex: '0', onClick: () => Router.navigate(`#/ueberprojekt/${up.id}`) },
            el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
              el('div', null,
                el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' } },
                  el('h3', { style: { fontSize: '18px', margin: '0', color: '#063838' } }, up.name),
                  el('span', { style: { fontSize: '10px', padding: '2px 8px', borderRadius: '999px', background: typColor + '15', color: typColor, fontWeight: '600', letterSpacing: '0.02em' } }, typLabel),
                  ...(up.nurAdmin ? [el('span', { style: { fontSize: '10px', padding: '2px 8px', borderRadius: '999px', background: '#FEF3C7', color: '#92400E', fontWeight: '600' } }, 'Nur Admin')] : [])
                ),
                el('p', { style: { fontSize: '13px', color: '#64748B', margin: '0' } }, up.beschreibung || 'Keine Beschreibung')
              ),
              el('button', {
                className: 'btn-icon',
                onClick: (e) => { e.stopPropagation(); confirmDialog(`"${up.name}" und alle zugehörigen Projekte wirklich löschen?`, () => { DataStore.deleteUeberProjekt(up.id); Router.resolve(); }); },
                'aria-label': 'Löschen'
              }, trashIcon())
            ),
            el('div', { style: { display: 'flex', gap: '16px', marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #F1F5F9' } },
              el('span', { style: { fontSize: '13px', color: '#64748B' } }, `${pCount} Projekt${pCount !== 1 ? 'e' : ''}`),
              el('span', { style: { fontSize: '13px', color: '#94A3B8' } }, `Erstellt: ${formatDate(up.erstelltAm)}`)
            )
          );
          grid.appendChild(card);
        }
        container.appendChild(grid);
      }
    }

    // --- Empty State ---
    const EMPTY_STATE_ICONS = {
      'Firmen': '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#0D7377" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
      'Projekte': '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#0D7377" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>',
      'Mitarbeiter': '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#0D7377" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>',
      'Exporte': '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#0D7377" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
      'Arbeitspakete': '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#0D7377" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>',
    };

    function renderEmptyState(title, desc, btnText, btnAction) {
      // Pick icon based on title keyword
      let iconSvg = EMPTY_STATE_ICONS['Firmen']; // default
      for (const [key, svg] of Object.entries(EMPTY_STATE_ICONS)) {
        if (title.toLowerCase().includes(key.toLowerCase())) { iconSvg = svg; break; }
      }
      const iconWrap = el('div', { className: 'empty-state-icon', style: { background: '#F0FDFD' } });
      iconWrap.innerHTML = iconSvg;

      return el('div', {
        className: 'card',
        style: { textAlign: 'center', padding: '64px 32px', border: '2px dashed #E2E8F0', background: 'transparent', boxShadow: 'none' }
      },
        iconWrap,
        el('h3', { style: { fontSize: '18px', color: '#334155', margin: '0 0 8px' } }, title),
        el('p', { style: { fontSize: '14px', color: '#64748B', margin: '0 0 24px', maxWidth: '400px', marginLeft: 'auto', marginRight: 'auto' } }, desc),
        el('button', { className: 'btn-primary', onClick: btnAction }, btnText)
      );
    }

    // =========================================================================
    // Calendar Components (Phase 9)
    // =========================================================================

    const MONTH_NAMES_DE = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
    const WEEKDAY_HEADERS = ['Mo','Di','Mi','Do','Fr','Sa','So'];

    function buildCalendarNav(year, month, onChangeMonth) {
      return el('div', { className: 'cal-nav' },
        el('button', {
          onClick: () => onChangeMonth(month === 0 ? year - 1 : year, month === 0 ? 11 : month - 1),
          'aria-label': 'Vorheriger Monat'
        }, '\u2039'),
        el('h2', null, `${MONTH_NAMES_DE[month]} ${year}`),
        el('button', {
          onClick: () => onChangeMonth(month === 11 ? year + 1 : year, month === 11 ? 0 : month + 1),
          'aria-label': 'Nächster Monat'
        }, '\u203A')
      );
    }

    function toDateStr(y, m, d) {
      return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    function todayStr() {
      const n = new Date(); return toDateStr(n.getFullYear(), n.getMonth(), n.getDate());
    }

    function buildMonthGrid(year, month, options) {
      const opts = Object.assign({
        getDayClasses: () => [],
        getDayContent: () => null,
        getDayTooltip: () => null,
        onDayClick: null,
        onDayMouseDown: null,
        onDayMouseEnter: null,
        onDayMouseUp: null,
        isSelectable: () => true,
      }, options);

      const grid = el('div', { className: 'cal-grid' });

      // Header row
      for (let i = 0; i < 7; i++) {
        grid.appendChild(el('div', {
          className: 'cal-header-cell' + (i >= 5 ? ' cal-header-cell--weekend' : '')
        }, WEEKDAY_HEADERS[i]));
      }

      const firstDay = new Date(year, month, 1);
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const startOffset = (firstDay.getDay() + 6) % 7; // Monday = 0

      // Previous month fill
      const prevMonthDays = new Date(year, month, 0).getDate();
      for (let i = 0; i < startOffset; i++) {
        const d = prevMonthDays - startOffset + 1 + i;
        const pm = month === 0 ? 11 : month - 1;
        const py = month === 0 ? year - 1 : year;
        const ds = toDateStr(py, pm, d);
        grid.appendChild(el('div', { className: 'cal-day cal-day--outside', dataset: { date: ds } },
          el('span', { className: 'cal-day-number' }, String(d))
        ));
      }

      // Current month days
      const today = todayStr();
      for (let d = 1; d <= daysInMonth; d++) {
        const ds = toDateStr(year, month, d);
        const dow = new Date(year, month, d).getDay();
        const isWeekend = dow === 0 || dow === 6;
        const classes = ['cal-day'];
        if (isWeekend) classes.push('cal-day--weekend');
        if (ds === today) classes.push('cal-day--today');
        const extra = opts.getDayClasses(ds);
        if (extra && extra.length) classes.push(...extra);

        const cell = el('div', { className: classes.join(' '), dataset: { date: ds } });
        cell.appendChild(el('span', { className: 'cal-day-number' }, String(d)));

        const tooltip = opts.getDayTooltip(ds);
        if (tooltip) cell.title = tooltip;

        const content = opts.getDayContent(ds);
        if (content) cell.appendChild(content);

        if (!isWeekend && opts.isSelectable(ds)) {
          if (opts.onDayClick) cell.addEventListener('click', (e) => { if (!cell._dragged) opts.onDayClick(ds, e); });
          if (opts.onDayMouseDown) cell.addEventListener('mousedown', (e) => { e.preventDefault(); opts.onDayMouseDown(ds, e); });
          if (opts.onDayMouseEnter) cell.addEventListener('mouseenter', (e) => opts.onDayMouseEnter(ds, e));
          if (opts.onDayMouseUp) cell.addEventListener('mouseup', (e) => opts.onDayMouseUp(ds, e));
        }

        grid.appendChild(cell);
      }

      // Next month fill
      const totalCells = startOffset + daysInMonth;
      const remaining = (7 - (totalCells % 7)) % 7;
      for (let i = 1; i <= remaining; i++) {
        const nm = month === 11 ? 0 : month + 1;
        const ny = month === 11 ? year + 1 : year;
        const ds = toDateStr(ny, nm, i);
        grid.appendChild(el('div', { className: 'cal-day cal-day--outside', dataset: { date: ds } },
          el('span', { className: 'cal-day-number' }, String(i))
        ));
      }

      return grid;
    }

    function buildCalendarLegend(items) {
      const legend = el('div', { className: 'cal-legend' });
      for (const item of items) {
        legend.appendChild(el('div', { className: 'cal-legend-item' },
          el('span', { className: 'cal-legend-swatch', style: { background: item.color } }),
          el('span', null, item.label)
        ));
      }
      return legend;
    }

    function classifyDay(dateStr, ma, feiertage) {
      const d = new Date(dateStr);
      const dow = d.getDay();
      if (dow === 0 || dow === 6) return 'weekend';
      if (ma.feiertagePflicht && feiertage.some(f => f.datum === dateStr)) return 'feiertag';
      for (const b of (ma.blockierungen || [])) {
        if (dateStr >= b.von && dateStr <= b.bis) return b.typ;
      }
      return 'frei';
    }

    function findBlockierungForDay(ma, dateStr) {
      for (const b of (ma.blockierungen || [])) {
        if (dateStr >= b.von && dateStr <= b.bis) return b;
      }
      return null;
    }

    function getBlockTypeForDay(ma, dateStr, feiertage) {
      if (ma.feiertagePflicht && feiertage.some(f => f.datum === dateStr)) return 'feiertag';
      for (const b of (ma.blockierungen || [])) {
        if (dateStr >= b.von && dateStr <= b.bis) return b.typ;
      }
      return null;
    }

    function getFeiertagName(dateStr, feiertage) {
      const ft = feiertage.find(f => f.datum === dateStr);
      return ft ? ft.name : null;
    }

    // --- Range Selection State Machine ---
    function attachRangeSelection(gridEl, onRangeComplete) {
      let dragging = false;
      let anchor = null;
      let current = null;

      function minMax(a, b) { return a < b ? [a, b] : [b, a]; }

      function updateVisual() {
        const cells = gridEl.querySelectorAll('.cal-day[data-date]');
        cells.forEach(c => {
          c.classList.remove('cal-day--in-range', 'cal-day--selected');
          c._dragged = false;
        });
        if (!anchor) return;
        const [von, bis] = current ? minMax(anchor, current) : [anchor, anchor];
        cells.forEach(c => {
          const ds = c.dataset.date;
          if (ds >= von && ds <= bis && !c.classList.contains('cal-day--outside') && !c.classList.contains('cal-day--weekend')) {
            c.classList.add(anchor === current || !current ? 'cal-day--selected' : 'cal-day--in-range');
            if (anchor !== current) c._dragged = true;
          }
        });
      }

      gridEl.addEventListener('mousedown', (e) => {
        const cell = e.target.closest('.cal-day[data-date]');
        if (!cell || cell.classList.contains('cal-day--outside') || cell.classList.contains('cal-day--weekend')) return;
        e.preventDefault();
        dragging = true;
        anchor = cell.dataset.date;
        current = anchor;
        updateVisual();
      });

      gridEl.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const cell = e.target.closest('.cal-day[data-date]');
        if (!cell || cell.classList.contains('cal-day--outside') || cell.classList.contains('cal-day--weekend')) return;
        current = cell.dataset.date;
        updateVisual();
      });

      const endDrag = () => {
        if (!dragging || !anchor) { dragging = false; return; }
        dragging = false;
        const [von, bis] = current ? minMax(anchor, current) : [anchor, anchor];
        const wasDrag = anchor !== current;
        // Clear visual
        gridEl.querySelectorAll('.cal-day').forEach(c => {
          c.classList.remove('cal-day--in-range', 'cal-day--selected');
        });
        // Small delay so click doesn't also fire
        setTimeout(() => {
          onRangeComplete(von, bis, wasDrag);
          anchor = null; current = null;
        }, 10);
      };

      gridEl.addEventListener('mouseup', endDrag);
      const docMouseUp = () => { if (dragging) endDrag(); };
      document.addEventListener('mouseup', docMouseUp);

      return {
        reset: () => { dragging = false; anchor = null; current = null; updateVisual(); },
        destroy: () => { document.removeEventListener('mouseup', docMouseUp); },
      };
    }

    // --- Mitarbeiter-Kalender ---
    function renderMitarbeiterKalender(container, maId) {
      const ma = DataStore.getMitarbeiterById(maId);
      if (!ma) {
        container.appendChild(renderEmptyState('Mitarbeiter nicht gefunden', 'Dieser Mitarbeiter existiert nicht mehr.', 'Zur Übersicht', () => Router.navigate('#/mitarbeiter')));
        return;
      }
      const feiertage = DataStore.getFeiertage();
      let curYear = new Date().getFullYear();
      let curMonth = new Date().getMonth();
      let _rangeSelection = null;

      function render() {
        if (_rangeSelection) { _rangeSelection.destroy(); _rangeSelection = null; }
        container.innerHTML = '';
        const freshMa = DataStore.getMitarbeiterById(maId);
        if (!freshMa) return;
        const budget = getUrlaubstageBudget(maId, curYear);

        // Load AP assignments for this employee
        const maZuweisungen = DataStore.getZuweisungenForMitarbeiter(maId);
        const apColorMap = {};
        const apNameMap = {};
        let apColorIdx = 0;
        for (const zw of maZuweisungen) {
          const found = DataStore.findProjektWithParent(zw.projektId);
          if (!found) continue;
          const allAps = flattenAPs(found.projekt.arbeitspakete);
          for (const av of (zw.arbeitspaketVerteilung || [])) {
            if (!apColorMap[av.arbeitspaketId]) {
              const apObj = allAps.find(a => a.id === av.arbeitspaketId);
              apColorMap[av.arbeitspaketId] = AP_PALETTE[apColorIdx % AP_PALETTE.length];
              apNameMap[av.arbeitspaketId] = apObj ? apObj.name : 'Unbekannt';
              apColorIdx++;
            }
          }
        }

        // Breadcrumb
        container.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '16px', fontSize: '13px', color: '#64748B' } },
          el('a', { href: '#/mitarbeiter', style: { color: '#0D7377', textDecoration: 'none', fontWeight: '500' } }, 'Mitarbeiter'),
          breadcrumbChevron(),
          el('span', { style: { color: '#334155' } }, `${freshMa.name} – Kalender`)
        ));

        // Header
        container.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' } },
          el('div', null,
            el('h1', { style: { fontSize: '28px', margin: '0', color: '#063838', fontFamily: "'DM Serif Display', serif" } }, freshMa.name),
            el('p', { style: { color: '#64748B', fontSize: '14px', margin: '4px 0 0' } }, `${freshMa.position || 'Mitarbeiter'} · ${freshMa.wochenStunden || 40}h/Woche`)
          ),
          el('button', { className: 'btn-secondary', onClick: () => Router.navigate('#/mitarbeiter') }, '\u2190 Zurück zur Liste')
        ));

        // Budget card
        const budgetPct = budget.anspruch > 0 ? Math.min((budget.genommen / budget.anspruch) * 100, 100) : 0;
        const budgetColor = budget.verbleibend <= 0 ? '#DC2626' : budget.verbleibend <= 5 ? '#F59E0B' : '#0D7377';
        const budgetCard = el('div', { className: 'card', style: { padding: '16px 24px', marginBottom: '24px' } },
          el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } },
            el('span', { style: { fontSize: '14px', fontWeight: '600', color: '#334155' } }, `Urlaubsbudget ${curYear}`),
            el('span', { style: { fontSize: '13px', color: budgetColor, fontWeight: '600' } }, `${budget.verbleibend} Tage verbleibend`)
          ),
          el('div', { style: { height: '8px', borderRadius: '4px', background: '#E2E8F0', overflow: 'hidden' } },
            el('div', { style: { height: '100%', width: `${budgetPct}%`, borderRadius: '4px', background: budgetColor, transition: 'width 0.3s ease' } })
          ),
          el('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '12px', color: '#94A3B8' } },
            el('span', null, `${budget.genommen} genommen`),
            el('span', null, `${budget.anspruch} Anspruch`)
          )
        );
        container.appendChild(budgetCard);

        // Calendar nav
        container.appendChild(buildCalendarNav(curYear, curMonth, (y, m) => { curYear = y; curMonth = m; render(); }));

        // Calendar grid
        const grid = buildMonthGrid(curYear, curMonth, {
          getDayClasses: (ds) => {
            const typ = classifyDay(ds, freshMa, feiertage);
            if (typ === 'urlaub') return ['cal-day--urlaub'];
            if (typ === 'krank') return ['cal-day--krank'];
            if (typ === 'feiertag') return ['cal-day--feiertag'];
            return [];
          },
          getDayContent: (ds) => {
            const typ = classifyDay(ds, freshMa, feiertage);
            if (typ === 'feiertag') {
              const name = getFeiertagName(ds, feiertage);
              if (name) return el('span', { className: 'cal-day-label' }, name);
            }
            if (typ === 'urlaub') return el('span', { className: 'cal-day-label' }, 'Urlaub');
            if (typ === 'krank') return el('span', { className: 'cal-day-label' }, 'Krank');
            // Free workday: show AP assignment dots
            if (typ === 'frei') {
              const dots = [];
              for (const zw of maZuweisungen) {
                if (ds < zw.von || ds > zw.bis) continue;
                for (const av of (zw.arbeitspaketVerteilung || [])) {
                  if (apColorMap[av.arbeitspaketId]) {
                    dots.push(el('span', { className: 'cal-dot', style: { background: apColorMap[av.arbeitspaketId] }, title: `${apNameMap[av.arbeitspaketId]} (${av.prozentAnteil}%)` }));
                  }
                }
              }
              if (dots.length > 0) return el('div', { className: 'cal-day-dots' }, ...dots);
            }
            return null;
          },
          getDayTooltip: (ds) => {
            const typ = classifyDay(ds, freshMa, feiertage);
            if (typ === 'feiertag') return getFeiertagName(ds, feiertage) || 'Feiertag';
            if (typ === 'urlaub') { const b = findBlockierungForDay(freshMa, ds); return b && b.notiz ? `Urlaub: ${b.notiz}` : 'Urlaub'; }
            if (typ === 'krank') { const b = findBlockierungForDay(freshMa, ds); return b && b.notiz ? `Krank: ${b.notiz}` : 'Krank'; }
            if (typ === 'frei') {
              const lines = [];
              for (const zw of maZuweisungen) {
                if (ds < zw.von || ds > zw.bis) continue;
                const found = DataStore.findProjektWithParent(zw.projektId);
                const projName = found ? found.projekt.name : '?';
                for (const av of (zw.arbeitspaketVerteilung || [])) {
                  lines.push(`${projName}: ${apNameMap[av.arbeitspaketId] || '?'} (${av.prozentAnteil}%)`);
                }
              }
              return lines.length > 0 ? lines.join('\n') : null;
            }
            return null;
          },
          isSelectable: (ds) => true,
        });
        container.appendChild(grid);

        // Wire range selection
        _rangeSelection = attachRangeSelection(grid, (von, bis, wasDrag) => {
          const typ = classifyDay(von, freshMa, feiertage);
          if (!wasDrag && (typ === 'urlaub' || typ === 'krank')) {
            // Clicked on existing blockierung → show detail
            const b = findBlockierungForDay(freshMa, von);
            if (b) showBlockierungDetail(b, freshMa, render);
            return;
          }
          // Show picker to add new
          showBlockierungPicker(von, bis, freshMa, render);
        });

        // Legend
        const legendItems = [
          { color: '#0D7377', label: 'Urlaub' },
          { color: '#DC2626', label: 'Krank' },
        ];
        if (freshMa.feiertagePflicht) legendItems.push({ color: '#F59E0B', label: 'Feiertag' });
        legendItems.push({ color: '#F1F5F9', label: 'Wochenende' });
        for (const apId of Object.keys(apColorMap)) {
          legendItems.push({ color: apColorMap[apId], label: apNameMap[apId] });
        }
        container.appendChild(buildCalendarLegend(legendItems));

        // Blockierung list
        const allBlocks = (freshMa.blockierungen || []).slice().sort((a, b) => a.von.localeCompare(b.von));
        if (allBlocks.length > 0) {
          const listCard = el('div', { className: 'card', style: { marginTop: '24px', padding: '20px 24px' } });
          listCard.appendChild(el('h3', { style: { fontSize: '16px', margin: '0 0 12px', color: '#063838', fontFamily: "'DM Serif Display', serif" } }, 'Alle Blockierungen'));
          for (const b of allBlocks) {
            const days = CalcEngine.countWeekdays(b.von, b.bis);
            const typeColor = b.typ === 'urlaub' ? '#0D7377' : '#DC2626';
            const typeLabel = b.typ === 'urlaub' ? 'Urlaub' : 'Krank';
            const row = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #F1F5F9' } },
              el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
                el('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: typeColor, flexShrink: '0' } }),
                el('span', { style: { fontSize: '13px', fontWeight: '600', color: typeColor } }, typeLabel),
                el('span', { style: { fontSize: '13px', color: '#334155' } }, `${formatDate(b.von)} – ${formatDate(b.bis)}`),
                el('span', { style: { fontSize: '12px', color: '#94A3B8' } }, `(${days} Werktage)`),
                b.notiz ? el('span', { style: { fontSize: '12px', color: '#64748B', fontStyle: 'italic' } }, b.notiz) : null
              ),
              el('button', { className: 'btn-icon', style: { fontSize: '14px', width: '28px', height: '28px' }, onClick: () => {
                const curr = DataStore.getMitarbeiterById(maId);
                curr.blockierungen = (curr.blockierungen || []).filter(x => x.id !== b.id);
                DataStore.saveMitarbeiter(curr);
                render();
              }, 'aria-label': 'Entfernen' }, '\u2715')
            );
            listCard.appendChild(row);
          }
          container.appendChild(listCard);
        }
      }

      render();
    }

    function showBlockierungPicker(von, bis, ma, refreshFn) {
      const days = CalcEngine.countWeekdays(von, bis);
      openModal('Blockierung eintragen', (body, close) => {
        body.appendChild(el('div', { style: { padding: '12px 16px', background: '#F8FAFB', borderRadius: '8px', marginBottom: '16px' } },
          el('div', { style: { fontSize: '14px', color: '#334155', fontWeight: '500' } }, `${formatDate(von)}${von !== bis ? ' – ' + formatDate(bis) : ''}`),
          el('div', { style: { fontSize: '13px', color: '#64748B', marginTop: '4px' } }, `${days} Werktag${days !== 1 ? 'e' : ''}`)
        ));

        const notizInput = el('input', { className: 'form-input', placeholder: 'Notiz (optional)' });
        body.appendChild(el('div', { style: { marginBottom: '20px' } },
          el('label', { className: 'form-label' }, 'Notiz'),
          notizInput
        ));

        body.appendChild(el('div', { style: { display: 'flex', gap: '10px', justifyContent: 'flex-end' } },
          el('button', { className: 'btn-secondary', onClick: close }, 'Abbrechen'),
          el('button', {
            style: { padding: '8px 20px', borderRadius: '8px', border: 'none', color: 'white', background: '#DC2626', cursor: 'pointer', fontWeight: '600', fontSize: '14px' },
            onClick: () => { addBlockierungToMA(ma.id, 'krank', von, bis, notizInput.value.trim()); close(); refreshFn(); }
          }, 'Krank'),
          el('button', {
            className: 'btn-primary',
            onClick: () => { addBlockierungToMA(ma.id, 'urlaub', von, bis, notizInput.value.trim()); close(); refreshFn(); }
          }, 'Urlaub')
        ));
      });
    }

    function showBlockierungDetail(blockierung, ma, refreshFn) {
      const days = CalcEngine.countWeekdays(blockierung.von, blockierung.bis);
      const typLabel = blockierung.typ === 'urlaub' ? 'Urlaub' : 'Krank';
      const typColor = blockierung.typ === 'urlaub' ? '#0D7377' : '#DC2626';
      openModal('Blockierung Details', (body, close) => {
        body.appendChild(el('div', { style: { padding: '16px', background: blockierung.typ === 'urlaub' ? '#F0FDFD' : '#FEF2F2', borderRadius: '8px', borderLeft: `3px solid ${typColor}`, marginBottom: '16px' } },
          el('div', { style: { fontSize: '15px', fontWeight: '600', color: typColor } }, typLabel),
          el('div', { style: { fontSize: '14px', color: '#334155', marginTop: '6px' } }, `${formatDate(blockierung.von)} – ${formatDate(blockierung.bis)} (${days} Werktage)`),
          blockierung.notiz ? el('div', { style: { fontSize: '13px', color: '#64748B', marginTop: '4px', fontStyle: 'italic' } }, blockierung.notiz) : null
        ));

        body.appendChild(el('div', { style: { display: 'flex', gap: '10px', justifyContent: 'flex-end' } },
          el('button', { className: 'btn-secondary', onClick: close }, 'Schließen'),
          el('button', {
            style: { padding: '8px 20px', borderRadius: '8px', border: 'none', color: 'white', background: '#DC2626', cursor: 'pointer', fontWeight: '600', fontSize: '14px' },
            onClick: () => {
              const curr = DataStore.getMitarbeiterById(ma.id);
              curr.blockierungen = (curr.blockierungen || []).filter(x => x.id !== blockierung.id);
              DataStore.saveMitarbeiter(curr);
              close();
              refreshFn();
            }
          }, 'Entfernen')
        ));
      });
    }

    function addBlockierungToMA(maId, typ, von, bis, notiz) {
      const curr = DataStore.getMitarbeiterById(maId);
      if (!curr) return;
      if (!curr.blockierungen) curr.blockierungen = [];
      curr.blockierungen.push({ id: crypto.randomUUID(), typ, von, bis, notiz: notiz || '' });
      DataStore.saveMitarbeiter(curr);
    }

    // --- Projekt-Kalender ---
    const EMPLOYEE_PALETTE = ['#0D7377','#6366F1','#EC4899','#8B5CF6','#06B6D4','#10B981','#F97316','#EF4444'];
    const AP_PALETTE = ['#6366F1','#8B5CF6','#EC4899','#06B6D4','#10B981','#F97316','#EF4444','#0D7377','#D946EF','#0EA5E9'];

    function renderProjektKalender(container, ueberProjektId, projektId) {
      const up = DataStore.getUeberProjekt(ueberProjektId);
      if (!up) { container.appendChild(renderEmptyState('Über-Projekt nicht gefunden', '', 'Zum Dashboard', () => Router.navigate('#/dashboard'))); return; }
      if (up.nurAdmin && !AuthSystem.isAdmin()) { container.appendChild(renderEmptyState('Kein Zugriff', 'Dieses Projekt ist nur für Admin-Benutzer sichtbar.', 'Zum Dashboard', () => Router.navigate('#/dashboard'))); return; }
      const p = (up.projekte || []).find(pr => pr.id === projektId);
      if (!p) { container.appendChild(renderEmptyState('Projekt nicht gefunden', '', 'Zurück', () => Router.navigate(`#/ueberprojekt/${ueberProjektId}`))); return; }

      const zuweisungen = DataStore.getZuweisungenForProjekt(projektId);
      const feiertage = DataStore.getFeiertage();
      const employeeData = zuweisungen.map(zw => ({ zw, ma: DataStore.getMitarbeiterById(zw.mitarbeiterId) })).filter(d => d.ma);
      const colorMap = {};
      employeeData.forEach((d, i) => { colorMap[d.ma.id] = EMPLOYEE_PALETTE[i % EMPLOYEE_PALETTE.length]; });

      // Start on project start month or current month
      const startDate = p.startDatum ? new Date(p.startDatum) : new Date();
      let curYear = startDate.getFullYear();
      let curMonth = startDate.getMonth();

      function render() {
        container.innerHTML = '';

        // Breadcrumb
        container.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '16px', fontSize: '13px', color: '#64748B' } },
          el('a', { href: '#/dashboard', style: { color: '#0D7377', textDecoration: 'none', fontWeight: '500' } }, 'Dashboard'),
          breadcrumbChevron(),
          el('a', { href: `#/ueberprojekt/${ueberProjektId}`, style: { color: '#0D7377', textDecoration: 'none', fontWeight: '500' } }, up.name),
          breadcrumbChevron(),
          el('a', { href: `#/projekt/${ueberProjektId}/${projektId}`, style: { color: '#0D7377', textDecoration: 'none', fontWeight: '500' } }, p.name),
          breadcrumbChevron(),
          el('span', { style: { color: '#334155' } }, 'Kalender')
        ));

        // Header
        container.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' } },
          el('div', null,
            el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
              el('h1', { style: { fontSize: '28px', margin: '0', color: '#063838', fontFamily: "'DM Serif Display', serif" } }, p.name),
              el('span', { className: `badge badge-${p.status}` }, statusLabel(p.status))
            ),
            el('p', { style: { color: '#64748B', fontSize: '14px', margin: '4px 0 0' } },
              `${formatDate(p.startDatum)} – ${formatDate(p.endDatum)} · ${employeeData.length} Mitarbeiter zugewiesen`)
          ),
          el('button', { className: 'btn-secondary', onClick: () => Router.navigate(`#/projekt/${ueberProjektId}/${projektId}`) }, '\u2190 Zurück zum Projekt')
        ));

        // Calendar nav
        container.appendChild(buildCalendarNav(curYear, curMonth, (y, m) => { curYear = y; curMonth = m; render(); }));

        // Helper: check blockages for a day
        function getDayBlockInfo(ds) {
          const d = new Date(ds);
          if (d.getDay() === 0 || d.getDay() === 6) return { assigned: 0, blocked: 0 };
          let assigned = 0, blocked = 0;
          for (const { zw, ma } of employeeData) {
            if (ds < zw.von || ds > zw.bis) continue;
            assigned++;
            if (getBlockTypeForDay(ma, ds, feiertage)) blocked++;
          }
          return { assigned, blocked };
        }

        // Calendar grid
        const grid = buildMonthGrid(curYear, curMonth, {
          getDayClasses: (ds) => {
            const classes = [];
            if (p.startDatum && ds < p.startDatum) classes.push('cal-day--out-of-project');
            if (p.endDatum && ds > p.endDatum) classes.push('cal-day--out-of-project');
            if (ds === p.startDatum) classes.push('cal-day--project-start');
            if (ds === p.endDatum) classes.push('cal-day--project-end');
            // Mark blocked days red
            const bi = getDayBlockInfo(ds);
            if (bi.blocked > 0 && bi.assigned > 0) {
              classes.push(bi.blocked >= bi.assigned ? 'cal-day--all-blocked' : 'cal-day--has-block');
            }
            return classes;
          },
          getDayContent: (ds) => {
            if ((p.startDatum && ds < p.startDatum) || (p.endDatum && ds > p.endDatum)) return null;
            const d = new Date(ds);
            if (d.getDay() === 0 || d.getDay() === 6) return null;

            const dots = [];
            for (const { zw, ma } of employeeData) {
              if (ds < zw.von || ds > zw.bis) continue;
              const blockType = getBlockTypeForDay(ma, ds, feiertage);
              const color = blockType ? (blockType === 'krank' ? '#DC2626' : blockType === 'feiertag' ? '#F59E0B' : '#0D7377') : colorMap[ma.id];
              const pctOpacity = Math.max(0.15, Math.min(1, zw.prozentAnteil / 100));
              dots.push(el('span', {
                className: `cal-dot${blockType ? ' cal-dot--blocked' : ''}`,
                style: { background: color, opacity: blockType ? 0.4 : pctOpacity },
                title: `${ma.name} (${zw.prozentAnteil}%)${blockType ? ' – ' + (blockType === 'urlaub' ? 'Urlaub' : blockType === 'krank' ? 'Krank' : 'Feiertag') : ''}`
              }));
            }
            if (dots.length === 0) return null;
            return el('div', { className: 'cal-day-dots' }, ...dots);
          },
          getDayTooltip: (ds) => {
            if ((p.startDatum && ds < p.startDatum) || (p.endDatum && ds > p.endDatum)) return null;
            const d = new Date(ds);
            if (d.getDay() === 0 || d.getDay() === 6) return null;
            const lines = [];
            for (const { zw, ma } of employeeData) {
              if (ds < zw.von || ds > zw.bis) continue;
              const blockType = getBlockTypeForDay(ma, ds, feiertage);
              lines.push(`${ma.name} (${zw.prozentAnteil}%)${blockType ? ' – ' + blockType : ''}`);
            }
            return lines.length > 0 ? lines.join('\n') : null;
          },
          isSelectable: () => false,
        });
        container.appendChild(grid);

        // Projekt calendar click: show detail popover
        grid.addEventListener('click', (e) => {
          const cell = e.target.closest('.cal-day[data-date]');
          if (!cell || cell.classList.contains('cal-day--outside') || cell.classList.contains('cal-day--weekend') || cell.classList.contains('cal-day--out-of-project')) return;
          const ds = cell.dataset.date;
          const assigned = [];
          for (const { zw, ma } of employeeData) {
            if (ds < zw.von || ds > zw.bis) continue;
            const blockType = getBlockTypeForDay(ma, ds, feiertage);
            assigned.push({ ma, zw, blockType });
          }
          if (assigned.length === 0) return;
          openModal(`${formatDate(ds)} – Mitarbeiter`, (body, close) => {
            for (const { ma, zw, blockType } of assigned) {
              const color = colorMap[ma.id];
              const statusText = blockType ? (blockType === 'urlaub' ? 'Urlaub' : blockType === 'krank' ? 'Krank' : 'Feiertag') : 'Verfügbar';
              const statusColor = blockType ? (blockType === 'krank' ? '#DC2626' : blockType === 'feiertag' ? '#F59E0B' : '#0D7377') : '#10B981';
              body.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0', borderBottom: '1px solid #F1F5F9' } },
                el('span', { style: { width: '10px', height: '10px', borderRadius: '50%', background: color, flexShrink: '0' } }),
                el('div', { style: { flex: '1' } },
                  el('div', { style: { fontWeight: '500', fontSize: '14px', color: '#1E293B' } }, ma.name),
                  el('div', { style: { fontSize: '12px', color: '#64748B' } }, `${zw.prozentAnteil}% · ${formatDate(zw.von)} – ${formatDate(zw.bis)}`)
                ),
                el('span', { style: { fontSize: '12px', fontWeight: '600', color: statusColor, padding: '2px 8px', borderRadius: '4px', background: statusColor + '15' } }, statusText)
              ));
            }
            body.appendChild(el('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '16px' } },
              el('button', { className: 'btn-secondary', onClick: close }, 'Schließen')
            ));
          });
        });

        // Legend
        const legendItems = [];
        for (const { ma } of employeeData) {
          legendItems.push({ color: colorMap[ma.id], label: ma.name });
        }
        if (legendItems.length > 0) {
          legendItems.push({ color: '#DC2626', label: 'Blockiert (Urlaub/Krank/Feiertag)' });
        }
        container.appendChild(buildCalendarLegend(legendItems));

        // Employee summary cards
        if (employeeData.length > 0) {
          const summaryCard = el('div', { className: 'card', style: { marginTop: '20px', padding: '20px 24px' } });
          summaryCard.appendChild(el('h3', { style: { fontSize: '16px', margin: '0 0 12px', color: '#063838', fontFamily: "'DM Serif Display', serif" } }, 'Zugewiesene Mitarbeiter'));
          let totalProjKosten = 0;
          for (const { zw, ma } of employeeData) {
            const calc = CalcEngine.calculateCosts(zw.mitarbeiterId, zw.prozentAnteil, zw.von, zw.bis, zw.arbeitspaketVerteilung);
            totalProjKosten += calc.projektKosten;
            summaryCard.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderBottom: '1px solid #F1F5F9' } },
              el('span', { style: { width: '10px', height: '10px', borderRadius: '50%', background: colorMap[ma.id], flexShrink: '0' } }),
              el('span', { style: { fontWeight: '500', fontSize: '14px', color: '#1E293B', flex: '1' } }, ma.name),
              el('span', { style: { fontSize: '12px', color: '#64748B' } }, `${zw.prozentAnteil}% · ${formatDate(zw.von)} – ${formatDate(zw.bis)}`),
              el('span', { style: { fontSize: '13px', color: '#0D7377', fontWeight: '600' } }, `${calc.projektTage} Tage`),
              calc.projektKosten > 0 ? el('span', { style: { fontSize: '13px', color: '#F59E0B', fontWeight: '600' } }, formatEuro(calc.projektKosten)) : null
            ));
          }
          if (totalProjKosten > 0) {
            summaryCard.appendChild(el('div', { style: { display: 'flex', justifyContent: 'flex-end', padding: '12px 0 4px', borderTop: '2px solid #E2E8F0', marginTop: '4px' } },
              el('span', { style: { fontSize: '14px', fontWeight: '700', color: '#92400E' } }, `Gesamt: ${formatEuro(totalProjKosten)}`)
            ));
          }
          container.appendChild(summaryCard);
        }

        // AP list (tree)
        const flatAps = flattenAPs(p.arbeitspakete || []);
        if (flatAps.length > 0) {
          const apCard = el('div', { className: 'card', style: { marginTop: '16px', padding: '20px 24px' } });
          apCard.appendChild(el('h3', { style: { fontSize: '16px', margin: '0 0 12px', color: '#063838', fontFamily: "'DM Serif Display', serif" } }, 'Arbeitspakete'));
          for (const ap of flatAps) {
            const indent = (ap._depth || 0) * 16;
            apCard.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 0', paddingLeft: `${indent}px` } },
              el('span', { className: `badge badge-${ap.status}` }, statusLabel(ap.status)),
              el('span', { style: { fontSize: '14px', fontWeight: '500', color: '#334155' } }, ap.name),
              (ap.startDatum || ap.endDatum) ? el('span', { style: { fontSize: '12px', color: '#94A3B8' } }, `${ap.startDatum ? formatDate(ap.startDatum) : '–'} – ${ap.endDatum ? formatDate(ap.endDatum) : '–'}`) : null,
              el('a', { href: `#/ap-kalender/${ueberProjektId}/${projektId}/${ap.id}`, style: { fontSize: '12px', color: '#0D7377', textDecoration: 'none', fontWeight: '500' } }, 'Kalender')
            ));
          }
          container.appendChild(apCard);
        }
      }

      render();
    }

    // --- AP-Kalender ---
    function renderApKalender(container, ueberProjektId, projektId, apId) {
      const up = DataStore.getUeberProjekt(ueberProjektId);
      if (!up) { container.appendChild(renderEmptyState('Über-Projekt nicht gefunden', '', 'Zum Dashboard', () => Router.navigate('#/dashboard'))); return; }
      if (up.nurAdmin && !AuthSystem.isAdmin()) { container.appendChild(renderEmptyState('Kein Zugriff', 'Dieses Projekt ist nur für Admin-Benutzer sichtbar.', 'Zum Dashboard', () => Router.navigate('#/dashboard'))); return; }
      const p = (up.projekte || []).find(pr => pr.id === projektId);
      if (!p) { container.appendChild(renderEmptyState('Projekt nicht gefunden', '', 'Zurück', () => Router.navigate(`#/ueberprojekt/${ueberProjektId}`))); return; }
      const ap = findApInTree(p.arbeitspakete || [], apId);
      if (!ap) { container.appendChild(renderEmptyState('Arbeitspaket nicht gefunden', '', 'Zum Projekt', () => Router.navigate(`#/projekt/${ueberProjektId}/${projektId}`))); return; }

      const zuweisungen = DataStore.getZuweisungenForProjekt(projektId);
      const feiertage = DataStore.getFeiertage();
      const relevantZw = zuweisungen.filter(zw => (zw.arbeitspaketVerteilung || []).some(av => av.arbeitspaketId === apId));
      const employeeData = relevantZw.map(zw => {
        const ma = DataStore.getMitarbeiterById(zw.mitarbeiterId);
        const avEntry = (zw.arbeitspaketVerteilung || []).find(av => av.arbeitspaketId === apId);
        return { zw, ma, apProzent: avEntry ? avEntry.prozentAnteil : 0 };
      }).filter(d => d.ma);
      const colorMap = {};
      employeeData.forEach((d, i) => { colorMap[d.ma.id] = EMPLOYEE_PALETTE[i % EMPLOYEE_PALETTE.length]; });

      const apStart = ap.startDatum || p.startDatum;
      const apEnd = ap.endDatum || p.endDatum;
      const startDate = apStart ? new Date(apStart) : new Date();
      let curYear = startDate.getFullYear();
      let curMonth = startDate.getMonth();

      function render() {
        container.innerHTML = '';

        // Breadcrumb
        container.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '16px', fontSize: '13px', color: '#64748B', flexWrap: 'wrap' } },
          el('a', { href: '#/dashboard', style: { color: '#0D7377', textDecoration: 'none', fontWeight: '500' } }, 'Dashboard'),
          breadcrumbChevron(),
          el('a', { href: `#/ueberprojekt/${ueberProjektId}`, style: { color: '#0D7377', textDecoration: 'none', fontWeight: '500' } }, up.name),
          breadcrumbChevron(),
          el('a', { href: `#/projekt/${ueberProjektId}/${projektId}`, style: { color: '#0D7377', textDecoration: 'none', fontWeight: '500' } }, p.name),
          breadcrumbChevron(),
          el('span', { style: { color: '#334155' } }, `${ap.name} – Kalender`)
        ));

        // Header
        container.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' } },
          el('div', null,
            el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
              el('h1', { style: { fontSize: '28px', margin: '0', color: '#063838', fontFamily: "'DM Serif Display', serif" } }, ap.name),
              el('span', { className: `badge badge-${ap.status}` }, statusLabel(ap.status))
            ),
            el('p', { style: { color: '#64748B', fontSize: '14px', margin: '4px 0 0' } },
              `${apStart ? formatDate(apStart) : '–'} – ${apEnd ? formatDate(apEnd) : '–'} · ${employeeData.length} Mitarbeiter`)
          ),
          el('button', { className: 'btn-secondary', onClick: () => Router.navigate(`#/projekt/${ueberProjektId}/${projektId}`) }, '\u2190 Zurück zum Projekt')
        ));

        // Calendar nav
        container.appendChild(buildCalendarNav(curYear, curMonth, (y, m) => { curYear = y; curMonth = m; render(); }));

        // Precompute which specific days each employee actually works on this AP
        const employeeSchedule = {};
        for (const { zw, ma, apProzent } of employeeData) {
          const calc = CalcEngine.calculateCosts(zw.mitarbeiterId, zw.prozentAnteil, zw.von, zw.bis, zw.arbeitspaketVerteilung);
          const apCalc = (calc.apKosten || []).find(at => at.arbeitspaketId === apId);
          const totalApDays = apCalc ? apCalc.tage : 0;
          const fullDays = Math.floor(totalApDays);
          const remainingHours = Math.round((totalApDays - fullDays) * 8);

          // Collect all available weekdays in the intersection of zw range and AP range
          const rangeStart = zw.von > apStart ? zw.von : apStart;
          const rangeEnd = zw.bis < apEnd ? zw.bis : apEnd;
          const availableDays = [];
          const cur = new Date(rangeStart);
          const end = new Date(rangeEnd);
          while (cur <= end) {
            const ds = cur.toISOString().slice(0, 10);
            if (cur.getDay() !== 0 && cur.getDay() !== 6 && !getBlockTypeForDay(ma, ds, feiertage)) {
              availableDays.push(ds);
            }
            cur.setDate(cur.getDate() + 1);
          }

          // Distribute work days across the AP range (prefer pairs of 2 consecutive days)
          const totalSlots = fullDays + (remainingHours > 0 ? 1 : 0);
          const workDaySet = new Set();
          let partialDay = null;

          if (totalSlots >= availableDays.length) {
            // More work than available days — fill all
            for (const ds of availableDays) workDaySet.add(ds);
            if (remainingHours > 0) partialDay = availableDays[availableDays.length - 1];
          } else if (totalSlots > 0) {
            // Deterministic seed from employee+AP id for stable "random" placement
            let seed = 0;
            for (let i = 0; i < ma.id.length; i++) seed = ((seed << 5) - seed + ma.id.charCodeAt(i)) | 0;
            for (let i = 0; i < apId.length; i++) seed = ((seed << 5) - seed + apId.charCodeAt(i)) | 0;
            function seededRand() { seed = (seed * 1664525 + 1013904223) & 0x7fffffff; return seed / 0x7fffffff; }

            // Build consecutive pairs from available days
            const pairs = [];
            for (let i = 0; i < availableDays.length - 1; i++) {
              const d1 = new Date(availableDays[i]);
              const d2 = new Date(availableDays[i + 1]);
              const diff = (d2 - d1) / 86400000;
              if (diff <= 3) pairs.push([i, i + 1]); // consecutive weekdays (allow Fri→Mon = 3 days)
            }

            const picked = new Set();
            let remaining = totalSlots;

            // First, pick pairs spread across the range
            if (pairs.length > 0 && remaining >= 2) {
              const numPairs = Math.min(Math.floor(remaining / 2), pairs.length);
              // Spread pairs evenly, with seeded offset
              const step = pairs.length / numPairs;
              const offset = seededRand() * step;
              for (let p = 0; p < numPairs && remaining >= 2; p++) {
                const pi = Math.floor(offset + p * step) % pairs.length;
                const [a, b] = pairs[pi];
                if (!picked.has(a) && !picked.has(b)) {
                  picked.add(a);
                  picked.add(b);
                  remaining -= 2;
                }
              }
            }

            // Fill remaining singles spread across the range
            if (remaining > 0) {
              const unpicked = [];
              for (let i = 0; i < availableDays.length; i++) {
                if (!picked.has(i)) unpicked.push(i);
              }
              const step = unpicked.length / remaining;
              const offset = seededRand() * step;
              for (let s = 0; s < remaining && s < unpicked.length; s++) {
                const ui = Math.floor(offset + s * step) % unpicked.length;
                picked.add(unpicked[ui]);
              }
            }

            // Sort picked indices and assign to workDaySet
            const sortedPicked = [...picked].sort((a, b) => a - b);
            for (let i = 0; i < sortedPicked.length && i < totalSlots; i++) {
              const idx = sortedPicked[i];
              if (i === totalSlots - 1 && remainingHours > 0) {
                partialDay = availableDays[idx];
              }
              workDaySet.add(availableDays[idx]);
            }
          }
          employeeSchedule[ma.id] = { workDaySet, partialDay, partialHours: remainingHours };
        }

        // Helper: check blockages for a day
        function getApDayBlockInfo(ds) {
          const d = new Date(ds);
          if (d.getDay() === 0 || d.getDay() === 6) return { assigned: 0, blocked: 0 };
          let assigned = 0, blocked = 0;
          for (const { zw, ma } of employeeData) {
            if (ds < zw.von || ds > zw.bis) continue;
            const sched = employeeSchedule[ma.id];
            if (!sched || !sched.workDaySet.has(ds)) {
              // Not a scheduled work day — check if blocked
              if (getBlockTypeForDay(ma, ds, feiertage)) { assigned++; blocked++; }
              continue;
            }
            assigned++;
          }
          return { assigned, blocked };
        }

        // Calendar grid
        const grid = buildMonthGrid(curYear, curMonth, {
          getDayClasses: (ds) => {
            const classes = [];
            if (apStart && ds < apStart) classes.push('cal-day--out-of-project');
            if (apEnd && ds > apEnd) classes.push('cal-day--out-of-project');
            if (ds === apStart) classes.push('cal-day--project-start');
            if (ds === apEnd) classes.push('cal-day--project-end');
            // Mark blocked days red
            const bi = getApDayBlockInfo(ds);
            if (bi.blocked > 0 && bi.assigned > 0) {
              classes.push(bi.blocked >= bi.assigned ? 'cal-day--all-blocked' : 'cal-day--has-block');
            }
            return classes;
          },
          getDayContent: (ds) => {
            if ((apStart && ds < apStart) || (apEnd && ds > apEnd)) return null;
            const d = new Date(ds);
            if (d.getDay() === 0 || d.getDay() === 6) return null;
            const dots = [];
            for (const { zw, ma, apProzent } of employeeData) {
              if (ds < zw.von || ds > zw.bis) continue;
              const blockType = getBlockTypeForDay(ma, ds, feiertage);
              const sched = employeeSchedule[ma.id];

              // Blocked day within range — show blocked indicator
              if (blockType) {
                const color = blockType === 'krank' ? '#DC2626' : blockType === 'feiertag' ? '#F59E0B' : '#0D7377';
                dots.push(el('span', {
                  className: 'cal-dot cal-dot--blocked',
                  style: { background: color, opacity: 0.4 },
                  title: `${ma.name} – ${blockType}`
                }));
                continue;
              }

              // Only show green dot if this is an actual scheduled work day
              if (!sched || !sched.workDaySet.has(ds)) continue;
              const isPartial = ds === sched.partialDay;
              if (isPartial) {
                const wrapper = el('span', {
                  style: { display: 'inline-flex', alignItems: 'center', gap: '0px', fontSize: '9px', color: colorMap[ma.id], fontWeight: '700', lineHeight: '1' },
                  title: `${ma.name} (${sched.partialHours}h)`
                },
                  el('span', null, '('),
                  el('span', { className: 'cal-dot', style: { background: colorMap[ma.id] } }),
                  el('span', null, ')')
                );
                dots.push(wrapper);
              } else {
                dots.push(el('span', {
                  className: 'cal-dot',
                  style: { background: colorMap[ma.id] },
                  title: ma.name
                }));
              }
            }
            if (dots.length === 0) return null;
            return el('div', { className: 'cal-day-dots' }, ...dots);
          },
          getDayTooltip: (ds) => {
            if ((apStart && ds < apStart) || (apEnd && ds > apEnd)) return null;
            const d = new Date(ds);
            if (d.getDay() === 0 || d.getDay() === 6) return null;
            const lines = [];
            for (const { zw, ma, apProzent } of employeeData) {
              if (ds < zw.von || ds > zw.bis) continue;
              const blockType = getBlockTypeForDay(ma, ds, feiertage);
              if (blockType) {
                lines.push(`${ma.name} – ${blockType}`);
                continue;
              }
              const sched = employeeSchedule[ma.id];
              if (!sched || !sched.workDaySet.has(ds)) continue;
              const isPartial = ds === sched.partialDay;
              lines.push(`${ma.name}${isPartial ? ` (${sched.partialHours}h)` : ''}`);
            }
            return lines.length > 0 ? lines.join('\n') : null;
          },
          isSelectable: () => false,
        });
        container.appendChild(grid);

        // Click detail
        grid.addEventListener('click', (e) => {
          const cell = e.target.closest('.cal-day[data-date]');
          if (!cell || cell.classList.contains('cal-day--outside') || cell.classList.contains('cal-day--weekend') || cell.classList.contains('cal-day--out-of-project')) return;
          const ds = cell.dataset.date;
          const assigned = [];
          for (const { zw, ma, apProzent } of employeeData) {
            if (ds < zw.von || ds > zw.bis) continue;
            const blockType = getBlockTypeForDay(ma, ds, feiertage);
            const sched = employeeSchedule[ma.id];
            const isWorkDay = sched && sched.workDaySet.has(ds);
            const isPartial = sched && ds === sched.partialDay;
            assigned.push({ ma, zw, apProzent, blockType, isWorkDay, isPartial, partialHours: sched ? sched.partialHours : 0 });
          }
          if (assigned.length === 0) return;
          openModal(`${formatDate(ds)} – ${ap.name}`, (body, close) => {
            for (const { ma, apProzent, blockType, isWorkDay, isPartial, partialHours } of assigned) {
              const statusText = blockType ? (blockType === 'urlaub' ? 'Urlaub' : blockType === 'krank' ? 'Krank' : 'Feiertag') : isWorkDay ? (isPartial ? `${partialHours}h` : 'Ganzer Tag') : 'Kein Arbeitstag';
              const statusColor = blockType ? (blockType === 'krank' ? '#DC2626' : blockType === 'feiertag' ? '#F59E0B' : '#0D7377') : isWorkDay ? '#10B981' : '#94A3B8';
              body.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0', borderBottom: '1px solid #F1F5F9' } },
                el('span', { style: { width: '10px', height: '10px', borderRadius: '50%', background: colorMap[ma.id], flexShrink: '0' } }),
                el('div', { style: { flex: '1' } },
                  el('div', { style: { fontWeight: '500', fontSize: '14px', color: '#1E293B' } }, ma.name)
                ),
                el('span', { style: { fontSize: '12px', fontWeight: '600', color: statusColor, padding: '2px 8px', borderRadius: '4px', background: statusColor + '15' } }, statusText)
              ));
            }
            body.appendChild(el('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '16px' } },
              el('button', { className: 'btn-secondary', onClick: close }, 'Schließen')
            ));
          });
        });

        // Legend
        const legendItems = employeeData.map(d => ({ color: colorMap[d.ma.id], label: `${d.ma.name} (${d.apProzent}%)` }));
        if (legendItems.length > 0) legendItems.push({ color: '#DC2626', label: 'Blockiert (Urlaub/Krank/Feiertag)' });
        container.appendChild(buildCalendarLegend(legendItems));

        // Employee summary
        if (employeeData.length > 0) {
          const summaryCard = el('div', { className: 'card', style: { marginTop: '20px', padding: '20px 24px' } });
          summaryCard.appendChild(el('h3', { style: { fontSize: '16px', margin: '0 0 12px', color: '#063838', fontFamily: "'DM Serif Display', serif" } }, 'Zugewiesene Mitarbeiter'));
          let totalApKosten = 0;
          for (const { zw, ma, apProzent } of employeeData) {
            const calc = CalcEngine.calculateCosts(zw.mitarbeiterId, zw.prozentAnteil, zw.von, zw.bis, zw.arbeitspaketVerteilung);
            const apCalc = (calc.apKosten || []).find(at => at.arbeitspaketId === apId);
            const apKosten = apCalc ? apCalc.kosten : 0;
            totalApKosten += apKosten;
            summaryCard.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderBottom: '1px solid #F1F5F9' } },
              el('span', { style: { width: '10px', height: '10px', borderRadius: '50%', background: colorMap[ma.id], flexShrink: '0' } }),
              el('span', { style: { fontWeight: '500', fontSize: '14px', color: '#1E293B', flex: '1' } }, ma.name),
              el('span', { style: { fontSize: '12px', color: '#64748B' } }, `${apProzent}% AP · ${zw.prozentAnteil}% Projekt`),
              el('span', { style: { fontSize: '13px', color: '#0D7377', fontWeight: '600' } }, apCalc ? formatTageStunden(apCalc.tage) : '–'),
              apKosten > 0 ? el('span', { style: { fontSize: '13px', color: '#F59E0B', fontWeight: '600' } }, formatEuro(apKosten)) : null
            ));
          }
          if (totalApKosten > 0) {
            summaryCard.appendChild(el('div', { style: { display: 'flex', justifyContent: 'flex-end', padding: '12px 0 4px', borderTop: '2px solid #E2E8F0', marginTop: '4px' } },
              el('span', { style: { fontSize: '14px', fontWeight: '700', color: '#92400E' } }, `Gesamt: ${formatEuro(totalApKosten)}`)
            ));
          }
          container.appendChild(summaryCard);
        } else {
          container.appendChild(el('div', { className: 'card', style: { padding: '32px', textAlign: 'center', marginTop: '20px' } },
            el('p', { style: { color: '#64748B', fontSize: '14px' } }, 'Keine Mitarbeiter sind diesem Arbeitspaket zugewiesen.')
          ));
        }
      }

      render();
    }

    // --- Über-Projekt Modal ---
    function openUeberProjektModal(existing) {
      openModal(existing ? 'Firma bearbeiten' : 'Neue Firma', (body, close) => {
        if (existing) { const w = buildExportWarning(existing.id); if (w) body.appendChild(w); }
        const nameInput = el('input', { className: 'form-input', placeholder: 'z.B. Firma Mustermann GmbH', value: existing ? existing.name : '' });
        const descInput = el('textarea', { className: 'form-textarea', placeholder: 'Kurze Beschreibung des Kunden...', rows: '3' });
        if (existing) descInput.value = existing.beschreibung || '';
        const typSelect = el('select', { className: 'form-input' });
        for (const t of ['kmu', 'grossunternehmen']) {
          const label = t === 'kmu' ? 'KMU' : 'Großunternehmen';
          const opt = el('option', { value: t }, label);
          if (existing && existing.unternehmensTyp === t) opt.selected = true;
          else if (!existing && t === 'kmu') opt.selected = true;
          typSelect.appendChild(opt);
        }

        body.appendChild(el('div', { style: { marginBottom: '16px' } },
          el('label', { className: 'form-label' }, 'Name *'),
          nameInput
        ));
        body.appendChild(el('div', { style: { marginBottom: '16px' } },
          el('label', { className: 'form-label' }, 'Beschreibung'),
          descInput
        ));
        body.appendChild(el('div', { style: { marginBottom: '16px' } },
          el('label', { className: 'form-label' }, 'Unternehmenstyp'),
          typSelect
        ));

        // Nur Admin checkbox
        const nurAdminCheck = el('input', { type: 'checkbox', id: 'nurAdminCheck', style: { width: '18px', height: '18px', accentColor: '#0D7377', cursor: 'pointer' } });
        if (existing && existing.nurAdmin) nurAdminCheck.checked = true;
        body.appendChild(el('div', { style: { marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '10px', padding: '12px', background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: '8px' } },
          nurAdminCheck,
          el('label', { htmlFor: 'nurAdminCheck', style: { fontSize: '14px', color: '#92400E', cursor: 'pointer', margin: '0' } }, 'Nur Admin — nur sichtbar für Admin-Benutzer')
        ));

        body.appendChild(el('div', { style: { display: 'flex', gap: '12px', justifyContent: 'flex-end' } },
          el('button', { className: 'btn-secondary', onClick: close }, 'Abbrechen'),
          el('button', { className: 'btn-primary', onClick: () => {
            const name = nameInput.value.trim();
            if (!name) { nameInput.style.borderColor = '#DC2626'; return; }
            const up = existing ? { ...existing, name, beschreibung: descInput.value.trim(), unternehmensTyp: typSelect.value, nurAdmin: nurAdminCheck.checked, geaendertAm: new Date().toISOString() } : {
              id: crypto.randomUUID(),
              name,
              beschreibung: descInput.value.trim(),
              erstelltAm: new Date().toISOString(),
              unternehmensTyp: typSelect.value,
              nurAdmin: nurAdminCheck.checked,
              projekte: [],
            };
            DataStore.saveUeberProjekt(up);
            close();
            Router.resolve();
          }}, existing ? 'Speichern' : 'Erstellen')
        ));
      });
    }

    // --- Über-Projekt Detail ---
    function renderUeberProjekt(container, id) {
      const up = DataStore.getUeberProjekt(id);
      if (!up) {
        container.appendChild(el('p', { style: { color: '#DC2626' } }, 'Über-Projekt nicht gefunden.'));
        return;
      }
      if (up.nurAdmin && !AuthSystem.isAdmin()) {
        container.appendChild(renderEmptyState('Kein Zugriff', 'Dieses Projekt ist nur für Admin-Benutzer sichtbar.', 'Zum Dashboard', () => Router.navigate('#/dashboard')));
        return;
      }

      // Breadcrumb
      container.appendChild(el('div', { style: { marginBottom: '24px', fontSize: '13px', color: '#64748B', display: 'flex', alignItems: 'center' } },
        el('a', { href: '#/dashboard', style: { color: '#0D7377', textDecoration: 'none', cursor: 'pointer' } }, 'Dashboard'),
        breadcrumbChevron(),
        el('span', null, up.name)
      ));

      // Header
      const _utLabel = up.unternehmensTyp === 'grossunternehmen' ? 'Großunternehmen' : 'KMU';
      const _utColor = up.unternehmensTyp === 'grossunternehmen' ? '#6366F1' : '#0D7377';
      const header = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' } },
        el('div', null,
          el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
            el('h1', { style: { fontSize: '28px', margin: '0', color: '#063838' } }, up.name),
            el('span', { style: { fontSize: '11px', padding: '3px 10px', borderRadius: '999px', background: _utColor + '15', color: _utColor, fontWeight: '600' } }, _utLabel)
          ),
          el('p', { style: { color: '#64748B', fontSize: '14px', margin: '4px 0 0' } }, up.beschreibung || 'Keine Beschreibung')
        ),
        el('div', { style: { display: 'flex', gap: '8px' } },
          el('button', { className: 'btn-secondary', onClick: () => openExportDialog('ueberprojekt', up.id, { von: new Date().getFullYear() + '-01-01', bis: new Date().getFullYear() + '-12-31' }) }, 'PDF Export'),
          el('button', { className: 'btn-secondary', onClick: () => openUeberProjektModal(up) }, 'Bearbeiten'),
          el('button', { className: 'btn-primary', onClick: () => openProjektModal(up.id) }, '+ Neues Projekt')
        )
      );
      container.appendChild(header);

      const projekte = up.projekte || [];

      if (projekte.length === 0) {
        container.appendChild(el('div', { style: { marginTop: '32px' } },
          renderEmptyState(
            'Noch keine Projekte',
            'Erstelle das erste Projekt für diesen Kunden.',
            '+ Projekt erstellen',
            () => openProjektModal(up.id)
          )
        ));
      } else {
        const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '16px', marginTop: '32px' } });
        for (const p of projekte) {
          const apCount = (p.arbeitspakete || []).length;
          const projZw = DataStore.getZuweisungenForProjekt(p.id);
          let projKosten = 0;
          for (const zw of projZw) {
            const c = CalcEngine.calculateCosts(zw.mitarbeiterId, zw.prozentAnteil, zw.von, zw.bis, zw.arbeitspaketVerteilung);
            projKosten += c.projektKosten;
          }
          const card = el('div', {
            className: 'card card-clickable', tabindex: '0',
            onClick: () => Router.navigate(`#/projekt/${up.id}/${p.id}`)
          },
            el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
              el('div', null,
                el('h3', { style: { fontSize: '16px', margin: '0 0 4px', color: '#063838' } }, p.name),
                el('span', { className: `badge badge-${p.status}` }, statusLabel(p.status))
              ),
              el('button', {
                className: 'btn-icon',
                onClick: (e) => { e.stopPropagation(); confirmDialog(`Projekt "${p.name}" wirklich löschen?`, () => { DataStore.deleteProjekt(up.id, p.id); Router.resolve(); }); },
                'aria-label': 'Löschen'
              }, trashIcon())
            ),
            el('div', { style: { marginTop: '12px', fontSize: '13px', color: '#64748B' } },
              el('span', null, `${formatDate(p.startDatum)} – ${formatDate(p.endDatum)}`),
            ),
            el('div', { style: { marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #F1F5F9', fontSize: '13px', color: '#64748B', display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
              el('span', null, `${apCount} Arbeitspaket${apCount !== 1 ? 'e' : ''}`),
              projKosten > 0 ? el('span', { style: { fontWeight: '600', color: '#92400E' } }, formatEuro(projKosten)) : null
            )
          );
          grid.appendChild(card);
        }
        container.appendChild(grid);
      }
    }

    // --- Projekt Modal ---
    function buildExportWarning(referenzId) {
      const exports = DataStore.getExportsForRecord(referenzId);
      if (exports.length === 0) return null;
      const latest = exports.sort((a, b) => b.erstelltAm.localeCompare(a.erstelltAm))[0];
      return el('div', { style: { background: '#FEF3C7', border: '1px solid #F59E0B', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', fontSize: '13px', color: '#92400E' } },
        el('strong', null, '\u26A0 GoBD-Hinweis: '),
        `Dieser Datensatz wurde bereits exportiert (${latest.dokumentNummer}). Änderungen werden im Änderungsprotokoll vermerkt.`
      );
    }

    function openProjektModal(ueberProjektId, existing) {
      openModal(existing ? 'Projekt bearbeiten' : 'Neues Projekt', (body, close) => {
        if (existing) { const w = buildExportWarning(existing.id); if (w) body.appendChild(w); }
        const nameInput = el('input', { className: 'form-input', placeholder: 'Projektname', value: existing ? existing.name : '' });
        const descInput = el('textarea', { className: 'form-textarea', placeholder: 'Beschreibung...', rows: '2' });
        if (existing) descInput.value = existing.beschreibung || '';
        const startInput = el('input', { className: 'form-input', type: 'date', value: existing ? existing.startDatum : '' });
        const endInput = el('input', { className: 'form-input', type: 'date', value: existing ? existing.endDatum : '' });
        const statusSelect = el('select', { className: 'form-input' });
        for (const s of ['aktiv', 'geplant', 'abgeschlossen']) {
          const opt = el('option', { value: s }, statusLabel(s));
          if (existing && existing.status === s) opt.selected = true;
          statusSelect.appendChild(opt);
        }
        const budgetInput = el('input', { className: 'form-input', type: 'number', placeholder: 'z.B. 50000', min: '0', step: '1000',
          value: existing && existing.sollKosten != null ? String(existing.sollKosten) : '' });

        body.appendChild(el('div', { style: { marginBottom: '16px' } }, el('label', { className: 'form-label' }, 'Name *'), nameInput));
        body.appendChild(el('div', { style: { marginBottom: '16px' } }, el('label', { className: 'form-label' }, 'Beschreibung'), descInput));
        body.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' } },
          el('div', null, el('label', { className: 'form-label' }, 'Startdatum *'), startInput),
          el('div', null, el('label', { className: 'form-label' }, 'Enddatum *'), endInput)
        ));
        body.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' } },
          el('div', null, el('label', { className: 'form-label' }, 'Status'), statusSelect),
          el('div', null, el('label', { className: 'form-label' }, 'Budget / Soll-Kosten'),
            el('div', { style: { position: 'relative' } },
              budgetInput,
              el('span', { style: { position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', fontSize: '13px', color: '#94A3B8', pointerEvents: 'none' } }, 'EUR')
            )
          )
        ));
        body.appendChild(el('div', { style: { display: 'flex', gap: '12px', justifyContent: 'flex-end' } },
          el('button', { className: 'btn-secondary', onClick: close }, 'Abbrechen'),
          el('button', { className: 'btn-primary', onClick: () => {
            const name = nameInput.value.trim();
            const start = startInput.value;
            const end = endInput.value;
            if (!name) { nameInput.style.borderColor = '#DC2626'; return; }
            if (!start) { startInput.style.borderColor = '#DC2626'; return; }
            if (!end) { endInput.style.borderColor = '#DC2626'; return; }
            if (start > end) { startInput.style.borderColor = '#DC2626'; endInput.style.borderColor = '#DC2626'; alert('Startdatum muss vor dem Enddatum liegen.'); return; }
            const sollKosten = budgetInput.value ? parseFloat(budgetInput.value) : null;
            const projekt = existing ? { ...existing, name, beschreibung: descInput.value.trim(), startDatum: start, endDatum: end, status: statusSelect.value, sollKosten, geaendertAm: new Date().toISOString() }
              : { id: crypto.randomUUID(), name, beschreibung: descInput.value.trim(), startDatum: start, endDatum: end, status: statusSelect.value, arbeitspakete: [], sollKosten, erstelltAm: new Date().toISOString() };
            DataStore.saveProjekt(ueberProjektId, projekt);
            close();
            Router.resolve();
          }}, existing ? 'Speichern' : 'Erstellen')
        ));
      });
    }

    // --- AP Timeline / Gantt Component ---
    const AP_COLORS = ['#0D7377','#6366F1','#EC4899','#8B5CF6','#06B6D4','#10B981','#F97316','#EF4444'];
    const MONTH_SHORT_DE = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];

    // Rich Tooltip System
    const ApTooltip = {
      _el: null,
      show(e, ap, employees, dayCount) {
        this.hide();
        const tt = el('div', { className: 'ap-rich-tooltip' },
          el('div', { className: 'ap-tt-name' }, ap.name),
          el('div', { className: 'ap-tt-row' },
            el('span', null, 'Status'), el('span', null, statusLabel(ap.status))),
          el('div', { className: 'ap-tt-row' },
            el('span', null, 'Zeitraum'),
            el('span', null, ap.startDatum && ap.endDatum ? `${formatDate(ap.startDatum)} – ${formatDate(ap.endDatum)}` : 'Kein Zeitraum')),
          el('div', { className: 'ap-tt-row' },
            el('span', null, 'Werktage'), el('span', null, dayCount !== null ? `${dayCount} Tage` : '\u2013'))
        );
        if (employees.length > 0) {
          const sec = el('div', { className: 'ap-tt-employees' });
          sec.appendChild(el('div', { style: { fontSize: '11px', fontWeight: '600', color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' } }, `${employees.length} Mitarbeiter`));
          for (const emp of employees.slice(0, 5)) {
            sec.appendChild(el('div', { className: 'ap-tt-emp-item' },
              el('span', { className: 'ap-tt-emp-dot' }),
              el('span', null, `${emp.name} (${emp.prozent}%)`)
            ));
          }
          if (employees.length > 5) sec.appendChild(el('div', { style: { fontSize: '11px', color: '#94A3B8', paddingTop: '2px' } }, `+${employees.length - 5} weitere`));
          tt.appendChild(sec);
        }
        document.body.appendChild(tt);
        this._el = tt;
        this._pos(e);
      },
      _pos(e) {
        if (!this._el) return;
        const r = this._el.getBoundingClientRect();
        let x = e.clientX + 12, y = e.clientY + 12;
        if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 12;
        if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 12;
        this._el.style.left = `${Math.max(4, x)}px`;
        this._el.style.top = `${Math.max(4, y)}px`;
      },
      move(e) { if (this._el) this._pos(e); },
      hide() { if (this._el) { this._el.remove(); this._el = null; } }
    };

    function buildApTimeline(targetEl, projekt, ueberProjektId, projektId) {
      const aps = projekt.arbeitspakete || [];
      const flatAps = flattenAPs(aps);

      // --- Build numbering map (1, 1.1, 1.2, 2, 2.1 ...) ---
      const numberMap = {};
      function buildNumbers(items, prefix) {
        let idx = 1;
        for (const item of items) {
          const num = prefix ? `${prefix}.${idx}` : `${idx}`;
          numberMap[item.id] = num;
          if (item.unterArbeitspakete && item.unterArbeitspakete.length > 0) {
            buildNumbers(item.unterArbeitspakete, num);
          }
          idx++;
        }
      }
      buildNumbers(aps, '');

      // --- Count total tasks (recursive sub-AP count) ---
      function countTasks(items) {
        let n = 0;
        for (const item of items) {
          n++;
          if (item.unterArbeitspakete) n += countTasks(item.unterArbeitspakete);
        }
        return n;
      }
      function countDirectChildren(apId) {
        const ap = flatAps.find(a => a.id === apId);
        return ap && ap.unterArbeitspakete ? ap.unterArbeitspakete.length : 0;
      }

      // Status-aware color system
      const STATUS_TINTS = {
        abgeschlossen: { base: '#64748B', light: '#94A3B8' },
        in_bearbeitung: { base: '#0D7377', light: '#0FA8A3' },
        offen: { base: '#D97706', light: '#F59E0B' },
      };
      const colorMap = {};
      flatAps.forEach((ap) => {
        const tint = STATUS_TINTS[ap.status] || STATUS_TINTS.offen;
        colorMap[ap.id] = ap._depth > 0 ? tint.light : tint.base;
      });
      function getStatusBarClass(status) {
        if (status === 'abgeschlossen') return 'ap-gantt-bar--completed';
        if (status === 'offen') return 'ap-gantt-bar--offen';
        return '';
      }

      // State
      let viewMode = 'monat'; // monat | woche | jahr
      const today = new Date();
      let curYear = today.getFullYear();
      let curMonth = today.getMonth();
      let curWeekStart = getMonday(today);

      // If project has a start date, start there
      if (projekt.startDatum) {
        const sd = new Date(projekt.startDatum);
        curYear = sd.getFullYear();
        curMonth = sd.getMonth();
        curWeekStart = getMonday(sd);
      }

      function getMonday(d) {
        const dt = new Date(d);
        const day = dt.getDay();
        const diff = dt.getDate() - day + (day === 0 ? -6 : 1);
        return new Date(dt.getFullYear(), dt.getMonth(), diff);
      }

      function addDays(d, n) {
        const dt = new Date(d);
        dt.setDate(dt.getDate() + n);
        return dt;
      }

      // --- Collapse State ---
      if (!buildApTimeline._collapse) buildApTimeline._collapse = {};
      if (!buildApTimeline._collapse[projektId]) buildApTimeline._collapse[projektId] = new Set();
      const collapsed = buildApTimeline._collapse[projektId];

      function isApVisible(ap) {
        let pid = ap._parentId;
        while (pid) {
          if (collapsed.has(pid)) return false;
          const parent = flatAps.find(a => a.id === pid);
          pid = parent ? parent._parentId : null;
        }
        return true;
      }
      function toggleCollapse(apId) {
        if (collapsed.has(apId)) collapsed.delete(apId); else collapsed.add(apId);
        render();
      }
      function hasChildren(apId) {
        return flatAps.some(a => a._parentId === apId);
      }

      // --- Employee per AP lookup ---
      const zuweisungen = DataStore.getZuweisungenForProjekt(projektId);
      const apEmployeeMap = {};
      for (const zw of zuweisungen) {
        for (const av of (zw.arbeitspaketVerteilung || [])) {
          if (!apEmployeeMap[av.arbeitspaketId]) apEmployeeMap[av.arbeitspaketId] = [];
          const ma = DataStore.getMitarbeiterById(zw.mitarbeiterId);
          if (ma) apEmployeeMap[av.arbeitspaketId].push({ name: ma.name, prozent: av.prozentAnteil });
        }
      }

      function getSubApCompletionRatio(ap) {
        const subs = (ap.unterArbeitspakete || []);
        if (subs.length === 0) return null;
        const done = subs.filter(s => s.status === 'abgeschlossen').length;
        return done / subs.length;
      }

      // --- Shared: buildLabelCell ---
      function buildLabelCell(ap, upId, pId, apCostMap) {
        const depth = ap._depth || 0;
        const indent = depth * 20;
        const cell = el('td', { className: 'ap-td-label' });
        const employees = apEmployeeMap[ap.id] || [];
        const hasKids = hasChildren(ap.id);
        const isCollapsed = collapsed.has(ap.id);
        const apNumber = numberMap[ap.id] || '';
        const childCount = countDirectChildren(ap.id);

        const row = el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', paddingLeft: `${indent}px` } });

        // Chevron for parents
        if (hasKids) {
          row.appendChild(el('span', {
            className: `ap-chevron ${isCollapsed ? 'ap-chevron--collapsed' : ''}`,
            onClick: (e) => { e.stopPropagation(); toggleCollapse(ap.id); }
          }, '\u25BE'));
        } else if (depth > 0) {
          row.appendChild(el('span', { style: { width: '18px', flexShrink: '0' } }));
        }

        // Number badge (1, 1.1, 1.2, 2, ...)
        row.appendChild(el('span', {
          className: `plan-item-number ${depth > 0 ? 'plan-item-number--sub' : ''}`
        }, apNumber));

        // Info block — name is clickable → opens AP calendar
        const nameEl = el('span', {
          className: 'ap-label-name',
          style: { cursor: 'pointer' },
          onClick: (e) => { e.stopPropagation(); Router.navigate(`#/ap-kalender/${upId}/${pId}/${ap.id}`); },
          title: 'Kalender öffnen'
        }, ap.name);
        const info = el('div', { className: 'ap-label-info' },
          nameEl,
          ap.startDatum && ap.endDatum
            ? el('span', { className: 'ap-label-dates' }, `${formatDate(ap.startDatum)} – ${formatDate(ap.endDatum)}`)
            : null
        );
        row.appendChild(info);

        // Status dot
        row.appendChild(el('span', { className: `ap-status-dot ap-status-dot--${ap.status}` }));

        // Tasks count badge (like reference: "4 tasks")
        if (childCount > 0) {
          row.appendChild(el('span', { className: 'plan-item-tasks-badge' },
            el('svg', { width: '12', height: '12', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' },
              el('rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }),
              el('line', { x1: '8', y1: '9', x2: '16', y2: '9' }),
              el('line', { x1: '8', y1: '13', x2: '14', y2: '13' })
            ),
            `${childCount} APs`
          ));
        }

        // Cost badge
        if (apCostMap && apCostMap[ap.id] > 0) {
          row.appendChild(el('span', { style: { fontSize: '10px', padding: '1px 6px', borderRadius: '999px', background: '#FEF3C7', color: '#92400E', fontWeight: '600', whiteSpace: 'nowrap' } }, formatEuro(apCostMap[ap.id])));
        }

        // Employee count
        if (employees.length > 0) {
          row.appendChild(el('span', { className: 'ap-employee-count' }, String(employees.length)));
        }

        // Actions (hidden by default, visible on hover)
        const actions = el('div', { className: 'ap-label-actions' },
          depth < 2 ? el('button', { className: 'btn-icon', style: { width: '24px', height: '24px', fontSize: '12px' },
            onClick: (e) => { e.stopPropagation(); openArbeitspaketModal(upId, pId, null, ap.id); }, title: 'Unter-AP' }, '+') : null,
          el('button', { className: 'btn-icon', style: { width: '24px', height: '24px', fontSize: '11px' },
            onClick: (e) => { e.stopPropagation(); openArbeitspaketModal(upId, pId, ap); }, title: 'Bearbeiten' }, '\u270E'),
          el('button', { className: 'btn-icon', style: { width: '24px', height: '24px', fontSize: '11px' },
            onClick: (e) => {
              e.stopPropagation();
              const hc = (ap.unterArbeitspakete || []).length > 0;
              confirmDialog(
                `"${ap.name}" löschen?${hc ? ' Alle Unter-APs werden ebenfalls gelöscht.' : ''}`,
                () => { removeApFromTree(projekt.arbeitspakete, ap.id); DataStore.saveProjekt(upId, projekt); Router.resolve(); }
              );
            }, title: 'Löschen' }, trashIcon())
        );
        row.appendChild(actions);

        cell.appendChild(row);
        return cell;
      }

      // --- Shared: buildGanttBar ---
      function buildGanttBar(ap, leftPct, widthPct, overflowLeft, overflowRight, upId, pId) {
        const statusCls = getStatusBarClass(ap.status);
        const employees = apEmployeeMap[ap.id] || [];
        const subRatio = getSubApCompletionRatio(ap);
        const apIdx = flatAps.indexOf(ap);

        let dayCount = null;
        if (ap.startDatum && ap.endDatum) {
          dayCount = CalcEngine.countWeekdays(ap.startDatum, ap.endDatum);
        }

        const bar = el('div', {
          className: `ap-gantt-bar ap-gantt-bar--animated ${statusCls}`,
          style: {
            left: `${leftPct}%`,
            width: `${Math.max(widthPct, 2)}%`,
            background: colorMap[ap.id],
            borderTopLeftRadius: overflowLeft ? '0' : '6px',
            borderBottomLeftRadius: overflowLeft ? '0' : '6px',
            borderTopRightRadius: overflowRight ? '0' : '6px',
            borderBottomRightRadius: overflowRight ? '0' : '6px',
            animationDelay: `${apIdx * 0.04}s`,
          },
          onMouseenter: (e) => { ApTooltip.show(e, ap, employees, dayCount); },
          onMousemove: (e) => { ApTooltip.move(e); },
          onMouseleave: () => { ApTooltip.hide(); },
          onClick: () => openArbeitspaketModal(upId, pId, ap)
        });

        // Sub-AP progress overlay
        if (subRatio !== null) {
          bar.appendChild(el('div', { className: 'ap-bar-progress', style: { width: `${Math.round(subRatio * 100)}%` } }));
        }

        // Overflow indicators
        if (overflowLeft) bar.appendChild(el('div', { className: 'ap-overflow-ind ap-overflow-ind--left' }, '\u25C0'));
        if (overflowRight) bar.appendChild(el('div', { className: 'ap-overflow-ind ap-overflow-ind--right' }, '\u25B6'));

        // Label
        if (widthPct > 10) {
          bar.appendChild(el('span', { className: 'ap-gantt-bar-label', style: { position: 'relative', zIndex: '1' } }, ap.name));
        }

        return bar;
      }

      // --- Shared: buildTodayMarker ---
      function buildTodayMarker(todayPct) {
        if (todayPct === null || todayPct < 0 || todayPct > 100) return null;
        const wrapper = el('div', { style: { position: 'absolute', left: `${todayPct}%`, top: '0', bottom: '0', zIndex: '4', pointerEvents: 'none' } });
        // Label "TODAY"
        wrapper.appendChild(el('span', { className: 'plan-marker-label plan-marker-label--today' }, 'HEUTE'));
        // Vertical line
        wrapper.appendChild(el('div', { className: 'plan-marker-line plan-marker-line--today' }));
        return wrapper;
      }

      // Build PROJECT START marker at given percentage
      function buildProjectStartMarker(startPct) {
        if (startPct === null || startPct < 0 || startPct > 100) return null;
        const wrapper = el('div', { style: { position: 'absolute', left: `${startPct}%`, top: '0', bottom: '0', zIndex: '3', pointerEvents: 'none' } });
        wrapper.appendChild(el('span', { className: 'plan-marker-label plan-marker-label--start' }));
        wrapper.appendChild(el('div', { className: 'plan-marker-line plan-marker-line--start' }));
        return wrapper;
      }

      function render() {
        targetEl.innerHTML = '';

        const wrap = el('div', { className: 'ap-timeline-wrap' });

        // --- Toolbar (PLAN ITEMS header matching reference) ---
        const toolbar = el('div', { className: 'ap-timeline-toolbar' });
        toolbar.appendChild(el('h2', null, 'PLAN ITEMS'));

        const toolbarRight = el('div', { className: 'ap-timeline-toolbar-right' });

        // View toggle
        const toggle = el('div', { className: 'ap-view-toggle' });
        const views = [
          { key: 'woche', label: 'Woche' },
          { key: 'monat', label: 'Monat' },
          { key: 'jahr', label: 'Jahr' },
        ];
        for (const v of views) {
          const btn = el('button', {
            className: v.key === viewMode ? 'active' : '',
            onClick: () => { viewMode = v.key; render(); }
          }, v.label);
          toggle.appendChild(btn);
        }
        toolbarRight.appendChild(toggle);

        // Nav
        const nav = el('div', { className: 'ap-timeline-nav' });
        const navLabel = el('span');

        if (viewMode === 'monat') {
          navLabel.textContent = `${MONTH_NAMES_DE[curMonth]} ${curYear}`;
          nav.appendChild(el('button', { onClick: () => {
            if (curMonth === 0) { curMonth = 11; curYear--; } else { curMonth--; }
            render();
          }, 'aria-label': 'Vorheriger Monat' }, '\u2039'));
          nav.appendChild(navLabel);
          nav.appendChild(el('button', { onClick: () => {
            if (curMonth === 11) { curMonth = 0; curYear++; } else { curMonth++; }
            render();
          }, 'aria-label': 'Nächster Monat' }, '\u203A'));
        } else if (viewMode === 'woche') {
          const weekEnd = addDays(curWeekStart, 6);
          navLabel.textContent = `${curWeekStart.getDate()}.${curWeekStart.getMonth()+1}. – ${weekEnd.getDate()}.${weekEnd.getMonth()+1}.${weekEnd.getFullYear()}`;
          nav.appendChild(el('button', { onClick: () => {
            curWeekStart = addDays(curWeekStart, -7);
            render();
          }, 'aria-label': 'Vorherige Woche' }, '\u2039'));
          nav.appendChild(navLabel);
          nav.appendChild(el('button', { onClick: () => {
            curWeekStart = addDays(curWeekStart, 7);
            render();
          }, 'aria-label': 'Nächste Woche' }, '\u203A'));
        } else {
          navLabel.textContent = `${curYear}`;
          nav.appendChild(el('button', { onClick: () => { curYear--; render(); }, 'aria-label': 'Vorheriges Jahr' }, '\u2039'));
          nav.appendChild(navLabel);
          nav.appendChild(el('button', { onClick: () => { curYear++; render(); }, 'aria-label': 'Nächstes Jahr' }, '\u203A'));
        }
        toolbarRight.appendChild(nav);

        // Add AP button
        toolbarRight.appendChild(el('button', {
          className: 'btn-primary',
          style: { padding: '6px 16px', fontSize: '13px' },
          onClick: () => openArbeitspaketModal(ueberProjektId, projektId)
        }, '+ AP'));

        toolbar.appendChild(toolbarRight);
        wrap.appendChild(toolbar);

        // --- Project Info Row (matching reference: name | dates | task count | + Add) ---
        const totalTaskCount = countTasks(aps);
        const topLevelAps = flatAps.filter(a => a._depth === 0);
        const completedAps = topLevelAps.filter(a => a.status === 'abgeschlossen').length;
        const completionPct = topLevelAps.length > 0 ? Math.round((completedAps / topLevelAps.length) * 100) : 0;

        // Calculate project duration in months
        let durationLabel = '';
        if (projekt.startDatum && projekt.endDatum) {
          const sd = new Date(projekt.startDatum);
          const ed = new Date(projekt.endDatum);
          const months = Math.max(1, Math.round((ed - sd) / (30.44 * 24 * 60 * 60 * 1000)));
          durationLabel = `${MONTH_SHORT_DE[sd.getMonth()]} ${sd.getFullYear()} \u2013 ${MONTH_SHORT_DE[ed.getMonth()]} ${ed.getFullYear()} (${months} Monate)`;
        }

        if (flatAps.length > 0 || durationLabel) {
          wrap.appendChild(el('div', { className: 'plan-header-row' },
            el('span', { className: 'plan-header-name' }, projekt.name),
            durationLabel ? el('span', { className: 'plan-header-dates' }, durationLabel) : null,
            el('span', { className: 'plan-header-tasks' },
              el('svg', { width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' },
                el('rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }),
                el('line', { x1: '8', y1: '9', x2: '16', y2: '9' }),
                el('line', { x1: '8', y1: '13', x2: '14', y2: '13' })
              ),
              `${totalTaskCount} tasks`
            ),
            el('button', { className: 'plan-add-btn', onClick: () => openArbeitspaketModal(ueberProjektId, projektId) }, '+ Hinzuf\u00FCgen'),
            // Completion indicator
            completionPct > 0 ? el('div', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' } },
              el('div', { className: 'ap-stat-progress', style: { width: '80px' } }, el('div', { className: 'ap-stat-progress-fill', style: { width: `${completionPct}%` } })),
              el('span', { style: { fontSize: '12px', fontWeight: '700', color: '#0D7377' } }, `${completionPct}%`)
            ) : null
          ));
        }

        // --- Body ---
        if (flatAps.length === 0) {
          wrap.appendChild(el('div', { className: 'ap-timeline-empty' },
            el('div', { className: 'ap-empty-icon' },
              el('svg', { width: '32', height: '32', viewBox: '0 0 24 24', fill: 'none', stroke: '#0D7377', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
                el('rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }),
                el('line', { x1: '3', y1: '8', x2: '21', y2: '8' }),
                el('rect', { x: '6', y: '11', width: '8', height: '2', rx: '1', fill: '#0D7377', stroke: 'none' }),
                el('rect', { x: '6', y: '15', width: '5', height: '2', rx: '1', fill: '#0D7377', stroke: 'none', opacity: '0.5' })
              )
            ),
            el('h3', null, 'Noch keine Arbeitspakete'),
            el('p', null, 'Erstelle das erste Arbeitspaket, um den Projektzeitplan als Gantt-Diagramm zu visualisieren.'),
            el('button', {
              className: 'btn-primary',
              style: { padding: '10px 24px' },
              onClick: () => openArbeitspaketModal(ueberProjektId, projektId)
            }, '+ Arbeitspaket erstellen')
          ));
          targetEl.appendChild(wrap);
          return;
        }

        const body = el('div', { className: 'ap-timeline-body ap-timeline-body--entering' });
        setTimeout(() => body.classList.remove('ap-timeline-body--entering'), 300);
        const todayDs = todayStr();

        // Compute total cost per AP (sum across all assigned employees)
        const _zwForCost = DataStore.getZuweisungenForProjekt(projektId);
        const apCostMap = {};
        for (const ap of flatAps) {
          let total = 0;
          for (const zw of _zwForCost) {
            const c = CalcEngine.calculateCosts(zw.mitarbeiterId, zw.prozentAnteil, zw.von, zw.bis, zw.arbeitspaketVerteilung);
            const entry = c.apKosten.find(a => a.arbeitspaketId === ap.id);
            if (entry) total += entry.kosten;
          }
          apCostMap[ap.id] = total;
        }

        if (viewMode === 'monat') {
          body.appendChild(buildMonthTimeline(flatAps, colorMap, curYear, curMonth, todayDs, ueberProjektId, projektId, apCostMap));
        } else if (viewMode === 'woche') {
          body.appendChild(buildWeekTimeline(flatAps, colorMap, curWeekStart, todayDs, ueberProjektId, projektId, apCostMap));
        } else {
          body.appendChild(buildYearTimeline(flatAps, colorMap, curYear, todayDs, ueberProjektId, projektId, apCostMap));
        }

        wrap.appendChild(body);

        // Legend — status-based colors + AP names
        const legend = el('div', { style: { padding: '12px 20px', borderTop: '1px solid #E2E8F0', display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '12px', color: '#64748B', alignItems: 'center' } });
        flatAps.forEach((ap) => {
          if (ap._depth > 0) return;
          legend.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '5px' } },
            el('span', { className: `ap-status-dot ap-status-dot--${ap.status}`, style: { flexShrink: '0' } }),
            el('span', { style: { fontWeight: '500' } }, ap.name),
            el('span', { style: { fontSize: '10px', color: '#94A3B8' } }, statusLabel(ap.status))
          ));
        });
        // Add status legend entries
        if (flatAps.length > 0) {
          legend.appendChild(el('div', { style: { borderLeft: '1px solid #E2E8F0', paddingLeft: '16px', marginLeft: '8px', display: 'flex', gap: '12px' } },
            el('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
              el('span', { style: { width: '16px', height: '8px', borderRadius: '4px', background: '#0D7377', flexShrink: '0' } }),
              el('span', null, 'Aktiv')),
            el('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
              el('span', { style: { width: '16px', height: '8px', borderRadius: '4px', background: '#64748B', flexShrink: '0', backgroundImage: 'repeating-linear-gradient(135deg,transparent,transparent 2px,rgba(255,255,255,.3) 2px,rgba(255,255,255,.3) 4px)' } }),
              el('span', null, 'Fertig')),
            el('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
              el('span', { style: { width: '16px', height: '8px', borderRadius: '4px', border: '1.5px dashed #D97706', flexShrink: '0', boxSizing: 'border-box' } }),
              el('span', null, 'Offen'))
          ));
        }
        if (legend.children.length > 0) wrap.appendChild(legend);

        targetEl.appendChild(wrap);
      }

      // ======= MONTH VIEW =======
      function buildMonthTimeline(flatAps, colorMap, year, month, todayDs, upId, pId, apCostMap) {
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const table = el('table', { className: 'ap-timeline-table ap-timeline-table--month' });

        // Determine project start day for this month (to gray out days before it)
        let projektStartDay = 0; // 0 = no graying needed
        if (projekt.startDatum) {
          const psd = new Date(projekt.startDatum);
          const psdStr = toDateStr(psd.getFullYear(), psd.getMonth(), psd.getDate());
          const monthFirstStr = toDateStr(year, month, 1);
          if (psdStr > monthFirstStr && psd.getFullYear() === year && psd.getMonth() === month) {
            projektStartDay = psd.getDate(); // days before this are pre-project
          }
        }

        // Header
        const thead = el('thead');
        const hRow = el('tr');
        hRow.appendChild(el('th', { className: 'ap-th-label' }, 'Arbeitspaket'));
        for (let d = 1; d <= daysInMonth; d++) {
          const ds = toDateStr(year, month, d);
          const dow = new Date(year, month, d).getDay();
          const isWeekend = dow === 0 || dow === 6;
          const isToday = ds === todayDs;
          const isBeforeStart = projektStartDay > 0 && d < projektStartDay;
          let cls = '';
          if (isToday) cls = 'ap-th-today';
          else if (isBeforeStart) cls = 'ap-th-weekend'; // dim like weekend
          else if (isWeekend) cls = 'ap-th-weekend';
          const dayLabel = WEEKDAY_HEADERS[(dow + 6) % 7];
          const dimStyle = isBeforeStart ? { minWidth: '32px', opacity: '0.35' } : { minWidth: '32px' };
          hRow.appendChild(el('th', { className: cls, style: dimStyle },
            el('div', { style: { lineHeight: '1.2' } },
              el('div', { style: { fontSize: '10px', opacity: '0.7' } }, dayLabel),
              el('div', null, String(d))
            )
          ));
        }
        thead.appendChild(hRow);
        table.appendChild(thead);

        // Body
        const tbody = el('tbody');
        // Today marker percentage for this month
        const todayDate = new Date();
        let monthTodayPct = null;
        if (todayDate.getFullYear() === year && todayDate.getMonth() === month) {
          monthTodayPct = ((todayDate.getDate() - 0.5) / daysInMonth) * 100;
        }

        // Project start marker percentage for this month
        let monthStartPct = null;
        if (projekt.startDatum) {
          const psd = new Date(projekt.startDatum);
          if (psd.getFullYear() === year && psd.getMonth() === month) {
            monthStartPct = ((psd.getDate() - 0.5) / daysInMonth) * 100;
          }
        }

        for (const ap of flatAps) {
          if (!isApVisible(ap)) continue;
          const row = el('tr');

          // Shared label cell
          row.appendChild(buildLabelCell(ap, upId, pId, apCostMap));

          // Day cells — use a single row container for the bar
          const barRowEl = el('td', {
            colSpan: String(daysInMonth),
            style: { position: 'relative', padding: '0' }
          });

          // Background grid lines for weekends/today/pre-project
          const bgGrid = el('div', { style: { display: 'grid', gridTemplateColumns: `repeat(${daysInMonth}, 1fr)`, height: '100%', position: 'absolute', inset: '0', pointerEvents: 'none' } });
          for (let d = 1; d <= daysInMonth; d++) {
            const ds = toDateStr(year, month, d);
            const dow = new Date(year, month, d).getDay();
            const isWeekend = dow === 0 || dow === 6;
            const isToday = ds === todayDs;
            const isBeforeStart = projektStartDay > 0 && d < projektStartDay;
            let bg = 'transparent';
            if (isBeforeStart) bg = 'rgba(148,163,184,0.10)';
            else if (isWeekend) bg = 'rgba(226,232,240,0.3)';
            if (isToday) bg = 'rgba(13,115,119,0.06)';
            bgGrid.appendChild(el('div', { style: { background: bg, borderRight: '1px solid #F1F5F9' } }));
          }
          barRowEl.appendChild(bgGrid);

          // Project start marker
          if (monthStartPct !== null) {
            const startMarker = buildProjectStartMarker(monthStartPct);
            if (startMarker) barRowEl.appendChild(startMarker);
          }

          // Today marker
          if (monthTodayPct !== null) {
            const marker = buildTodayMarker(monthTodayPct);
            if (marker) barRowEl.appendChild(marker);
          }

          // AP bar
          if (ap.startDatum && ap.endDatum) {
            const monthStart = toDateStr(year, month, 1);
            const monthEnd = toDateStr(year, month, daysInMonth);

            if (ap.startDatum <= monthEnd && ap.endDatum >= monthStart) {
              const barStart = ap.startDatum > monthStart ? ap.startDatum : monthStart;
              const barEnd = ap.endDatum < monthEnd ? ap.endDatum : monthEnd;
              const startDay = parseInt(barStart.split('-')[2], 10);
              const endDay = parseInt(barEnd.split('-')[2], 10);
              const leftPct = ((startDay - 1) / daysInMonth) * 100;
              const widthPct = ((endDay - startDay + 1) / daysInMonth) * 100;
              const overflowLeft = ap.startDatum < monthStart;
              const overflowRight = ap.endDatum > monthEnd;

              barRowEl.appendChild(buildGanttBar(ap, leftPct, widthPct, overflowLeft, overflowRight, upId, pId));
            } else {
              const isBefore = ap.endDatum < monthStart;
              barRowEl.appendChild(el('div', { style: { padding: '12px 8px', fontSize: '11px', color: '#CBD5E1', display: 'flex', alignItems: 'center', gap: '4px' } },
                el('span', null, isBefore ? '\u2190' : '\u2192'),
                el('span', null, isBefore ? `endet ${formatDate(ap.endDatum)}` : `ab ${formatDate(ap.startDatum)}`)
              ));
            }
          } else {
            barRowEl.appendChild(el('div', { style: { padding: '12px 8px', fontSize: '11px', color: '#94A3B8', fontStyle: 'italic' } }, 'Kein Zeitraum'));
          }

          barRowEl.style.height = '44px';
          row.appendChild(barRowEl);
          tbody.appendChild(row);
        }
        table.appendChild(tbody);
        return table;
      }

      // ======= WEEK VIEW =======
      function buildWeekTimeline(flatAps, colorMap, weekStart, todayDs, upId, pId, apCostMap) {
        const table = el('table', { className: 'ap-timeline-table ap-timeline-table--week' });
        const thead = el('thead');
        const hRow = el('tr');
        hRow.appendChild(el('th', { className: 'ap-th-label' }, 'Arbeitspaket'));

        const days = [];
        const pStartDs = projekt.startDatum || '';
        for (let i = 0; i < 7; i++) {
          const d = addDays(weekStart, i);
          const ds = toDateStr(d.getFullYear(), d.getMonth(), d.getDate());
          days.push({ date: d, ds });
          const dow = d.getDay();
          const isWeekend = dow === 0 || dow === 6;
          const isToday = ds === todayDs;
          const isBeforeStart = pStartDs && ds < pStartDs;
          let cls = '';
          if (isToday) cls = 'ap-th-today';
          else if (isBeforeStart) cls = 'ap-th-weekend';
          else if (isWeekend) cls = 'ap-th-weekend';
          const dimStyle = isBeforeStart ? { opacity: '0.35' } : {};
          hRow.appendChild(el('th', { className: cls, style: dimStyle },
            el('div', { style: { lineHeight: '1.2' } },
              el('div', { style: { fontSize: '10px', opacity: '0.7' } }, WEEKDAY_HEADERS[i]),
              el('div', null, `${d.getDate()}.${d.getMonth()+1}.`)
            )
          ));
        }
        thead.appendChild(hRow);
        table.appendChild(thead);

        const tbody = el('tbody');
        // Today marker for week
        let weekTodayPct = null;
        for (let i = 0; i < 7; i++) {
          if (days[i].ds === todayDs) {
            weekTodayPct = ((i + 0.5) / 7) * 100;
            break;
          }
        }
        // Project start marker for week
        let weekStartPct = null;
        if (projekt.startDatum) {
          for (let i = 0; i < 7; i++) {
            if (days[i].ds === projekt.startDatum) {
              weekStartPct = ((i + 0.5) / 7) * 100;
              break;
            }
          }
        }

        for (const ap of flatAps) {
          if (!isApVisible(ap)) continue;
          const row = el('tr');

          // Shared label cell
          row.appendChild(buildLabelCell(ap, upId, pId, apCostMap));

          // Bar across 7 day columns
          const barRowEl = el('td', {
            colSpan: '7',
            style: { position: 'relative', padding: '0', height: '48px' }
          });

          // Background
          const bgGrid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', height: '100%', position: 'absolute', inset: '0', pointerEvents: 'none' } });
          for (let i = 0; i < 7; i++) {
            const d = days[i];
            const dow = d.date.getDay();
            const isWeekend = dow === 0 || dow === 6;
            const isToday = d.ds === todayDs;
            const isBeforeStart = pStartDs && d.ds < pStartDs;
            let bg = 'transparent';
            if (isBeforeStart) bg = 'rgba(148,163,184,0.10)';
            else if (isWeekend) bg = 'rgba(226,232,240,0.3)';
            if (isToday) bg = 'rgba(13,115,119,0.06)';
            bgGrid.appendChild(el('div', { style: { background: bg, borderRight: '1px solid #F1F5F9' } }));
          }
          barRowEl.appendChild(bgGrid);

          // Project start marker
          if (weekStartPct !== null) {
            const startMarker = buildProjectStartMarker(weekStartPct);
            if (startMarker) barRowEl.appendChild(startMarker);
          }

          // Today marker
          if (weekTodayPct !== null) {
            const marker = buildTodayMarker(weekTodayPct);
            if (marker) barRowEl.appendChild(marker);
          }

          if (ap.startDatum && ap.endDatum) {
            const weekStartDs = days[0].ds;
            const weekEndDs = days[6].ds;

            if (ap.startDatum <= weekEndDs && ap.endDatum >= weekStartDs) {
              const barStartDs = ap.startDatum > weekStartDs ? ap.startDatum : weekStartDs;
              const barEndDs = ap.endDatum < weekEndDs ? ap.endDatum : weekEndDs;
              let startIdx = 0, endIdx = 6;
              for (let i = 0; i < 7; i++) {
                if (days[i].ds <= barStartDs) startIdx = i;
                if (days[i].ds <= barEndDs) endIdx = i;
              }
              const leftPct = (startIdx / 7) * 100;
              const widthPct = ((endIdx - startIdx + 1) / 7) * 100;
              const overflowLeft = ap.startDatum < weekStartDs;
              const overflowRight = ap.endDatum > weekEndDs;

              barRowEl.appendChild(buildGanttBar(ap, leftPct, widthPct, overflowLeft, overflowRight, upId, pId));
            } else {
              const isBefore = ap.endDatum < weekStartDs;
              barRowEl.appendChild(el('div', { style: { padding: '14px 8px', fontSize: '11px', color: '#CBD5E1', display: 'flex', alignItems: 'center', gap: '4px' } },
                el('span', null, isBefore ? '\u2190' : '\u2192'),
                el('span', null, isBefore ? `endet ${formatDate(ap.endDatum)}` : `ab ${formatDate(ap.startDatum)}`)
              ));
            }
          } else {
            barRowEl.appendChild(el('div', { style: { padding: '14px 8px', fontSize: '11px', color: '#94A3B8', fontStyle: 'italic' } }, 'Kein Zeitraum'));
          }

          row.appendChild(barRowEl);
          tbody.appendChild(row);
        }
        table.appendChild(tbody);
        return table;
      }

      // ======= YEAR VIEW =======
      function buildYearTimeline(flatAps, colorMap, year, todayDs, upId, pId, apCostMap) {
        const table = el('table', { className: 'ap-timeline-table ap-timeline-table--year' });
        const thead = el('thead');
        const hRow = el('tr');
        hRow.appendChild(el('th', { className: 'ap-th-label' }, 'Arbeitspaket'));

        const todayMonth = new Date().getMonth();
        const todayYear = new Date().getFullYear();
        // Determine project start month for this year (to gray out months before it)
        let projektStartMonth = -1;
        if (projekt.startDatum) {
          const psd = new Date(projekt.startDatum);
          if (psd.getFullYear() === year) projektStartMonth = psd.getMonth();
          else if (psd.getFullYear() > year) projektStartMonth = 12; // entire year is before project
        }
        for (let m = 0; m < 12; m++) {
          const isCurrentMonth = (year === todayYear && m === todayMonth);
          const isBeforeStart = projektStartMonth >= 0 && m < projektStartMonth;
          const dimStyle = isBeforeStart ? { minWidth: '60px', opacity: '0.35' } : { minWidth: '60px' };
          let cls = isCurrentMonth ? 'ap-th-today' : (isBeforeStart ? 'ap-th-weekend' : '');
          hRow.appendChild(el('th', { className: cls, style: dimStyle }, MONTH_SHORT_DE[m]));
        }
        thead.appendChild(hRow);
        table.appendChild(thead);

        const tbody = el('tbody');
        // Today marker for year view
        let yearTodayPct = null;
        if (todayYear === year) {
          const td = new Date();
          const daysInTodayMonth = new Date(td.getFullYear(), td.getMonth() + 1, 0).getDate();
          const frac = td.getMonth() + (td.getDate() - 0.5) / daysInTodayMonth;
          yearTodayPct = (frac / 12) * 100;
        }
        // Project start marker for year view
        let yearStartPct = null;
        if (projekt.startDatum) {
          const psd = new Date(projekt.startDatum);
          if (psd.getFullYear() === year) {
            const daysInPsMonth = new Date(psd.getFullYear(), psd.getMonth() + 1, 0).getDate();
            const sFrac = psd.getMonth() + (psd.getDate() - 0.5) / daysInPsMonth;
            yearStartPct = (sFrac / 12) * 100;
          }
        }

        for (const ap of flatAps) {
          if (!isApVisible(ap)) continue;
          const row = el('tr');

          // Shared label cell
          row.appendChild(buildLabelCell(ap, upId, pId, apCostMap));

          // Bar across 12 month columns
          const barRowEl = el('td', {
            colSpan: '12',
            style: { position: 'relative', padding: '0', height: '36px' }
          });

          // Background grid
          const bgGrid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', height: '100%', position: 'absolute', inset: '0', pointerEvents: 'none' } });
          for (let m = 0; m < 12; m++) {
            const isCurrentMonth = (year === todayYear && m === todayMonth);
            const isBeforeStart = projektStartMonth >= 0 && m < projektStartMonth;
            let bg = 'transparent';
            if (isBeforeStart) bg = 'rgba(148,163,184,0.10)';
            else if (isCurrentMonth) bg = 'rgba(13,115,119,0.06)';
            bgGrid.appendChild(el('div', { style: { background: bg, borderRight: '1px solid #F1F5F9' } }));
          }
          barRowEl.appendChild(bgGrid);

          // Project start marker
          if (yearStartPct !== null) {
            const startMarker = buildProjectStartMarker(yearStartPct);
            if (startMarker) barRowEl.appendChild(startMarker);
          }

          // Today marker
          if (yearTodayPct !== null) {
            const marker = buildTodayMarker(yearTodayPct);
            if (marker) barRowEl.appendChild(marker);
          }

          if (ap.startDatum && ap.endDatum) {
            const yearStart = `${year}-01-01`;
            const yearEnd = `${year}-12-31`;

            if (ap.startDatum <= yearEnd && ap.endDatum >= yearStart) {
              const clampStart = ap.startDatum > yearStart ? ap.startDatum : yearStart;
              const clampEnd = ap.endDatum < yearEnd ? ap.endDatum : yearEnd;

              const startDate = new Date(clampStart);
              const endDate = new Date(clampEnd);
              const daysInStartMonth = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0).getDate();
              const daysInEndMonth = new Date(endDate.getFullYear(), endDate.getMonth() + 1, 0).getDate();

              const startFrac = startDate.getMonth() + (startDate.getDate() - 1) / daysInStartMonth;
              const endFrac = endDate.getMonth() + endDate.getDate() / daysInEndMonth;

              const leftPct = (startFrac / 12) * 100;
              const widthPct = ((endFrac - startFrac) / 12) * 100;

              const overflowLeft = ap.startDatum < yearStart;
              const overflowRight = ap.endDatum > yearEnd;

              barRowEl.appendChild(buildGanttBar(ap, leftPct, Math.max(widthPct, 2), overflowLeft, overflowRight, upId, pId));
            }
          } else {
            barRowEl.appendChild(el('div', { style: { padding: '8px', fontSize: '11px', color: '#94A3B8', fontStyle: 'italic' } }, 'Kein Zeitraum'));
          }

          row.appendChild(barRowEl);
          tbody.appendChild(row);
        }
        table.appendChild(tbody);
        return table;
      }

      render();
    }

    // --- Cost Overview Section ---
    function buildCostOverview(container, projekt, zuweisungen) {
      const employeeCosts = [];
      let totalIstKosten = 0;
      for (const zw of zuweisungen) {
        const ma = DataStore.getMitarbeiterById(zw.mitarbeiterId);
        const calc = CalcEngine.calculateCosts(zw.mitarbeiterId, zw.prozentAnteil, zw.von, zw.bis, zw.arbeitspaketVerteilung);
        totalIstKosten += calc.projektKosten;
        if (ma && calc.projektKosten > 0) {
          employeeCosts.push({ name: ma.name, kosten: calc.projektKosten, id: ma.id });
        }
      }

      const sollKosten = projekt.sollKosten;
      const hasBudget = sollKosten != null && sollKosten > 0;
      const hasEmployees = employeeCosts.length > 0;
      if (!hasBudget && !hasEmployees) return;

      const section = el('div', { className: 'cost-overview' });
      const card = el('div', { className: 'cost-overview-card' });

      // Header
      card.appendChild(el('div', { className: 'cost-overview-header' },
        el('h2', { style: { fontSize: '18px', margin: '0', color: '#063838' } }, 'Kostenübersicht'),
        totalIstKosten > 0
          ? el('span', { style: { fontSize: '13px', fontWeight: '600', color: hasBudget && totalIstKosten > sollKosten ? '#DC2626' : '#0D7377' } },
              `Ist: ${formatEuro(totalIstKosten)}`)
          : null
      ));

      const body = el('div', { className: 'cost-overview-body' });

      // --- LEFT: Soll/Ist bars ---
      const left = el('div', { className: 'cost-overview-left' });
      if (hasBudget) {
        const maxVal = Math.max(sollKosten, totalIstKosten);
        const sollPct = maxVal > 0 ? (sollKosten / maxVal) * 100 : 0;
        const istPct = maxVal > 0 ? (totalIstKosten / maxVal) * 100 : 0;
        const isOver = totalIstKosten > sollKosten;

        // Soll bar
        left.appendChild(el('div', { className: 'cost-bar-group' },
          el('div', { className: 'cost-bar-label' },
            el('span', null, 'Soll-Kosten (Budget)'),
            el('span', { style: { fontWeight: '700', color: '#0D7377' } }, formatEuro(sollKosten))
          ),
          el('div', { className: 'cost-bar-track' },
            el('div', { className: 'cost-bar-fill cost-bar-fill--soll', style: { width: `${sollPct}%` } }))
        ));

        // Ist bar
        left.appendChild(el('div', { className: 'cost-bar-group' },
          el('div', { className: 'cost-bar-label' },
            el('span', null, 'Ist-Kosten (Berechnet)'),
            el('span', { style: { fontWeight: '700', color: isOver ? '#DC2626' : '#92400E' } }, formatEuro(totalIstKosten))
          ),
          el('div', { className: 'cost-bar-track' },
            el('div', { className: `cost-bar-fill ${isOver ? 'cost-bar-fill--ist-over' : 'cost-bar-fill--ist-ok'}`, style: { width: `${Math.min(istPct, 100)}%` } }))
        ));

        // Budget utilization
        const utilPct = sollKosten > 0 ? Math.round((totalIstKosten / sollKosten) * 100) : 0;
        const diff = sollKosten - totalIstKosten;
        const utilColor = utilPct <= 75 ? '#0D7377' : utilPct <= 100 ? '#F59E0B' : '#DC2626';
        const utilBg = utilPct <= 75 ? 'linear-gradient(90deg, #0D7377, #2BC8C4)' : utilPct <= 100 ? 'linear-gradient(90deg, #F59E0B, #FBBF24)' : 'linear-gradient(90deg, #DC2626, #EF4444)';

        left.appendChild(el('div', { style: { marginTop: '20px', paddingTop: '20px', borderTop: '1px solid #F1F5F9' } },
          el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '4px' } },
            el('span', { style: { fontSize: '13px', fontWeight: '500', color: '#475569' } }, 'Budgetauslastung'),
            el('span', { style: { fontSize: '20px', fontWeight: '700', color: utilColor } }, `${utilPct}%`)
          ),
          el('div', { className: 'budget-util-track' },
            el('div', { className: 'budget-util-fill', style: { width: `${Math.min(utilPct, 100)}%`, background: utilBg } })
          ),
          el('p', { style: { fontSize: '12px', color: '#64748B', margin: '8px 0 0' } },
            diff >= 0 ? `${formatEuro(diff)} unter Budget` : `${formatEuro(Math.abs(diff))} über Budget`)
        ));
      } else {
        left.appendChild(el('div', { style: { padding: '24px', textAlign: 'center', color: '#64748B', fontSize: '13px' } },
          el('p', { style: { margin: '0 0 8px', fontSize: '32px', opacity: '0.3' } }, '\uD83D\uDCB0'),
          el('p', { style: { margin: '0 0 4px', fontWeight: '600', color: '#475569' } }, 'Kein Budget definiert'),
          el('p', { style: { margin: '0' } }, 'Bearbeite das Projekt, um Soll-Kosten festzulegen.')
        ));
      }
      body.appendChild(left);

      // --- RIGHT: Donut chart (progress towards Soll-Kosten) ---
      const right = el('div', { className: 'cost-overview-right' });
      if (hasEmployees) {
        const colors = ['#0D7377','#6366F1','#EC4899','#8B5CF6','#06B6D4','#10B981','#F97316','#EF4444'];
        const gradientParts = [];
        let currentAngle = 0;
        // Scale relative to budget if set, otherwise relative to total Ist
        const donutRef = hasBudget ? Math.max(sollKosten, totalIstKosten) : totalIstKosten;
        for (let i = 0; i < employeeCosts.length; i++) {
          const emp = employeeCosts[i];
          const pct = donutRef > 0 ? (emp.kosten / donutRef) * 360 : 0;
          const color = colors[i % colors.length];
          emp._color = color;
          const endAngle = currentAngle + pct;
          gradientParts.push(`${color} ${currentAngle}deg ${endAngle}deg`);
          currentAngle = endAngle;
        }
        // Add remaining budget as gray segment
        if (hasBudget && totalIstKosten < sollKosten) {
          gradientParts.push(`#E2E8F0 ${currentAngle}deg 360deg`);
        }
        // If over budget or no budget, employee segments fill 360deg — close any gap
        if (currentAngle < 360 && !(hasBudget && totalIstKosten < sollKosten)) {
          gradientParts.push(`${employeeCosts[employeeCosts.length - 1]._color} ${currentAngle}deg 360deg`);
        }

        // Center content: show budget progress if budget set, otherwise just total
        const utilPctDonut = hasBudget && sollKosten > 0 ? Math.round((totalIstKosten / sollKosten) * 100) : null;
        const utilColorDonut = utilPctDonut !== null
          ? (utilPctDonut <= 75 ? '#0D7377' : utilPctDonut <= 100 ? '#F59E0B' : '#DC2626')
          : '#063838';

        const donutCenter = hasBudget
          ? el('div', { className: 'cost-donut-hole' },
              el('span', { className: 'cost-donut-total', style: { fontSize: '22px', color: utilColorDonut } }, `${utilPctDonut}%`),
              el('span', { className: 'cost-donut-sublabel' }, formatEuro(totalIstKosten)),
              el('span', { className: 'cost-donut-sublabel', style: { fontSize: '10px' } }, `von ${formatEuro(sollKosten)}`)
            )
          : el('div', { className: 'cost-donut-hole' },
              el('span', { className: 'cost-donut-total' }, formatEuro(totalIstKosten)),
              el('span', { className: 'cost-donut-sublabel' }, 'Gesamt')
            );

        right.appendChild(el('div', { className: 'cost-donut', style: { background: `conic-gradient(${gradientParts.join(', ')})` } },
          donutCenter
        ));

        const legend = el('div', { className: 'cost-legend' });
        for (const emp of employeeCosts) {
          const empPct = totalIstKosten > 0 ? Math.round((emp.kosten / totalIstKosten) * 100) : 0;
          legend.appendChild(el('div', { className: 'cost-legend-item' },
            el('div', { className: 'cost-legend-dot', style: { background: emp._color } }),
            el('span', null, `${emp.name} · ${formatEuro(emp.kosten)} (${empPct}%)`)
          ));
        }
        right.appendChild(legend);
      } else {
        right.appendChild(el('div', { style: { textAlign: 'center', color: '#64748B', fontSize: '13px' } },
          el('p', { style: { margin: '0 0 8px', fontSize: '32px', opacity: '0.3' } }, '\uD83D\uDC65'),
          el('p', { style: { margin: '0', fontWeight: '500' } }, 'Keine Mitarbeiter zugewiesen')
        ));
      }
      body.appendChild(right);

      card.appendChild(body);
      section.appendChild(card);
      container.appendChild(section);
    }

    // --- Förderübersicht Section ---
    function buildFoerderuebersicht(container, ueberProjekt, projekt, zuweisungen) {
      const typ = ueberProjekt.unternehmensTyp || 'kmu';
      const foerderRate = typ === 'grossunternehmen' ? 0.25 : 0.35;
      const foerderLabel = typ === 'grossunternehmen' ? '25 %' : '35 %';
      const typLabel = typ === 'grossunternehmen' ? 'Großunternehmen' : 'KMU';
      const typColor = typ === 'grossunternehmen' ? '#6366F1' : '#0D7377';

      // Compute Ist-Kosten
      let totalIstKosten = 0;
      for (const zw of zuweisungen) {
        const calc = CalcEngine.calculateCosts(zw.mitarbeiterId, zw.prozentAnteil, zw.von, zw.bis, zw.arbeitspaketVerteilung);
        totalIstKosten += calc.projektKosten;
      }

      const sollKosten = projekt.sollKosten;
      const hasBudget = sollKosten != null && sollKosten > 0;

      // Förderung at full budget (Soll) and at current costs (Ist)
      const foerderSoll = hasBudget ? Math.round(sollKosten * foerderRate * 100) / 100 : null;
      const foerderIst = Math.round(totalIstKosten * foerderRate * 100) / 100;

      const section = el('div', { style: { marginTop: '32px' } });
      const card = el('div', { className: 'cost-overview-card' });

      // Header
      card.appendChild(el('div', { className: 'cost-overview-header' },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          el('h2', { style: { fontSize: '18px', margin: '0', color: '#063838' } }, 'Förderübersicht'),
          el('span', { style: { fontSize: '10px', padding: '2px 8px', borderRadius: '999px', background: typColor + '15', color: typColor, fontWeight: '600' } }, typLabel),
          el('span', { style: { fontSize: '10px', padding: '2px 8px', borderRadius: '999px', background: '#F0FDF4', color: '#15803D', fontWeight: '600' } }, foerderLabel + ' Förderquote')
        )
      ));

      const body = el('div', { style: { padding: '24px' } });

      // Two-column layout for Soll and Ist Förderung
      const grid = el('div', { style: { display: 'grid', gridTemplateColumns: hasBudget ? '1fr 1fr' : '1fr', gap: '24px', marginBottom: '24px' } });

      // Ist Förderung (current)
      const istCard = el('div', { style: { background: '#F0FDF4', borderRadius: '10px', padding: '20px', border: '1px solid #BBF7D0' } },
        el('div', { style: { fontSize: '12px', fontWeight: '600', color: '#15803D', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' } }, 'Aktuelle Förderung'),
        el('div', { style: { fontSize: '28px', fontWeight: '700', color: '#15803D', marginBottom: '4px', fontFamily: '"DM Serif Display", serif' } }, formatEuro(foerderIst)),
        el('div', { style: { fontSize: '12px', color: '#64748B' } },
          `${foerderLabel} von ${formatEuro(totalIstKosten)} Ist-Kosten`)
      );
      grid.appendChild(istCard);

      // Soll Förderung (at full budget)
      if (hasBudget) {
        const sollCard = el('div', { style: { background: '#F8FAFC', borderRadius: '10px', padding: '20px', border: '1px solid #E2E8F0' } },
          el('div', { style: { fontSize: '12px', fontWeight: '600', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' } }, 'Förderung bei Soll-Kosten'),
          el('div', { style: { fontSize: '28px', fontWeight: '700', color: '#063838', marginBottom: '4px', fontFamily: '"DM Serif Display", serif' } }, formatEuro(foerderSoll)),
          el('div', { style: { fontSize: '12px', color: '#64748B' } },
            `${foerderLabel} von ${formatEuro(sollKosten)} Budget`)
        );
        grid.appendChild(sollCard);
      }

      body.appendChild(grid);

      // Progress bar: Ist-Förderung towards Soll-Förderung
      if (hasBudget && foerderSoll > 0) {
        const pct = Math.round((foerderIst / foerderSoll) * 100);
        const remaining = foerderSoll - foerderIst;

        body.appendChild(el('div', { style: { marginBottom: '16px' } },
          el('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' } },
            el('span', { style: { fontWeight: '500', color: '#475569' } }, 'Förderfortschritt'),
            el('span', { style: { fontWeight: '700', color: '#15803D' } }, `${pct}%`)
          ),
          el('div', { style: { height: '12px', background: '#E2E8F0', borderRadius: '6px', overflow: 'hidden' } },
            el('div', { style: {
              height: '100%', borderRadius: '6px',
              width: `${Math.min(pct, 100)}%`,
              background: 'linear-gradient(90deg, #22C55E, #4ADE80)',
              transition: 'width 0.8s cubic-bezier(0.16, 1, 0.3, 1)'
            } })
          ),
          el('p', { style: { fontSize: '12px', color: '#64748B', margin: '6px 0 0' } },
            remaining > 0
              ? `Noch ${formatEuro(remaining)} Förderung bis zum Budget-Ziel`
              : 'Budget-Förderziel erreicht')
        ));
      }

      // Info footer
      body.appendChild(el('div', { style: { padding: '12px 16px', background: '#FFFBEB', borderRadius: '8px', border: '1px solid #FDE68A', fontSize: '12px', color: '#92400E', display: 'flex', gap: '8px', alignItems: 'flex-start' } },
        el('span', { style: { fontSize: '14px', flexShrink: '0' } }, '\u2139\uFE0F'),
        el('span', null, `${typLabel} erhalten eine Förderquote von ${foerderLabel} auf die förderfähigen Gesamtkosten. Die tatsächliche Förderhöhe kann je nach Programm und Bewilligungsbescheid abweichen.`)
      ));

      card.appendChild(body);
      section.appendChild(card);
      container.appendChild(section);
    }

    // --- Projekt Detail (placeholder for Phase 3+) ---
    function renderProjekt(container, ueberProjektId, projektId) {
      const up = DataStore.getUeberProjekt(ueberProjektId);
      if (!up) { container.appendChild(el('p', { style: { color: '#DC2626' } }, 'Über-Projekt nicht gefunden.')); return; }
      if (up.nurAdmin && !AuthSystem.isAdmin()) { container.appendChild(renderEmptyState('Kein Zugriff', 'Dieses Projekt ist nur für Admin-Benutzer sichtbar.', 'Zum Dashboard', () => Router.navigate('#/dashboard'))); return; }
      const p = (up.projekte || []).find(pr => pr.id === projektId);
      if (!p) { container.appendChild(el('p', { style: { color: '#DC2626' } }, 'Projekt nicht gefunden.')); return; }

      // Breadcrumb
      container.appendChild(el('div', { style: { marginBottom: '24px', fontSize: '13px', color: '#64748B', display: 'flex', alignItems: 'center' } },
        el('a', { href: '#/dashboard', style: { color: '#0D7377', textDecoration: 'none' } }, 'Dashboard'),
        breadcrumbChevron(),
        el('a', { href: `#/ueberprojekt/${up.id}`, style: { color: '#0D7377', textDecoration: 'none' } }, up.name),
        breadcrumbChevron(),
        el('span', null, p.name)
      ));

      // Header — "Plan & Timeline" title like the reference
      container.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' } },
        el('div', null,
          el('h1', { style: { fontSize: '28px', margin: '0 0 4px', color: '#063838' } }, 'Plan & Zeitplan'),
          el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' } },
            el('span', { style: { fontSize: '14px', color: '#475569', fontWeight: '500' } }, p.name),
            el('span', { className: `badge badge-${p.status}` }, statusLabel(p.status))
          )
        ),
        el('div', { style: { display: 'flex', gap: '8px' } },
          el('button', { className: 'btn-secondary', onClick: () => openExportDialog('projekt', projektId, { ueberProjektId, von: p.startDatum, bis: p.endDatum }) }, 'PDF Export'),
          el('button', { className: 'btn-secondary', onClick: () => PDFExport.projektplanBericht(ueberProjektId, projektId) }, 'Projektplan'),
          el('button', { className: 'btn-secondary', onClick: () => Router.navigate(`#/projekt-kalender/${ueberProjektId}/${projektId}`) }, 'Kalender'),
          el('button', { className: 'btn-secondary', onClick: () => openProjektModal(ueberProjektId, p) }, 'Bearbeiten')
        )
      ));

      // ─── Tab Navigation (matching reference image) ───
      const TAB_ICONS = {
        plan: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/></svg>',
        kosten: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
        personal: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
        foerder: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
        extern: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
      };
      const tabDefs = [
        { id: 'plan', label: 'Plan & Zeitplan' },
        { id: 'kosten', label: 'Kostenübersicht' },
        { id: 'personal', label: 'Personalplan' },
        { id: 'foerder', label: 'Förderplan' },
        { id: 'extern', label: 'Externe Entwicklung' },
      ];
      const tabBar = el('div', { className: 'plan-tabs' });
      const tabPanels = {};
      let activeTab = 'plan';

      function switchTab(tabId) {
        activeTab = tabId;
        tabBar.querySelectorAll('.plan-tab').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.tab === tabId);
        });
        Object.entries(tabPanels).forEach(([id, panel]) => {
          panel.classList.toggle('active', id === tabId);
        });
      }

      for (const tab of tabDefs) {
        const iconSpan = el('span', { className: 'plan-tab-icon' });
        iconSpan.innerHTML = TAB_ICONS[tab.id] || '';
        const tabBtn = el('button', {
          className: `plan-tab ${tab.id === activeTab ? 'active' : ''}`,
          'data-tab': tab.id,
          onClick: () => switchTab(tab.id)
        }, iconSpan, tab.label);
        tabBar.appendChild(tabBtn);
      }
      container.appendChild(tabBar);

      // ─── Tab 1: Plan & Zeitplan (rendered immediately) ───
      const planPanel = el('div', { className: 'plan-tab-content active' });
      const apTimelineContainer = el('div');
      buildApTimeline(apTimelineContainer, p, ueberProjektId, projektId);
      planPanel.appendChild(apTimelineContainer);
      tabPanels['plan'] = planPanel;
      container.appendChild(planPanel);

      // ─── Lazy tab builders (render on first switch) ───
      const lazyBuilt = { plan: true };
      const zuweisungen = DataStore.getZuweisungenForProjekt(projektId);

      function buildPersonalPanel(panel) {
        const zwSection = el('div', { style: { marginTop: '8px' } });
        zwSection.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' } },
          el('h2', { style: { fontSize: '18px', margin: '0', color: '#063838' } }, 'Zuweisungen'),
          el('button', { className: 'btn-secondary', onClick: () => openZuweisungModal(ueberProjektId, projektId) }, '+ Mitarbeiter zuweisen')
        ));
        const zwList = DataStore.getZuweisungenForProjekt(projektId);
        if (zwList.length === 0) {
          zwSection.appendChild(renderEmptyState(
            'Keine Zuweisungen',
            'Weise Mitarbeiter diesem Projekt zu, um die Arbeitszeit zu verteilen.',
            '+ Mitarbeiter zuweisen',
            () => openZuweisungModal(ueberProjektId, projektId)
          ));
        } else {
          const table = el('table', { className: 'data-table' });
          const thead = el('thead', null, el('tr', null,
            el('th', null, 'Mitarbeiter'),
            el('th', null, 'Anteil'),
            el('th', null, 'Zeitraum'),
            el('th', null, 'Verfügb. Tage'),
            el('th', null, 'Projekt-Tage'),
            el('th', null, 'Kosten'),
            el('th', { style: { width: '60px' } }, '')
          ));
          table.appendChild(thead);
          const tbody = el('tbody');
          let totalProjektKosten = 0;
          for (const zw of zwList) {
            const ma = DataStore.getMitarbeiterById(zw.mitarbeiterId);
            const calc = CalcEngine.calculateCosts(zw.mitarbeiterId, zw.prozentAnteil, zw.von, zw.bis, zw.arbeitspaketVerteilung);
            totalProjektKosten += calc.projektKosten;
            tbody.appendChild(el('tr', null,
              el('td', { style: { fontWeight: '500' } }, ma ? ma.name : 'Unbekannt'),
              el('td', null, `${zw.prozentAnteil}%`),
              el('td', null, `${formatDate(zw.von)} – ${formatDate(zw.bis)}`),
              el('td', null, `${calc.verfuegbar}`),
              el('td', { style: { fontWeight: '600', color: '#0D7377' } }, `${calc.projektTage}`),
              el('td', { style: { fontWeight: '600', color: '#F59E0B' } }, formatEuro(calc.projektKosten)),
              el('td', { style: { display: 'flex', gap: '4px' } },
                el('button', { className: 'btn-icon', onClick: () => openZuweisungModal(ueberProjektId, projektId, zw), 'aria-label': 'Bearbeiten' }, '\u270F\uFE0F'),
                el('button', { className: 'btn-icon', onClick: () => confirmDialog('Zuweisung löschen?', () => { DataStore.deleteZuweisung(zw.id); Router.resolve(); }), 'aria-label': 'Löschen' }, trashIcon())
              )
            ));
          }
          table.appendChild(tbody);
          if (totalProjektKosten > 0) {
            const tfoot = el('tfoot', null, el('tr', { style: { background: '#FEF3C7' } },
              el('td', { colSpan: '5', style: { textAlign: 'right', paddingRight: '12px', fontWeight: '700', color: '#063838' } }, 'Gesamt-Projektkosten:'),
              el('td', { style: { fontWeight: '700', color: '#92400E' } }, formatEuro(totalProjektKosten)),
              el('td', null, '')
            ));
            table.appendChild(tfoot);
          }
          const tableWrap = el('div', { className: 'card', style: { padding: '0', overflow: 'auto' } });
          tableWrap.appendChild(table);
          zwSection.appendChild(tableWrap);
        }
        panel.appendChild(zwSection);
      }

      const lazyTabs = {
        kosten: (panel) => buildCostOverview(panel, p, zuweisungen),
        personal: (panel) => buildPersonalPanel(panel),
        foerder: (panel) => buildFoerderuebersicht(panel, up, p, zuweisungen),
        extern: (panel) => buildExterneEntwicklung(panel, ueberProjektId, projektId),
      };

      // Create empty panels, build on first switch
      for (const tabId of ['kosten', 'personal', 'foerder', 'extern']) {
        const panel = el('div', { className: 'plan-tab-content' });
        tabPanels[tabId] = panel;
        container.appendChild(panel);
      }

      const origSwitchTab = switchTab;
      switchTab = function(tabId) {
        if (!lazyBuilt[tabId] && lazyTabs[tabId]) {
          lazyTabs[tabId](tabPanels[tabId]);
          lazyBuilt[tabId] = true;
        }
        origSwitchTab(tabId);
      };
    }

    // --- Externe Entwicklung (Backend-Dokumente) ---
    async function buildExterneEntwicklung(container, ueberProjektId, projektId) {
      const section = el('div', { style: { marginTop: '8px' } });
      const isEditable = AuthSystem.isAdmin() || (AuthSystem.getCurrentUser() && AuthSystem.getCurrentUser().role === 'editor');

      // Header
      section.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' } },
        el('h2', { style: { fontSize: '18px', margin: '0', color: '#063838' } }, 'Externe Entwicklung'),
        isEditable ? el('button', { className: 'btn-secondary', onClick: () => openDokumentUploadModal(projektId) }, '+ Dokument hochladen') : null
      ));

      try {
        const docs = await DataStoreAPI.getDokumente(projektId);

        if (!docs || docs.length === 0) {
          section.appendChild(renderEmptyState(
            'Keine Dokumente',
            'Lade PDF-Dokumente für externe Entwicklungsleistungen hoch.',
            isEditable ? '+ Dokument hochladen' : null,
            isEditable ? () => openDokumentUploadModal(projektId) : null
          ));
        } else {
          const card = el('div', { className: 'card', style: { padding: '20px' } });
          card.appendChild(el('div', { style: { marginBottom: '12px' } },
            el('span', { style: { fontSize: '13px', color: '#64748B' } }, `${docs.length} Dokument${docs.length !== 1 ? 'e' : ''}`)
          ));

          const docList = el('div');
          for (const doc of docs) {
            const sizeStr = doc.size < 1024 * 1024
              ? `${Math.round(doc.size / 1024)} KB`
              : `${(doc.size / (1024 * 1024)).toFixed(1)} MB`;
            const dt = new Date(doc.createdAt);
            const dateStr = `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')}.${dt.getFullYear()}`;
            docList.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #F1F5F9' } },
              el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                el('span', { style: { fontSize: '18px' } }, '\uD83D\uDCC4'),
                el('div', null,
                  el('span', { style: { fontSize: '14px', fontWeight: '500', color: '#334155', cursor: 'pointer', textDecoration: 'underline', textDecorationColor: '#CBD5E1' }, onClick: () => downloadBackendDocument(doc) }, doc.name),
                  el('span', { style: { fontSize: '12px', color: '#94A3B8', marginLeft: '8px' } }, sizeStr),
                  el('span', { style: { fontSize: '12px', color: '#94A3B8', marginLeft: '8px' } }, dateStr)
                )
              ),
              el('div', { style: { display: 'flex', gap: '4px' } },
                el('button', { className: 'btn-icon', style: { fontSize: '14px' }, onClick: () => downloadBackendDocument(doc), 'aria-label': 'Herunterladen' }, '\u2B07\uFE0F'),
                isEditable ? el('button', { className: 'btn-icon', style: { fontSize: '14px', color: '#DC2626' }, onClick: () => confirmDialog(`"${doc.name}" wirklich löschen?`, async () => { await DataStoreAPI.deleteDokument(doc.id); Router.resolve(); }), 'aria-label': 'Löschen' }, trashIcon()) : null
              )
            ));
          }
          card.appendChild(docList);
          section.appendChild(card);
        }
      } catch (e) {
        section.appendChild(el('div', { className: 'card', style: { padding: '20px' } },
          el('p', { style: { color: '#DC2626' } }, 'Fehler beim Laden der Dokumente: ' + e.message)
        ));
      }
      container.appendChild(section);
    }

    async function downloadBackendDocument(doc) {
      try {
        const blob = await DataStoreAPI.downloadDokument(doc.id);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = doc.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (e) {
        alert('Download fehlgeschlagen: ' + e.message);
      }
    }

    function openDokumentUploadModal(projektId) {
      openModal('Dokument hochladen', (body, close) => {
        const fileInput = el('input', { type: 'file', accept: '.pdf', multiple: true, style: { display: 'none' } });
        let selectedFiles = [];

        const fileListContainer = el('div', { style: { marginBottom: '16px' } });
        function renderFileList() {
          fileListContainer.innerHTML = '';
          if (selectedFiles.length === 0) return;
          fileListContainer.appendChild(el('label', { className: 'form-label', style: { marginBottom: '8px' } }, 'Ausgewählte Dateien'));
          for (let i = 0; i < selectedFiles.length; i++) {
            const file = selectedFiles[i];
            const sizeStr = file.size < 1024 * 1024
              ? `${Math.round(file.size / 1024)} KB`
              : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
            const idx = i;
            fileListContainer.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: '#F8FAFC', borderRadius: '8px', marginBottom: '4px' } },
              el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                el('span', null, '\uD83D\uDCC4'),
                el('span', { style: { fontSize: '14px', color: '#334155' } }, file.name),
                el('span', { style: { fontSize: '12px', color: '#94A3B8' } }, sizeStr)
              ),
              el('button', { className: 'btn-icon', style: { fontSize: '14px', color: '#DC2626' }, onClick: () => { selectedFiles.splice(idx, 1); renderFileList(); }, 'aria-label': 'Entfernen' }, '\u2716')
            ));
          }
        }
        body.appendChild(fileListContainer);

        // Upload zone
        const uploadZone = el('div', {
          style: { border: '2px dashed #CBD5E1', borderRadius: '12px', padding: '24px', textAlign: 'center', cursor: 'pointer', transition: 'border-color 0.15s ease, background 0.15s ease' },
          onClick: () => fileInput.click(),
        },
          el('div', { style: { fontSize: '28px', marginBottom: '8px' } }, '\uD83D\uDCC1'),
          el('p', { style: { fontSize: '14px', color: '#475569', margin: '0 0 4px' } }, 'PDF-Dateien hier ablegen oder klicken'),
          el('p', { style: { fontSize: '12px', color: '#94A3B8', margin: '0' } }, 'Nur PDF, max. 5 MB pro Datei')
        );

        uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.style.borderColor = '#0D7377'; uploadZone.style.background = '#F0FDFD'; });
        uploadZone.addEventListener('dragleave', () => { uploadZone.style.borderColor = '#CBD5E1'; uploadZone.style.background = ''; });
        uploadZone.addEventListener('drop', (e) => {
          e.preventDefault();
          uploadZone.style.borderColor = '#CBD5E1';
          uploadZone.style.background = '';
          addFiles(e.dataTransfer.files);
        });

        fileInput.addEventListener('change', (e) => { addFiles(e.target.files); fileInput.value = ''; });

        function addFiles(files) {
          for (const file of files) {
            if (file.type !== 'application/pdf') { alert(`"${file.name}" ist keine PDF-Datei.`); continue; }
            if (file.size > 5 * 1024 * 1024) { alert(`"${file.name}" ist zu groß (max. 5 MB).`); continue; }
            selectedFiles.push(file);
          }
          renderFileList();
        }

        body.appendChild(uploadZone);
        body.appendChild(fileInput);

        const statusEl = el('div', { style: { display: 'none', padding: '8px', fontSize: '13px', color: '#0D7377', marginTop: '12px' } });
        body.appendChild(statusEl);

        body.appendChild(el('div', { style: { display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '24px' } },
          el('button', { className: 'btn-secondary', onClick: close }, 'Abbrechen'),
          el('button', { className: 'btn-primary', onClick: async () => {
            if (selectedFiles.length === 0) { alert('Bitte mindestens eine Datei auswählen.'); return; }
            statusEl.style.display = 'block';
            try {
              for (let i = 0; i < selectedFiles.length; i++) {
                statusEl.textContent = `Lade ${i + 1}/${selectedFiles.length} hoch...`;
                await DataStoreAPI.uploadDokument(projektId, selectedFiles[i]);
              }
              close();
              Router.resolve();
            } catch (e) {
              statusEl.style.color = '#DC2626';
              statusEl.textContent = 'Fehler: ' + e.message;
            }
          }}, 'Hochladen')
        ));
      });
    }

    // --- Arbeitspaket Modal ---
    function openArbeitspaketModal(ueberProjektId, projektId, existing, parentApId) {
      const title = parentApId
        ? (existing ? 'Unter-Arbeitspaket bearbeiten' : 'Neues Unter-Arbeitspaket')
        : (existing ? 'Arbeitspaket bearbeiten' : 'Neues Arbeitspaket');

      // Look up project and parent AP dates for the info hint
      const _up = DataStore.getUeberProjekt(ueberProjektId);
      const _proj = _up ? (_up.projekte || []).find(pr => pr.id === projektId) : null;
      const _parentAp = (parentApId && _proj) ? findApInTree(_proj.arbeitspakete || [], parentApId) : null;
      // Use parent AP dates when creating Unter-AP, otherwise project dates
      const _rangeSource = _parentAp || _proj;
      const _rangeLabel = _parentAp ? 'Arbeitspaket-Zeitraum' : 'Projektzeitraum';

      openModal(title, (body, close) => {
        const nameInput = el('input', { className: 'form-input', placeholder: 'z.B. Konzeptphase', value: existing ? existing.name : '' });
        const descInput = el('textarea', { className: 'form-textarea', placeholder: 'Beschreibung...', rows: '2' });
        if (existing) descInput.value = existing.beschreibung || '';
        const statusSelect = el('select', { className: 'form-input' });
        for (const s of ['offen', 'in_bearbeitung', 'abgeschlossen']) {
          const opt = el('option', { value: s }, statusLabel(s));
          if (existing && existing.status === s) opt.selected = true;
          statusSelect.appendChild(opt);
        }
        const startInput = el('input', { className: 'form-input', type: 'date', value: existing ? (existing.startDatum || '') : '' });
        const endInput = el('input', { className: 'form-input', type: 'date', value: existing ? (existing.endDatum || '') : '' });

        // Set min/max on date inputs based on parent AP range (for Unter-AP) or project range
        if (_rangeSource) {
          if (_rangeSource.startDatum) { startInput.setAttribute('min', _rangeSource.startDatum); endInput.setAttribute('min', _rangeSource.startDatum); }
          if (_rangeSource.endDatum) { startInput.setAttribute('max', _rangeSource.endDatum); endInput.setAttribute('max', _rangeSource.endDatum); }
        }

        body.appendChild(el('div', { style: { marginBottom: '16px' } }, el('label', { className: 'form-label' }, 'Name *'), nameInput));
        body.appendChild(el('div', { style: { marginBottom: '16px' } }, el('label', { className: 'form-label' }, 'Beschreibung'), descInput));
        body.appendChild(el('div', { style: { marginBottom: '16px' } }, el('label', { className: 'form-label' }, 'Status'), statusSelect));

        // Date range hint (parent AP range for Unter-AP, project range otherwise)
        if (_rangeSource && (_rangeSource.startDatum || _rangeSource.endDatum)) {
          body.appendChild(el('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '10px 14px', marginBottom: '12px',
              background: 'rgba(13,115,119,0.06)', border: '1px solid rgba(13,115,119,0.15)',
              borderRadius: '8px', fontSize: '13px', color: '#0A5C5F'
            }
          },
            el('svg', { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: '#0D7377', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', style: { flexShrink: '0' } },
              el('rect', { x: '3', y: '4', width: '18', height: '18', rx: '2', ry: '2' }),
              el('line', { x1: '16', y1: '2', x2: '16', y2: '6' }),
              el('line', { x1: '8', y1: '2', x2: '8', y2: '6' }),
              el('line', { x1: '3', y1: '10', x2: '21', y2: '10' })
            ),
            el('span', null, `${_rangeLabel}: ${formatDate(_rangeSource.startDatum)} – ${formatDate(_rangeSource.endDatum)}`)
          ));
        }

        body.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' } },
          el('div', null, el('label', { className: 'form-label' }, 'Startdatum'), startInput),
          el('div', null, el('label', { className: 'form-label' }, 'Enddatum'), endInput)
        ));
        body.appendChild(el('div', { style: { display: 'flex', gap: '12px', justifyContent: 'flex-end' } },
          el('button', { className: 'btn-secondary', onClick: close }, 'Abbrechen'),
          el('button', { className: 'btn-primary', onClick: () => {
            const name = nameInput.value.trim();
            if (!name) { nameInput.style.borderColor = '#DC2626'; return; }
            if (startInput.value && endInput.value && startInput.value > endInput.value) { startInput.style.borderColor = '#DC2626'; endInput.style.borderColor = '#DC2626'; alert('Startdatum muss vor dem Enddatum liegen.'); return; }
            const up = DataStore.getUeberProjekt(ueberProjektId);
            const p = (up.projekte || []).find(pr => pr.id === projektId);
            if (!p) return;
            if (!p.arbeitspakete) p.arbeitspakete = [];
            if (existing) {
              const target = findApInTree(p.arbeitspakete, existing.id);
              if (target) Object.assign(target, { name, beschreibung: descInput.value.trim(), status: statusSelect.value, startDatum: startInput.value || null, endDatum: endInput.value || null });
            } else {
              const newAp = { id: crypto.randomUUID(), name, beschreibung: descInput.value.trim(), status: statusSelect.value, startDatum: startInput.value || null, endDatum: endInput.value || null, unterArbeitspakete: [] };
              if (parentApId) {
                const parentAp = findApInTree(p.arbeitspakete, parentApId);
                if (parentAp) { if (!parentAp.unterArbeitspakete) parentAp.unterArbeitspakete = []; parentAp.unterArbeitspakete.push(newAp); }
              } else {
                p.arbeitspakete.push(newAp);
              }
            }
            DataStore.saveProjekt(ueberProjektId, p);
            close();
            Router.resolve();
          }}, existing ? 'Speichern' : 'Erstellen')
        ));
      });
    }

    // --- Zuweisung Modal ---
    function openZuweisungModal(ueberProjektId, projektId, existing) {
      const mitarbeiterList = DataStore.getMitarbeiter();
      const up = DataStore.getUeberProjekt(ueberProjektId);
      const p = up ? (up.projekte || []).find(pr => pr.id === projektId) : null;
      const aps = p ? flattenAPs(p.arbeitspakete) : [];

      if (mitarbeiterList.length === 0) {
        openModal('Mitarbeiter zuweisen', (body, close) => {
          body.appendChild(renderEmptyState(
            'Keine Mitarbeiter vorhanden',
            'Erstelle zuerst Mitarbeiter unter "Mitarbeiter" in der Sidebar.',
            'Zur Mitarbeiter-Seite',
            () => { close(); Router.navigate('#/mitarbeiter'); }
          ));
        });
        return;
      }

      openModal(existing ? 'Zuweisung bearbeiten' : 'Mitarbeiter zuweisen', (body, close) => {
        const maSelect = el('select', { className: 'form-input' });
        maSelect.appendChild(el('option', { value: '' }, '– Mitarbeiter wählen –'));
        for (const ma of mitarbeiterList) {
          maSelect.appendChild(el('option', { value: ma.id }, ma.name));
        }
        if (existing) { maSelect.value = existing.mitarbeiterId; maSelect.disabled = true; maSelect.style.opacity = '0.6'; }
        const prozentInput = el('input', { className: 'form-input', type: 'number', min: '1', max: '100', placeholder: 'z.B. 20', value: existing ? String(existing.prozentAnteil) : '' });
        const vonInput = el('input', { className: 'form-input', type: 'date', value: existing ? existing.von : (p ? p.startDatum : '') });
        const bisInput = el('input', { className: 'form-input', type: 'date', value: existing ? existing.bis : (p ? p.endDatum : '') });

        body.appendChild(el('div', { style: { marginBottom: '16px' } }, el('label', { className: 'form-label' }, 'Mitarbeiter *'), maSelect));
        body.appendChild(el('div', { style: { marginBottom: '16px' } }, el('label', { className: 'form-label' }, 'Anteil am Projekt (%) *'), prozentInput));
        body.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' } },
          el('div', null, el('label', { className: 'form-label' }, 'Von *'), vonInput),
          el('div', null, el('label', { className: 'form-label' }, 'Bis *'), bisInput)
        ));

        // AP distribution
        let apContainer = null;
        const apInputs = [];
        if (aps.length > 0) {
          apContainer = el('div', { style: { marginBottom: '24px' } });
          apContainer.appendChild(el('label', { className: 'form-label', style: { marginBottom: '8px' } }, 'Verteilung auf Arbeitspakete (%)'));
          const sumDisplay = el('span', { style: { fontSize: '13px', fontWeight: '600' } }, '0%');
          for (const ap of aps) {
            const inp = el('input', { className: 'form-input', type: 'number', min: '0', max: '100', value: '0', style: { width: '80px', textAlign: 'right' } });
            inp.addEventListener('input', () => {
              const total = apInputs.reduce((s, i) => s + (parseInt(i.input.value) || 0), 0);
              sumDisplay.textContent = `${total}%`;
              sumDisplay.style.color = total > 100 ? '#DC2626' : total === 100 ? '#0D7377' : '#64748B';
            });
            apInputs.push({ apId: ap.id, input: inp });
            const indent = (ap._depth || 0) * 20;
            const prefix = ap._depth > 0 ? '\u2514 ' : '';
            apContainer.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', paddingLeft: `${indent}px`, borderBottom: '1px solid #F1F5F9' } },
              el('span', { style: { fontSize: '14px', color: ap._depth > 0 ? '#64748B' : '#334155' } }, `${prefix}${ap.name}`),
              el('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } }, inp, el('span', { style: { fontSize: '13px', color: '#94A3B8' } }, '%'))
            ));
          }
          apContainer.appendChild(el('div', { style: { display: 'flex', justifyContent: 'flex-end', padding: '8px 0', fontSize: '13px', color: '#64748B' } },
            el('span', null, 'Summe: '), sumDisplay
          ));
          // Pre-populate AP values when editing
          if (existing && existing.arbeitspaketVerteilung) {
            for (const av of existing.arbeitspaketVerteilung) {
              const match = apInputs.find(ai => ai.apId === av.arbeitspaketId);
              if (match) match.input.value = String(av.prozentAnteil);
            }
            const total = apInputs.reduce((s, i) => s + (parseInt(i.input.value) || 0), 0);
            sumDisplay.textContent = `${total}%`;
            sumDisplay.style.color = total > 100 ? '#DC2626' : total === 100 ? '#0D7377' : '#64748B';
          }
          body.appendChild(apContainer);
        }

        // Preview
        const previewBox = el('div', { className: 'card', style: { background: '#F0FDFD', border: '1px solid #CCFBF9', padding: '16px', marginBottom: '24px', display: 'none' } });
        body.appendChild(previewBox);

        function updatePreview() {
          const maId = maSelect.value;
          const pct = parseInt(prozentInput.value) || 0;
          const von = vonInput.value;
          const bis = bisInput.value;
          if (!maId || !pct || !von || !bis) { previewBox.style.display = 'none'; return; }
          const calc = CalcEngine.calculate(maId, pct, von, bis, []);
          previewBox.style.display = 'block';
          previewBox.innerHTML = '';
          previewBox.appendChild(el('p', { style: { fontSize: '13px', fontWeight: '600', color: '#0A5C5F', margin: '0 0 8px' } }, 'Vorschau'));
          previewBox.appendChild(el('p', { style: { fontSize: '13px', color: '#0A5C5F', margin: '0' } },
            `${calc.werktage} Werktage − ${calc.blockiert} blockiert = ${calc.verfuegbar} verfügbar \u00D7 ${pct}% = ${calc.projektTage} Projekt-Tage`
          ));
        }
        maSelect.addEventListener('change', updatePreview);
        prozentInput.addEventListener('input', updatePreview);
        vonInput.addEventListener('change', updatePreview);
        bisInput.addEventListener('change', updatePreview);
        if (existing) updatePreview();

        body.appendChild(el('div', { style: { display: 'flex', gap: '12px', justifyContent: 'flex-end' } },
          el('button', { className: 'btn-secondary', onClick: close }, 'Abbrechen'),
          el('button', { className: 'btn-primary', onClick: () => {
            if (!maSelect.value) { maSelect.style.borderColor = '#DC2626'; return; }
            const pct = parseInt(prozentInput.value);
            if (!pct || pct < 1 || pct > 100) { prozentInput.style.borderColor = '#DC2626'; return; }
            if (!vonInput.value) { vonInput.style.borderColor = '#DC2626'; return; }
            if (!bisInput.value) { bisInput.style.borderColor = '#DC2626'; return; }
            if (vonInput.value > bisInput.value) { vonInput.style.borderColor = '#DC2626'; bisInput.style.borderColor = '#DC2626'; alert('Startdatum muss vor dem Enddatum liegen.'); return; }

            const apVert = aps.length > 0 && apContainer
              ? apInputs.map(item => ({
                  arbeitspaketId: item.apId,
                  prozentAnteil: parseInt(item.input.value) || 0
                })).filter(a => a.prozentAnteil > 0)
              : [];

            const totalAp = apVert.reduce((s, a) => s + a.prozentAnteil, 0);
            if (totalAp > 100) { alert('AP-Prozente dürfen zusammen nicht über 100% liegen.'); return; }

            DataStore.saveZuweisung({
              id: existing ? existing.id : crypto.randomUUID(),
              mitarbeiterId: existing ? existing.mitarbeiterId : maSelect.value,
              projektId,
              ueberProjektId,
              prozentAnteil: pct,
              von: vonInput.value,
              bis: bisInput.value,
              arbeitspaketVerteilung: apVert,
              erstelltAm: existing ? (existing.erstelltAm || new Date().toISOString()) : new Date().toISOString(),
              geaendertAm: existing ? new Date().toISOString() : undefined,
            });
            close();
            Router.resolve();
          }}, existing ? 'Speichern' : 'Zuweisen')
        ));
      });
    }

    // --- Mitarbeiter ---
    function renderMitarbeiter(container) {
      const mitarbeiter = DataStore.getMitarbeiter();

      container.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '32px' } },
        el('div', null,
          el('h1', { style: { fontSize: '28px', margin: '0', color: '#063838' } }, 'Mitarbeiter'),
          el('p', { style: { color: '#64748B', fontSize: '14px', margin: '4px 0 0' } }, 'Mitarbeiter verwalten und Blockierungen pflegen')
        ),
        el('button', { className: 'btn-primary', onClick: () => openMitarbeiterModal() }, '+ Neuer Mitarbeiter')
      ));

      if (mitarbeiter.length === 0) {
        container.appendChild(renderEmptyState(
          'Noch keine Mitarbeiter',
          'Erstelle Mitarbeiter, um sie Projekten zuzuweisen.',
          '+ Mitarbeiter erstellen',
          () => openMitarbeiterModal()
        ));
      } else {
        const grid = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
        for (const ma of mitarbeiter) {
          const jahr = new Date().getFullYear();
          const budget = getUrlaubstageBudget(ma.id, jahr);
          const zwCount = DataStore.getZuweisungenForMitarbeiter(ma.id).length;
          const budgetColor = budget.verbleibend <= 0 ? '#DC2626' : budget.verbleibend <= 5 ? '#F59E0B' : '#0D7377';
          const ftBadge = ma.feiertagePflicht
            ? el('span', { style: { fontSize: '11px', padding: '1px 8px', borderRadius: '999px', background: '#CCFBF9', color: '#0A5C5F', fontWeight: '600' } }, 'Feiertage: An')
            : el('span', { style: { fontSize: '11px', padding: '1px 8px', borderRadius: '999px', background: '#F1F5F9', color: '#94A3B8', fontWeight: '600' } }, 'Feiertage: Aus');
          grid.appendChild(el('div', { className: 'card', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px' } },
            el('div', null,
              el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
                el('span', { style: { fontWeight: '600', fontSize: '15px', color: '#1E293B' } }, ma.name),
                el('span', { style: { fontSize: '13px', color: '#64748B' } }, ma.position || ''),
                ftBadge
              ),
              el('div', { style: { fontSize: '12px', color: '#94A3B8', marginTop: '4px', display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
                el('span', null, `${ma.wochenStunden || 40}h/Woche`),
                el('span', null, '\u00B7'),
                el('span', { style: { color: budgetColor, fontWeight: '600' } }, `Urlaub: ${budget.genommen}/${budget.anspruch}`),
                el('span', null, '\u00B7'),
                el('span', null, `${zwCount} Zuweisung${zwCount !== 1 ? 'en' : ''}`),
                (ma.jahresgehalt || ma.lohnnebenkosten) ? el('span', null, '\u00B7') : null,
                (ma.jahresgehalt || ma.lohnnebenkosten) ? el('span', { style: { color: '#F59E0B', fontWeight: '600' } }, `${formatEuro(CalcEngine.getDailyRate(ma.id))}/Tag`) : null
              )
            ),
            el('div', { style: { display: 'flex', gap: '4px' } },
              el('button', { className: 'btn-secondary', style: { padding: '6px 12px', fontSize: '12px' }, onClick: () => openExportDialog('mitarbeiter', ma.id, { von: jahr + '-01-01', bis: jahr + '-12-31' }) }, 'PDF'),
              el('button', { className: 'btn-secondary', style: { padding: '6px 12px', fontSize: '12px' }, onClick: () => Router.navigate(`#/mitarbeiter-kalender/${ma.id}`) }, 'Kalender'),
              el('button', { className: 'btn-secondary', style: { padding: '6px 12px', fontSize: '12px' }, onClick: () => openBlockierungModal(ma) }, 'Urlaub & Krank'),
              el('button', { className: 'btn-icon', onClick: () => openMitarbeiterModal(ma), 'aria-label': 'Bearbeiten' }, '\u270E'),
              el('button', { className: 'btn-icon', onClick: () => confirmDialog(`"${ma.name}" und alle Zuweisungen löschen?`, () => { DataStore.deleteMitarbeiter(ma.id); Router.resolve(); }), 'aria-label': 'Löschen' }, trashIcon())
            )
          ));
        }
        container.appendChild(grid);
      }
    }

    // --- Mitarbeiter Modal ---
    function openMitarbeiterModal(existing) {
      openModal(existing ? 'Mitarbeiter bearbeiten' : 'Neuer Mitarbeiter', (body, close) => {
        if (existing) { const w = buildExportWarning(existing.id); if (w) body.appendChild(w); }
        const nameInput = el('input', { className: 'form-input', placeholder: 'Vor- und Nachname', value: existing ? existing.name : '' });
        const posInput = el('input', { className: 'form-input', placeholder: 'z.B. Entwickler', value: existing ? (existing.position || '') : '' });
        const hoursInput = el('input', { className: 'form-input', type: 'number', min: '1', max: '60', value: existing ? (existing.wochenStunden || 40) : '40' });
        const urlaubInput = el('input', { className: 'form-input', type: 'number', min: '0', max: '365', value: existing ? (existing.jahresUrlaub ?? 30) : '30' });
        const gehaltInput = el('input', { className: 'form-input', type: 'number', min: '0', step: '1000', placeholder: 'z.B. 60000', value: existing ? (existing.jahresgehalt || '') : '' });
        const nebenkostenInput = el('input', { className: 'form-input', type: 'number', min: '0', step: '100', placeholder: 'z.B. 12000', value: existing ? (existing.lohnnebenkosten || '') : '' });
        const feiertageCb = el('input', { type: 'checkbox', style: { width: '18px', height: '18px', accentColor: '#0D7377', cursor: 'pointer' } });
        if (existing && existing.feiertagePflicht) feiertageCb.checked = true;

        body.appendChild(el('div', { style: { marginBottom: '16px' } }, el('label', { className: 'form-label' }, 'Name *'), nameInput));
        body.appendChild(el('div', { style: { marginBottom: '16px' } }, el('label', { className: 'form-label' }, 'Position'), posInput));
        body.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' } },
          el('div', null, el('label', { className: 'form-label' }, 'Wochenstunden'), hoursInput),
          el('div', null, el('label', { className: 'form-label' }, 'Jahresurlaub (Tage)'), urlaubInput)
        ));
        body.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' } },
          el('div', null, el('label', { className: 'form-label' }, 'Jahresgehalt (EUR)'), gehaltInput),
          el('div', null, el('label', { className: 'form-label' }, 'Lohnnebenkosten (EUR)'), nebenkostenInput)
        ));
        body.appendChild(el('div', { style: { marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '10px' } },
          feiertageCb,
          el('label', { style: { fontSize: '14px', color: '#334155', cursor: 'pointer' }, onClick: () => { feiertageCb.checked = !feiertageCb.checked; } }, 'Gesetzliche Feiertage auf diesen Mitarbeiter anwenden')
        ));
        body.appendChild(el('div', { style: { display: 'flex', gap: '12px', justifyContent: 'flex-end' } },
          el('button', { className: 'btn-secondary', onClick: close }, 'Abbrechen'),
          el('button', { className: 'btn-primary', onClick: () => {
            const name = nameInput.value.trim();
            if (!name) { nameInput.style.borderColor = '#DC2626'; return; }
            const ma = existing
              ? { ...existing, name, position: posInput.value.trim(), wochenStunden: parseInt(hoursInput.value) || 40, jahresUrlaub: parseInt(urlaubInput.value) || 30, jahresgehalt: parseFloat(gehaltInput.value) || 0, lohnnebenkosten: parseFloat(nebenkostenInput.value) || 0, feiertagePflicht: feiertageCb.checked, geaendertAm: new Date().toISOString() }
              : { id: crypto.randomUUID(), name, position: posInput.value.trim(), wochenStunden: parseInt(hoursInput.value) || 40, jahresUrlaub: parseInt(urlaubInput.value) || 30, jahresgehalt: parseFloat(gehaltInput.value) || 0, lohnnebenkosten: parseFloat(nebenkostenInput.value) || 0, feiertagePflicht: feiertageCb.checked, blockierungen: [], erstelltAm: new Date().toISOString() };
            DataStore.saveMitarbeiter(ma);
            close();
            Router.resolve();
          }}, existing ? 'Speichern' : 'Erstellen')
        ));
      });
    }

    // --- Urlaub & Krank Modal ---
    function openBlockierungModal(ma) {
      openModal(`Urlaub & Krank: ${ma.name}`, (body, close) => {
        const budgetEl = el('div');
        const urlaubListEl = el('div');
        const krankListEl = el('div');

        function refreshAll() {
          renderBudget();
          renderSection('urlaub', urlaubListEl);
          renderSection('krank', krankListEl);
        }

        function renderBudget() {
          budgetEl.innerHTML = '';
          const jahr = new Date().getFullYear();
          const budget = getUrlaubstageBudget(ma.id, jahr);
          const pct = budget.anspruch > 0 ? Math.min(100, Math.round((budget.genommen / budget.anspruch) * 100)) : 0;
          const barColor = budget.verbleibend <= 0 ? '#DC2626' : budget.verbleibend <= 5 ? '#F59E0B' : '#0D7377';
          const textColor = budget.verbleibend <= 0 ? '#DC2626' : '#0D7377';
          budgetEl.appendChild(el('div', { style: { background: '#F0FDFD', borderRadius: '10px', padding: '16px', marginBottom: '24px', border: '1px solid #CCFBF9' } },
            el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' } },
              el('span', { style: { fontSize: '13px', fontWeight: '600', color: '#0A5C5F' } }, `Urlaubsbudget ${jahr}`),
              el('span', { style: { fontSize: '13px', fontWeight: '700', color: textColor } }, `${budget.verbleibend} Tage verbleibend`)
            ),
            el('div', { style: { background: '#E2E8F0', borderRadius: '4px', height: '8px', overflow: 'hidden' } },
              el('div', { style: { background: barColor, height: '100%', width: `${pct}%`, borderRadius: '4px', transition: 'width 0.3s cubic-bezier(0.16,1,0.3,1)' } })
            ),
            el('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '12px', color: '#64748B' } },
              el('span', null, `${budget.genommen} genommen`),
              el('span', null, `${budget.anspruch} Anspruch`)
            )
          ));
        }

        function renderSection(typ, container) {
          container.innerHTML = '';
          const current = DataStore.getMitarbeiterById(ma.id);
          const items = (current ? (current.blockierungen || []) : []).filter(b => b.typ === typ);
          const label = typ === 'urlaub' ? 'Urlaubstage' : 'Krankheitstage';
          const color = typ === 'urlaub' ? '#0D7377' : '#DC2626';
          const bgColor = typ === 'urlaub' ? '#F0FDFD' : '#FEF2F2';

          container.appendChild(el('h3', { style: { fontSize: '15px', margin: '0 0 12px', color: color, display: 'flex', alignItems: 'center', gap: '8px' } },
            el('span', { style: { width: '10px', height: '10px', borderRadius: '50%', background: color, display: 'inline-block' } }),
            `${label} (${items.length})`
          ));

          if (items.length > 0) {
            for (const b of items) {
              const days = CalcEngine.countWeekdays(b.von, b.bis);
              container.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', marginBottom: '4px', borderRadius: '6px', background: bgColor } },
                el('div', null,
                  el('span', { style: { fontSize: '14px', color: '#334155', fontWeight: '500' } }, `${formatDate(b.von)} – ${formatDate(b.bis)}`),
                  el('span', { style: { fontSize: '12px', color: '#64748B', marginLeft: '8px' } }, `(${days} Werktage)`),
                  b.notiz ? el('span', { style: { fontSize: '12px', color: '#94A3B8', marginLeft: '8px' } }, `– ${b.notiz}`) : null
                ),
                el('button', { className: 'btn-icon', onClick: () => {
                  const curr = DataStore.getMitarbeiterById(ma.id);
                  curr.blockierungen = curr.blockierungen.filter(bl => bl.id !== b.id);
                  DataStore.saveMitarbeiter(curr);
                  refreshAll();
                }, 'aria-label': 'Entfernen' }, '\u00D7')
              ));
            }
          } else {
            container.appendChild(el('p', { style: { color: '#94A3B8', fontSize: '13px', padding: '4px 0 8px' } }, `Keine ${label} eingetragen.`));
          }

          // Add form inline
          const vonInput = el('input', { className: 'form-input', type: 'date', style: { flex: '1' } });
          const bisInput = el('input', { className: 'form-input', type: 'date', style: { flex: '1' } });
          const notizInput = el('input', { className: 'form-input', placeholder: 'Notiz (optional)', style: { flex: '1' } });
          container.appendChild(el('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-end', marginTop: '8px', marginBottom: '24px' } },
            el('div', { style: { flex: '1' } }, el('label', { className: 'form-label' }, 'Von'), vonInput),
            el('div', { style: { flex: '1' } }, el('label', { className: 'form-label' }, 'Bis'), bisInput),
            el('div', { style: { flex: '1' } }, el('label', { className: 'form-label' }, 'Notiz'), notizInput),
            el('button', { className: 'btn-primary', style: { height: '40px', whiteSpace: 'nowrap' }, onClick: () => {
              if (!vonInput.value || !bisInput.value) return;
              const curr = DataStore.getMitarbeiterById(ma.id);
              if (!curr.blockierungen) curr.blockierungen = [];
              curr.blockierungen.push({
                id: crypto.randomUUID(),
                typ,
                von: vonInput.value,
                bis: bisInput.value,
                notiz: notizInput.value.trim(),
              });
              DataStore.saveMitarbeiter(curr);
              vonInput.value = '';
              bisInput.value = '';
              notizInput.value = '';
              refreshAll();
            }}, '+ Hinzufügen')
          ));
        }

        refreshAll();
        body.appendChild(budgetEl);
        body.appendChild(urlaubListEl);
        body.appendChild(krankListEl);
        body.appendChild(el('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '8px' } },
          el('button', { className: 'btn-secondary', onClick: close }, 'Schließen')
        ));
      });
    }

    // --- Feiertage ---
    function renderFeiertage(container) {
      container.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '32px' } },
        el('div', null,
          el('h1', { style: { fontSize: '28px', margin: '0', color: '#063838' } }, 'Feiertage'),
          el('p', { style: { color: '#64748B', fontSize: '14px', margin: '4px 0 0' } }, 'Gesetzliche Feiertage, die für alle Mitarbeiter gelten')
        ),
        el('div', { style: { display: 'flex', gap: '8px' } },
          el('button', { className: 'btn-secondary', onClick: () => loadDefaultFeiertage() }, 'Standard laden'),
          el('button', { className: 'btn-primary', onClick: () => openFeiertagModal() }, '+ Feiertag hinzufügen')
        )
      ));

      const feiertage = DataStore.getFeiertage().sort((a, b) => a.datum.localeCompare(b.datum));
      if (feiertage.length === 0) {
        container.appendChild(renderEmptyState(
          'Keine Feiertage eingetragen',
          'Füge Feiertage hinzu oder lade die deutschen Standard-Feiertage.',
          'Standard-Feiertage laden',
          () => loadDefaultFeiertage()
        ));
      } else {
        const table = el('table', { className: 'data-table' });
        table.appendChild(el('thead', null, el('tr', null,
          el('th', null, 'Datum'),
          el('th', null, 'Name'),
          el('th', { style: { width: '60px' } }, '')
        )));
        const tbody = el('tbody');
        for (const ft of feiertage) {
          tbody.appendChild(el('tr', null,
            el('td', null, formatDate(ft.datum)),
            el('td', { style: { fontWeight: '500' } }, ft.name),
            el('td', null, el('button', { className: 'btn-icon', onClick: () => { confirmDialog(`Feiertag "${ft.name}" am ${formatDate(ft.datum)} löschen?`, () => { DataStore.deleteFeiertag(ft.datum); Router.resolve(); }); }, 'aria-label': 'Löschen' }, trashIcon()))
          ));
        }
        table.appendChild(tbody);
        const wrap = el('div', { className: 'card', style: { padding: '0', overflow: 'auto' } });
        wrap.appendChild(table);
        container.appendChild(wrap);
      }
    }

    function openFeiertagModal() {
      openModal('Feiertag hinzufügen', (body, close) => {
        const datumInput = el('input', { className: 'form-input', type: 'date' });
        const nameInput = el('input', { className: 'form-input', placeholder: 'z.B. Tag der Arbeit' });
        body.appendChild(el('div', { style: { marginBottom: '16px' } }, el('label', { className: 'form-label' }, 'Datum *'), datumInput));
        body.appendChild(el('div', { style: { marginBottom: '24px' } }, el('label', { className: 'form-label' }, 'Bezeichnung *'), nameInput));
        body.appendChild(el('div', { style: { display: 'flex', gap: '12px', justifyContent: 'flex-end' } },
          el('button', { className: 'btn-secondary', onClick: close }, 'Abbrechen'),
          el('button', { className: 'btn-primary', onClick: () => {
            if (!datumInput.value || !nameInput.value.trim()) return;
            DataStore.addFeiertag({ datum: datumInput.value, name: nameInput.value.trim() });
            close();
            Router.resolve();
          }}, 'Hinzufügen')
        ));
      });
    }

    function loadDefaultFeiertage() {
      const baseYear = new Date().getFullYear();
      // Easter calculation (Gauss algorithm)
      function easterSunday(y) {
        const a = y % 19, b = Math.floor(y / 100), c = y % 100;
        const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
        const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
        const i = Math.floor(c / 4), k = c % 4;
        const l = (32 + 2 * e + 2 * i - h - k) % 7;
        const m = Math.floor((a + 11 * h + 22 * l) / 451);
        const month = Math.floor((h + l - 7 * m + 114) / 31);
        const day = ((h + l - 7 * m + 114) % 31) + 1;
        return new Date(y, month - 1, day);
      }
      function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r.toISOString().slice(0, 10); }

      function feiertageFuerJahr(year) {
        const easter = easterSunday(year);
        return [
          { datum: `${year}-01-01`, name: 'Neujahr' },
          { datum: addDays(easter, -2), name: 'Karfreitag' },
          { datum: addDays(easter, 1), name: 'Ostermontag' },
          { datum: `${year}-05-01`, name: 'Tag der Arbeit' },
          { datum: addDays(easter, 39), name: 'Christi Himmelfahrt' },
          { datum: addDays(easter, 50), name: 'Pfingstmontag' },
          { datum: `${year}-10-03`, name: 'Tag der Deutschen Einheit' },
          { datum: `${year}-12-25`, name: '1. Weihnachtstag' },
          { datum: `${year}-12-26`, name: '2. Weihnachtstag' },
        ];
      }

      const defaults = [...feiertageFuerJahr(baseYear), ...feiertageFuerJahr(baseYear + 1)];

      const existing = DataStore.getFeiertage().map(f => f.datum);
      let added = 0;
      for (const ft of defaults) {
        if (!existing.includes(ft.datum)) {
          DataStore.addFeiertag(ft);
          added++;
        }
      }
      Router.resolve();
    }

    // --- Export-Historie (placeholder for Phase 7) ---
    function renderExportHistorie(container) {
      container.appendChild(el('div', { style: { marginBottom: '32px' } },
        el('h1', { style: { fontSize: '28px', margin: '0', color: '#063838' } }, 'Export-Historie'),
        el('p', { style: { color: '#64748B', fontSize: '14px', margin: '4px 0 0' } }, 'Alle erstellten PDF-Exporte mit GoBD-Dokumentnummern')
      ));

      const log = DataStore.getExportLog();
      if (log.length === 0) {
        container.appendChild(renderEmptyState(
          'Noch keine Exporte',
          'PDF-Exporte werden hier aufgelistet, sobald du welche erstellst.',
          'Zum Dashboard',
          () => Router.navigate('#/dashboard')
        ));
      } else {
        const table = el('table', { className: 'data-table' });
        table.appendChild(el('thead', null, el('tr', null,
          el('th', null, 'Dokumentnr.'),
          el('th', null, 'Typ'),
          el('th', null, 'Erstellt am'),
          el('th', null, 'Zeitraum'),
        )));
        const tbody = el('tbody');
        for (const entry of log.sort((a, b) => b.erstelltAm.localeCompare(a.erstelltAm))) {
          const typLabel = { projekt: 'Projekt', mitarbeiter: 'Mitarbeiter', ueberprojekt: 'Über-Projekt' }[entry.typ] || entry.typ;
          tbody.appendChild(el('tr', null,
            el('td', { style: { fontWeight: '600', fontFamily: 'monospace', color: '#0D7377' } }, entry.dokumentNummer),
            el('td', null, typLabel),
            el('td', null, formatDate(entry.erstelltAm.slice(0, 10))),
            el('td', null, `${formatDate(entry.zeitraumVon)} – ${formatDate(entry.zeitraumBis)}`)
          ));
        }
        table.appendChild(tbody);
        const wrap = el('div', { className: 'card', style: { padding: '0', overflow: 'auto' } });
        wrap.appendChild(table);
        container.appendChild(wrap);
      }
    }

    // --- Änderungsprotokoll (GoBD) ---
    function renderAenderungsprotokoll(container) {
      const log = DataStore.getAenderungsLog();
      container.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '32px', flexWrap: 'wrap', gap: '12px' } },
        el('div', null,
          el('h1', { style: { fontSize: '28px', margin: '0', color: '#063838' } }, 'Änderungsprotokoll'),
          el('p', { style: { color: '#64748B', fontSize: '14px', margin: '4px 0 0' } }, 'GoBD-konformes Protokoll aller Datenänderungen')
        ),
        log.length > 0 ? el('button', { className: 'btn-secondary', onClick: () => PDFExport.aenderungsprotokollBericht() }, 'PDF Export') : null
      ));

      if (log.length === 0) {
        container.appendChild(renderEmptyState(
          'Keine Änderungen protokolliert',
          'Alle Erstellungen, Bearbeitungen und Löschungen werden hier automatisch erfasst.',
          'Zum Dashboard',
          () => Router.navigate('#/dashboard')
        ));
      } else {
        // Collect unique filter values from log
        const entitaeten = [...new Set(log.map(e => e.entitaet))].sort();
        const aktionen = [...new Set(log.map(e => e.aktion))].sort();
        const namen = [...new Set(log.map(e => e.name).filter(Boolean))].sort();

        // Filter controls row
        const filterRow = el('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px', alignItems: 'center' } });

        const entitaetSelect = el('select', { className: 'form-input', style: { width: 'auto', minWidth: '150px' } });
        entitaetSelect.appendChild(el('option', { value: '' }, 'Alle Entitäten'));
        for (const t of entitaeten) entitaetSelect.appendChild(el('option', { value: t }, t));

        const aktionSelect = el('select', { className: 'form-input', style: { width: 'auto', minWidth: '140px' } });
        aktionSelect.appendChild(el('option', { value: '' }, 'Alle Aktionen'));
        for (const a of aktionen) aktionSelect.appendChild(el('option', { value: a }, a.charAt(0).toUpperCase() + a.slice(1)));

        const nameSelect = el('select', { className: 'form-input', style: { width: 'auto', minWidth: '180px' } });
        nameSelect.appendChild(el('option', { value: '' }, 'Alle Namen'));
        for (const n of namen) nameSelect.appendChild(el('option', { value: n }, n));

        const searchInput = el('input', { className: 'form-input', type: 'text', placeholder: 'Freitext-Suche...', style: { width: 'auto', minWidth: '180px' } });

        const resetBtn = el('button', { className: 'btn-secondary', style: { height: '40px', whiteSpace: 'nowrap' }, onClick: () => {
          entitaetSelect.value = ''; aktionSelect.value = ''; nameSelect.value = ''; searchInput.value = '';
          applyFilters();
        }}, 'Zurücksetzen');

        filterRow.append(entitaetSelect, aktionSelect, nameSelect, searchInput, resetBtn);

        const countEl = el('p', { style: { fontSize: '13px', color: '#64748B', margin: '0 0 12px' } });
        const tableWrap = el('div', { className: 'card', style: { padding: '0', overflow: 'auto' } });

        function applyFilters() {
          const eFilter = entitaetSelect.value;
          const aFilter = aktionSelect.value;
          const nFilter = nameSelect.value;
          const sFilter = searchInput.value.trim().toLowerCase();

          let filtered = log;
          if (eFilter) filtered = filtered.filter(e => e.entitaet === eFilter);
          if (aFilter) filtered = filtered.filter(e => e.aktion === aFilter);
          if (nFilter) filtered = filtered.filter(e => e.name === nFilter);
          if (sFilter) filtered = filtered.filter(e =>
            (e.name || '').toLowerCase().includes(sFilter) ||
            (e.details || '').toLowerCase().includes(sFilter) ||
            (e.entitaet || '').toLowerCase().includes(sFilter)
          );

          const sorted = filtered.sort((a, b) => b.zeitpunkt.localeCompare(a.zeitpunkt));
          countEl.textContent = `${sorted.length} von ${log.length} Einträgen`;

          const table = el('table', { className: 'data-table' });
          table.appendChild(el('thead', null, el('tr', null,
            el('th', null, ''),
            el('th', null, 'Zeitpunkt'),
            el('th', null, 'Aktion'),
            el('th', null, 'Entität'),
            el('th', null, 'Name'),
            el('th', null, 'Details'),
          )));
          const tbody = el('tbody');
          for (const entry of sorted) {
            const actionColor = entry.aktion === 'erstellt' ? '#0D7377' : entry.aktion === 'gelöscht' ? '#DC2626' : '#F59E0B';
            const dt = new Date(entry.zeitpunkt);
            const dateStr = `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')}.${dt.getFullYear()} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
            const hasData = entry.vorherJson || entry.nachherJson;
            const toggleBtn = hasData ? el('button', {
              style: { background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', fontSize: '14px', color: '#64748B', transition: 'transform 0.2s' },
              title: 'Details ein-/ausklappen',
            }, '▶') : el('span', { style: { display: 'inline-block', width: '24px' } });
            const mainRow = el('tr', { style: { cursor: hasData ? 'pointer' : 'default' } },
              el('td', { style: { width: '32px', padding: '8px 4px', textAlign: 'center' } }, toggleBtn),
              el('td', { style: { fontFamily: 'monospace', fontSize: '12px', color: '#64748B', whiteSpace: 'nowrap' } }, dateStr),
              el('td', null, el('span', { style: { display: 'inline-block', padding: '2px 8px', borderRadius: '4px', fontSize: '12px', fontWeight: '600', color: 'white', background: actionColor } }, entry.aktion)),
              el('td', { style: { fontWeight: '500' } }, entry.entitaet),
              el('td', null, entry.name || '–'),
              el('td', { style: { fontSize: '13px', color: '#64748B' } }, entry.details || '–'),
            );
            tbody.appendChild(mainRow);

            if (hasData) {
              const detailRow = el('tr', { style: { display: 'none' } });
              const detailCell = el('td', { colSpan: '6', style: { padding: '0 16px 12px', background: '#F8FAFB', borderTop: 'none' } });
              const detailWrap = el('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap' } });
              if (entry.vorherJson) {
                const vorher = typeof entry.vorherJson === 'string' ? JSON.parse(entry.vorherJson) : entry.vorherJson;
                detailWrap.appendChild(el('div', { style: { flex: '1', minWidth: '280px' } },
                  el('div', { style: { fontSize: '11px', fontWeight: '600', color: '#DC2626', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' } }, 'Vorher'),
                  el('pre', { style: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '8px 12px', fontSize: '11px', lineHeight: '1.5', overflow: 'auto', maxHeight: '200px', margin: '0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, JSON.stringify(vorher, null, 2))
                ));
              }
              if (entry.nachherJson) {
                const nachher = typeof entry.nachherJson === 'string' ? JSON.parse(entry.nachherJson) : entry.nachherJson;
                detailWrap.appendChild(el('div', { style: { flex: '1', minWidth: '280px' } },
                  el('div', { style: { fontSize: '11px', fontWeight: '600', color: '#0D7377', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' } }, 'Nachher'),
                  el('pre', { style: { background: '#F0FDFD', border: '1px solid #CCFBF9', borderRadius: '6px', padding: '8px 12px', fontSize: '11px', lineHeight: '1.5', overflow: 'auto', maxHeight: '200px', margin: '0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, JSON.stringify(nachher, null, 2))
                ));
              }
              detailCell.appendChild(detailWrap);
              detailRow.appendChild(detailCell);
              tbody.appendChild(detailRow);

              const toggle = () => {
                const visible = detailRow.style.display !== 'none';
                detailRow.style.display = visible ? 'none' : 'table-row';
                toggleBtn.textContent = visible ? '▶' : '▼';
                toggleBtn.style.color = visible ? '#64748B' : '#0D7377';
              };
              mainRow.addEventListener('click', toggle);
            }
          }
          table.appendChild(tbody);
          tableWrap.innerHTML = '';
          tableWrap.appendChild(table);
        }

        entitaetSelect.addEventListener('change', applyFilters);
        aktionSelect.addEventListener('change', applyFilters);
        nameSelect.addEventListener('change', applyFilters);
        searchInput.addEventListener('input', applyFilters);

        container.appendChild(filterRow);
        container.appendChild(countEl);
        container.appendChild(tableWrap);
        applyFilters();
      }
    }

    // --- Sitzungsprotokoll (Admin) ---
    async function renderSitzungsprotokoll(container) {
      if (!AuthSystem.isAdmin()) {
        container.appendChild(el('div', { className: 'card', style: { padding: '40px', textAlign: 'center' } },
          el('p', { style: { color: '#DC2626', fontSize: '16px' } }, 'Zugriff verweigert. Nur Administratoren können das Sitzungsprotokoll einsehen.')
        ));
        return;
      }

      container.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '32px' } },
        el('div', null,
          el('h1', { style: { fontSize: '28px', margin: '0', color: '#063838' } }, 'Sitzungsprotokoll'),
          el('p', { style: { color: '#64748B', fontSize: '14px', margin: '4px 0 0' } }, 'Login-, Logout- und Sicherheitsereignisse')
        )
      ));

      try {
        const data = await DataStoreAPI.getSessionLogs(500);
        const logs = data.data || data.logs || (Array.isArray(data) ? data : []);

        if (logs.length === 0) {
          container.appendChild(renderEmptyState(
            'Keine Sitzungsereignisse',
            'Login-, Logout- und Passwortänderungen werden hier automatisch protokolliert.',
            'Zum Dashboard',
            () => Router.navigate('#/dashboard')
          ));
          return;
        }

        const filterSelect = el('select', { className: 'form-input', style: { width: 'auto', marginBottom: '16px' } });
        filterSelect.appendChild(el('option', { value: '' }, 'Alle Aktionen'));
        for (const t of ['login_success', 'login_failed', 'logout', 'password_changed']) {
          filterSelect.appendChild(el('option', { value: t }, t));
        }

        const tableWrap = el('div', { className: 'card', style: { padding: '0', overflow: 'auto' } });

        function renderTable(filter) {
          const filtered = filter ? logs.filter(e => e.aktion === filter) : logs;
          const table = el('table', { className: 'data-table' });
          table.appendChild(el('thead', null, el('tr', null,
            el('th', null, 'Zeitpunkt'),
            el('th', null, 'Aktion'),
            el('th', null, 'E-Mail'),
            el('th', null, 'IP'),
            el('th', null, 'Details'),
          )));
          const tbody = el('tbody');
          for (const entry of filtered) {
            const actionColor = entry.aktion === 'login_success' ? '#0D7377'
              : entry.aktion === 'login_failed' ? '#DC2626'
              : entry.aktion === 'logout' ? '#64748B' : '#F59E0B';
            const dt = new Date(entry.zeitpunkt);
            const dateStr = `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')}.${dt.getFullYear()} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
            tbody.appendChild(el('tr', null,
              el('td', { style: { fontFamily: 'monospace', fontSize: '12px', color: '#64748B', whiteSpace: 'nowrap' } }, dateStr),
              el('td', null, el('span', { style: { display: 'inline-block', padding: '2px 8px', borderRadius: '4px', fontSize: '12px', fontWeight: '600', color: 'white', background: actionColor } }, entry.aktion)),
              el('td', { style: { fontWeight: '500' } }, entry.email || '–'),
              el('td', { style: { fontFamily: 'monospace', fontSize: '12px', color: '#64748B' } }, entry.ip || '–'),
              el('td', { style: { fontSize: '13px', color: '#64748B' } }, entry.details || '–'),
            ));
          }
          table.appendChild(tbody);
          tableWrap.innerHTML = '';
          tableWrap.appendChild(table);
        }

        filterSelect.addEventListener('change', () => renderTable(filterSelect.value));
        container.appendChild(filterSelect);
        container.appendChild(tableWrap);
        renderTable('');
      } catch (e) {
        container.appendChild(el('div', { className: 'card', style: { padding: '20px' } },
          el('p', { style: { color: '#DC2626' } }, 'Fehler beim Laden: ' + e.message)
        ));
      }
    }

    // =========================================================================
    // Phase 6: JSON Export / Import
    // =========================================================================
    function downloadJSON() {
      const json = DataStore.exportJSON();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `novarix-backup-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }

    function importJSON() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          confirmDialog(
            'Achtung: Beim Import werden ALLE aktuellen Daten überschrieben. Vorher ein Backup erstellen! Wirklich importieren?',
            () => {
              try {
                DataStore.importJSON(ev.target.result);
                Router.resolve();
              } catch (err) {
                alert('Fehler beim Import: Ungültige JSON-Datei.');
              }
            }
          );
        };
        reader.readAsText(file);
      });
      input.click();
    }

    // =========================================================================
    // Phase 7: GoBD-konforme PDF-Exporte
    // =========================================================================
    const PDFExport = {
      _initDoc(title, dokumentNr) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF('p', 'mm', 'a4');
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const now = new Date();
        const dateStr = `${String(now.getDate()).padStart(2,'0')}.${String(now.getMonth()+1).padStart(2,'0')}.${now.getFullYear()}`;
        const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

        // Header on every page — gradient effect
        const addHeader = () => {
          // Gradient from dark teal to lighter teal
          const gradSteps = 20;
          const barH = 28;
          for (let i = 0; i < gradSteps; i++) {
            const t = i / gradSteps;
            const r = Math.round(6 + t * (15 - 6));
            const g = Math.round(56 + t * (168 - 56));
            const b = Math.round(56 + t * (163 - 56));
            doc.setFillColor(r, g, b);
            doc.rect(0, (barH * i) / gradSteps, pageWidth, barH / gradSteps + 0.5, 'F');
          }
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(16);
          doc.setTextColor(255, 255, 255);
          doc.text('Novarix', 14, 13);
          doc.setFontSize(9);
          doc.setFont('helvetica', 'normal');
          doc.text(title, 14, 21);
          doc.setFontSize(8);
          doc.text(`Dok.Nr.: ${dokumentNr}`, pageWidth - 14, 13, { align: 'right' });
          doc.text(`Datum: ${dateStr}`, pageWidth - 14, 19, { align: 'right' });
          doc.setTextColor(0, 0, 0);
        };

        // Footer on every page — with separator line
        const addFooter = (pageNum, totalPages) => {
          doc.setDrawColor(226, 232, 240);
          doc.setLineWidth(0.3);
          doc.line(14, pageHeight - 14, pageWidth - 14, pageHeight - 14);
          doc.setFontSize(7);
          doc.setTextColor(100, 116, 139);
          doc.text(`GoBD-konform erstellt am ${dateStr} um ${timeStr} Uhr`, 14, pageHeight - 8);
          doc.text(`Seite ${pageNum} von ${totalPages}`, pageWidth - 14, pageHeight - 8, { align: 'right' });
          doc.text(`Dokumentnummer: ${dokumentNr}`, pageWidth / 2, pageHeight - 8, { align: 'center' });
        };

        addHeader();
        return { doc, pageWidth, pageHeight, addHeader, addFooter, dateStr, timeStr };
      },

      _addVerfahrensdoku(doc) {
        doc.addPage();
        let y = 30;
        doc.setFontSize(14);
        doc.setTextColor(6, 56, 56);
        doc.text('Verfahrensdokumentation (GoBD)', 14, y);
        y += 10;
        doc.setFontSize(9);
        doc.setTextColor(51, 65, 85);
        const lines = [
          'Dieses Dokument wurde automatisch durch die Software NOVARIX erstellt.',
          '',
          '1. Datenquelle',
          'Alle Daten werden manuell durch autorisierte Benutzer erfasst und im lokalen',
          'Browser-Speicher (localStorage) persistiert. Änderungen werden im Änderungs-',
          'protokoll revisionssicher protokolliert.',
          '',
          '2. Dokumentennummerierung',
          'Jedes exportierte Dokument erhält eine eindeutige, fortlaufende Nummer',
          'im Format CLX-JJJJ-NNNN. Die Nummernvergabe ist sequentiell und lückenlos.',
          '',
          '3. Datenintegrität',
          'Bei jedem Export wird ein Prüfwert (Hash) der zugrundeliegenden Daten',
          'gespeichert. Nachträgliche Änderungen an exportierten Datensätzen werden',
          'im Änderungsprotokoll vermerkt und dem Benutzer beim Bearbeiten angezeigt.',
          '',
          '4. Aufbewahrung',
          'Die Export-Historie dokumentiert alle erstellten Berichte mit Zeitstempel,',
          'Dokumentennummer, Berichtstyp und Daten-Hashwert. Das Änderungsprotokoll',
          'erfasst alle Erstellungen, Bearbeitungen und Löschungen mit Zeitstempel.',
        ];
        for (const line of lines) {
          if (y > 270) { doc.addPage(); y = 30; }
          doc.text(line, 14, y);
          y += line === '' ? 4 : 5;
        }
      },

      _finalize(doc, addHeader, addFooter) {
        const totalPages = doc.internal.getNumberOfPages();
        for (let i = 1; i <= totalPages; i++) {
          doc.setPage(i);
          if (i > 1) addHeader();
          addFooter(i, totalPages);
        }
      },

      async projektBericht(ueberProjektId, projektId, von, bis) {
        const up = DataStore.getUeberProjekt(ueberProjektId);
        const p = up ? (up.projekte || []).find(pr => pr.id === projektId) : null;
        if (!up || !p) return;

        const dokumentNr = DataStore.nextDokumentNummer();
        const { doc, pageWidth, addHeader, addFooter, dateStr, timeStr } = this._initDoc(`Projekt-Bericht: ${p.name}`, dokumentNr);

        let y = 36;

        // Project info
        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(6, 56, 56);
        doc.text('Projektinformationen', 14, y); y += 8;

        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(51, 65, 85);
        const info = [
          ['Kunde (Über-Projekt)', up.name],
          ['Projekt', p.name],
          ['Status', statusLabel(p.status)],
          ['Zeitraum Projekt', `${formatDate(p.startDatum)} – ${formatDate(p.endDatum)}`],
          ['Berichtszeitraum', `${formatDate(von)} – ${formatDate(bis)}`],
        ];
        for (const [label, val] of info) {
          doc.setFont('helvetica', 'bold');
          doc.text(`${label}:`, 14, y);
          doc.setFont('helvetica', 'normal');
          doc.text(val, 70, y);
          y += 6;
        }
        y += 6;

        // Arbeitspakete — Gantt-style Plan Items (matching web view)
        const aps = p.arbeitspakete || [];
        if (aps.length > 0) {
          doc.setFontSize(11);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(6, 56, 56);
          doc.text('PLAN ITEMS', 14, y); y += 2;

          // Build numbering map (1, 1.1, 1.2, 2, ...)
          const pdfNumberMap = {};
          (function buildNums(items, prefix) {
            let idx = 1;
            for (const item of items) {
              const num = prefix ? `${prefix}.${idx}` : `${idx}`;
              pdfNumberMap[item.id] = num;
              if (item.unterArbeitspakete && item.unterArbeitspakete.length > 0) buildNums(item.unterArbeitspakete, num);
              idx++;
            }
          })(aps, '');

          const flatAps = flattenAPs(aps);

          // Determine timeline range from project dates
          const pStart = new Date(p.startDatum || von);
          const pEnd = new Date(p.endDatum || bis);
          const totalDays = Math.max(1, Math.round((pEnd - pStart) / 86400000));

          // Gantt layout constants
          const leftMargin = 14;
          const rightMargin = 14;
          const labelWidth = 72; // mm for AP label column
          const ganttLeft = leftMargin + labelWidth;
          const ganttWidth = pageWidth - ganttLeft - rightMargin;
          const rowHeight = 7;
          const barHeight = 4;
          const headerHeight = 10;

          // Status colors for bars
          const pdfStatusColors = {
            aktiv: [13, 115, 119],
            in_bearbeitung: [13, 115, 119],
            abgeschlossen: [100, 116, 139],
            offen: [217, 119, 6],
            geplant: [217, 119, 6],
          };
          const pdfStatusColorsLight = {
            aktiv: [15, 168, 163],
            in_bearbeitung: [15, 168, 163],
            abgeschlossen: [148, 163, 184],
            offen: [245, 158, 11],
            geplant: [245, 158, 11],
          };

          // Check if we need a new page
          const neededHeight = headerHeight + flatAps.length * rowHeight + 10;
          if (y + neededHeight > 260) { doc.addPage(); y = 36; }

          // --- Draw timeline header (month labels) ---
          const hdrY = y;
          doc.setFillColor(240, 253, 253);
          doc.rect(ganttLeft, hdrY, ganttWidth, headerHeight, 'F');
          doc.setDrawColor(226, 232, 240);
          doc.line(ganttLeft, hdrY, ganttLeft + ganttWidth, hdrY);
          doc.line(ganttLeft, hdrY + headerHeight, ganttLeft + ganttWidth, hdrY + headerHeight);

          // Column header: "Arbeitspaket"
          doc.setFontSize(7);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(100, 116, 139);
          doc.text('Arbeitspaket', leftMargin + 2, hdrY + 6);

          // Draw month markers across the timeline
          const startMonth = new Date(pStart.getFullYear(), pStart.getMonth(), 1);
          const endTime = pEnd.getTime();
          const startTime = pStart.getTime();
          doc.setFontSize(6);
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(100, 116, 139);
          let mCur = new Date(startMonth);
          while (mCur.getTime() <= endTime) {
            const dayOffset = Math.round((mCur - pStart) / 86400000);
            const xPos = ganttLeft + (dayOffset / totalDays) * ganttWidth;
            if (xPos >= ganttLeft && xPos <= ganttLeft + ganttWidth - 5) {
              doc.setDrawColor(226, 232, 240);
              doc.line(xPos, hdrY, xPos, hdrY + headerHeight);
              const mLabel = MONTH_SHORT_DE[mCur.getMonth()] + (mCur.getMonth() === 0 ? ' ' + mCur.getFullYear() : '');
              doc.text(mLabel, xPos + 1, hdrY + 6);
            }
            mCur.setMonth(mCur.getMonth() + 1);
          }

          y = hdrY + headerHeight;

          // --- Draw AP rows with Gantt bars ---
          for (let i = 0; i < flatAps.length; i++) {
            const ap = flatAps[i];
            const rowY = y + i * rowHeight;

            // Page break check
            if (rowY + rowHeight > 270) {
              doc.addPage(); y = 36;
              // Re-offset for remaining rows on new page
              const remaining = flatAps.length - i;
              // Redraw header on new page
              doc.setFillColor(240, 253, 253);
              doc.rect(ganttLeft, y, ganttWidth, headerHeight, 'F');
              doc.setFontSize(7);
              doc.setFont('helvetica', 'bold');
              doc.setTextColor(100, 116, 139);
              doc.text('Arbeitspaket', leftMargin + 2, y + 6);
              doc.setFontSize(6);
              doc.setFont('helvetica', 'normal');
              let mCur2 = new Date(startMonth);
              while (mCur2.getTime() <= endTime) {
                const dayOff = Math.round((mCur2 - pStart) / 86400000);
                const xP = ganttLeft + (dayOff / totalDays) * ganttWidth;
                if (xP >= ganttLeft && xP <= ganttLeft + ganttWidth - 5) {
                  doc.setDrawColor(226, 232, 240);
                  doc.line(xP, y, xP, y + headerHeight);
                  const mL = MONTH_SHORT_DE[mCur2.getMonth()] + (mCur2.getMonth() === 0 ? ' ' + mCur2.getFullYear() : '');
                  doc.text(mL, xP + 1, y + 6);
                }
                mCur2.setMonth(mCur2.getMonth() + 1);
              }
              y += headerHeight;
              // Adjust i to re-render from current AP
              i--;
              continue;
            }

            // Alternating row background
            if (i % 2 === 0) {
              doc.setFillColor(250, 252, 252);
              doc.rect(leftMargin, rowY, pageWidth - leftMargin - rightMargin, rowHeight, 'F');
            }

            // Row separator line
            doc.setDrawColor(241, 245, 249);
            doc.line(leftMargin, rowY + rowHeight, leftMargin + pageWidth - leftMargin - rightMargin, rowY + rowHeight);

            // Vertical separator between label and gantt
            doc.setDrawColor(226, 232, 240);
            doc.line(ganttLeft, rowY, ganttLeft, rowY + rowHeight);

            // AP label: number badge + name
            const depth = ap._depth || 0;
            const indent = depth * 4;
            const apNum = pdfNumberMap[ap.id] || '';

            // Number badge
            doc.setFontSize(6);
            doc.setFont('helvetica', 'bold');
            if (depth === 0) {
              doc.setFillColor(13, 115, 119);
              doc.roundedRect(leftMargin + 1 + indent, rowY + 1.5, 5 + apNum.length * 1.8, 4, 1, 1, 'F');
              doc.setTextColor(255, 255, 255);
              doc.text(apNum, leftMargin + 2.5 + indent, rowY + 4.3);
            } else {
              doc.setFillColor(226, 232, 240);
              doc.roundedRect(leftMargin + 1 + indent, rowY + 1.5, 5 + apNum.length * 1.8, 4, 1, 1, 'F');
              doc.setTextColor(71, 85, 105);
              doc.text(apNum, leftMargin + 2.5 + indent, rowY + 4.3);
            }

            // AP name (truncated to fit)
            const nameX = leftMargin + 2 + indent + 6 + apNum.length * 1.8;
            const maxNameWidth = ganttLeft - nameX - 2;
            doc.setFontSize(6.5);
            doc.setFont('helvetica', depth === 0 ? 'bold' : 'normal');
            doc.setTextColor(51, 65, 85);
            let apName = ap.name;
            while (doc.getTextWidth(apName) > maxNameWidth && apName.length > 3) {
              apName = apName.slice(0, -1);
            }
            if (apName.length < ap.name.length) apName += '...';
            doc.text(apName, nameX, rowY + 4.5);

            // Status dot
            const dotColors = { aktiv: [13,115,119], in_bearbeitung: [13,115,119], abgeschlossen: [100,116,139], offen: [217,119,6], geplant: [217,119,6] };
            const dc = dotColors[ap.status] || [217,119,6];
            doc.setFillColor(dc[0], dc[1], dc[2]);
            doc.circle(ganttLeft - 3, rowY + rowHeight / 2, 1, 'F');

            // Gantt bar
            if (ap.startDatum && ap.endDatum) {
              const apStartDate = new Date(ap.startDatum);
              const apEndDate = new Date(ap.endDatum);
              const apStartDay = Math.max(0, Math.round((apStartDate - pStart) / 86400000));
              const apEndDay = Math.min(totalDays, Math.round((apEndDate - pStart) / 86400000));
              if (apEndDay > apStartDay) {
                const barX = ganttLeft + (apStartDay / totalDays) * ganttWidth;
                const barW = ((apEndDay - apStartDay) / totalDays) * ganttWidth;
                const barY = rowY + (rowHeight - barHeight) / 2;

                const bc = depth > 0 ? (pdfStatusColorsLight[ap.status] || [15,168,163]) : (pdfStatusColors[ap.status] || [13,115,119]);
                doc.setFillColor(bc[0], bc[1], bc[2]);
                doc.roundedRect(barX, barY, Math.max(barW, 1), barHeight, 1.5, 1.5, 'F');

                // Progress indicator for parent APs with fortschritt
                if (ap.fortschritt > 0 && ap.fortschritt < 100 && depth === 0) {
                  const progressW = barW * (ap.fortschritt / 100);
                  // Draw a slightly darker progress fill on the left part
                  doc.setFillColor(Math.max(0, bc[0] - 20), Math.max(0, bc[1] - 20), Math.max(0, bc[2] - 20));
                  doc.roundedRect(barX, barY, Math.max(progressW, 1), barHeight, 1.5, 1.5, 'F');
                }

                // Bar label (only if wide enough)
                if (barW > 20) {
                  doc.setFontSize(5);
                  doc.setFont('helvetica', 'bold');
                  doc.setTextColor(255, 255, 255);
                  let barLabel = ap.name;
                  while (doc.getTextWidth(barLabel) > barW - 3 && barLabel.length > 3) barLabel = barLabel.slice(0, -1);
                  if (barLabel.length < ap.name.length) barLabel += '..';
                  doc.text(barLabel, barX + 1.5, barY + 3);
                }
              }
            }
          }

          // Draw month grid lines across the full gantt body
          const ganttBodyTop = hdrY + headerHeight;
          const ganttBodyBottom = y + flatAps.length * rowHeight;
          doc.setDrawColor(241, 245, 249);
          let mGrid = new Date(startMonth);
          while (mGrid.getTime() <= endTime) {
            const dayOff = Math.round((mGrid - pStart) / 86400000);
            const xP = ganttLeft + (dayOff / totalDays) * ganttWidth;
            if (xP > ganttLeft && xP < ganttLeft + ganttWidth) {
              doc.line(xP, ganttBodyTop, xP, ganttBodyBottom);
            }
            mGrid.setMonth(mGrid.getMonth() + 1);
          }

          // Today marker
          const todayDate = new Date();
          const todayOffset = Math.round((todayDate - pStart) / 86400000);
          if (todayOffset >= 0 && todayOffset <= totalDays) {
            const todayX = ganttLeft + (todayOffset / totalDays) * ganttWidth;
            doc.setDrawColor(220, 38, 38);
            doc.setLineWidth(0.3);
            doc.line(todayX, ganttBodyTop, todayX, ganttBodyBottom);
            doc.setLineWidth(0.2);
          }

          // Project start marker (subtle line)
          const projStartOffset = 0;
          const projStartX = ganttLeft;
          doc.setDrawColor(13, 115, 119);
          doc.setLineWidth(0.2);
          doc.line(projStartX, ganttBodyTop, projStartX, ganttBodyBottom);
          doc.setLineWidth(0.2);

          y = ganttBodyBottom + 8;

          // Legend
          doc.setFontSize(6);
          doc.setFont('helvetica', 'normal');
          let legendX = leftMargin;
          const legendItems = [
            { label: 'Aktiv', color: [13,115,119] },
            { label: 'Abgeschlossen', color: [100,116,139] },
            { label: 'Geplant', color: [217,119,6] },
          ];
          for (const item of legendItems) {
            doc.setFillColor(item.color[0], item.color[1], item.color[2]);
            doc.roundedRect(legendX, y - 2, 8, 3, 1, 1, 'F');
            doc.setTextColor(100, 116, 139);
            doc.text(item.label, legendX + 10, y);
            legendX += 10 + doc.getTextWidth(item.label) + 6;
          }
          // Today marker legend
          doc.setDrawColor(220, 38, 38);
          doc.setLineWidth(0.4);
          doc.line(legendX, y - 2, legendX, y + 1);
          doc.setLineWidth(0.2);
          doc.setTextColor(100, 116, 139);
          doc.text('Heute', legendX + 2, y);

          y += 10;
        }

        // Zuweisungen
        const zuweisungen = DataStore.getZuweisungenForProjekt(projektId).filter(z => {
          return z.von <= bis && z.bis >= von;
        });

        if (zuweisungen.length > 0) {
          if (y > 240) { doc.addPage(); y = 36; }
          doc.setFontSize(11);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(6, 56, 56);
          doc.text('Mitarbeiter-Zuweisungen', 14, y); y += 6;

          const zwRows = [];
          for (const zw of zuweisungen) {
            const ma = DataStore.getMitarbeiterById(zw.mitarbeiterId);
            const calc = CalcEngine.calculate(zw.mitarbeiterId, zw.prozentAnteil, zw.von, zw.bis, zw.arbeitspaketVerteilung);
            zwRows.push([
              ma ? ma.name : 'Unbekannt',
              `${zw.prozentAnteil}%`,
              `${formatDate(zw.von)} – ${formatDate(zw.bis)}`,
              String(calc.werktage),
              String(calc.blockiert),
              String(calc.verfuegbar),
              String(calc.projektTage),
            ]);
          }

          doc.autoTable({
            startY: y,
            head: [['Mitarbeiter', 'Anteil', 'Zeitraum', 'Werktage', 'Blockiert', 'Verfügbar', 'Proj.-Tage']],
            body: zwRows,
            styles: { fontSize: 7.5, cellPadding: 2.5, font: 'helvetica' },
            headStyles: { fillColor: [13, 115, 119], textColor: 255, fontStyle: 'bold' },
            alternateRowStyles: { fillColor: [240, 253, 253] },
            margin: { left: 14, right: 14 },
          });
          y = doc.lastAutoTable.finalY + 10;

          // AP breakdown per employee
          for (const zw of zuweisungen) {
            const ma = DataStore.getMitarbeiterById(zw.mitarbeiterId);
            const calc = CalcEngine.calculate(zw.mitarbeiterId, zw.prozentAnteil, zw.von, zw.bis, zw.arbeitspaketVerteilung);
            if (calc.apTage.length > 0) {
              if (y > 250) { doc.addPage(); y = 36; }
              doc.setFontSize(9);
              doc.setFont('helvetica', 'bold');
              doc.text(`AP-Verteilung: ${ma ? ma.name : 'Unbekannt'}`, 14, y); y += 5;

              const apRows = calc.apTage.map(at => {
                const ap = findApInTree(aps, at.arbeitspaketId);
                return [ap ? ap.name : 'Unbekannt', `${at.prozent}%`, formatTageStunden(at.tage)];
              });
              doc.autoTable({
                startY: y,
                head: [['Arbeitspaket', 'Anteil', 'Tage']],
                body: apRows,
                styles: { fontSize: 7.5, cellPadding: 2, font: 'helvetica' },
                headStyles: { fillColor: [15, 168, 163], textColor: 255, fontStyle: 'bold' },
                alternateRowStyles: { fillColor: [240, 253, 253] },
                margin: { left: 20, right: 14 },
              });
              y = doc.lastAutoTable.finalY + 6;
            }
          }
        }

        this._finalize(doc, addHeader, addFooter);

        // Log + save
        DataStore.addExportEntry({
          id: crypto.randomUUID(),
          dokumentNummer: dokumentNr,
          typ: 'projekt',
          referenzId: projektId,
          erstelltAm: new Date().toISOString(),
          zeitraumVon: von,
          zeitraumBis: bis,
          datenHash: await DataStore.hashData(JSON.stringify({ p, zuweisungen: DataStore.getZuweisungenForProjekt(projektId) })),
        });

        doc.save(`${dokumentNr}_Projekt_${p.name.replace(/\s+/g, '_')}.pdf`);
      },

      // ─── Projektplan Export (Plan Items + Descriptions only) ───
      async projektplanBericht(ueberProjektId, projektId) {
        const up = DataStore.getUeberProjekt(ueberProjektId);
        const p = up ? (up.projekte || []).find(pr => pr.id === projektId) : null;
        if (!up || !p) return;

        const dokumentNr = DataStore.nextDokumentNummer();
        const { doc, pageWidth, addHeader, addFooter } = this._initDoc(`Projektplan: ${p.name}`, dokumentNr);

        let y = 36;

        // Project header
        doc.setFontSize(14);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(6, 56, 56);
        doc.text(p.name, 14, y); y += 6;
        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(100, 116, 139);
        const pDates = (p.startDatum && p.endDatum) ? `${formatDate(p.startDatum)} – ${formatDate(p.endDatum)}` : '';
        doc.text(`${up.name}  |  ${pDates}`, 14, y); y += 10;

        // Build numbering
        const aps = p.arbeitspakete || [];
        const pdfNumMap = {};
        (function buildNums(items, prefix) {
          let idx = 1;
          for (const item of items) {
            const num = prefix ? `${prefix}.${idx}` : `${idx}`;
            pdfNumMap[item.id] = num;
            if (item.unterArbeitspakete && item.unterArbeitspakete.length > 0) buildNums(item.unterArbeitspakete, num);
            idx++;
          }
        })(aps, '');

        const flatAps = flattenAPs(aps);

        // ─── Gantt chart (same as projektBericht) ───
        const pStart = new Date(p.startDatum || '2025-01-01');
        const pEnd = new Date(p.endDatum || '2026-12-31');
        const totalDays = Math.max(1, Math.round((pEnd - pStart) / 86400000));
        const leftMargin = 14, rightMargin = 14, labelWidth = 72;
        const ganttLeft = leftMargin + labelWidth;
        const ganttWidth = pageWidth - ganttLeft - rightMargin;
        const rowHeight = 7, barHeight = 4, headerHeight = 10;
        const pdfStatusColors = { aktiv: [13,115,119], in_bearbeitung: [13,115,119], abgeschlossen: [100,116,139], offen: [217,119,6], geplant: [217,119,6] };
        const pdfStatusColorsLight = { aktiv: [15,168,163], in_bearbeitung: [15,168,163], abgeschlossen: [148,163,184], offen: [245,158,11], geplant: [245,158,11] };

        // Timeline header
        const hdrY = y;
        doc.setFillColor(240, 253, 253);
        doc.rect(ganttLeft, hdrY, ganttWidth, headerHeight, 'F');
        doc.setDrawColor(226, 232, 240);
        doc.line(ganttLeft, hdrY, ganttLeft + ganttWidth, hdrY);
        doc.line(ganttLeft, hdrY + headerHeight, ganttLeft + ganttWidth, hdrY + headerHeight);
        doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(100, 116, 139);
        doc.text('Arbeitspaket', leftMargin + 2, hdrY + 6);

        const startMonth = new Date(pStart.getFullYear(), pStart.getMonth(), 1);
        const endTime = pEnd.getTime();
        doc.setFontSize(6); doc.setFont('helvetica', 'normal'); doc.setTextColor(100, 116, 139);
        let mCur = new Date(startMonth);
        while (mCur.getTime() <= endTime) {
          const dayOffset = Math.round((mCur - pStart) / 86400000);
          const xPos = ganttLeft + (dayOffset / totalDays) * ganttWidth;
          if (xPos >= ganttLeft && xPos <= ganttLeft + ganttWidth - 5) {
            doc.setDrawColor(226, 232, 240); doc.line(xPos, hdrY, xPos, hdrY + headerHeight);
            const mLabel = MONTH_SHORT_DE[mCur.getMonth()] + (mCur.getMonth() === 0 ? ' ' + mCur.getFullYear() : '');
            doc.text(mLabel, xPos + 1, hdrY + 6);
          }
          mCur.setMonth(mCur.getMonth() + 1);
        }
        y = hdrY + headerHeight;

        // AP rows with bars
        for (let i = 0; i < flatAps.length; i++) {
          const ap = flatAps[i];
          const rowY = y + i * rowHeight;
          if (rowY + rowHeight > 270) {
            doc.addPage(); y = 36;
            doc.setFillColor(240, 253, 253); doc.rect(ganttLeft, y, ganttWidth, headerHeight, 'F');
            doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(100, 116, 139);
            doc.text('Arbeitspaket', leftMargin + 2, y + 6);
            doc.setFontSize(6); doc.setFont('helvetica', 'normal');
            let mC = new Date(startMonth);
            while (mC.getTime() <= endTime) {
              const dOff = Math.round((mC - pStart) / 86400000);
              const xP = ganttLeft + (dOff / totalDays) * ganttWidth;
              if (xP >= ganttLeft && xP <= ganttLeft + ganttWidth - 5) {
                doc.setDrawColor(226, 232, 240); doc.line(xP, y, xP, y + headerHeight);
                doc.text(MONTH_SHORT_DE[mC.getMonth()] + (mC.getMonth() === 0 ? ' ' + mC.getFullYear() : ''), xP + 1, y + 6);
              }
              mC.setMonth(mC.getMonth() + 1);
            }
            y += headerHeight; i--; continue;
          }

          const depth = ap._depth || 0;
          const indent = depth * 4;
          const apNum = pdfNumMap[ap.id] || '';
          if (i % 2 === 0) { doc.setFillColor(250, 252, 252); doc.rect(leftMargin, rowY, pageWidth - leftMargin - rightMargin, rowHeight, 'F'); }
          doc.setDrawColor(241, 245, 249); doc.line(leftMargin, rowY + rowHeight, leftMargin + pageWidth - leftMargin - rightMargin, rowY + rowHeight);
          doc.setDrawColor(226, 232, 240); doc.line(ganttLeft, rowY, ganttLeft, rowY + rowHeight);

          // Number badge
          doc.setFontSize(6); doc.setFont('helvetica', 'bold');
          if (depth === 0) {
            doc.setFillColor(13, 115, 119); doc.roundedRect(leftMargin + 1 + indent, rowY + 1.5, 5 + apNum.length * 1.8, 4, 1, 1, 'F');
            doc.setTextColor(255, 255, 255); doc.text(apNum, leftMargin + 2.5 + indent, rowY + 4.3);
          } else {
            doc.setFillColor(226, 232, 240); doc.roundedRect(leftMargin + 1 + indent, rowY + 1.5, 5 + apNum.length * 1.8, 4, 1, 1, 'F');
            doc.setTextColor(71, 85, 105); doc.text(apNum, leftMargin + 2.5 + indent, rowY + 4.3);
          }
          // Name
          const nameX = leftMargin + 2 + indent + 6 + apNum.length * 1.8;
          const maxNameW = ganttLeft - nameX - 2;
          doc.setFontSize(6.5); doc.setFont('helvetica', depth === 0 ? 'bold' : 'normal'); doc.setTextColor(51, 65, 85);
          let apN = ap.name;
          while (doc.getTextWidth(apN) > maxNameW && apN.length > 3) apN = apN.slice(0, -1);
          if (apN.length < ap.name.length) apN += '...';
          doc.text(apN, nameX, rowY + 4.5);
          // Status dot
          const dc = (pdfStatusColors[ap.status] || [217,119,6]);
          doc.setFillColor(dc[0], dc[1], dc[2]); doc.circle(ganttLeft - 3, rowY + rowHeight / 2, 1, 'F');
          // Bar
          if (ap.startDatum && ap.endDatum) {
            const s = Math.max(0, Math.round((new Date(ap.startDatum) - pStart) / 86400000));
            const e = Math.min(totalDays, Math.round((new Date(ap.endDatum) - pStart) / 86400000));
            if (e > s) {
              const bx = ganttLeft + (s / totalDays) * ganttWidth, bw = ((e - s) / totalDays) * ganttWidth, by = rowY + (rowHeight - barHeight) / 2;
              const bc = depth > 0 ? (pdfStatusColorsLight[ap.status] || [15,168,163]) : (pdfStatusColors[ap.status] || [13,115,119]);
              doc.setFillColor(bc[0], bc[1], bc[2]); doc.roundedRect(bx, by, Math.max(bw, 1), barHeight, 1.5, 1.5, 'F');
              if (bw > 20) {
                doc.setFontSize(5); doc.setFont('helvetica', 'bold'); doc.setTextColor(255, 255, 255);
                let bl = ap.name; while (doc.getTextWidth(bl) > bw - 3 && bl.length > 3) bl = bl.slice(0, -1);
                if (bl.length < ap.name.length) bl += '..'; doc.text(bl, bx + 1.5, by + 3);
              }
            }
          }
        }

        // Grid + today
        const gTop = hdrY + headerHeight, gBot = y + flatAps.length * rowHeight;
        doc.setDrawColor(241, 245, 249);
        let mG = new Date(startMonth);
        while (mG.getTime() <= endTime) {
          const xP = ganttLeft + (Math.round((mG - pStart) / 86400000) / totalDays) * ganttWidth;
          if (xP > ganttLeft && xP < ganttLeft + ganttWidth) doc.line(xP, gTop, xP, gBot);
          mG.setMonth(mG.getMonth() + 1);
        }
        const tOff = Math.round((new Date() - pStart) / 86400000);
        if (tOff >= 0 && tOff <= totalDays) {
          doc.setDrawColor(220, 38, 38); doc.setLineWidth(0.3);
          doc.line(ganttLeft + (tOff / totalDays) * ganttWidth, gTop, ganttLeft + (tOff / totalDays) * ganttWidth, gBot);
          doc.setLineWidth(0.2);
        }

        y = gBot + 12;

        // ─── Detailed AP descriptions ───
        doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.setTextColor(6, 56, 56);
        if (y > 250) { doc.addPage(); y = 36; }
        doc.text('Arbeitspakete im Detail', 14, y); y += 8;

        for (const ap of flatAps) {
          const depth = ap._depth || 0;
          const apNum = pdfNumMap[ap.id] || '';
          const neededH = 20 + (ap.beschreibung ? Math.ceil(ap.beschreibung.length / 80) * 4 + 6 : 0);
          if (y + neededH > 270) { doc.addPage(); y = 36; }

          // Number + Name
          doc.setFontSize(depth === 0 ? 10 : 9);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(depth === 0 ? 6 : 51, depth === 0 ? 56 : 65, depth === 0 ? 56 : 85);
          const indent = depth * 6;
          doc.text(`${apNum}  ${ap.name}`, 14 + indent, y);
          y += 5;

          // Status + Dates
          doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(100, 116, 139);
          const parts = [];
          parts.push(`Status: ${statusLabel(ap.status)}`);
          if (ap.startDatum && ap.endDatum) parts.push(`${formatDate(ap.startDatum)} – ${formatDate(ap.endDatum)}`);
          if (ap.fortschritt !== undefined && ap.fortschritt !== null) parts.push(`Fortschritt: ${ap.fortschritt}%`);
          doc.text(parts.join('   |   '), 14 + indent, y); y += 5;

          // Description
          if (ap.beschreibung && ap.beschreibung.trim()) {
            doc.setFontSize(8); doc.setTextColor(51, 65, 85);
            const lines = doc.splitTextToSize(ap.beschreibung.trim(), pageWidth - 28 - indent);
            for (const line of lines) {
              if (y > 275) { doc.addPage(); y = 36; }
              doc.text(line, 14 + indent, y); y += 4;
            }
            y += 2;
          }

          // Separator line for top-level APs
          if (depth === 0) {
            doc.setDrawColor(226, 232, 240);
            doc.line(14, y, pageWidth - 14, y);
            y += 4;
          } else {
            y += 2;
          }
        }

        this._finalize(doc, addHeader, addFooter);

        DataStore.addExportEntry({
          id: crypto.randomUUID(),
          dokumentNummer: dokumentNr,
          typ: 'projektplan',
          referenzId: projektId,
          erstelltAm: new Date().toISOString(),
          zeitraumVon: p.startDatum,
          zeitraumBis: p.endDatum,
          datenHash: await DataStore.hashData(JSON.stringify({ p })),
        });

        doc.save(`${dokumentNr}_Projektplan_${p.name.replace(/\s+/g, '_')}.pdf`);
      },

      async mitarbeiterBericht(mitarbeiterId, von, bis) {
        const ma = DataStore.getMitarbeiterById(mitarbeiterId);
        if (!ma) return;

        const dokumentNr = DataStore.nextDokumentNummer();
        const { doc, pageWidth, addHeader, addFooter } = this._initDoc(`Mitarbeiter-Bericht: ${ma.name}`, dokumentNr);

        let y = 36;

        // MA info
        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(6, 56, 56);
        doc.text('Mitarbeiterinformationen', 14, y); y += 8;

        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(51, 65, 85);
        const jahr = new Date().getFullYear();
        const budget = getUrlaubstageBudget(mitarbeiterId, jahr);
        const info = [
          ['Name', ma.name],
          ['Position', ma.position || '–'],
          ['Wochenstunden', `${ma.wochenStunden || 40}h`],
          ['Jahresurlaub', `${budget.anspruch} Tage (genommen: ${budget.genommen}, verbleibend: ${budget.verbleibend})`],
          ['Feiertage', ma.feiertagePflicht ? 'Gesetzliche Feiertage aktiv' : 'Nicht angewandt'],
          ['Berichtszeitraum', `${formatDate(von)} – ${formatDate(bis)}`],
        ];
        for (const [label, val] of info) {
          doc.setFont('helvetica', 'bold');
          doc.text(`${label}:`, 14, y);
          doc.setFont('helvetica', 'normal');
          doc.text(val, 60, y);
          y += 6;
        }
        y += 6;

        // Blockierungen im Zeitraum
        const blocks = (ma.blockierungen || []).filter(b => b.von <= bis && b.bis >= von);
        const feiertageInRange = ma.feiertagePflicht ? DataStore.getFeiertage().filter(f => f.datum >= von && f.datum <= bis) : [];

        if (blocks.length > 0 || feiertageInRange.length > 0) {
          doc.setFontSize(11);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(6, 56, 56);
          doc.text('Blockierungen im Zeitraum', 14, y); y += 6;

          const blockRows = [];
          for (const b of blocks) {
            const typeLabel = { urlaub: 'Urlaub', krank: 'Krank' }[b.typ] || b.typ;
            blockRows.push([typeLabel, `${formatDate(b.von)} – ${formatDate(b.bis)}`, b.notiz || '–']);
          }
          for (const f of feiertageInRange) {
            blockRows.push(['Feiertag', formatDate(f.datum), f.name]);
          }

          doc.autoTable({
            startY: y,
            head: [['Typ', 'Zeitraum', 'Notiz']],
            body: blockRows,
            styles: { fontSize: 8, cellPadding: 2.5, font: 'helvetica' },
            headStyles: { fillColor: [13, 115, 119], textColor: 255, fontStyle: 'bold' },
            alternateRowStyles: { fillColor: [240, 253, 253] },
            margin: { left: 14, right: 14 },
          });
          y = doc.lastAutoTable.finalY + 10;
        }

        // Zuweisungen
        const zuweisungen = DataStore.getZuweisungenForMitarbeiter(mitarbeiterId).filter(z => z.von <= bis && z.bis >= von);
        const feiertage = DataStore.getFeiertage();
        if (zuweisungen.length > 0) {
          if (y > 240) { doc.addPage(); y = 36; }
          doc.setFontSize(11);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(6, 56, 56);
          doc.text('Projekt-Zuweisungen', 14, y); y += 6;

          const zwRows = [];
          for (const zw of zuweisungen) {
            const found = DataStore.findProjektWithParent(zw.projektId);
            const projName = found ? `${found.ueberProjekt.name} / ${found.projekt.name}` : 'Unbekannt';
            const calc = CalcEngine.calculate(mitarbeiterId, zw.prozentAnteil, zw.von, zw.bis, zw.arbeitspaketVerteilung);
            zwRows.push([projName, `${zw.prozentAnteil}%`, `${formatDate(zw.von)} – ${formatDate(zw.bis)}`, String(calc.verfuegbar), String(calc.projektTage)]);
          }

          doc.autoTable({
            startY: y,
            head: [['Projekt', 'Anteil', 'Zeitraum', 'Verfügbar', 'Proj.-Tage']],
            body: zwRows,
            styles: { fontSize: 8, cellPadding: 2.5, font: 'helvetica' },
            headStyles: { fillColor: [13, 115, 119], textColor: 255, fontStyle: 'bold' },
            alternateRowStyles: { fillColor: [240, 253, 253] },
            margin: { left: 14, right: 14 },
          });
          y = doc.lastAutoTable.finalY + 10;
        }

        // Arbeitspaket-Details with day-by-day schedule
        if (zuweisungen.length > 0) {
          for (const zw of zuweisungen) {
            const found = DataStore.findProjektWithParent(zw.projektId);
            if (!found) continue;
            const projekt = found.projekt;
            const allAps = flattenAPs(projekt.arbeitspakete || []);
            const apVerteilung = zw.arbeitspaketVerteilung || [];
            if (apVerteilung.length === 0) continue;

            const calc = CalcEngine.calculate(mitarbeiterId, zw.prozentAnteil, zw.von, zw.bis, apVerteilung);

            for (const av of apVerteilung) {
              const apObj = allAps.find(a => a.id === av.arbeitspaketId);
              if (!apObj) continue;
              const apCalc = calc.apTage.find(at => at.arbeitspaketId === av.arbeitspaketId);
              if (!apCalc) continue;

              const totalApDays = apCalc.tage;
              const fullDays = Math.floor(totalApDays);
              const remainingHours = Math.round((totalApDays - fullDays) * 8);

              // Compute AP date range
              const apStart = apObj.startDatum || projekt.startDatum;
              const apEnd = apObj.endDatum || projekt.endDatum;
              const rangeStart = zw.von > apStart ? zw.von : apStart;
              const rangeEnd = zw.bis < apEnd ? zw.bis : apEnd;

              // Collect available weekdays
              const availableDays = [];
              const cur = new Date(rangeStart);
              const end = new Date(rangeEnd);
              while (cur <= end) {
                const ds = cur.toISOString().slice(0, 10);
                if (cur.getDay() !== 0 && cur.getDay() !== 6 && !getBlockTypeForDay(ma, ds, feiertage)) {
                  availableDays.push(ds);
                }
                cur.setDate(cur.getDate() + 1);
              }

              // Distribute days (same seeded random logic as calendar)
              const totalSlots = fullDays + (remainingHours > 0 ? 1 : 0);
              const scheduledDays = [];

              if (totalSlots >= availableDays.length) {
                for (const ds of availableDays) scheduledDays.push({ date: ds, hours: 8 });
                if (remainingHours > 0 && scheduledDays.length > 0) scheduledDays[scheduledDays.length - 1].hours = remainingHours;
              } else if (totalSlots > 0) {
                let seed = 0;
                for (let i = 0; i < ma.id.length; i++) seed = ((seed << 5) - seed + ma.id.charCodeAt(i)) | 0;
                for (let i = 0; i < av.arbeitspaketId.length; i++) seed = ((seed << 5) - seed + av.arbeitspaketId.charCodeAt(i)) | 0;
                function _sr() { seed = (seed * 1664525 + 1013904223) & 0x7fffffff; return seed / 0x7fffffff; }

                const pairs = [];
                for (let i = 0; i < availableDays.length - 1; i++) {
                  const diff = (new Date(availableDays[i + 1]) - new Date(availableDays[i])) / 86400000;
                  if (diff <= 3) pairs.push([i, i + 1]);
                }
                const picked = new Set();
                let rem = totalSlots;
                if (pairs.length > 0 && rem >= 2) {
                  const numPairs = Math.min(Math.floor(rem / 2), pairs.length);
                  const step = pairs.length / numPairs;
                  const off = _sr() * step;
                  for (let p = 0; p < numPairs && rem >= 2; p++) {
                    const pi = Math.floor(off + p * step) % pairs.length;
                    const [a, b] = pairs[pi];
                    if (!picked.has(a) && !picked.has(b)) { picked.add(a); picked.add(b); rem -= 2; }
                  }
                }
                if (rem > 0) {
                  const unpicked = [];
                  for (let i = 0; i < availableDays.length; i++) { if (!picked.has(i)) unpicked.push(i); }
                  const step = unpicked.length / rem;
                  const off = _sr() * step;
                  for (let s = 0; s < rem && s < unpicked.length; s++) {
                    picked.add(unpicked[Math.floor(off + s * step) % unpicked.length]);
                  }
                }
                const sortedPicked = [...picked].sort((a, b) => a - b);
                for (let i = 0; i < sortedPicked.length && i < totalSlots; i++) {
                  const isLast = (i === totalSlots - 1 && remainingHours > 0);
                  scheduledDays.push({ date: availableDays[sortedPicked[i]], hours: isLast ? remainingHours : 8 });
                }
              }

              if (scheduledDays.length === 0) continue;
              const schedSet = new Set(scheduledDays.map(sd => sd.date));
              const partialMap = {};
              for (const sd of scheduledDays) { if (sd.hours < 8) partialMap[sd.date] = sd.hours; }

              // Section header
              if (y > 200) { doc.addPage(); y = 36; }
              doc.setFontSize(10);
              doc.setFont('helvetica', 'bold');
              doc.setTextColor(13, 115, 119);
              doc.text(`AP: ${apObj.name}`, 14, y);
              doc.setFontSize(8);
              doc.setFont('helvetica', 'normal');
              doc.setTextColor(100, 116, 139);
              doc.text(`${found.ueberProjekt.name} / ${projekt.name} · ${av.prozentAnteil}% AP · ${formatTageStunden(totalApDays)}`, 14, y + 5);
              y += 12;

              // Draw calendar graphic for each month in the AP range
              const firstMonth = new Date(rangeStart);
              firstMonth.setDate(1);
              const lastMonth = new Date(rangeEnd);
              lastMonth.setDate(1);
              const calLeft = 14;
              const cellW = (pageWidth - 28) / 7;
              const cellH = 7;
              const dayHeaders = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
              const monthNames = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

              const curM = new Date(firstMonth);
              while (curM <= lastMonth) {
                const mYear = curM.getFullYear();
                const mMonth = curM.getMonth();
                const daysInMonth = new Date(mYear, mMonth + 1, 0).getDate();
                // Calculate rows needed: header + day-headers + up to 6 week rows
                const firstDow = (new Date(mYear, mMonth, 1).getDay() + 6) % 7; // Mon=0
                const totalCells = firstDow + daysInMonth;
                const weekRows = Math.ceil(totalCells / 7);
                const blockH = 6 + 8 + weekRows * cellH + 4;

                if (y + blockH > 270) { doc.addPage(); y = 36; }

                // Month title
                doc.setFontSize(8);
                doc.setFont('helvetica', 'bold');
                doc.setTextColor(6, 56, 56);
                doc.text(`${monthNames[mMonth]} ${mYear}`, calLeft, y + 4);
                y += 6;

                // Day headers
                doc.setFontSize(6);
                doc.setFont('helvetica', 'normal');
                doc.setTextColor(100, 116, 139);
                for (let i = 0; i < 7; i++) {
                  doc.text(dayHeaders[i], calLeft + i * cellW + cellW / 2, y + 3, { align: 'center' });
                }
                y += 5;

                // Day cells
                for (let d = 1; d <= daysInMonth; d++) {
                  const dow = (new Date(mYear, mMonth, d).getDay() + 6) % 7;
                  const row = Math.floor((firstDow + d - 1) / 7);
                  const cx = calLeft + dow * cellW;
                  const cy = y + row * cellH;
                  const ds = `${mYear}-${String(mMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                  const inRange = ds >= rangeStart && ds <= rangeEnd;
                  const isWeekend = dow >= 5;
                  const blockType = inRange && !isWeekend ? getBlockTypeForDay(ma, ds, feiertage) : null;
                  const isWorkDay = schedSet.has(ds);
                  const isPartial = partialMap[ds] !== undefined;

                  // Cell background
                  if (isWorkDay) {
                    if (isPartial) {
                      doc.setFillColor(204, 251, 249); // light teal for partial
                    } else {
                      doc.setFillColor(13, 115, 119); // teal for full day
                    }
                    doc.roundedRect(cx + 0.3, cy + 0.3, cellW - 0.6, cellH - 0.6, 0.8, 0.8, 'F');
                  } else if (blockType) {
                    const bc = blockType === 'krank' ? [220, 38, 38] : blockType === 'feiertag' ? [245, 158, 11] : [13, 115, 119];
                    doc.setFillColor(bc[0], bc[1], bc[2]);
                    doc.roundedRect(cx + 0.3, cy + 0.3, cellW - 0.6, cellH - 0.6, 0.8, 0.8, 'F');
                  } else if (isWeekend) {
                    doc.setFillColor(241, 245, 249);
                    doc.roundedRect(cx + 0.3, cy + 0.3, cellW - 0.6, cellH - 0.6, 0.8, 0.8, 'F');
                  } else if (!inRange) {
                    doc.setFillColor(248, 250, 252);
                    doc.roundedRect(cx + 0.3, cy + 0.3, cellW - 0.6, cellH - 0.6, 0.8, 0.8, 'F');
                  }

                  // Day number
                  doc.setFontSize(5.5);
                  if (isWorkDay && !isPartial) {
                    doc.setTextColor(255, 255, 255);
                    doc.setFont('helvetica', 'bold');
                  } else if (blockType) {
                    doc.setTextColor(255, 255, 255);
                    doc.setFont('helvetica', 'normal');
                  } else if (isWeekend || !inRange) {
                    doc.setTextColor(180, 190, 200);
                    doc.setFont('helvetica', 'normal');
                  } else {
                    doc.setTextColor(51, 65, 85);
                    doc.setFont('helvetica', 'normal');
                  }
                  doc.text(String(d), cx + cellW / 2, cy + cellH / 2 + 1, { align: 'center' });

                  // Hours label for partial day
                  if (isPartial) {
                    doc.setFontSize(4);
                    doc.setTextColor(13, 115, 119);
                    doc.text(`${partialMap[ds]}h`, cx + cellW / 2, cy + cellH - 1, { align: 'center' });
                  }
                }

                y += weekRows * cellH + 4;

                // Signature field
                if (y + 18 > 270) { doc.addPage(); y = 36; }
                y += 2;
                doc.setDrawColor(180, 190, 200);
                doc.line(calLeft, y + 10, calLeft + 70, y + 10);
                doc.setFontSize(6);
                doc.setFont('helvetica', 'normal');
                doc.setTextColor(130, 140, 150);
                doc.text('Unterschrift Mitarbeiter', calLeft, y + 14);
                doc.text(`${monthNames[mMonth]} ${mYear}`, calLeft + 50, y + 14);

                doc.line(calLeft + 90, y + 10, calLeft + 160, y + 10);
                doc.text('Datum', calLeft + 90, y + 14);
                y += 20;

                curM.setMonth(curM.getMonth() + 1);
              }

              // Legend
              if (y + 8 > 270) { doc.addPage(); y = 36; }
              doc.setFontSize(5.5);
              doc.setFont('helvetica', 'normal');
              const legendItems = [
                { color: [13, 115, 119], label: 'Arbeitstag (8h)' },
                { color: [204, 251, 249], label: 'Teiltag', textColor: [13, 115, 119] },
                { color: [220, 38, 38], label: 'Krank' },
                { color: [245, 158, 11], label: 'Feiertag' },
              ];
              let lx = 18;
              for (const li of legendItems) {
                doc.setFillColor(li.color[0], li.color[1], li.color[2]);
                doc.roundedRect(lx, y, 3, 3, 0.5, 0.5, 'F');
                doc.setTextColor(li.textColor ? li.textColor[0] : 80, li.textColor ? li.textColor[1] : 80, li.textColor ? li.textColor[2] : 80);
                doc.text(li.label, lx + 4, y + 2.5);
                lx += doc.getTextWidth(li.label) + 8;
              }
              y += 8;

              // Day-by-day table
              const dayRows = scheduledDays.map(sd => {
                const d = new Date(sd.date);
                const weekdays = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
                const dayLabel = weekdays[d.getDay()];
                return [formatDate(sd.date), dayLabel, sd.hours === 8 ? 'Ganzer Tag (8h)' : `${sd.hours} Stunde${sd.hours !== 1 ? 'n' : ''}`];
              });

              doc.autoTable({
                startY: y,
                head: [['Datum', 'Tag', 'Arbeitszeit']],
                body: dayRows,
                styles: { fontSize: 7.5, cellPadding: 2, font: 'helvetica' },
                headStyles: { fillColor: [15, 168, 163], textColor: 255, fontStyle: 'bold' },
                alternateRowStyles: { fillColor: [240, 253, 253] },
                columnStyles: { 0: { cellWidth: 28 }, 1: { cellWidth: 14 }, 2: { cellWidth: 'auto' } },
                margin: { left: 18, right: 14 },
              });
              y = doc.lastAutoTable.finalY + 10;
            }
          }
        }

        this._finalize(doc, addHeader, addFooter);

        DataStore.addExportEntry({
          id: crypto.randomUUID(),
          dokumentNummer: dokumentNr,
          typ: 'mitarbeiter',
          referenzId: mitarbeiterId,
          erstelltAm: new Date().toISOString(),
          zeitraumVon: von,
          zeitraumBis: bis,
          datenHash: await DataStore.hashData(JSON.stringify({ ma, zuweisungen: DataStore.getZuweisungenForMitarbeiter(mitarbeiterId) })),
        });

        doc.save(`${dokumentNr}_Mitarbeiter_${ma.name.replace(/\s+/g, '_')}.pdf`);
      },

      async ueberProjektBericht(ueberProjektId, von, bis) {
        const up = DataStore.getUeberProjekt(ueberProjektId);
        if (!up) return;

        const dokumentNr = DataStore.nextDokumentNummer();
        const { doc, pageWidth, addHeader, addFooter } = this._initDoc(`Über-Projekt-Bericht: ${up.name}`, dokumentNr);

        let y = 36;

        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(6, 56, 56);
        doc.text('Kundeninformationen', 14, y); y += 8;

        doc.setFontSize(9);
        doc.setTextColor(51, 65, 85);
        doc.setFont('helvetica', 'bold');
        doc.text('Kunde:', 14, y);
        doc.setFont('helvetica', 'normal');
        doc.text(up.name, 45, y); y += 6;
        doc.setFont('helvetica', 'bold');
        doc.text('Beschreibung:', 14, y);
        doc.setFont('helvetica', 'normal');
        doc.text(up.beschreibung || '–', 45, y); y += 6;
        doc.setFont('helvetica', 'bold');
        doc.text('Berichtszeitraum:', 14, y);
        doc.setFont('helvetica', 'normal');
        doc.text(`${formatDate(von)} – ${formatDate(bis)}`, 55, y); y += 10;

        // Each Projekt
        for (const p of (up.projekte || [])) {
          if (y > 240) { doc.addPage(); y = 36; }
          doc.setFontSize(11);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(13, 115, 119);
          doc.text(`Projekt: ${p.name}`, 14, y);
          doc.setFontSize(8);
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(100, 116, 139);
          doc.text(`${formatDate(p.startDatum)} – ${formatDate(p.endDatum)} | Status: ${statusLabel(p.status)}`, 14, y + 5);
          y += 12;

          const zuweisungen = DataStore.getZuweisungenForProjekt(p.id).filter(z => z.von <= bis && z.bis >= von);
          if (zuweisungen.length > 0) {
            const rows = zuweisungen.map(zw => {
              const ma = DataStore.getMitarbeiterById(zw.mitarbeiterId);
              const calc = CalcEngine.calculate(zw.mitarbeiterId, zw.prozentAnteil, zw.von, zw.bis, zw.arbeitspaketVerteilung);
              return [ma ? ma.name : '?', `${zw.prozentAnteil}%`, String(calc.verfuegbar), String(calc.projektTage)];
            });
            doc.autoTable({
              startY: y,
              head: [['Mitarbeiter', 'Anteil', 'Verfügbar', 'Proj.-Tage']],
              body: rows,
              styles: { fontSize: 7.5, cellPadding: 2, font: 'helvetica' },
              headStyles: { fillColor: [15, 168, 163], textColor: 255, fontStyle: 'bold' },
              alternateRowStyles: { fillColor: [240, 253, 253] },
              margin: { left: 18, right: 14 },
            });
            y = doc.lastAutoTable.finalY + 8;
          } else {
            doc.setFontSize(8);
            doc.setTextColor(148, 163, 184);
            doc.text('Keine Zuweisungen im Berichtszeitraum', 18, y);
            y += 8;
          }
        }

        this._finalize(doc, addHeader, addFooter);

        DataStore.addExportEntry({
          id: crypto.randomUUID(),
          dokumentNummer: dokumentNr,
          typ: 'ueberprojekt',
          referenzId: ueberProjektId,
          erstelltAm: new Date().toISOString(),
          zeitraumVon: von,
          zeitraumBis: bis,
          datenHash: await DataStore.hashData(JSON.stringify(up)),
        });

        doc.save(`${dokumentNr}_Kunde_${up.name.replace(/\s+/g, '_')}.pdf`);
      },

      async aenderungsprotokollBericht() {
        const log = DataStore.getAenderungsLog();
        if (log.length === 0) return;

        const dokumentNr = DataStore.nextDokumentNummer();
        const { doc, pageWidth, addHeader, addFooter } = this._initDoc('Änderungsprotokoll', dokumentNr);

        let y = 36;

        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(6, 56, 56);
        doc.text('Änderungsprotokoll', 14, y); y += 6;
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(100, 116, 139);
        doc.text(`${log.length} Einträge | GoBD-konformes Protokoll aller Datenänderungen`, 14, y); y += 8;

        const sorted = [...log].sort((a, b) => b.zeitpunkt.localeCompare(a.zeitpunkt));
        const rows = sorted.map(entry => {
          const dt = new Date(entry.zeitpunkt);
          const dateStr = `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')}.${dt.getFullYear()} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
          return [dateStr, entry.aktion, entry.entitaet, entry.name || '–', entry.details || '–'];
        });

        doc.autoTable({
          startY: y,
          head: [['Zeitpunkt', 'Aktion', 'Entität', 'Name', 'Details']],
          body: rows,
          styles: { fontSize: 7, cellPadding: 2, font: 'helvetica', overflow: 'linebreak' },
          headStyles: { fillColor: [13, 115, 119], textColor: 255, fontStyle: 'bold' },
          alternateRowStyles: { fillColor: [240, 253, 253] },
          columnStyles: {
            0: { cellWidth: 30, fontStyle: 'normal', textColor: [100, 116, 139] },
            1: { cellWidth: 18 },
            2: { cellWidth: 22 },
            3: { cellWidth: 30 },
            4: { cellWidth: 'auto' },
          },
          margin: { left: 14, right: 14 },
        });

        this._finalize(doc, addHeader, addFooter);

        DataStore.addExportEntry({
          id: crypto.randomUUID(),
          dokumentNummer: dokumentNr,
          typ: 'aenderungsprotokoll',
          referenzId: 'aenderungsprotokoll',
          erstelltAm: new Date().toISOString(),
          zeitraumVon: sorted.length > 0 ? sorted[sorted.length - 1].zeitpunkt.slice(0, 10) : '',
          zeitraumBis: sorted.length > 0 ? sorted[0].zeitpunkt.slice(0, 10) : '',
          datenHash: await DataStore.hashData(JSON.stringify(log)),
        });

        doc.save(`${dokumentNr}_Aenderungsprotokoll.pdf`);
      },
    };

    // --- PDF Export Dialog ---
    function openExportDialog(typ, referenzId, defaults) {
      openModal('PDF exportieren', (body, close) => {
        const vonInput = el('input', { className: 'form-input', type: 'date', value: defaults?.von || '' });
        const bisInput = el('input', { className: 'form-input', type: 'date', value: defaults?.bis || '' });

        body.appendChild(el('p', { style: { fontSize: '14px', color: '#475569', marginBottom: '16px' } },
          'Wähle den Berichtszeitraum für den GoBD-konformen PDF-Export.'
        ));
        body.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' } },
          el('div', null, el('label', { className: 'form-label' }, 'Von *'), vonInput),
          el('div', null, el('label', { className: 'form-label' }, 'Bis *'), bisInput)
        ));
        body.appendChild(el('div', { style: { display: 'flex', gap: '12px', justifyContent: 'flex-end' } },
          el('button', { className: 'btn-secondary', onClick: close }, 'Abbrechen'),
          el('button', { className: 'btn-primary', onClick: async () => {
            if (!vonInput.value || !bisInput.value) return;
            if (typ === 'projekt') {
              await PDFExport.projektBericht(defaults.ueberProjektId, referenzId, vonInput.value, bisInput.value);
            } else if (typ === 'mitarbeiter') {
              await PDFExport.mitarbeiterBericht(referenzId, vonInput.value, bisInput.value);
            } else if (typ === 'ueberprojekt') {
              await PDFExport.ueberProjektBericht(referenzId, vonInput.value, bisInput.value);
            }
            close();
            // Refresh if on export-historie page
            if (window.location.hash === '#/export-historie') Router.resolve();
          }}, 'PDF exportieren')
        ));
      });
    }

    // =========================================================================
    // Loading State Helper
    // =========================================================================
    function showLoading(message = 'Laden...') {
      let overlay = document.getElementById('loading-overlay');
      if (!overlay) {
        overlay = el('div', { id: 'loading-overlay', style: {
          position: 'fixed', inset: '0', background: 'rgba(255,255,255,0.85)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: '10000', backdropFilter: 'blur(2px)'
        }},
          el('div', { style: { textAlign: 'center' } },
            el('div', { style: {
              width: '40px', height: '40px', border: '3px solid #E2E8F0',
              borderTopColor: '#0D7377', borderRadius: '50%',
              animation: 'spin 0.8s linear infinite', margin: '0 auto 12px'
            }}),
            el('p', { id: 'loading-text', style: { color: '#475569', fontSize: '14px', margin: '0' } }, message)
          )
        );
        document.body.appendChild(overlay);
      } else {
        const txt = document.getElementById('loading-text');
        if (txt) txt.textContent = message;
        overlay.style.display = 'flex';
      }
    }

    function hideLoading() {
      const overlay = document.getElementById('loading-overlay');
      if (overlay) overlay.style.display = 'none';
    }

    // =========================================================================
    // Error Boundary — wraps render functions safely
    // =========================================================================
    function withErrorBoundary(renderFn) {
      return function(container, ...args) {
        try {
          renderFn(container, ...args);
        } catch (err) {
          console.error('Render-Fehler:', err);
          container.innerHTML = '';
          container.appendChild(el('div', { className: 'card', style: { textAlign: 'center', padding: '48px 24px' } },
            el('div', { style: { fontSize: '48px', marginBottom: '16px' } }, '\u26A0'),
            el('h2', { style: { color: '#DC2626', marginBottom: '8px' } }, 'Fehler beim Laden'),
            el('p', { style: { color: '#64748B', marginBottom: '24px' } }, err.message || 'Ein unerwarteter Fehler ist aufgetreten.'),
            el('button', { className: 'btn-primary', onClick: () => Router.resolve() }, 'Erneut versuchen')
          ));
        }
      };
    }

    // =========================================================================
    // Client-Side Form Validation Helpers
    // =========================================================================
    function validateDateRange(vonInput, bisInput) {
      if (vonInput.value && bisInput.value && vonInput.value > bisInput.value) {
        bisInput.style.borderColor = '#DC2626';
        return false;
      }
      bisInput.style.borderColor = '';
      return true;
    }

    function validateRequired(input, label) {
      if (!input.value || !input.value.toString().trim()) {
        input.style.borderColor = '#DC2626';
        input.placeholder = `${label} ist erforderlich`;
        return false;
      }
      input.style.borderColor = '';
      return true;
    }

    function validatePercent(input) {
      const v = parseFloat(input.value);
      if (isNaN(v) || v < 1 || v > 100) {
        input.style.borderColor = '#DC2626';
        return false;
      }
      input.style.borderColor = '';
      return true;
    }

    // =========================================================================
    // Register Routes & Init
    // =========================================================================
    Router.register('#/dashboard', withErrorBoundary(renderDashboard));
    Router.register('#/ueberprojekt/:id', withErrorBoundary(renderUeberProjekt));
    Router.register('#/projekt/:upId/:pId', withErrorBoundary(renderProjekt));
    Router.register('#/mitarbeiter', withErrorBoundary(renderMitarbeiter));
    Router.register('#/feiertage', withErrorBoundary(renderFeiertage));
    Router.register('#/export-historie', withErrorBoundary(renderExportHistorie));
    Router.register('#/aenderungsprotokoll', withErrorBoundary(renderAenderungsprotokoll));
    Router.register('#/sitzungsprotokoll', withErrorBoundary(renderSitzungsprotokoll));
    Router.register('#/mitarbeiter-kalender/:maId', withErrorBoundary(renderMitarbeiterKalender));
    Router.register('#/projekt-kalender/:upId/:pId', withErrorBoundary(renderProjektKalender));
    Router.register('#/ap-kalender/:upId/:pId/:apId', withErrorBoundary(renderApKalender));

    // ─── Multi-Tab Sync: reload view when another tab changes localStorage ───
    window.addEventListener('storage', (e) => {
      if (e.key === DataStore._key) Router.resolve();
    });

    // ─── Warn before leaving with open modal (unsaved form data) ───
    window.addEventListener('beforeunload', (e) => {
      if (document.querySelector('.modal-backdrop')) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // Start auth check — Router.init() is called after successful login
    AuthSystem.init();

// ─── Window Globals (für onclick-Handler in HTML) ──────────────
window.AuthSystem = AuthSystem;
window.downloadJSON = downloadJSON;
window.importJSON = importJSON;
