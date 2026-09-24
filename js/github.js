(() => {
  'use strict';

  const API_ROOT = 'https://api.github.com';
  const JOURNAL_FILE = 'trading-journal.json';
  const GIST_DESCRIPTION = 'Ledgerly trading journal (encrypted)';

  class GithubError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  // The plaintext token lives only in this call frame; it is never returned, cached or logged.
  function takeToken() {
    if (!window.Vault || !Vault.isUnlocked()) throw new GithubError('locked', 'Unlock the vault before syncing with GitHub.');
    const token = Vault.getToken();
    if (!token) throw new GithubError('missing-token', 'Add your GitHub token in Settings → GitHub storage before syncing.');
    return token;
  }

  function takePassphrase() {
    if (!window.Vault || !Vault.isUnlocked()) throw new GithubError('locked', 'Unlock the vault before syncing with GitHub.');
    return Vault.getPassword();
  }

  function currentGistId() {
    return (window.Vault && Vault.isUnlocked()) ? Vault.getGistId() : '';
  }

  function describeFailure(response) {
    if (response.status === 401) return new GithubError('invalid-token', 'GitHub rejected the token. Create a new token with the "gist" scope and save it again.');
    if (response.status === 403) {
      if (response.headers.get('x-ratelimit-remaining') === '0') return new GithubError('rate-limited', 'GitHub rate limit reached. Wait a few minutes and try again.');
      return new GithubError('forbidden', 'GitHub refused the request. The token is missing the "gist" scope or access was blocked.');
    }
    if (response.status === 404) return new GithubError('not-found', 'GitHub could not find that Gist. Check the Gist ID, or clear it to create a new one.');
    if (response.status === 409 || response.status === 412) return new GithubError('conflict', 'The Gist changed on GitHub since it was last read. Review the conflict before saving.');
    if (response.status === 422) return new GithubError('invalid-request', 'GitHub rejected the journal payload. Your local journal was not changed.');
    if (response.status >= 500) return new GithubError('server-error', 'GitHub is currently unavailable. Your local journal was not changed.');
    return new GithubError('github-error', `GitHub returned ${response.status}. Your local journal was not changed.`);
  }

  async function request(url, { method = 'GET', body, etag } = {}) {
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${takeToken()}`,
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (body) headers['Content-Type'] = 'application/json';
    if (etag) headers['If-Match'] = etag;
    let response;
    try {
      response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new GithubError('network', 'GitHub could not be reached. Your local journal is still available offline.');
    }
    if (!response.ok) throw describeFailure(response);
    return response;
  }

  async function parseJson(response, context) {
    try {
      return await response.json();
    } catch {
      throw new GithubError('invalid-response', `GitHub returned an unreadable ${context} response.`);
    }
  }

  async function testConnection() {
    const response = await request(`${API_ROOT}/user`);
    const user = await parseJson(response, 'account');
    const scopes = (response.headers.get('x-oauth-scopes') || '').split(',').map((scope) => scope.trim());
    if (scopes.length && scopes[0] !== '' && !scopes.includes('gist')) throw new GithubError('forbidden', 'This token does not include the "gist" scope. Create a new token with Gist access.');
    return { login: user.login || '' };
  }

  async function getGist(gistId) {
    if (!gistId) throw new GithubError('missing-gist-id', 'No Gist ID is configured yet.');
    const response = await request(`${API_ROOT}/gists/${encodeURIComponent(gistId)}`);
    const gist = await parseJson(response, 'Gist');
    return { gist, etag: response.headers.get('etag') || '' };
  }

  async function readJournalFile(gist) {
    const file = gist.files?.[JOURNAL_FILE];
    if (!file) throw new GithubError('missing-journal-file', `The Gist does not contain ${JOURNAL_FILE}.`);
    let content = file.content;
    if (file.truncated && file.raw_url) content = await (await request(file.raw_url)).text();
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new GithubError('malformed-json', `${JOURNAL_FILE} contains malformed JSON.`);
    }
    return JournalCipher.unwrap(parsed, takePassphrase());
  }

  async function loadJournal(gistId = currentGistId()) {
    const { gist, etag } = await getGist(gistId);
    const data = await readJournalFile(gist);
    return { data, etag, fingerprint: JournalStorage.fingerprint(data) };
  }

  async function createGist(journalData) {
    const content = await JournalCipher.wrap(journalData, takePassphrase());
    const response = await request(`${API_ROOT}/gists`, {
      method: 'POST',
      body: { description: GIST_DESCRIPTION, public: false, files: { [JOURNAL_FILE]: { content } } }
    });
    const gist = await parseJson(response, 'Gist');
    if (!gist.id) throw new GithubError('invalid-response', 'GitHub did not return a new Gist id.');
    Vault.setGistId(gist.id);
    return { gistId: gist.id, etag: response.headers.get('etag') || '' };
  }

  async function updateGist(gistId, journalData, etag) {
    if (!gistId) throw new GithubError('missing-gist-id', 'No Gist ID is configured yet.');
    const content = await JournalCipher.wrap(journalData, takePassphrase());
    const response = await request(`${API_ROOT}/gists/${encodeURIComponent(gistId)}`, {
      method: 'PATCH',
      body: { files: { [JOURNAL_FILE]: { content } } },
      etag
    });
    return { etag: response.headers.get('etag') || '' };
  }

  // Re-reads the remote copy and refuses to write when it no longer matches what the caller reviewed.
  async function saveJournal(journalData, { expectedFingerprint = null, etag = '' } = {}) {
    const gistId = currentGistId();
    if (!gistId) return createGist(journalData);
    if (expectedFingerprint !== null) {
      const latest = await loadJournal(gistId);
      if (latest.fingerprint !== expectedFingerprint) throw new GithubError('conflict', 'The GitHub journal changed since it was last read. Review the conflict before saving.');
      return { gistId, ...(await updateGist(gistId, journalData, latest.etag)) };
    }
    return { gistId, ...(await updateGist(gistId, journalData, etag)) };
  }

  async function connect({ githubUsername, token, gistId }) {
    await Vault.setGithubConfig({ githubUsername, token, gistId });
    return testConnection();
  }

  window.GithubStorage = Object.freeze({
    connect,
    testConnection,
    loadJournal,
    saveJournal,
    createGist,
    getGist,
    updateGist,
    GithubError,
    journalFileName: JOURNAL_FILE
  });
})();
