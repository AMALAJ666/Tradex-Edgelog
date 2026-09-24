(() => {
  'use strict';

  function b64(bytes) {
    let s = '';
    const b = new Uint8Array(bytes);
    for (let i = 0; i < b.length; i += 1) s += String.fromCharCode(b[i]);
    return btoa(s);
  }

  function ub64(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deriveKey(passphrase, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function encryptData(obj, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const iterations = 200000;
    const key = await deriveKey(passphrase, salt, iterations);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
    return { kdf: { salt: b64(salt), iterations }, iv: b64(iv), ciphertext: b64(ct) };
  }

  async function decryptData(payload, passphrase) {
    const key = await deriveKey(passphrase, ub64(payload.kdf.salt), payload.kdf.iterations);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(payload.iv) }, key, ub64(payload.ciphertext));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  class CipherError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  async function unwrap(parsed, passphrase) {
    if (parsed && typeof parsed === 'object' && parsed.ciphertext && parsed.kdf) {
      if (!passphrase) throw new CipherError('missing-passphrase', 'Unlock the vault to read this Gist.');
      try {
        return await decryptData(parsed, passphrase);
      } catch (error) {
        if (/operation-specific|operationerror|decrypt/i.test(`${error.name} ${error.message}`)) throw new CipherError('wrong-passphrase', 'The Gist was encrypted with a different vault password and could not be decrypted.');
        throw new CipherError('malformed-json', 'The encrypted Gist could not be decrypted.');
      }
    }
    return parsed;
  }

  async function wrap(journalData, passphrase) {
    if (!passphrase) throw new CipherError('missing-passphrase', 'Unlock the vault before saving to GitHub.');
    const payload = await encryptData(journalData, passphrase);
    return JSON.stringify({
      schema: journalData.schemaVersion,
      version: journalData.dataVersion,
      updatedAt: journalData.updatedAt,
      deviceId: journalData.deviceId,
      kdf: payload.kdf,
      iv: payload.iv,
      ciphertext: payload.ciphertext
    }, null, 2);
  }

  window.JournalCipher = Object.freeze({ wrap, unwrap, encryptData, decryptData, CipherError });
})();
