(() => {
  'use strict';

  const STORAGE_KEY = 'ledgerly.journal.v1';
  const SCHEMA_VERSION = 1;
  const DEVICE_ID = JournalStorage.getDeviceId();
  const listeners = new Set();
  let preserveExistingData = false;
  let storageWarning = '';

  const makeId = (prefix) => `${prefix}-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const now = () => new Date().toISOString();
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;

  function isValidDate(date) {
    if (!datePattern.test(date)) return false;
    const [year, month, day] = date.split('-').map(Number);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day;
  }

  function assertDate(date) {
    if (!isValidDate(date)) throw new Error('A journal date must be a valid YYYY-MM-DD date.');
  }

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function validateDocument(document) {
    if (!isRecord(document) || document.schemaVersion !== SCHEMA_VERSION) throw new Error(`Expected journal schema version ${SCHEMA_VERSION}.`);
    if (!Number.isInteger(document.dataVersion) || document.dataVersion < 1) throw new Error('Journal data must include a positive dataVersion.');
    if (typeof document.updatedAt !== 'string' || Number.isNaN(Date.parse(document.updatedAt))) throw new Error('Journal data must include a valid updatedAt timestamp.');
    if (typeof document.deviceId !== 'string' || !document.deviceId) throw new Error('Journal data must include a deviceId.');
    if (!Array.isArray(document.strategies) || !Array.isArray(document.journals)) throw new Error('Journal data must contain strategies and journals arrays.');
    const strategyIds = new Set();
    document.strategies.forEach((strategy) => {
      if (!isRecord(strategy) || typeof strategy.id !== 'string' || !strategy.id || typeof strategy.name !== 'string') throw new Error('Each strategy must have an id and name.');
      if (strategyIds.has(strategy.id)) throw new Error('Strategy ids must be unique.');
      strategyIds.add(strategy.id);
    });
    const dates = new Set();
    const tradeIds = new Set();
    document.journals.forEach((journal) => {
      if (!isRecord(journal) || typeof journal.id !== 'string' || !isValidDate(journal.date) || !Array.isArray(journal.trades)) throw new Error('Each journal must have an id, date, and trades array.');
      if (dates.has(journal.date)) throw new Error('Only one journal can exist for each date.');
      dates.add(journal.date);
      journal.trades.forEach((trade) => {
        if (!isRecord(trade) || typeof trade.id !== 'string' || !trade.id || typeof trade.asset !== 'string' || !['long', 'short'].includes(trade.direction) || typeof trade.strategyId !== 'string') throw new Error('Each trade must have valid identifying fields.');
        if (tradeIds.has(trade.id)) throw new Error('Trade ids must be unique.');
        tradeIds.add(trade.id);
        ['entry', 'stopLoss', 'takeProfit', 'riskPercent', 'positionSize', 'pnl'].forEach((field) => {
          if (typeof trade[field] !== 'number' || !Number.isFinite(trade[field])) throw new Error(`Trade ${field} values must be numeric.`);
        });
      });
    });
    return true;
  }

  function migrateLegacyDocument(document) {
    if (!isRecord(document)) return document;
    const migrated = clone(document);
    if (!Number.isInteger(migrated.dataVersion) || migrated.dataVersion < 1) migrated.dataVersion = 1;
    if (typeof migrated.updatedAt !== 'string' || Number.isNaN(Date.parse(migrated.updatedAt))) migrated.updatedAt = now();
    if (typeof migrated.deviceId !== 'string' || !migrated.deviceId) migrated.deviceId = DEVICE_ID;
    return migrated;
  }

  function createDefaultJournal(date, values = {}) {
    assertDate(date);
    const timestamp = now();
    return {
      id: makeId('journal'),
      date,
      createdAt: timestamp,
      updatedAt: timestamp,
      trades: [],
      psychology: {
        before: '',
        during: '',
        after: '',
        confidenceScore: 0,
        impulseScore: 0,
        fearGreedInterference: 'none'
      },
      mistakeFlags: [],
      screenshots: {
        before: '',
        after: ''
      },
      whatHappened: '',
      marketLesson: '',
      whatWorked: '',
      whatFailed: '',
      whatRepeats: '',
      improvementAction: '',
      ...clone(values),
      date
    };
  }

  function createDefaultTrade(values = {}) {
    return {
      id: makeId('trade'),
      asset: '',
      direction: 'long',
      strategyId: '',
      timeframe: '',
      session: '',
      htfBias: 'neutral',
      entry: 0,
      stopLoss: 0,
      takeProfit: 0,
      riskPercent: 0,
      positionSize: 0,
      pnl: 0,
      result: 'breakeven',
      ...clone(values),
      id: values.id || makeId('trade')
    };
  }

  function createDefaultStrategy(values = {}) {
    const timestamp = now();
    return {
      id: makeId('strategy'),
      name: 'Untitled strategy',
      description: '',
      color: 'violet',
      createdAt: timestamp,
      updatedAt: timestamp,
      ...clone(values),
      id: values.id || makeId('strategy')
    };
  }

  function seedState() {
    return { schemaVersion: SCHEMA_VERSION, dataVersion: 1, updatedAt: now(), deviceId: DEVICE_ID, strategies: [], journals: [] };
  }

  function loadState() {
    const stored = JournalStorage.load(STORAGE_KEY);
    if (stored.status === 'missing') return seedState();
    if (stored.status === 'corrupt') {
      preserveExistingData = true;
      storageWarning = 'Existing local journal data could not be read. It will be preserved as a recovery copy before the next save.';
      return seedState();
    }
    try {
      const migrated = migrateLegacyDocument(stored.data);
      validateDocument(migrated);
      return migrated;
    } catch (error) {
      preserveExistingData = true;
      storageWarning = `Existing local journal data is invalid: ${error.message} It will be preserved as a recovery copy before the next save.`;
      return seedState();
    }
  }

  let state = loadState();

  function commit({ localChange = true } = {}) {
    if (localChange) {
      state.dataVersion = Math.max(1, Number(state.dataVersion) || 1) + 1;
      state.updatedAt = now();
      state.deviceId = DEVICE_ID;
    }
    JournalStorage.save(STORAGE_KEY, state, { preserveExisting: preserveExistingData });
    preserveExistingData = false;
    const snapshot = getState();
    listeners.forEach((listener) => listener(snapshot));
    return snapshot;
  }

  function getState() {
    return clone(state);
  }

  function exportData() {
    return getState();
  }

  function importData(document) {
    validateDocument(document);
    const previousState = state;
    state = clone(document);
    try {
      commit({ localChange: false });
    } catch (error) {
      state = previousState;
      throw error;
    }
    return getState();
  }

  function prepareKeepLocalResolution(remoteDataVersion) {
    state.dataVersion = Math.max(state.dataVersion, Number(remoteDataVersion) || 0) + 1;
    state.updatedAt = now();
    state.deviceId = DEVICE_ID;
    commit({ localChange: false });
    return getState();
  }

  function getJournal(date) {
    assertDate(date);
    const journal = state.journals.find((item) => item.date === date);
    return journal ? clone(journal) : null;
  }

  function buildDraftJournal(date) {
    return createDefaultJournal(date);
  }

  function createJournal(date, values = {}) {
    assertDate(date);
    if (state.journals.some((journal) => journal.date === date)) throw new Error(`A journal already exists for ${date}.`);
    const journal = createDefaultJournal(date, values);
    journal.trades = (journal.trades || []).map(createDefaultTrade);
    state.journals.push(journal);
    state.journals.sort((first, second) => first.date.localeCompare(second.date));
    commit();
    return clone(journal);
  }

  function updateJournal(date, changes) {
    const journal = state.journals.find((item) => item.date === date);
    if (!journal) throw new Error(`No journal exists for ${date}.`);
    const { id, date: requestedDate, createdAt, updatedAt, trades, psychology, ...fields } = changes;
    Object.assign(journal, clone(fields));
    if (psychology) journal.psychology = { ...journal.psychology, ...clone(psychology) };
    if (trades) journal.trades = clone(trades).map(createDefaultTrade);
    journal.updatedAt = now();
    commit();
    return clone(journal);
  }

  function deleteJournal(date) {
    const index = state.journals.findIndex((journal) => journal.date === date);
    if (index < 0) return false;
    state.journals.splice(index, 1);
    commit();
    return true;
  }

  function requireJournal(date) {
    const journal = state.journals.find((item) => item.date === date);
    if (!journal) throw new Error(`No journal exists for ${date}.`);
    return journal;
  }

  function createTrade(date, values = {}) {
    const journal = requireJournal(date);
    const trade = createDefaultTrade(values);
    journal.trades.push(trade);
    journal.updatedAt = now();
    commit();
    return clone(trade);
  }

  function updateTrade(date, tradeId, changes) {
    const journal = requireJournal(date);
    const trade = journal.trades.find((item) => item.id === tradeId);
    if (!trade) throw new Error(`No trade exists with id ${tradeId}.`);
    const { id, ...fields } = changes;
    Object.assign(trade, clone(fields));
    journal.updatedAt = now();
    commit();
    return clone(trade);
  }

  function deleteTrade(date, tradeId) {
    const journal = requireJournal(date);
    const index = journal.trades.findIndex((trade) => trade.id === tradeId);
    if (index < 0) return false;
    journal.trades.splice(index, 1);
    journal.updatedAt = now();
    commit();
    return true;
  }

  function createStrategy(values = {}) {
    const strategy = createDefaultStrategy(values);
    state.strategies.push(strategy);
    commit();
    return clone(strategy);
  }

  function updateStrategy(strategyId, changes) {
    const strategy = state.strategies.find((item) => item.id === strategyId);
    if (!strategy) throw new Error(`No strategy exists with id ${strategyId}.`);
    const { id, createdAt, updatedAt, ...fields } = changes;
    Object.assign(strategy, clone(fields), { updatedAt: now() });
    commit();
    return clone(strategy);
  }

  function deleteStrategy(strategyId) {
    const index = state.strategies.findIndex((strategy) => strategy.id === strategyId);
    if (index < 0) return false;
    state.strategies.splice(index, 1);
    state.journals.forEach((journal) => {
      journal.trades.forEach((trade) => {
        if (trade.strategyId === strategyId) trade.strategyId = '';
      });
    });
    commit();
    return true;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  window.JournalStore = Object.freeze({
    getState,
    exportData,
    importData,
    prepareKeepLocalResolution,
    getStorageWarning: () => storageWarning,
    getJournal,
    buildDraftJournal,
    createJournal,
    updateJournal,
    deleteJournal,
    createTrade,
    updateTrade,
    deleteTrade,
    createStrategy,
    updateStrategy,
    deleteStrategy,
    subscribe
  });
})();
