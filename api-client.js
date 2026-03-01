// =========================================================================
// Novarix API Client — Ersetzt localStorage DataStore
// Importiert als <script src="api-client.js"></script> VOR dem Hauptscript
// =========================================================================

const API_BASE = window.NOVARIX_API_URL || 'http://localhost:3000/api/v1';

// ─── Token Management ─────────────────────────────────────────
// Access token: in-memory only (short-lived, 15 min)
// Refresh token: HttpOnly cookie (managed by browser, not accessible to JS)
const TokenManager = {
  _accessToken: null,
  _hasSession: false,

  setTokens(access) {
    this._accessToken = access;
    this._hasSession = true;
  },

  getAccessToken() { return this._accessToken; },

  clear() {
    this._accessToken = null;
    this._hasSession = false;
  },

  hasTokens() {
    return this._hasSession;
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

  let res = await fetch(url, { ...options, headers, credentials: 'include' });

  // 401 → Token abgelaufen → Refresh versuchen
  if (res.status === 401 && TokenManager.hasTokens()) {
    const refreshed = await refreshTokens();
    if (refreshed) {
      headers['Authorization'] = `Bearer ${TokenManager.getAccessToken()}`;
      res = await fetch(url, { ...options, headers, credentials: 'include' });
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
    // Refresh token is sent automatically as HttpOnly cookie
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) return false;
    const data = await res.json();
    TokenManager.setTokens(data.accessToken);
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
      credentials: 'include', // receive HttpOnly cookie
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const error = new Error(err.error || err.message || `HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    const data = await res.json();
    TokenManager.setTokens(data.accessToken);
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

  async forgotPassword(email) {
    const url = `${API_BASE}/auth/forgot-password`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  async resetPassword(token, newPassword) {
    const url = `${API_BASE}/auth/reset-password`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
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

  // ─── Dokumente (PDF-Uploads) ─────────────────────────────
  async uploadDokument(projektId, file) {
    const formData = new FormData();
    formData.append('file', file);
    const url = `${API_BASE}/projekte/${projektId}/dokumente`;
    const headers = {};
    if (TokenManager.getAccessToken()) {
      headers['Authorization'] = `Bearer ${TokenManager.getAccessToken()}`;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  async getDokumente(projektId) {
    return apiFetch(`/projekte/${projektId}/dokumente`);
  },

  async downloadDokument(id) {
    const url = `${API_BASE}/dokumente/${id}/download`;
    const headers = {};
    if (TokenManager.getAccessToken()) {
      headers['Authorization'] = `Bearer ${TokenManager.getAccessToken()}`;
    }
    const res = await fetch(url, { headers, credentials: 'include' });
    if (!res.ok) throw new Error(`Download fehlgeschlagen: HTTP ${res.status}`);
    return res.blob();
  },

  async deleteDokument(id) {
    return apiFetch(`/dokumente/${id}`, { method: 'DELETE' });
  },

  // ─── Sitzungsprotokoll ─────────────────────────────────────
  async getSessionLogs(limit = 100, offset = 0) {
    return apiFetch(`/session-logs?limit=${limit}&offset=${offset}`);
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
