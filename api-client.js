// =========================================================================
// Novarix API Client — Ersetzt localStorage DataStore
// Importiert als <script src="api-client.js"></script> VOR dem Hauptscript
// =========================================================================

const API_BASE = window.NOVARIX_API_URL || 'http://localhost:3000/api/v1';

// ─── Token Management ─────────────────────────────────────────
const TokenManager = {
  _accessToken: null,
  _refreshToken: null,

  setTokens(access, refresh) {
    this._accessToken = access;
    this._refreshToken = refresh;
    // Refresh Token im localStorage für Tab-Persistenz
    if (refresh) localStorage.setItem('novarix_refresh_token', refresh);
  },

  getAccessToken() { return this._accessToken; },
  getRefreshToken() { return this._refreshToken || localStorage.getItem('novarix_refresh_token'); },

  clear() {
    this._accessToken = null;
    this._refreshToken = null;
    localStorage.removeItem('novarix_refresh_token');
  },

  hasTokens() {
    return !!this.getRefreshToken();
  },
};

// ─── HTTP Client mit Auto-Refresh ─────────────────────────────
async function apiFetch(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (TokenManager.getAccessToken()) {
    headers['Authorization'] = `Bearer ${TokenManager.getAccessToken()}`;
  }

  let res = await fetch(url, { ...options, headers });

  // 401 → Token abgelaufen → Refresh versuchen
  if (res.status === 401 && TokenManager.getRefreshToken()) {
    const refreshed = await refreshTokens();
    if (refreshed) {
      headers['Authorization'] = `Bearer ${TokenManager.getAccessToken()}`;
      res = await fetch(url, { ...options, headers });
    } else {
      // Refresh fehlgeschlagen → Logout
      TokenManager.clear();
      if (typeof AuthSystem !== 'undefined') AuthSystem._showLogin();
      throw new Error('Sitzung abgelaufen. Bitte erneut einloggen.');
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const error = new Error(err.error || err.message || `HTTP ${res.status}`);
    error.status = res.status;
    error.details = err.details;
    throw error;
  }

  return res.json();
}

async function refreshTokens() {
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: TokenManager.getRefreshToken() }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    TokenManager.setTokens(data.accessToken, data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

// ─── Auth API ─────────────────────────────────────────────────
const AuthAPI = {
  async login(email, password) {
    // Use fetch directly — NOT apiFetch — to avoid the 401→refresh
    // interception, which would misinterpret "wrong password" as "expired token"
    const url = `${API_BASE}/auth/login`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const error = new Error(err.error || err.message || `HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    const data = await res.json();
    TokenManager.setTokens(data.accessToken, data.refreshToken);
    return data.user;
  },

  async logout() {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } catch { /* Ignorieren */ }
    TokenManager.clear();
  },

  async me() {
    return apiFetch('/auth/me');
  },

  async changePassword(currentPassword, newPassword) {
    return apiFetch('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  },

  isLoggedIn() {
    return TokenManager.hasTokens();
  },
};

// ─── DataStore API (Drop-In-Replacement) ──────────────────────
// Behält die gleiche Schnittstelle wie der alte localStorage DataStore
const DataStoreAPI = {
  // ─── Über-Projekte (Firmen) ───────────────────────────────
  async getUeberProjekte() {
    return apiFetch('/ueberprojekte');
  },

  async getUeberProjekt(id) {
    return apiFetch(`/ueberprojekte/${id}`);
  },

  async saveUeberProjekt(up) {
    if (up.id && !up._isNew) {
      return apiFetch(`/ueberprojekte/${up.id}`, {
        method: 'PUT',
        body: JSON.stringify(up),
      });
    }
    const created = await apiFetch('/ueberprojekte', {
      method: 'POST',
      body: JSON.stringify(up),
    });
    return created;
  },

  async deleteUeberProjekt(id) {
    return apiFetch(`/ueberprojekte/${id}`, { method: 'DELETE' });
  },

  // ─── Projekte ─────────────────────────────────────────────
  async getProjekt(ueberProjektId, projektId) {
    return apiFetch(`/projekte/${projektId}`);
  },

  async saveProjekt(ueberProjektId, projekt) {
    if (projekt.id && !projekt._isNew) {
      return apiFetch(`/projekte/${projekt.id}`, {
        method: 'PUT',
        body: JSON.stringify(projekt),
      });
    }
    return apiFetch(`/ueberprojekte/${ueberProjektId}/projekte`, {
      method: 'POST',
      body: JSON.stringify(projekt),
    });
  },

  async deleteProjekt(ueberProjektId, projektId) {
    return apiFetch(`/projekte/${projektId}`, { method: 'DELETE' });
  },

  // ─── Arbeitspakete ────────────────────────────────────────
  async getArbeitspakete(projektId) {
    return apiFetch(`/projekte/${projektId}/arbeitspakete`);
  },

  async saveArbeitspaket(projektId, ap, parentId = null) {
    if (ap.id && !ap._isNew) {
      return apiFetch(`/arbeitspakete/${ap.id}`, {
        method: 'PUT',
        body: JSON.stringify(ap),
      });
    }
    if (parentId) {
      return apiFetch(`/arbeitspakete/${parentId}/unter`, {
        method: 'POST',
        body: JSON.stringify(ap),
      });
    }
    return apiFetch(`/projekte/${projektId}/arbeitspakete`, {
      method: 'POST',
      body: JSON.stringify(ap),
    });
  },

  async deleteArbeitspaket(apId) {
    return apiFetch(`/arbeitspakete/${apId}`, { method: 'DELETE' });
  },

  // ─── Mitarbeiter ──────────────────────────────────────────
  async getMitarbeiter() {
    return apiFetch('/mitarbeiter');
  },

  async getMitarbeiterById(id) {
    return apiFetch(`/mitarbeiter/${id}`);
  },

  async saveMitarbeiter(ma) {
    if (ma.id && !ma._isNew) {
      return apiFetch(`/mitarbeiter/${ma.id}`, {
        method: 'PUT',
        body: JSON.stringify(ma),
      });
    }
    return apiFetch('/mitarbeiter', {
      method: 'POST',
      body: JSON.stringify(ma),
    });
  },

  async deleteMitarbeiter(id) {
    return apiFetch(`/mitarbeiter/${id}`, { method: 'DELETE' });
  },

  // ─── Blockierungen (Urlaub/Krank) ────────────────────────
  async getBlockierungen(mitarbeiterId) {
    return apiFetch(`/mitarbeiter/${mitarbeiterId}/blockierungen`);
  },

  async saveBlockierung(mitarbeiterId, blockierung) {
    if (blockierung.id && !blockierung._isNew) {
      return apiFetch(`/blockierungen/${blockierung.id}`, {
        method: 'PUT',
        body: JSON.stringify(blockierung),
      });
    }
    return apiFetch(`/mitarbeiter/${mitarbeiterId}/blockierungen`, {
      method: 'POST',
      body: JSON.stringify(blockierung),
    });
  },

  async deleteBlockierung(id) {
    return apiFetch(`/blockierungen/${id}`, { method: 'DELETE' });
  },

  // ─── Zuweisungen ──────────────────────────────────────────
  async getZuweisungen() {
    // Nicht direkt verfügbar — über Projekte laden
    return [];
  },

  async getZuweisungenForProjekt(projektId) {
    return apiFetch(`/projekte/${projektId}/zuweisungen`);
  },

  async saveZuweisung(projektId, zw) {
    if (zw.id && !zw._isNew) {
      return apiFetch(`/zuweisungen/${zw.id}`, {
        method: 'PUT',
        body: JSON.stringify(zw),
      });
    }
    return apiFetch(`/projekte/${projektId}/zuweisungen`, {
      method: 'POST',
      body: JSON.stringify(zw),
    });
  },

  async deleteZuweisung(id) {
    return apiFetch(`/zuweisungen/${id}`, { method: 'DELETE' });
  },

  // ─── Feiertage ────────────────────────────────────────────
  async getFeiertage() {
    return apiFetch('/feiertage');
  },

  async addFeiertag(ft) {
    return apiFetch('/feiertage', {
      method: 'POST',
      body: JSON.stringify(ft),
    });
  },

  async deleteFeiertag(id) {
    return apiFetch(`/feiertage/${id}`, { method: 'DELETE' });
  },

  // ─── Export ───────────────────────────────────────────────
  async getExportLog() {
    const result = await apiFetch('/export/log');
    return result.logs || [];
  },

  async addExportEntry(entry) {
    return apiFetch('/export/log', {
      method: 'POST',
      body: JSON.stringify(entry),
    });
  },

  async nextDokumentNummer() {
    const result = await apiFetch('/export/dokument-nummer');
    return result.dokumentNummer;
  },

  // ─── Änderungslog ─────────────────────────────────────────
  async getAenderungsLog() {
    const result = await apiFetch('/aenderungslog');
    return result.logs || [];
  },

  // ─── Papierkorb ───────────────────────────────────────────
  async getPapierkorb() {
    return apiFetch('/papierkorb');
  },

  async restoreFromPapierkorb(id) {
    return apiFetch(`/papierkorb/${id}/restore`, { method: 'POST' });
  },

  async permanentDelete(id) {
    return apiFetch(`/papierkorb/${id}`, { method: 'DELETE' });
  },

  // ─── Backup ───────────────────────────────────────────────
  async exportJSON() {
    const data = await apiFetch('/backup/export');
    return JSON.stringify(data, null, 2);
  },

  async importJSON(jsonString) {
    const parsed = JSON.parse(jsonString);
    return apiFetch('/backup/import', {
      method: 'POST',
      body: JSON.stringify(parsed),
    });
  },

  async migrateFromLocalStorage(localStorageData) {
    return apiFetch('/backup/migrate-localstorage', {
      method: 'POST',
      body: JSON.stringify(localStorageData),
    });
  },

  // ─── Benutzer (Admin) ─────────────────────────────────────
  async getUsers() {
    return apiFetch('/users');
  },

  async createUser(userData) {
    return apiFetch('/users', {
      method: 'POST',
      body: JSON.stringify(userData),
    });
  },

  async updateUser(id, userData) {
    return apiFetch(`/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(userData),
    });
  },

  async deleteUser(id) {
    return apiFetch(`/users/${id}`, { method: 'DELETE' });
  },
};

// Global verfügbar machen
window.AuthAPI = AuthAPI;
window.DataStoreAPI = DataStoreAPI;
window.TokenManager = TokenManager;
