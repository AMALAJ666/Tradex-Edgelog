(() => {
  'use strict';

  const GIST_ID_KEY = 'ledgerly.gist-id.v1';
  const TOKEN_KEY = 'ledgerly.gist-token.v1';
  const PASSPHRASE_KEY = 'ledgerly.gist-pass.v1';
  const USERNAME_KEY = 'ledgerly.username.v1';
  const SYNC_KEY = 'ledgerly.gist-sync.v1';
  const DEVICE_KEY = 'ledgerly.device-id.v1';
  const PREFERENCES_KEY = 'ledgerly.preferences.v1';
  const DEFAULT_PREFERENCES = { startingBalance: '', currency: 'USD', monthlyTarget: '' };

  function load(key) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return { status: 'missing', data: null };
      return { status: 'ok', data: JSON.parse(raw) };
    } catch (error) {
      return { status: 'corrupt', data: null, error: error.message };
    }
  }

  function save(key, data, options = {}) {
    const serialized = JSON.stringify(data);
    if (options.preserveExisting) {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        localStorage.setItem(`${key}.recovery.${timestamp}`, raw);
      }
    }
    try {
      localStorage.setItem(key, serialized);
    } catch (error) {
      if (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
        throw new Error('Local storage is full, so the journal was not saved. Export a backup, then remove older recovery copies.');
      }
      throw error;
    }
  }

  function getGistConfig() {
    return {
      gistId: localStorage.getItem(GIST_ID_KEY) || '',
      token: sessionStorage.getItem(TOKEN_KEY) || '',
      hasToken: Boolean(sessionStorage.getItem(TOKEN_KEY)),
      passphrase: sessionStorage.getItem(PASSPHRASE_KEY) || '',
      hasPassphrase: Boolean(sessionStorage.getItem(PASSPHRASE_KEY))
    };
  }

  function saveGistConfig({ gistId, token, passphrase }) {
    if (gistId !== undefined) localStorage.setItem(GIST_ID_KEY, gistId.trim());
    if (token) sessionStorage.setItem(TOKEN_KEY, token.trim());
    if (passphrase) sessionStorage.setItem(PASSPHRASE_KEY, passphrase);
  }

  function clearGistToken() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(PASSPHRASE_KEY);
  }

  function getUsername() {
    return localStorage.getItem(USERNAME_KEY) || '';
  }

  function saveUsername(username) {
    localStorage.setItem(USERNAME_KEY, (username || '').trim());
  }

  function getPreferences() {
    const result = load(PREFERENCES_KEY);
    return result.status === 'ok' && result.data && typeof result.data === 'object'
      ? { ...DEFAULT_PREFERENCES, ...result.data }
      : { ...DEFAULT_PREFERENCES };
  }

  function savePreferences(preferences) {
    const source = preferences || {};
    save(PREFERENCES_KEY, {
      startingBalance: String(source.startingBalance ?? '').trim(),
      currency: (source.currency || DEFAULT_PREFERENCES.currency).trim(),
      monthlyTarget: String(source.monthlyTarget ?? '').trim()
    });
  }

  function getDeviceId() {
    let deviceId = localStorage.getItem(DEVICE_KEY);
    if (!deviceId) {
      deviceId = crypto.randomUUID ? crypto.randomUUID() : `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(DEVICE_KEY, deviceId);
    }
    return deviceId;
  }

  function getSyncMetadata() {
    const result = load(SYNC_KEY);
    return result.status === 'ok' && result.data && typeof result.data === 'object' ? result.data : { gistId: '', fingerprint: '', syncedAt: '' };
  }

  function saveSyncMetadata(metadata) {
    save(SYNC_KEY, metadata);
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }

  function fingerprint(value) {
    const input = stableStringify(value);
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  window.JournalStorage = Object.freeze({ load, save, getGistConfig, saveGistConfig, clearGistToken, getUsername, saveUsername, getPreferences, savePreferences, getDeviceId, getSyncMetadata, saveSyncMetadata, fingerprint });
})();
