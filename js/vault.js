(() => {
  'use strict';

  const VAULT_KEY = 'ledgerly.vault.v1';
  const SCHEMA = 'ledgerly-vault';
  const ITERATIONS = 210000;
  const VERIFIER_TEXT = 'ledgerly-vault-verifier-v1';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // In-memory only. Holds the derived key, password (used as Gist passphrase) and
  // decrypted GitHub token while the app is unlocked. Never persisted.
  let session = null;

  class VaultError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'VaultError';
      this.code = code;
    }
  }

  function b64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
  }

  function ub64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function randomBytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
  }

  async function deriveKey(password, salt, iterations) {
    const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptWithKey(key, plaintext) {
    const iv = randomBytes(12);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));
    return { iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) };
  }

  async function decryptWithKey(key, ivB64, ciphertextB64) {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(ivB64) }, key, ub64(ciphertextB64));
    return decoder.decode(plaintext);
  }

  function readVault() {
    const raw = localStorage.getItem(VAULT_KEY);
    if (raw === null) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new VaultError('corrupt', 'Stored vault data is corrupted.');
    }
    if (!parsed || parsed.schema !== SCHEMA || !parsed.kdf || !parsed.verifier) {
      throw new VaultError('corrupt', 'Stored vault data is invalid.');
    }
    return parsed;
  }

  function safeRead() {
    try {
      return readVault();
    } catch {
      return null;
    }
  }

  function writeVault(vault) {
    vault.updatedAt = new Date().toISOString();
    localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
  }

  function requireUnlocked() {
    if (!session) throw new VaultError('locked', 'The vault is locked.');
  }

  function exists() {
    return localStorage.getItem(VAULT_KEY) !== null;
  }

  function isUnlocked() {
    return session !== null;
  }

  async function create({ appUsername, password }) {
    if (exists()) throw new VaultError('exists', 'A vault already exists on this device.');
    const username = (appUsername || '').trim();
    if (!username) throw new VaultError('invalid-username', 'Enter a username.');
    if (!password || password.length < 8) throw new VaultError('weak-password', 'Use a password with at least 8 characters.');
    const salt = randomBytes(16);
    const key = await deriveKey(password, salt, ITERATIONS);
    const verifier = await encryptWithKey(key, VERIFIER_TEXT);
    writeVault({
      schema: SCHEMA,
      version: 1,
      appUsername: username,
      kdf: { salt: b64(salt), iterations: ITERATIONS, hash: 'SHA-256' },
      verifier,
      githubToken: null,
      githubUsername: '',
      gistId: ''
    });
    session = { key, password, token: '' };
  }

  async function unlock(appUsername, password) {
    const vault = readVault();
    if (!vault) throw new VaultError('missing', 'No vault found on this device.');
    if ((appUsername || '').trim() !== vault.appUsername) throw new VaultError('wrong-username', 'Username not recognized.');
    const key = await deriveKey(password || '', ub64(vault.kdf.salt), vault.kdf.iterations);
    let verified;
    try {
      verified = await decryptWithKey(key, vault.verifier.iv, vault.verifier.ciphertext);
    } catch {
      throw new VaultError('wrong-password', 'Incorrect password.');
    }
    if (verified !== VERIFIER_TEXT) throw new VaultError('wrong-password', 'Incorrect password.');
    let token = '';
    if (vault.githubToken) {
      try {
        token = await decryptWithKey(key, vault.githubToken.iv, vault.githubToken.ciphertext);
      } catch {
        throw new VaultError('corrupt', 'Stored GitHub token could not be decrypted.');
      }
    }
    session = { key, password: password || '', token };
  }

  function lock() {
    session = null;
  }

  function getAppUsername() {
    return safeRead()?.appUsername || '';
  }

  function getGithubUsername() {
    return safeRead()?.githubUsername || '';
  }

  function getGistId() {
    return safeRead()?.gistId || '';
  }

  function hasToken() {
    return Boolean(safeRead()?.githubToken);
  }

  function getToken() {
    requireUnlocked();
    return session.token;
  }

  function getPassword() {
    requireUnlocked();
    return session.password;
  }

  async function setGithubConfig({ githubUsername, token, gistId }) {
    requireUnlocked();
    const vault = readVault();
    vault.githubUsername = (githubUsername || '').trim();
    vault.gistId = (gistId || '').trim();
    const trimmedToken = (token || '').trim();
    if (trimmedToken) {
      vault.githubToken = await encryptWithKey(session.key, trimmedToken);
      session.token = trimmedToken;
    }
    writeVault(vault);
  }

  function setGistId(gistId) {
    requireUnlocked();
    const vault = readVault();
    vault.gistId = (gistId || '').trim();
    writeVault(vault);
  }

  function clearToken() {
    requireUnlocked();
    const vault = readVault();
    vault.githubToken = null;
    writeVault(vault);
    session.token = '';
  }

  window.Vault = Object.freeze({
    exists,
    isUnlocked,
    create,
    unlock,
    lock,
    getAppUsername,
    getGithubUsername,
    getGistId,
    setGistId,
    hasToken,
    getToken,
    getPassword,
    setGithubConfig,
    clearToken,
    VaultError
  });
})();
