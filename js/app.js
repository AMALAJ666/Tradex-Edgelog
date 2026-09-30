const initialToday = new Date();
let activeJournalDate = `${initialToday.getFullYear()}-${String(initialToday.getMonth() + 1).padStart(2, '0')}-${String(initialToday.getDate()).padStart(2, '0')}`;
let displayedMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let toastTimer;
let journalDraft = null;
let saveStatus = 'saved';
let syncConflict = null;
const screenshotUrls = { before: '', after: '' };

const numericTradeFields = new Set(['entry', 'stopLoss', 'takeProfit', 'riskPercent', 'positionSize', 'leverage', 'pnl']);
let pnlChart;
let strategyChart;

function cloneJournal(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadJournalDraft() {
  const existing = JournalStore.getJournal(activeJournalDate);
  journalDraft = cloneJournal(existing || JournalStore.buildDraftJournal(activeJournalDate));
  journalDraft.screenshots = { before: '', after: '', ...journalDraft.screenshots };
  setSaveStatus('saved');
}

function setSaveStatus(status) {
  saveStatus = status;
  const statusElement = document.getElementById('saveStatus');
  if (!statusElement) return;
  statusElement.textContent = status === 'saving' ? 'Saving' : status === 'saved' ? 'Saved' : status === 'failed' ? 'Save failed' : 'Unsaved';
  statusElement.className = `save-status ${status}`;
}

function markJournalDirty() {
  if (saveStatus !== 'saving') setSaveStatus('unsaved');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function formatDateKey(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatPnl(pnl) {
  const symbol = currencySymbol();
  const amount = Math.abs(pnl).toFixed(2);
  return pnl > 0 ? `+${symbol}${amount}` : pnl < 0 ? `-${symbol}${amount}` : `${symbol}0.00`;
}

const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹', AUD: 'A$', CAD: 'C$' };
let preferences = JournalStorage.getPreferences();

function currencySymbol() {
  return CURRENCY_SYMBOLS[preferences.currency] || '$';
}

function calculateRiskReward(trade) {
  const entry = Number(trade.entry);
  const stopLoss = Number(trade.stopLoss);
  const takeProfit = Number(trade.takeProfit);
  const risk = trade.direction === 'short' ? stopLoss - entry : entry - stopLoss;
  const reward = trade.direction === 'short' ? entry - takeProfit : takeProfit - entry;
  return risk > 0 && reward >= 0 ? reward / risk : null;
}

function deriveAnalytics() {
  const state = JournalStore.getState();
  const strategyMap = new Map(state.strategies.map((strategy) => [strategy.id, strategy]));
  const byStrategy = new Map(state.strategies.map((strategy) => [strategy.id, { id: strategy.id, name: strategy.name, color: strategy.color, pnl: 0, count: 0, wins: 0, losses: 0, breakeven: 0 }]));
  const trades = [];
  const riskRewards = [];

  state.journals.forEach((journal) => {
    journal.trades.forEach((trade) => {
      const pnl = Number(trade.pnl || 0);
      const strategyId = trade.strategyId || 'unassigned';
      if (!byStrategy.has(strategyId)) byStrategy.set(strategyId, { id: strategyId, name: strategyMap.get(strategyId)?.name || 'Unassigned', color: 'gray', pnl: 0, count: 0, wins: 0, losses: 0, breakeven: 0 });
      const strategy = byStrategy.get(strategyId);
      strategy.pnl += pnl;
      strategy.count += 1;
      if (pnl > 0) strategy.wins += 1;
      else if (pnl < 0) strategy.losses += 1;
      else strategy.breakeven += 1;
      const riskReward = calculateRiskReward(trade);
      if (riskReward !== null) riskRewards.push(riskReward);
      trades.push({ ...trade, date: journal.date, pnl });
    });
  });

  trades.sort((first, second) => first.date.localeCompare(second.date));
  const totalPnl = trades.reduce((total, trade) => total + trade.pnl, 0);
  const winningTrades = trades.filter((trade) => trade.pnl > 0).length;
  const losingTrades = trades.filter((trade) => trade.pnl < 0).length;
  const breakevenTrades = trades.length - winningTrades - losingTrades;
  const dateTotals = trades.reduce((totals, trade) => {
    totals.set(trade.date, (totals.get(trade.date) || 0) + trade.pnl);
    return totals;
  }, new Map());
  let runningPnl = 0;
  const cumulative = [...dateTotals.entries()].sort((first, second) => first[0].localeCompare(second[0])).map(([date, pnl]) => {
    runningPnl += pnl;
    return { date, pnl: runningPnl };
  });

  const lessons = trades
    .filter((trade) => String(trade.whatILearned || '').trim())
    .map((trade) => ({
      date: trade.date,
      asset: trade.asset,
      strategyName: strategyMap.get(trade.strategyId)?.name || 'Unassigned',
      pnl: trade.pnl,
      lesson: String(trade.whatILearned).trim()
    }))
    .sort((first, second) => second.date.localeCompare(first.date));

  return {
    totalPnl,
    totalTrades: trades.length,
    winningTrades,
    losingTrades,
    breakevenTrades,
    winRate: trades.length ? winningTrades / trades.length : 0,
    averagePnl: trades.length ? totalPnl / trades.length : 0,
    averageRiskReward: riskRewards.length ? riskRewards.reduce((total, value) => total + value, 0) / riskRewards.length : null,
    cumulative,
    lessons,
    strategies: [...byStrategy.values()].map((strategy) => ({ ...strategy, winRate: strategy.count ? strategy.wins / strategy.count : 0 }))
  };
}

function renderLessons(analytics) {
  const list = document.getElementById('lessonsList');
  if (!list) return;
  const lessons = analytics.lessons.slice(0, 6);
  if (!lessons.length) {
    list.innerHTML = '<p class="muted-copy">Fill in "What I learned" on a trade and your lessons will collect here.</p>';
    return;
  }
  list.innerHTML = lessons.map((lesson) => {
    const when = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(`${lesson.date}T00:00:00`));
    const asset = lesson.asset ? ` · ${escapeHtml(lesson.asset)}` : '';
    return `<div class="lesson-item"><p>${escapeHtml(lesson.lesson)}</p><span class="lesson-meta">${when}${asset} · ${escapeHtml(lesson.strategyName)} · ${formatPnl(lesson.pnl)}</span></div>`;
  }).join('');
}

function renderAccountBalance(analytics) {
  const value = document.getElementById('accountBalanceValue');
  const detail = document.getElementById('accountBalanceDetail');
  if (!value || !detail) return;
  const startingBalance = Number(preferences.startingBalance);
  const hasStartingBalance = preferences.startingBalance !== '' && Number.isFinite(startingBalance);
  const balance = (hasStartingBalance ? startingBalance : 0) + analytics.totalPnl;
  value.textContent = `${currencySymbol()}${balance.toFixed(2)}`;
  value.classList.toggle('positive', hasStartingBalance && balance > startingBalance);
  value.classList.toggle('negative', hasStartingBalance && balance < startingBalance);
  detail.textContent = hasStartingBalance
    ? `Started at ${currencySymbol()}${startingBalance.toFixed(2)} · ${formatPnl(analytics.totalPnl)}`
    : 'Set a starting balance in Journal defaults';
}

function renderAnalytics() {
  const analytics = deriveAnalytics();
  const totalPnlValue = document.getElementById('totalPnlValue');
  totalPnlValue.textContent = formatPnl(analytics.totalPnl);
  totalPnlValue.classList.toggle('positive', analytics.totalPnl > 0);
  totalPnlValue.classList.toggle('negative', analytics.totalPnl < 0);
  document.getElementById('totalPnlDetail').textContent = 'Across all saved journals';
  document.getElementById('tradeCountValue').textContent = analytics.totalTrades;
  document.getElementById('tradeCountDetail').textContent = `${analytics.breakevenTrades} breakeven ${analytics.breakevenTrades === 1 ? 'trade' : 'trades'}`;
  document.getElementById('winRateValue').textContent = `${(analytics.winRate * 100).toFixed(1)}%`;
  document.getElementById('winRateDetail').textContent = `${analytics.winningTrades} wins / ${analytics.losingTrades} losses`;
  document.getElementById('averagePnlValue').textContent = formatPnl(analytics.averagePnl);
  document.getElementById('averageRrDetail').textContent = analytics.averageRiskReward === null ? 'Avg R:R —' : `Avg R:R 1:${analytics.averageRiskReward.toFixed(2)}`;
  document.getElementById('cumulativePnlValue').textContent = formatPnl(analytics.totalPnl);
  renderAccountBalance(analytics);
  renderLessons(analytics);

  document.getElementById('strategyAnalyticsList').innerHTML = analytics.strategies.map((strategy) => `
    <div><span><i class="strategy-color ${strategy.color}"></i>${escapeHtml(strategy.name)} <small>${strategy.count} trades · ${(strategy.winRate * 100).toFixed(0)}% win</small></span><b class="${strategy.pnl < 0 ? 'negative' : strategy.pnl > 0 ? 'positive' : ''}">${formatPnl(strategy.pnl)}</b></div>
  `).join('') || '<p class="muted-copy">No strategy activity yet.</p>';

  if (pnlChart) {
    pnlChart.data.labels = analytics.cumulative.map((point) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(`${point.date}T00:00:00`)));
    pnlChart.data.datasets[0].data = analytics.cumulative.map((point) => point.pnl);
    pnlChart.update();
  }
  if (strategyChart) {
    strategyChart.data.labels = analytics.strategies.map((strategy) => strategy.name);
    strategyChart.data.datasets[0].data = analytics.strategies.map((strategy) => strategy.pnl);
    strategyChart.data.datasets[0].backgroundColor = analytics.strategies.map((strategy) => strategy.pnl > 0 ? '#8ce0a6' : strategy.pnl < 0 ? '#f18480' : '#626964');
    strategyChart.update();
  }
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function formatJournalHeading(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(year, month - 1, day));
}

function showToast(message, tone = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.remove('error', 'info');
  if (tone === 'error' || tone === 'info') toast.classList.add(tone);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function openConfirmDialog({ title, message, confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirmDialog');
    const acceptButton = document.getElementById('confirmAcceptButton');
    const cancelButton = document.getElementById('confirmCancelButton');
    const previousFocus = document.activeElement;
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').textContent = message;
    acceptButton.textContent = confirmLabel;
    acceptButton.classList.toggle('danger-button', danger);
    overlay.hidden = false;

    function close(result) {
      overlay.hidden = true;
      acceptButton.removeEventListener('click', onAccept);
      cancelButton.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKeydown);
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
      resolve(result);
    }
    function onAccept() { close(true); }
    function onCancel() { close(false); }
    function onOverlayClick(event) { if (event.target === overlay) close(false); }
    function onKeydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); close(false); }
      else if (event.key === 'Tab') {
        event.preventDefault();
        (document.activeElement === acceptButton ? cancelButton : acceptButton).focus();
      }
    }
    acceptButton.addEventListener('click', onAccept);
    cancelButton.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeydown);
    acceptButton.focus();
  });
}

function openPromptDialog({ title, label, value = '', confirmLabel = 'Save' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('promptDialog');
    const acceptButton = document.getElementById('promptAcceptButton');
    const cancelButton = document.getElementById('promptCancelButton');
    const input = document.getElementById('promptInput');
    const previousFocus = document.activeElement;
    document.getElementById('promptTitle').textContent = title;
    document.getElementById('promptLabel').textContent = label;
    acceptButton.textContent = confirmLabel;
    input.value = value;
    overlay.hidden = false;

    function close(result) {
      overlay.hidden = true;
      acceptButton.removeEventListener('click', onAccept);
      cancelButton.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKeydown);
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
      resolve(result);
    }
    function onAccept() { close(input.value); }
    function onCancel() { close(null); }
    function onOverlayClick(event) { if (event.target === overlay) close(null); }
    function onKeydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); close(null); }
      else if (event.key === 'Enter') { event.preventDefault(); close(input.value); }
      else if (event.key === 'Tab') {
        const focusables = [input, cancelButton, acceptButton];
        const currentIndex = focusables.indexOf(document.activeElement);
        const nextIndex = (currentIndex + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
        event.preventDefault();
        focusables[nextIndex].focus();
      }
    }
    acceptButton.addEventListener('click', onAccept);
    cancelButton.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeydown);
    input.focus();
    input.select();
  });
}

function renderGreeting() {
  const name = Vault.getAppUsername().trim();
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  document.getElementById('dashboardGreeting').textContent = name ? `${part}, ${name}.` : `${part}.`;
}

function renderPreferences() {
  preferences = JournalStorage.getPreferences();
  document.getElementById('startingBalanceInput').value = preferences.startingBalance;
  document.getElementById('currencyInput').value = preferences.currency;
  document.getElementById('monthlyTargetInput').value = preferences.monthlyTarget;
}

function renderReflection() {
  const journals = JournalStore.getState().journals;
  const quote = document.getElementById('reflectionQuote');
  const pill = document.getElementById('reflectionDate');
  const latest = journals
    .filter((journal) => (journal.whatWorked || journal.marketLesson || journal.improvementAction || '').trim())
    .sort((first, second) => second.date.localeCompare(first.date))[0];
  if (!latest) {
    quote.textContent = 'Your latest reflection will appear here once you save a journal entry.';
    quote.classList.add('muted-copy');
    pill.hidden = true;
    return;
  }
  quote.textContent = `“${(latest.whatWorked || latest.marketLesson || latest.improvementAction).trim()}”`;
  quote.classList.remove('muted-copy');
  pill.hidden = false;
  pill.textContent = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(`${latest.date}T00:00:00`));
}

function hasUnsavedChanges() {
  return saveStatus === 'unsaved';
}

function renderCalendar() {
  const grid = document.getElementById('calendarGrid');
  const year = displayedMonth.getFullYear();
  const month = displayedMonth.getMonth();
  const firstWeekdayOffset = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((firstWeekdayOffset + daysInMonth) / 7) * 7;
  const currentDate = new Date();
  const todayKey = formatDateKey(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
  const journals = JournalStore.getState().journals;
  const calendarData = journals.reduce((activity, journal) => {
    if (!journal.date.startsWith(`${year}-${String(month + 1).padStart(2, '0')}-`)) return activity;
    activity[journal.date] = {
      count: journal.trades.length,
      pnl: journal.trades.reduce((total, trade) => total + Number(trade.pnl || 0), 0)
    };
    return activity;
  }, {});
  const cells = [];

  for (let index = 0; index < firstWeekdayOffset; index += 1) cells.push('<div class="calendar-day empty"></div>');
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateKey = formatDateKey(year, month, day);
    const activity = calendarData[dateKey] || { count: 0, pnl: 0 };
    const isToday = dateKey === todayKey;
    const pnlClass = activity.pnl > 0 ? 'gain' : activity.pnl < 0 ? 'loss' : 'neutral';
    cells.push(`
      <button class="calendar-day ${activity.count ? 'trade-day' : ''} ${isToday ? 'today' : ''}" type="button" data-date="${dateKey}" aria-label="${dateKey}, ${activity.count} trades, ${formatPnl(activity.pnl)}">
        ${day}
        ${activity.count ? `<span class="count">${activity.count}</span>` : ''}<span class="day-pnl ${pnlClass}">${activity.count ? formatPnl(activity.pnl) : ''}</span>
      </button>
    `);
  }
  for (let index = firstWeekdayOffset + daysInMonth; index < totalCells; index += 1) cells.push('<div class="calendar-day empty"></div>');
  grid.innerHTML = cells.join('');
  document.getElementById('calendarMonthLabel').textContent = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(displayedMonth);
  grid.onclick = (event) => {
    const date = event.target.closest('[data-date]')?.dataset.date;
    if (date) openJournal(date);
  };
}

function openJournal(date) {
  activeJournalDate = date;
  const route = `#/journal/${date}`;
  if (location.hash === route) setRoute();
  else location.hash = route;
}

const PRESET_ADD_VALUE = '__add_preset__';

// Builds a select from the saved preset list, always keeping the trade's current value selectable.
function presetSelect(field, kind, value, presets, required) {
  const saved = presets?.[kind] || [];
  const current = String(value ?? '').trim();
  const options = current && !saved.includes(current) ? [current, ...saved] : saved;
  const rendered = options.map((item) => `<option value="${escapeHtml(item)}" ${item === current ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('');
  return `<select data-trade-field="${field}" data-preset-kind="${kind}" ${required ? 'required' : ''}><option value="" ${current ? '' : 'selected'}>Select</option>${rendered}<option value="${PRESET_ADD_VALUE}">+ Add new...</option></select>`;
}

function renderTrades() {
  const list = document.getElementById('tradeList');
  const state = JournalStore.getState();
  const strategyOptions = [`<option value="">Select strategy</option>`, ...state.strategies.map((strategy) => `<option value="${strategy.id}">${escapeHtml(strategy.name)}</option>`)].join('');
  if (!journalDraft.trades.length) {
    list.innerHTML = '<p class="empty-trades">No trades yet. Add only the trades worth reviewing.</p>';
    return;
  }
  list.innerHTML = journalDraft.trades.map((trade, index) => `
    <article class="trade-editor" data-trade-id="${trade.id}">
      <div class="trade-editor-heading"><b>Trade ${index + 1}</b><button class="text-button delete-trade" type="button" data-delete-trade="${trade.id}">Delete</button></div>
      <div class="trade-fields">
        <label>Asset${presetSelect('asset', 'assets', trade.asset, state.presets, true)}</label>
        <label>Direction<select data-trade-field="direction" required><option value="long" ${trade.direction === 'long' ? 'selected' : ''}>Long</option><option value="short" ${trade.direction === 'short' ? 'selected' : ''}>Short</option></select></label>
        <label>Strategy<select data-trade-field="strategyId" required>${strategyOptions.replace(`value="${trade.strategyId}"`, `value="${trade.strategyId}" selected`)}</select></label>
        <label>Entry<input data-trade-field="entry" type="number" step="any" value="${escapeHtml(trade.entry)}" required></label>
        <label>Stop loss<input data-trade-field="stopLoss" type="number" step="any" value="${escapeHtml(trade.stopLoss)}" required></label>
        <label>Take profit<input data-trade-field="takeProfit" type="number" step="any" value="${escapeHtml(trade.takeProfit)}" required></label>
        <label>P&amp;L<input data-trade-field="pnl" type="number" step="any" value="${escapeHtml(trade.pnl)}" required></label>
      </div>
      <details class="trade-optional"><summary>Optional context</summary><div class="trade-fields optional-fields"><label>Timeframe${presetSelect('timeframe', 'timeframes', trade.timeframe, state.presets, false)}</label><label>Session${presetSelect('session', 'sessions', trade.session, state.presets, false)}</label><label>HTF bias<select data-trade-field="htfBias"><option value="bullish" ${trade.htfBias === 'bullish' ? 'selected' : ''}>Bullish</option><option value="neutral" ${trade.htfBias === 'neutral' ? 'selected' : ''}>Neutral</option><option value="bearish" ${trade.htfBias === 'bearish' ? 'selected' : ''}>Bearish</option></select></label><label>Risk %<input data-trade-field="riskPercent" type="number" step="any" value="${escapeHtml(trade.riskPercent)}"></label><label>Position size<input data-trade-field="positionSize" type="number" step="any" value="${escapeHtml(trade.positionSize)}"></label><label>Leverage<input data-trade-field="leverage" type="number" step="any" min="0" value="${escapeHtml(trade.leverage)}" placeholder="10"></label></div></details>
      <details class="trade-analysis"><summary>Trade analysis</summary><div class="trade-analysis-fields"><label>Why I took it<textarea data-trade-field="whyTaken" placeholder="What made this setup worth risking money on?">${escapeHtml(trade.whyTaken)}</textarea></label><label>What went right<textarea data-trade-field="whatWentRight" placeholder="Name the execution worth repeating...">${escapeHtml(trade.whatWentRight)}</textarea></label><label>What went wrong<textarea data-trade-field="whatWentWrong" placeholder="Where did the plan and the execution split?">${escapeHtml(trade.whatWentWrong)}</textarea></label><label>What I learned<textarea data-trade-field="whatILearned" placeholder="One lesson you want on the dashboard...">${escapeHtml(trade.whatILearned)}</textarea></label></div></details>
    </article>
  `).join('');
}

async function renderScreenshots() {
  await Promise.all(['before', 'after'].map(async (slot) => {
    const element = document.getElementById(`${slot}Screenshot`);
    if (!element) return;
    if (screenshotUrls[slot]) {
      URL.revokeObjectURL(screenshotUrls[slot]);
      screenshotUrls[slot] = '';
    }
    const value = journalDraft.screenshots[slot];
    let source = '';
    if (ScreenshotStore.isLegacyDataUrl(value)) {
      source = value;
    } else if (ScreenshotStore.isReference(value)) {
      const record = await ScreenshotStore.get(value).catch(() => null);
      if (record?.blob) {
        source = URL.createObjectURL(record.blob);
        screenshotUrls[slot] = source;
      }
    }
    element.classList.toggle('has-image', Boolean(source));
    element.style.backgroundImage = source ? `url("${source}")` : '';
    const tools = document.getElementById(`${slot}ScreenshotTools`);
    if (tools) tools.hidden = !source;
  }));
}

function openImageViewer(slot) {
  const source = screenshotUrls[slot] || (ScreenshotStore.isLegacyDataUrl(journalDraft.screenshots[slot]) ? journalDraft.screenshots[slot] : '');
  if (!source) return;
  const overlay = document.getElementById('imageDialog');
  const image = document.getElementById('imageDialogImage');
  const closeButton = document.getElementById('imageCloseButton');
  const previousFocus = document.activeElement;
  document.getElementById('imageDialogLabel').textContent = slot === 'before' ? 'Before screenshot' : 'After screenshot';
  image.src = source;
  overlay.hidden = false;
  closeButton.focus();

  function close() {
    overlay.hidden = true;
    image.removeAttribute('src');
    closeButton.removeEventListener('click', close);
    overlay.removeEventListener('click', onOverlayClick);
    document.removeEventListener('keydown', onKeydown);
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  }
  function onOverlayClick(event) {
    if (event.target === overlay) close();
  }
  function onKeydown(event) {
    if (event.key === 'Escape') close();
  }
  closeButton.addEventListener('click', close);
  overlay.addEventListener('click', onOverlayClick);
  document.addEventListener('keydown', onKeydown);
}

async function removeScreenshot(slot) {
  const value = journalDraft.screenshots[slot];
  if (!value) return;
  const confirmed = await openConfirmDialog({ title: 'Remove this screenshot?', message: 'The image will be deleted from this device. Your journal text is not affected.', confirmLabel: 'Remove screenshot', danger: true });
  if (!confirmed) return;
  if (ScreenshotStore.isReference(value)) await ScreenshotStore.remove(value).catch(() => null);
  journalDraft.screenshots[slot] = '';
  markJournalDirty();
  renderJournalFields();
  renderStorageUsage();
  showToast('Screenshot removed.');
}

function setupScreenshotTools() {
  document.querySelectorAll('.screenshot-placeholder').forEach((label) => {
    label.addEventListener('click', (event) => {
      if (!label.classList.contains('has-image')) return;
      event.preventDefault();
      openImageViewer(label.id.replace('Screenshot', ''));
    });
  });
  document.querySelectorAll('.screenshot-tools').forEach((tools) => {
    tools.addEventListener('click', (event) => {
      const view = event.target.closest('[data-view-shot]')?.dataset.viewShot;
      const replace = event.target.closest('[data-replace-shot]')?.dataset.replaceShot;
      const remove = event.target.closest('[data-remove-shot]')?.dataset.removeShot;
      if (view) openImageViewer(view);
      else if (replace) document.querySelector(`[data-screenshot-slot="${replace}"]`).click();
      else if (remove) removeScreenshot(remove);
    });
  });
}

function renderJournalFields() {
  document.querySelectorAll('[data-journal-field]').forEach((field) => { field.value = journalDraft[field.dataset.journalField] || ''; });
  document.querySelectorAll('[data-psychology-field]').forEach((field) => { field.value = journalDraft.psychology[field.dataset.psychologyField] ?? ''; });
  document.querySelectorAll('[data-mistake-flag]').forEach((field) => { field.checked = journalDraft.mistakeFlags.includes(field.dataset.mistakeFlag); });
  document.getElementById('confidenceValue').textContent = journalDraft.psychology.confidenceScore || 0;
  document.getElementById('impulseValue').textContent = journalDraft.psychology.impulseScore || 0;
  renderScreenshots();
}

function renderDailySummary() {
  const journal = journalDraft;
  const strategies = new Map(JournalStore.getState().strategies.map((strategy) => [strategy.id, strategy.name]));
  const pnl = journal.trades.reduce((total, trade) => total + Number(trade.pnl || 0), 0);
  const wins = journal.trades.filter((trade) => Number(trade.pnl || 0) > 0).length;
  const losses = journal.trades.filter((trade) => Number(trade.pnl || 0) < 0).length;
  const strategyPnl = journal.trades.reduce((totals, trade) => {
    const key = trade.strategyId || '';
    totals.set(key, (totals.get(key) || 0) + Number(trade.pnl || 0));
    return totals;
  }, new Map());
  const [bestStrategyId, bestStrategyPnl] = [...strategyPnl.entries()].sort((first, second) => second[1] - first[1])[0] || [];
  const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${activeJournalDate}T00:00:00`));

  const pnlValue = document.getElementById('dailyPnlValue');
  pnlValue.textContent = formatPnl(pnl);
  pnlValue.classList.toggle('positive', pnl > 0);
  document.getElementById('dailyPnlDetail').textContent = journal.trades.length ? 'Calculated from trades' : 'No trades recorded';
  document.getElementById('dailyTradeCount').textContent = journal.trades.length;
  document.getElementById('dailyTradeDetail').textContent = journal.trades.length ? `${wins} wins, ${losses} losses` : 'No trades recorded';
  document.getElementById('dailyBestSetup').textContent = bestStrategyId ? strategies.get(bestStrategyId) || 'Unassigned' : '—';
  document.getElementById('dailyBestSetupDetail').textContent = bestStrategyId ? formatPnl(bestStrategyPnl) : 'No setup recorded';
  document.getElementById('dailyMindset').textContent = journal.psychology.after || '—';
  document.getElementById('dailyMindsetDetail').textContent = journal.psychology.confidenceScore ? `Confidence ${journal.psychology.confidenceScore}/5` : 'Not recorded';
  document.getElementById('journalDateControl').textContent = `‹ ${date} ›`;
}

function createDraftTrade() {
  return {
    id: `trade-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    asset: '', direction: 'long', strategyId: '', timeframe: '', session: '', htfBias: 'neutral',
    entry: '', stopLoss: '', takeProfit: '', riskPercent: '', positionSize: '', leverage: '', pnl: '', result: 'breakeven',
    whyTaken: '', whatWentRight: '', whatWentWrong: '', whatILearned: ''
  };
}

function validateJournalDraft() {
  const requiredFields = ['asset', 'direction', 'strategyId', 'entry', 'stopLoss', 'takeProfit', 'pnl'];
  const invalidTrade = journalDraft.trades.find((trade) => requiredFields.some((field) => String(trade[field] ?? '').trim() === ''));
  if (invalidTrade) throw new Error('Complete asset, direction, strategy, entry, stop loss, take profit, and P&L for every trade.');
  const invalidNumber = journalDraft.trades.find((trade) => [...numericTradeFields].some((field) => trade[field] !== '' && !Number.isFinite(Number(trade[field]))));
  if (invalidNumber) throw new Error('Trade price, size, and P&L fields must be valid numbers.');
}

function normalizedTrades() {
  return journalDraft.trades.map((trade) => {
    const normalized = { ...trade };
    numericTradeFields.forEach((field) => { normalized[field] = trade[field] === '' ? 0 : Number(trade[field]); });
    normalized.result = normalized.pnl > 0 ? 'win' : normalized.pnl < 0 ? 'loss' : 'breakeven';
    return normalized;
  });
}

async function saveJournalDraft() {
  try {
    validateJournalDraft();
    setSaveStatus('saving');
    await new Promise((resolve) => setTimeout(resolve, 120));
    const journalPayload = {
      trades: normalizedTrades(),
      psychology: journalDraft.psychology,
      mistakeFlags: journalDraft.mistakeFlags,
      screenshots: journalDraft.screenshots,
      whatHappened: journalDraft.whatHappened,
      marketLesson: journalDraft.marketLesson,
      whatWorked: journalDraft.whatWorked,
      whatFailed: journalDraft.whatFailed,
      whatRepeats: journalDraft.whatRepeats,
      improvementAction: journalDraft.improvementAction
    };
    const savedJournal = JournalStore.getJournal(activeJournalDate)
      ? JournalStore.updateJournal(activeJournalDate, journalPayload)
      : JournalStore.createJournal(activeJournalDate, journalPayload);
    journalDraft = cloneJournal(savedJournal);
    renderTrades();
    renderJournalFields();
    renderDailySummary();
    setSaveStatus('saved');
    showToast('Journal saved locally.');
  } catch (error) {
    setSaveStatus('failed');
    showToast(error.message || 'The journal could not be saved.', 'error');
  }
}

async function addTradePreset(target, trade, field) {
  const kind = target.dataset.presetKind;
  const previous = trade[field];
  target.value = previous;
  const label = { assets: 'Asset', timeframes: 'Timeframe', sessions: 'Session' }[kind] || 'Value';
  const entered = await openPromptDialog({ title: `Add ${label.toLowerCase()}`, label, value: '', confirmLabel: 'Add' });
  if (entered === null) return;
  try {
    const saved = JournalStore.addPreset(kind, entered);
    trade[field] = saved;
    markJournalDirty();
    renderTrades();
    showToast(`"${saved}" was added to your ${label.toLowerCase()} list.`);
  } catch (error) {
    showToast(error.message || 'That value could not be saved.', 'error');
  }
}

function updateJournalDraft(event) {
  const target = event.target;
  const tradeField = target.dataset.tradeField;
  if (tradeField) {
    const trade = journalDraft.trades.find((item) => item.id === target.closest('[data-trade-id]').dataset.tradeId);
    if (trade) {
      if (target.value === PRESET_ADD_VALUE) {
        addTradePreset(target, trade, tradeField);
        return;
      }
      trade[tradeField] = target.value;
      markJournalDirty();
      renderDailySummary();
    }
    return;
  }
  if (target.dataset.journalField) {
    journalDraft[target.dataset.journalField] = target.value;
    markJournalDirty();
    return;
  }
  if (target.dataset.psychologyField) {
    const field = target.dataset.psychologyField;
    journalDraft.psychology[field] = target.type === 'range' ? Number(target.value) : target.value;
    document.getElementById(field === 'confidenceScore' ? 'confidenceValue' : field === 'impulseScore' ? 'impulseValue' : 'confidenceValue').textContent = target.type === 'range' ? target.value : document.getElementById('confidenceValue').textContent;
    markJournalDirty();
    renderDailySummary();
    return;
  }
  if (target.dataset.mistakeFlag) {
    const flag = target.dataset.mistakeFlag;
    journalDraft.mistakeFlags = target.checked ? [...new Set([...journalDraft.mistakeFlags, flag])] : journalDraft.mistakeFlags.filter((item) => item !== flag);
    markJournalDirty();
  }
}

async function readScreenshot(event) {
  const file = event.target.files[0];
  const slot = event.target.dataset.screenshotSlot;
  if (!file || !slot) return;
  if (!file.type.startsWith('image/')) {
    setSaveStatus('failed');
    showToast('Choose an image file for the screenshot.');
    event.target.value = '';
    return;
  }
  try {
    const previous = journalDraft.screenshots[slot];
    journalDraft.screenshots[slot] = await ScreenshotStore.put(journalDraft.date, slot, file);
    if (ScreenshotStore.isReference(previous)) await ScreenshotStore.remove(previous);
    renderJournalFields();
    markJournalDirty();
  } catch (error) {
    setSaveStatus('failed');
    showToast(error.message || 'The screenshot could not be saved.', 'error');
  } finally {
    event.target.value = '';
  }
}

async function exportJournalData() {
  try {
    const data = JournalStore.exportData();
    const stored = await ScreenshotStore.list();
    data.screenshotBlobs = await Promise.all(stored.map(async (record) => ({
      id: record.id,
      journalId: record.journalId,
      slot: record.slot,
      mimeType: record.mimeType,
      dataUrl: await ScreenshotStore.blobToDataUrl(record.blob)
    })));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `edgelog-journal-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showToast(`Journal export downloaded with ${data.screenshotBlobs.length} screenshot(s).`);
  } catch (error) {
    showToast(error.message || 'The export could not be created.', 'error');
  }
}

async function restoreScreenshotBlobs(blobs) {
  if (!Array.isArray(blobs)) return;
  await Promise.all(blobs.map(async (record) => {
    if (!record?.dataUrl || !ScreenshotStore.isReference(record.id)) return;
    await ScreenshotStore.putWithId(record.id, record.journalId, record.slot, ScreenshotStore.dataUrlToBlob(record.dataUrl));
  }));
}

function importJournalData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(reader.result);
      const { screenshotBlobs, ...document } = parsed;
      JournalStore.importData(document);
      await restoreScreenshotBlobs(screenshotBlobs);
      const journals = JournalStore.getState().journals;
      if (journals.length) {
        activeJournalDate = journals[0].date;
        journalDraft = null;
        loadJournalDraft();
      }
      setRoute();
      renderStorageUsage();
      showToast('Journal data imported and saved locally.');
    } catch (error) {
      showToast(error.message || 'Import failed. Your current journal was not changed.', 'error');
    } finally {
      event.target.value = '';
    }
  };
  reader.onerror = () => {
    event.target.value = '';
    showToast('The import file could not be read.');
  };
  reader.readAsText(file);
}

function setGistStatus(message, kind = 'muted-status') {
  const status = document.getElementById('gistConnectionStatus');
  status.textContent = message;
  status.className = `status-pill ${kind}`;
}

function formatSyncTimestamp(timestamp) {
  if (!timestamp) return 'Last synchronized: never';
  return `Last synchronized: ${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp))}`;
}

function renderGistStatus() {
  const metadata = JournalStorage.getSyncMetadata();
  const gistId = Vault.getGistId();
  const gistIdInput = document.getElementById('gistIdInput');
  if (gistIdInput && document.activeElement !== gistIdInput) gistIdInput.value = gistId;
  const githubUsernameInput = document.getElementById('githubUsernameInput');
  if (githubUsernameInput && document.activeElement !== githubUsernameInput) githubUsernameInput.value = Vault.getGithubUsername();
  document.getElementById('gistLastSynced').textContent = formatSyncTimestamp(metadata.syncedAt);
  if (!Vault.isUnlocked()) setGistStatus('Locked');
  else if (!Vault.hasToken()) setGistStatus('Token required');
  else if (!gistId) setGistStatus('Ready to connect', 'gist-ready');
  else if (metadata.gistId === gistId && metadata.fingerprint === JournalStorage.fingerprint(JournalStore.exportData())) setGistStatus('Synced', 'gist-synced');
  else if (metadata.gistId === gistId && metadata.fingerprint) setGistStatus('Local changes pending', 'gist-pending');
  else setGistStatus('Ready to connect', 'gist-ready');
}

function requireSyncReady() {
  if (!Vault.isUnlocked()) throw new Error('Unlock the vault before syncing with GitHub.');
  if (!Vault.hasToken()) throw new Error('Add your GitHub token in Settings → GitHub storage before syncing.');
  return Vault.getGistId();
}

function recordSuccessfulSync(gistId, data) {
  JournalStorage.saveSyncMetadata({ gistId, fingerprint: JournalStorage.fingerprint(data), syncedAt: new Date().toISOString() });
  renderGistStatus();
}

function downloadJournalFile(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function formatConflictMetadata(data) {
  const updated = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(data.updatedAt));
  return `${updated} · ${data.deviceId}`;
}

function showSyncConflict(localData, remoteData, context) {
  syncConflict = { localData, remoteData, context, remoteFingerprint: JournalStorage.fingerprint(remoteData) };
  document.getElementById('localConflictVersion').textContent = `Version ${localData.dataVersion}`;
  document.getElementById('remoteConflictVersion').textContent = `Version ${remoteData.dataVersion}`;
  document.getElementById('localConflictMeta').textContent = formatConflictMetadata(localData);
  document.getElementById('remoteConflictMeta').textContent = formatConflictMetadata(remoteData);
  document.getElementById('conflictScreen').hidden = false;
  setGistStatus('Conflict detected', 'gist-failed');
}

function hideSyncConflict() {
  syncConflict = null;
  document.getElementById('conflictScreen').hidden = true;
}

function getWriteDecision(localData, remoteData) {
  if (JournalStorage.fingerprint(localData) === JournalStorage.fingerprint(remoteData)) return 'equal';
  const localUpdated = Date.parse(localData.updatedAt);
  const remoteUpdated = Date.parse(remoteData.updatedAt);
  if (remoteData.dataVersion >= localData.dataVersion || remoteUpdated > localUpdated) return 'conflict';
  return 'save-local';
}

function applyImportedJournal(data) {
  JournalStore.importData(data);
  const journals = JournalStore.getState().journals;
  if (journals.length) {
    activeJournalDate = journals.some((journal) => journal.date === activeJournalDate) ? activeJournalDate : journals[0].date;
    journalDraft = null;
    loadJournalDraft();
  }
  setRoute();
}

async function loadFromGithub() {
  try {
    const gistId = requireSyncReady();
    if (!gistId) throw new Error('Enter and save a Gist ID before loading from GitHub.');
    setGistStatus('Loading...', 'gist-pending');
    const remote = await GithubStorage.loadJournal(gistId);
    applyImportedJournal(remote.data);
    recordSuccessfulSync(gistId, remote.data);
    showToast('Journal loaded from GitHub.');
  } catch (error) {
    setGistStatus('Load failed', 'gist-failed');
    showToast(error.message || 'GitHub load failed. Your local journal is unchanged.', 'error');
  }
}

async function saveToGithub() {
  try {
    const gistId = requireSyncReady();
    const localData = JournalStore.exportData();
    if (!gistId) {
      setGistStatus('Creating Gist...', 'gist-pending');
      const created = await GithubStorage.createGist(localData);
      recordSuccessfulSync(created.gistId, localData);
      showToast('A private encrypted Gist was created and saved.');
      return;
    }
    setGistStatus('Checking remote...', 'gist-pending');
    const remote = await GithubStorage.loadJournal(gistId);
    const decision = getWriteDecision(localData, remote.data);
    if (decision === 'conflict') {
      showSyncConflict(localData, remote.data, { gistId, etag: remote.etag });
      return;
    }
    if (decision === 'equal') {
      recordSuccessfulSync(gistId, localData);
      showToast('Local and GitHub journals are already synchronized.');
      return;
    }
    setGistStatus('Saving...', 'gist-pending');
    await GithubStorage.saveJournal(localData, { expectedFingerprint: remote.fingerprint });
    recordSuccessfulSync(gistId, localData);
    showToast('Journal saved to GitHub.');
  } catch (error) {
    setGistStatus('Save failed', 'gist-failed');
    showToast(error.message || 'GitHub save failed. Your local journal is unchanged.', 'error');
  }
}

async function syncGithub() {
  try {
    const gistId = requireSyncReady();
    const localData = JournalStore.exportData();
    if (!gistId) {
      setGistStatus('Creating Gist...', 'gist-pending');
      const created = await GithubStorage.createGist(localData);
      recordSuccessfulSync(created.gistId, localData);
      showToast('A private encrypted Gist was created and synchronized.');
      return;
    }
    setGistStatus('Checking...', 'gist-pending');
    const remote = await GithubStorage.loadJournal(gistId);
    const decision = getWriteDecision(localData, remote.data);
    if (decision === 'equal') {
      recordSuccessfulSync(gistId, localData);
      showToast('Local and GitHub journals are already synchronized.');
      return;
    }
    if (decision === 'save-local') {
      await GithubStorage.saveJournal(localData, { expectedFingerprint: remote.fingerprint });
      recordSuccessfulSync(gistId, localData);
      showToast('Local journal changes were saved to GitHub.');
      return;
    }
    showSyncConflict(localData, remote.data, { gistId, etag: remote.etag });
  } catch (error) {
    setGistStatus('Sync failed', 'gist-failed');
    showToast(error.message || 'GitHub sync failed. Your local journal is unchanged.', 'error');
  }
}

async function keepLocalConflictVersion() {
  if (!syncConflict) return;
  try {
    const { gistId } = syncConflict.context;
    setGistStatus('Checking remote...', 'gist-pending');
    const latest = await GithubStorage.loadJournal(gistId);
    if (latest.fingerprint !== syncConflict.remoteFingerprint) {
      showSyncConflict(JournalStore.exportData(), latest.data, { gistId, etag: latest.etag });
      showToast('Remote data changed again. Review the updated conflict before saving.');
      return;
    }
    const resolvedLocal = JournalStore.prepareKeepLocalResolution(latest.data.dataVersion);
    setGistStatus('Saving...', 'gist-pending');
    await GithubStorage.saveJournal(resolvedLocal, { expectedFingerprint: latest.fingerprint });
    recordSuccessfulSync(gistId, resolvedLocal);
    hideSyncConflict();
    showToast('Local journal was saved as the new conflict resolution version.');
  } catch (error) {
    setGistStatus('Save failed', 'gist-failed');
    showToast(error.message || 'Conflict resolution failed. Both journal copies remain available.', 'error');
  }
}

async function keepRemoteConflictVersion() {
  if (!syncConflict) return;
  try {
    const { gistId } = syncConflict.context;
    setGistStatus('Checking remote...', 'gist-pending');
    const latest = await GithubStorage.loadJournal(gistId);
    applyImportedJournal(latest.data);
    recordSuccessfulSync(gistId, latest.data);
    hideSyncConflict();
    showToast('GitHub journal was loaded into the local cache.');
  } catch (error) {
    setGistStatus('Load failed', 'gist-failed');
    showToast(error.message || 'Conflict resolution failed. Your local journal remains unchanged.', 'error');
  }
}

function exportBothConflictVersions() {
  if (!syncConflict) return;
  downloadJournalFile(syncConflict.localData, `ledgerly-local-v${syncConflict.localData.dataVersion}.json`);
  downloadJournalFile(syncConflict.remoteData, `ledgerly-remote-v${syncConflict.remoteData.dataVersion}.json`);
  showToast('Both conflict versions were exported.');
}

function renderStrategies() {
  const table = document.getElementById('strategyTable');
  const strategies = JournalStore.getState().strategies;
  table.innerHTML = strategies.map((strategy) => `
    <div class="strategy-row">
      <b><i class="strategy-color ${escapeHtml(strategy.color)}" style="display:inline-block;margin-right:8px"></i>${escapeHtml(strategy.name)}</b>
      <span>${escapeHtml(strategy.description) || 'No description'}</span>
      <div class="strategy-actions">
        <button type="button" class="text-button" data-strategy-rename="${escapeHtml(strategy.id)}" aria-label="Rename ${escapeHtml(strategy.name)}">Rename</button>
        <button type="button" class="text-button" data-strategy-describe="${escapeHtml(strategy.id)}" aria-label="Edit description for ${escapeHtml(strategy.name)}">Describe</button>
        <button type="button" class="text-button" data-strategy-delete="${escapeHtml(strategy.id)}" aria-label="Delete ${escapeHtml(strategy.name)}">Delete</button>
      </div>
    </div>
  `).join('');
}

function setupCharts() {
  const chartDefaults = {
    color: '#7f887f',
    font: { family: 'DM Mono', size: 9 }
  };
  Chart.defaults.color = chartDefaults.color;
  Chart.defaults.font = chartDefaults.font;

  pnlChart = new Chart(document.getElementById('pnlChart'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        data: [],
        borderColor: '#9ee6ab', borderWidth: 2, pointRadius: 0, tension: .35, fill: true,
        backgroundColor: (context) => {
          const area = context.chart.chartArea;
          if (!area) return 'transparent';
          const gradient = context.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
          gradient.addColorStop(0, 'rgba(109, 209, 133, .22)');
          gradient.addColorStop(1, 'rgba(109, 209, 133, 0)');
          return gradient;
        }
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#252c25', padding: 10, displayColors: false, callbacks: { label: (context) => ` ${currencySymbol()}${context.raw.toLocaleString()}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 6 } },
        y: { border: { display: false }, grid: { color: '#2c322c' }, ticks: { maxTicksLimit: 5, callback: (value) => `${currencySymbol()}${value / 1000}k` } }
      }
    }
  });

  strategyChart = new Chart(document.getElementById('strategyChart'), {
    type: 'bar',
    data: { labels: [], datasets: [{ data: [], borderRadius: 3, borderSkipped: false }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#252c25', padding: 10, displayColors: false, callbacks: { label: (context) => ` ${formatPnl(context.raw)}` } } },
      scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: false } }, y: { border: { display: false }, grid: { color: '#2c322c' }, ticks: { maxTicksLimit: 4, callback: (value) => `${currencySymbol()}${value}` } } }
    }
  });
}

function setRoute() {
  const [route, requestedDate] = (location.hash.replace('#/', '') || 'dashboard').split('/');
  const viewName = ['dashboard', 'journal', 'settings'].includes(route) ? route : 'dashboard';
  if (viewName === 'journal' && isDateKey(requestedDate)) {
    activeJournalDate = requestedDate;
  }
  if (!journalDraft || journalDraft.date !== activeJournalDate) loadJournalDraft();
  document.querySelectorAll('[data-view]').forEach((view) => { view.hidden = view.dataset.view !== viewName; });
  document.querySelectorAll('.nav-link').forEach((link) => link.classList.toggle('active', link.dataset.route === viewName));
  document.getElementById('journalDateHeading').textContent = formatJournalHeading(activeJournalDate);
  renderTrades();
  renderJournalFields();
  renderDailySummary();
  document.querySelector('.sidebar').classList.remove('open');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(2)} GB`;
  return `${megabytes.toFixed(1)} MB`;
}

async function renderStorageUsage() {
  const element = document.getElementById('storageUsage');
  if (!element) return;
  const estimate = await ScreenshotStore.estimate();
  if (!estimate) {
    element.textContent = 'This browser does not report storage usage.';
    return;
  }
  const percent = estimate.percent < 0.1 && estimate.usage > 0 ? '<0.1' : estimate.percent.toFixed(1);
  element.textContent = `Used ${formatBytes(estimate.usage)} of an estimated ${formatBytes(estimate.quota)} available (${percent}%).`;
}

// Moves screenshots saved as base64 inside the journal document into IndexedDB blobs.
async function migrateLegacyScreenshots() {
  const journals = JournalStore.getState().journals;
  const legacy = journals.filter((journal) => Object.values(journal.screenshots || {}).some((value) => ScreenshotStore.isLegacyDataUrl(value)));
  if (!legacy.length) return;
  let moved = 0;
  for (const journal of legacy) {
    const screenshots = { ...journal.screenshots };
    for (const slot of Object.keys(screenshots)) {
      if (!ScreenshotStore.isLegacyDataUrl(screenshots[slot])) continue;
      try {
        screenshots[slot] = await ScreenshotStore.put(journal.date, slot, ScreenshotStore.dataUrlToBlob(screenshots[slot]));
        moved += 1;
      } catch {
        return;
      }
    }
    JournalStore.updateJournal(journal.date, { screenshots });
  }
  if (moved) showToast(`${moved} screenshot(s) moved into local image storage.`);
}

async function setupLocalStorageLayer() {
  try {
    await ScreenshotStore.requestPersistence();
    await migrateLegacyScreenshots();
    await ScreenshotStore.pruneOrphans(JournalStore.getState().journals);
  } catch {
    // Image storage is optional; the journal stays usable without it.
  }
  renderStorageUsage();
}

const PRESET_GROUPS = [
  { kind: 'assets', title: 'Assets', label: 'Asset' },
  { kind: 'timeframes', title: 'Timeframes', label: 'Timeframe' },
  { kind: 'sessions', title: 'Sessions', label: 'Session' }
];

function renderPresetManager() {
  const container = document.getElementById('presetManager');
  if (!container) return;
  const presets = JournalStore.getState().presets || {};
  container.innerHTML = PRESET_GROUPS.map((group) => {
    const values = presets[group.kind] || [];
    const chips = values.length
      ? values.map((value) => `<span class="preset-chip">${escapeHtml(value)}<button type="button" data-remove-preset="${group.kind}" data-preset-value="${escapeHtml(value)}" aria-label="Remove ${escapeHtml(value)}">×</button></span>`).join('')
      : '<span class="muted-copy">Nothing saved yet.</span>';
    return `<div class="preset-group"><h3>${group.title}</h3><div class="preset-chips">${chips}</div><button class="outline-button" type="button" data-add-preset="${group.kind}">+ Add ${group.label.toLowerCase()}</button></div>`;
  }).join('');
}

function setupPresetManager() {
  const container = document.getElementById('presetManager');
  if (!container) return;
  container.addEventListener('click', async (event) => {
    const addKind = event.target.closest('[data-add-preset]')?.dataset.addPreset;
    const removeButton = event.target.closest('[data-remove-preset]');
    if (addKind) {
      const group = PRESET_GROUPS.find((item) => item.kind === addKind);
      const entered = await openPromptDialog({ title: `Add ${group.label.toLowerCase()}`, label: group.label, value: '', confirmLabel: 'Add' });
      if (entered === null) return;
      try {
        JournalStore.addPreset(addKind, entered);
        showToast(`${group.label} saved.`);
      } catch (error) {
        showToast(error.message || 'That value could not be saved.', 'error');
      }
      return;
    }
    if (removeButton) {
      const kind = removeButton.dataset.removePreset;
      const value = removeButton.dataset.presetValue;
      const confirmed = await openConfirmDialog({ title: 'Remove this preset?', message: `"${value}" will no longer be offered when logging trades. Existing trades keep their value.`, confirmLabel: 'Remove', danger: true });
      if (!confirmed) return;
      JournalStore.removePreset(kind, value);
      showToast('Preset removed.', 'info');
    }
  });
}

async function resetJournal() {
  const confirmed = await openConfirmDialog({
    title: 'Reset the whole journal?',
    message: 'Every journal entry, trade and screenshot on this device will be deleted. Strategies, presets and your GitHub connection are kept. This cannot be undone.',
    confirmLabel: 'Continue',
    danger: true
  });
  if (!confirmed) return;
  const typed = await openPromptDialog({ title: 'Type RESET to confirm', label: 'Confirmation', value: '', confirmLabel: 'Reset journal' });
  if (typed === null) return;
  if (typed.trim().toUpperCase() !== 'RESET') {
    showToast('Reset cancelled because the confirmation did not match.', 'error');
    return;
  }
  const wantsBackup = await openConfirmDialog({
    title: 'Download a backup first?',
    message: 'This exports your journal and screenshots before anything is deleted.',
    confirmLabel: 'Export backup'
  });
  if (wantsBackup) await exportJournalData();
  try {
    JournalStore.resetJournals();
    await ScreenshotStore.clear().catch(() => null);
    journalDraft = null;
    const today = new Date();
    activeJournalDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    loadJournalDraft();
    setRoute();
    renderCalendar();
    renderAnalytics();
    renderReflection();
    renderStorageUsage();
    showToast('Journal reset. The next GitHub sync will report a conflict, which is expected.', 'info');
  } catch (error) {
    showToast(error.message || 'The journal could not be reset.', 'error');
  }
}

function vaultErrorMessage(error) {
  switch (error && error.code) {
    case 'wrong-username': return 'Username not recognized.';
    case 'wrong-password': return 'Incorrect password.';
    case 'corrupt': return 'Saved credentials are corrupted and cannot be decrypted.';
    case 'missing': return 'No vault was found on this device.';
    default: return (error && error.message) || 'Unable to unlock the vault.';
  }
}

function showSetupScreen() {
  document.getElementById('vaultSetupForm').hidden = false;
  document.getElementById('vaultLoginForm').hidden = true;
  document.getElementById('lockScreen').hidden = false;
  document.getElementById('setupUsername').focus();
}

function showLoginScreen() {
  document.getElementById('vaultLoginForm').hidden = false;
  document.getElementById('vaultSetupForm').hidden = true;
  document.getElementById('lockScreen').hidden = false;
  document.getElementById('loginUsername').focus();
}

function unlockApp() {
  document.getElementById('lockScreen').hidden = true;
  ['setupPassword', 'setupPasswordConfirm', 'loginPassword'].forEach((id) => {
    const field = document.getElementById(id);
    if (field) field.value = '';
  });
  renderGreeting();
  renderGistStatus();
}

function lockApp() {
  Vault.lock();
  document.getElementById('githubTokenInput').value = '';
  showLoginScreen();
}

function setupVaultGate() {
  document.getElementById('vaultSetupForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('setupError');
    error.hidden = true;
    const password = document.getElementById('setupPassword').value;
    const confirmPassword = document.getElementById('setupPasswordConfirm').value;
    if (password !== confirmPassword) {
      error.textContent = 'Passwords do not match.';
      error.hidden = false;
      return;
    }
    try {
      await Vault.create({ appUsername: document.getElementById('setupUsername').value, password });
      unlockApp();
      showToast('Vault created. Your credentials stay encrypted on this device.');
    } catch (vaultError) {
      error.textContent = vaultErrorMessage(vaultError);
      error.hidden = false;
    }
  });
  document.getElementById('vaultLoginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.getElementById('loginError');
    error.hidden = true;
    try {
      await Vault.unlock(document.getElementById('loginUsername').value, document.getElementById('loginPassword').value);
      unlockApp();
    } catch (vaultError) {
      error.textContent = vaultErrorMessage(vaultError);
      error.hidden = false;
      document.getElementById('loginPassword').value = '';
    }
  });
  document.getElementById('lockButton').addEventListener('click', lockApp);
  if (Vault.exists()) showLoginScreen();
  else showSetupScreen();
}

function setupInteractions() {
  document.getElementById('mobileMenuButton').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));
  document.getElementById('previousMonthButton').addEventListener('click', () => {
    displayedMonth = new Date(displayedMonth.getFullYear(), displayedMonth.getMonth() - 1, 1);
    renderCalendar();
  });
  document.getElementById('nextMonthButton').addEventListener('click', () => {
    displayedMonth = new Date(displayedMonth.getFullYear(), displayedMonth.getMonth() + 1, 1);
    renderCalendar();
  });
  document.getElementById('saveJournalButton').addEventListener('click', saveJournalDraft);
  document.getElementById('addTradeButton').addEventListener('click', () => {
    journalDraft.trades.push(createDraftTrade());
    renderTrades();
    markJournalDirty();
    showToast('A new trade is ready to complete.');
  });
  document.getElementById('journalView').addEventListener('input', updateJournalDraft);
  document.getElementById('journalView').addEventListener('change', (event) => {
    if (event.target.dataset.screenshotSlot) readScreenshot(event);
    else updateJournalDraft(event);
  });
  document.getElementById('tradeList').addEventListener('click', async (event) => {
    const tradeId = event.target.closest('[data-delete-trade]')?.dataset.deleteTrade;
    if (!tradeId) return;
    const confirmed = await openConfirmDialog({
      title: 'Delete this trade?',
      message: 'This removes the trade from the day. The change is saved when you save the journal entry.',
      confirmLabel: 'Delete trade',
      danger: true,
    });
    if (!confirmed) return;
    journalDraft.trades = journalDraft.trades.filter((trade) => trade.id !== tradeId);
    renderTrades();
    renderDailySummary();
    markJournalDirty();
    showToast('Trade removed from this entry.', 'info');
  });
  document.getElementById('addStrategyButton').addEventListener('click', () => {
    JournalStore.createStrategy({ name: 'New strategy', description: 'Add a setup description', color: 'blue' });
    showToast('A new strategy was added.');
  });
  document.getElementById('strategyTable').addEventListener('click', async (event) => {
    const renameId = event.target.closest('[data-strategy-rename]')?.dataset.strategyRename;
    const describeId = event.target.closest('[data-strategy-describe]')?.dataset.strategyDescribe;
    const deleteId = event.target.closest('[data-strategy-delete]')?.dataset.strategyDelete;
    if (renameId) {
      const strategy = JournalStore.getState().strategies.find((item) => item.id === renameId);
      if (!strategy) return;
      const name = await openPromptDialog({ title: 'Rename strategy', label: 'Strategy name', value: strategy.name, confirmLabel: 'Save name' });
      if (name === null) return;
      const trimmed = name.trim();
      if (!trimmed) {
        showToast('Strategy name cannot be empty.', 'error');
        return;
      }
      JournalStore.updateStrategy(renameId, { name: trimmed });
      showToast('Strategy renamed.');
    } else if (describeId) {
      const strategy = JournalStore.getState().strategies.find((item) => item.id === describeId);
      if (!strategy) return;
      const description = await openPromptDialog({ title: 'Strategy description', label: 'Describe this setup', value: strategy.description, confirmLabel: 'Save description' });
      if (description === null) return;
      JournalStore.updateStrategy(describeId, { description: description.trim() });
      showToast('Strategy description saved.');
    } else if (deleteId) {
      const strategy = JournalStore.getState().strategies.find((item) => item.id === deleteId);
      if (!strategy) return;
      const confirmed = await openConfirmDialog({
        title: 'Delete this strategy?',
        message: `"${strategy.name}" will be removed and its trades will become unassigned.`,
        confirmLabel: 'Delete strategy',
        danger: true,
      });
      if (!confirmed) return;
      JournalStore.deleteStrategy(deleteId);
      showToast('Strategy deleted.', 'info');
    }
  });
  document.getElementById('exportDataButton').addEventListener('click', exportJournalData);
  document.getElementById('resetJournalButton').addEventListener('click', resetJournal);
  document.getElementById('importDataButton').addEventListener('click', () => document.getElementById('importDataInput').click());
  document.getElementById('importDataInput').addEventListener('change', importJournalData);
  document.getElementById('preferencesForm').addEventListener('submit', (event) => {
    event.preventDefault();
    JournalStorage.savePreferences({
      startingBalance: document.getElementById('startingBalanceInput').value,
      currency: document.getElementById('currencyInput').value,
      monthlyTarget: document.getElementById('monthlyTargetInput').value
    });
    renderPreferences();
    renderAnalytics();
    renderDailySummary();
    showToast('Journal defaults saved.');
  });
  document.getElementById('storageForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!Vault.isUnlocked()) {
      setGistStatus('Locked', 'gist-failed');
      showToast('Unlock the vault before saving a GitHub connection.', 'error');
      return;
    }
    const githubUsernameInput = document.getElementById('githubUsernameInput');
    const tokenInput = document.getElementById('githubTokenInput');
    const gistIdInput = document.getElementById('gistIdInput');
    if (!tokenInput.value.trim() && !Vault.hasToken()) {
      setGistStatus('Token required', 'gist-failed');
      showToast('Enter a GitHub token before saving the connection.', 'error');
      return;
    }
    try {
      setGistStatus('Verifying...', 'gist-pending');
      const account = await GithubStorage.connect({ githubUsername: githubUsernameInput.value, token: tokenInput.value, gistId: gistIdInput.value });
      tokenInput.value = '';
      renderGistStatus();
      showToast(account.login ? `Connected to GitHub as ${account.login}. Token encrypted on this device.` : 'GitHub connection saved and encrypted on this device.');
    } catch (error) {
      tokenInput.value = '';
      setGistStatus('Connection failed', 'gist-failed');
      showToast(error.message || 'Could not save the GitHub connection.', 'error');
    }
  });
  document.getElementById('clearTokenButton').addEventListener('click', () => {
    if (!Vault.isUnlocked()) return;
    Vault.clearToken();
    document.getElementById('githubTokenInput').value = '';
    renderGistStatus();
    showToast('Encrypted GitHub token removed from this device.');
  });
  document.getElementById('loadGithubButton').addEventListener('click', loadFromGithub);
  document.getElementById('saveGithubButton').addEventListener('click', saveToGithub);
  document.getElementById('syncGithubButton').addEventListener('click', syncGithub);
  document.getElementById('keepLocalButton').addEventListener('click', keepLocalConflictVersion);
  document.getElementById('keepRemoteButton').addEventListener('click', keepRemoteConflictVersion);
  document.getElementById('exportBothButton').addEventListener('click', exportBothConflictVersions);
  document.querySelectorAll('.nav-link, .mobile-header .brand').forEach((link) => {
    link.addEventListener('click', async (event) => {
      const targetHash = link.getAttribute('href');
      if (!hasUnsavedChanges() || !targetHash || targetHash === location.hash) return;
      event.preventDefault();
      const proceed = await openConfirmDialog({
        title: 'Leave without saving?',
        message: 'You have unsaved changes in this journal entry. Leaving now will discard them.',
        confirmLabel: 'Discard changes',
        danger: true,
      });
      if (proceed) {
        setSaveStatus('saved');
        location.hash = targetHash;
      }
    });
  });
  document.querySelectorAll('.settings-tab').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab').forEach((tab) => tab.classList.toggle('active', tab === button));
      document.querySelectorAll('.settings-section').forEach((section) => { section.hidden = section.dataset.settingsSection !== button.dataset.settingsTab; });
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  renderCalendar();
  renderStrategies();
  renderPresetManager();
  renderGreeting();
  renderReflection();
  renderPreferences();
  document.getElementById('sidebarPeriodLabel').textContent = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date());
  setupCharts();
  renderAnalytics();
  setupInteractions();
  setupVaultGate();
  setupScreenshotTools();
  setupPresetManager();
  setupLocalStorageLayer();
  renderGistStatus();
  JournalStore.subscribe(() => {
    renderCalendar();
    renderAnalytics();
    renderTrades();
    renderJournalFields();
    renderDailySummary();
    renderStrategies();
    renderPresetManager();
    renderReflection();
    renderGistStatus();
  });
  setRoute();
  const storageWarning = JournalStore.getStorageWarning();
  if (storageWarning) showToast(storageWarning, 'error');
  window.addEventListener('hashchange', setRoute);
  window.addEventListener('beforeunload', (event) => {
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  });
});
