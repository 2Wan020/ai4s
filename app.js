const API_BASE = location.pathname.startsWith('/quiz') ? '/quiz' : '';
const BANK_STORAGE_KEY = 'tudou-question-banks-v2';
const COMPLETED_KEY = 'tudou-completed-v2';
const WRONG_KEY = 'tudou-wrong-v2';
const FAVORITE_KEY = 'tudou-favorites-v1';
const AUTO_NEXT_CORRECT_KEY = 'tudou-auto-next-correct-v1';
const SHUFFLE_OPTIONS_KEY = 'tudou-shuffle-options-v1';
const LAST_PRACTICE_KEY = 'tudou-last-practice-v1';
const CLOUD_DIRTY_KEY = 'tudou-cloud-dirty-v1';
const BANK_NORMALISATION_VERSION = 3;
const AUTO_NEXT_DELAY_MS = 500;
const CLOUD_SYNC_DELAY_MS = 350;
const LETTERS = 'ABCDEFGH';
const MODE_CONFIG = {
  'ordered-single': { label: '顺序单选', type: 'single', shuffleQuestions: false, shuffleOptions: false },
  'ordered-multi': { label: '顺序多选', type: 'multi', shuffleQuestions: false, shuffleOptions: false },
  'random-single': { label: '乱序单选', type: 'single', shuffleQuestions: true, shuffleOptions: true },
  'random-multi': { label: '乱序多选', type: 'multi', shuffleQuestions: true, shuffleOptions: true },
  mock: { label: '模拟练习', type: 'any', shuffleQuestions: true, shuffleOptions: true },
  wrong: { label: '错题练习', type: 'any', shuffleQuestions: false, shuffleOptions: false },
  favorite: { label: '收藏练习', type: 'any', shuffleQuestions: false, shuffleOptions: false }
};
const OPTION_ORDER_MODES = new Set(['ordered-single', 'ordered-multi', 'random-single', 'random-multi']);

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));

const markdownRenderer = typeof window.markdownit === 'function'
  ? window.markdownit({ html: false, breaks: true, linkify: true, typographer: false })
  : null;

if (markdownRenderer) {
  const validateLink = markdownRenderer.validateLink.bind(markdownRenderer);
  markdownRenderer.validateLink = (url) => /^https?:\/\//i.test(String(url || '').trim()) && validateLink(url);
  const defaultLinkOpen = markdownRenderer.renderer.rules.link_open
    || ((tokens, index, options, environment, renderer) => renderer.renderToken(tokens, index, options));
  markdownRenderer.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noopener noreferrer nofollow');
    return defaultLinkOpen(tokens, index, options, environment, renderer);
  };
  markdownRenderer.renderer.rules.image = (tokens, index) => escapeHtml(tokens[index].content || '');
}

function markdownHtml(value) {
  const source = String(value ?? '');
  if (markdownRenderer) return markdownRenderer.render(source);
  return `<p>${escapeHtml(source).replace(/\n/g, '<br>')}</p>`;
}

function renderMarkdown(element, value) {
  element.innerHTML = markdownHtml(value);
}

async function readApiError(response, fallback) {
  try {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const payload = await response.json();
      return String(payload?.error || fallback);
    }
    const text = (await response.text()).trim();
    return text || fallback;
  } catch (_) {
    return fallback;
  }
}

async function consumeEventStream(response, handlers = {}) {
  if (!response.ok) throw new Error(await readApiError(response, '流式请求失败'));
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('text/event-stream')) throw new Error('服务器未返回 SSE 流');
  if (!response.body?.getReader) throw new Error('当前浏览器不支持流式回答');

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let eventName = 'message';
  let dataLines = [];
  let receivedDone = false;

  const dispatch = () => {
    if (!dataLines.length) {
      eventName = 'message';
      return;
    }
    const rawData = dataLines.join('\n');
    let payload;
    try { payload = JSON.parse(rawData); } catch (_) { payload = { data: rawData }; }
    const currentEvent = eventName || 'message';
    eventName = 'message';
    dataLines = [];
    if (currentEvent === 'error') throw new Error(String(payload?.error || '流式生成失败'));
    if (currentEvent === 'done') receivedDone = true;
    if (typeof handlers[currentEvent] === 'function') handlers[currentEvent](payload);
  };

  const processLine = (rawLine) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon >= 0 ? line.slice(0, colon) : line;
    let value = colon >= 0 ? line.slice(colon + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        processLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    if (buffer) processLine(buffer);
    dispatch();
  } finally {
    reader.releaseLock();
  }
  if (!receivedDone) throw new Error('流式连接提前结束，请重试');
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function extractTailAnswer(value) {
  const prompt = String(value || '').replace(/\s+/g, ' ').trim();
  const match = prompt.match(/^(.*?)\s*[（(【[]\s*([A-H](?:\s*[,，、/;；]?\s*[A-H])*)\s*[）)】\]]?\s*$/i);
  if (!match) return { prompt, answers: [] };
  return { prompt: match[1].trim(), answers: [...new Set((match[2].match(/[A-H]/gi) || []).map((letter) => letter.toUpperCase()))] };
}

function numericStoredOptionValue(value) {
  return /^[+\-]?(?:\d+(?:[.,]\d+)?|[零一二三四五六七八九十百千万两]+)(?:\s*(?:%|％|年|月|日|岁|个|项|届|名|人|次|倍|元|万|亿|℃|度))?$/.test(String(value || '').trim());
}

function splitMergedStoredOption(startKey, value) {
  let currentKey = String(startKey || '').toUpperCase();
  let remainder = String(value || '').replace(/\s+/g, ' ').trim();
  const result = [];
  while (currentKey && currentKey < 'H') {
    const nextKey = String.fromCharCode(currentKey.charCodeAt(0) + 1);
    const marker = new RegExp(`(^|[^A-Za-z\\u4e00-\\u9fff])(${nextKey}\\s*)(?=[+\\-]?(?:\\d|[零一二三四五六七八九十百千万两]))`, 'i');
    const match = remainder.match(marker);
    if (!match) break;
    const markerStart = match.index + match[1].length;
    const markerEnd = match.index + match[0].length;
    const currentText = remainder.slice(0, markerStart).trim();
    const nextText = remainder.slice(markerEnd).trim();
    if (!numericStoredOptionValue(currentText) || !/^[+\-]?(?:\d|[零一二三四五六七八九十百千万两])/.test(nextText)) break;
    result.push([currentKey, currentText]);
    currentKey = nextKey;
    remainder = nextText;
  }
  result.push([currentKey, remainder]);
  return result;
}

function meaningfulStoredText(value) {
  return /[A-Za-z0-9\u3400-\u9fff]/.test(String(value || ''));
}

function repairStoredQuestionParts(prompt, rawOptions) {
  let repairedPrompt = String(prompt || '').replace(/\s+/g, ' ').trim();
  let options = rawOptions.map(([key, text]) => [
    String(key || '').toUpperCase(),
    String(text || '').replace(/\s+/g, ' ').trim()
  ]);
  const optionKeys = new Set(options.map(([key]) => key));

  // Historical imports may have stored ``题干。 A选项`` as one prompt while
  // B/C/D remained separate. The later keys make this a safe structural fix.
  if (!optionKeys.has('A') && optionKeys.has('B') && [...optionKeys].some((key) => key > 'B')) {
    const attachedFirst = repairedPrompt.match(/^(.*[。！？!?；;：:])\s+A\s*([\u3400-\u9fff].+)$/i);
    if (attachedFirst && meaningfulStoredText(attachedFirst[2])) {
      repairedPrompt = attachedFirst[1].trim();
      options = [['A', attachedFirst[2].trim()], ...options];
    }
  }

  // Repair a missing sequential option only when a later key proves the gap:
  // A + embedded ``B.`` + C/D becomes A/B/C/D, but prose is not split when
  // a genuine B option already exists.
  const repairedOptions = [];
  options.forEach(([startKey, startText], optionIndex) => {
    let currentKey = startKey;
    let remainder = startText;
    const futureKeys = new Set(options.slice(optionIndex + 1).map(([key]) => key));
    while (LETTERS.includes(currentKey) && currentKey < 'H') {
      const nextKey = String.fromCharCode(currentKey.charCodeAt(0) + 1);
      if (futureKeys.has(nextKey) || repairedOptions.some(([key]) => key === nextKey)) break;
      if (![...futureKeys].some((key) => key > nextKey)) break;
      const marker = new RegExp(`(?:[\\(（\\[【]\\s*${nextKey}\\s*[\\)）\\]】]\\s*|${nextKey}\\s*[.．、:：\\-—]\\s*)`, 'i');
      const match = marker.exec(remainder);
      if (!match) break;
      const currentText = remainder.slice(0, match.index).trim();
      const nextText = remainder.slice(match.index + match[0].length).trim();
      if (!meaningfulStoredText(currentText) || !meaningfulStoredText(nextText)) break;
      repairedOptions.push([currentKey, currentText]);
      currentKey = nextKey;
      remainder = nextText;
    }
    repairedOptions.push([currentKey, remainder]);
  });

  return { prompt: repairedPrompt, options: repairedOptions };
}

function normaliseQuestion(question, bankId, bankName, index) {
  const rawId = question.sourceId ?? (String(question.id || '').startsWith(`${bankId}::`) ? String(question.id).slice(bankId.length + 2) : question.id) ?? index;
  const tail = extractTailAnswer(question.prompt || question.title || '');
  const rawAnswers = Array.isArray(question.answer) ? question.answer.join('') : String(question.answer || '');
  const explicitAnswers = [...new Set((rawAnswers.match(/[A-H]/gi) || []).map((letter) => letter.toUpperCase()))];
  const answers = explicitAnswers.length ? explicitAnswers : tail.answers;
  const rawOptions = (Array.isArray(question.options) ? question.options : []).map((option, optionIndex) => {
    if (Array.isArray(option)) return [String(option[0] || LETTERS[optionIndex]).toUpperCase(), String(option[1] || '').trim()];
    return [LETTERS[optionIndex], String(option || '').trim()];
  });
  const repaired = repairStoredQuestionParts(tail.prompt, rawOptions);
  const seenOptions = new Set();
  const options = repaired.options.flatMap(([key, text]) => splitMergedStoredOption(key, text)).filter(([key, text]) => {
    if (!text || seenOptions.has(key)) return false;
    seenOptions.add(key);
    return true;
  });
  const type = answers.length > 1 ? 'multi' : (!answers.length && question.type === 'multi' ? 'multi' : 'single');
  return {
    ...question,
    id: `${bankId}::${rawId}`,
    sourceId: rawId,
    bankId,
    bankName,
    prompt: repaired.prompt,
    title: repaired.prompt.length > 36 ? `${repaired.prompt.slice(0, 36)}…` : repaired.prompt,
    options,
    answer: answers,
    type,
    explanation: String(question.explanation || '').trim()
  };
}

function normaliseBank(bank) {
  const id = String(bank.id || `bank-${Date.now()}`);
  const name = bank.name || '导入题库';
  const rawQuestions = Array.isArray(bank.questions) ? bank.questions : [];
  const questions = rawQuestions.map((question, index) => normaliseQuestion(question, id, name, index));
  const rawSavedRelated = Array.isArray(bank.savedRelatedQuestions) ? bank.savedRelatedQuestions : [];
  const savedRelatedQuestions = rawSavedRelated.map((question, index) => normaliseQuestion(
    question,
    id,
    name,
    rawQuestions.length + index
  ));
  return {
    ...bank,
    id,
    name,
    filename: bank.filename || `${name}.docx`,
    importedAt: bank.importedAt || new Date().toISOString(),
    normalisationVersion: BANK_NORMALISATION_VERSION,
    questions,
    savedRelatedQuestions,
    questionCount: questions.length,
    singleCount: questions.filter((question) => question.type === 'single').length,
    multiCount: questions.filter((question) => question.type === 'multi').length
  };
}

function loadImportedBanks() {
  try {
    const value = JSON.parse(localStorage.getItem(BANK_STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value.map(normaliseBank) : [];
  } catch {
    return [];
  }
}

function loadSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
}

function loadBooleanPreference(key) {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}

function saveBooleanPreference(key, value) {
  try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* The preference remains active for this page. */ }
}

function loadPracticeBookmark() {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_PRACTICE_KEY) || 'null');
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function localStateIsDirty() {
  try { return localStorage.getItem(CLOUD_DIRTY_KEY) === '1'; } catch { return true; }
}

function setLocalStateDirty(value) {
  try {
    if (value) localStorage.setItem(CLOUD_DIRTY_KEY, '1');
    else localStorage.removeItem(CLOUD_DIRTY_KEY);
  } catch { /* Cloud sync can still continue for the current page. */ }
}

let importedBanks = loadImportedBanks();
const completedSet = loadSet(COMPLETED_KEY);
const wrongSet = loadSet(WRONG_KEY);
const favoriteSet = loadSet(FAVORITE_KEY);
const state = {
  activeBankId: null,
  wrongbookBankId: 'all',
  session: null,
  mockConfig: null,
  lastSpec: null,
  autoNextCorrect: loadBooleanPreference(AUTO_NEXT_CORRECT_KEY),
  shufflePracticeOptions: loadBooleanPreference(SHUFFLE_OPTIONS_KEY),
  resumeBookmark: loadPracticeBookmark(),
  cloud: { ready: false, saving: false, pending: false, timer: null, revision: 0 }
};

function allBanks() { return importedBanks; }
function bankAllQuestions(bank) { return [...(bank?.questions || []), ...(bank?.savedRelatedQuestions || [])]; }
function allQuestions() { return allBanks().flatMap((bank) => bankAllQuestions(bank)); }
function getBank(bankId) { return allBanks().find((bank) => bank.id === bankId); }
function markProfileChanged() {
  setLocalStateDirty(true);
  queueCloudSync();
}
function saveBanks() {
  try { localStorage.setItem(BANK_STORAGE_KEY, JSON.stringify(importedBanks)); } catch { /* SQLite remains the primary store. */ }
  markProfileChanged();
}
function saveProgress() {
  try {
    localStorage.setItem(COMPLETED_KEY, JSON.stringify([...completedSet]));
    localStorage.setItem(WRONG_KEY, JSON.stringify([...wrongSet]));
    localStorage.setItem(FAVORITE_KEY, JSON.stringify([...favoriteSet]));
  } catch { /* SQLite remains the primary store. */ }
  markProfileChanged();
}

function profileSnapshot() {
  return {
    version: 1,
    banks: importedBanks,
    completed: [...completedSet],
    wrong: [...wrongSet],
    favorites: [...favoriteSet],
    preferences: {
      autoNextCorrect: state.autoNextCorrect,
      shuffleOptions: state.shufflePracticeOptions
    },
    lastPractice: state.resumeBookmark
  };
}

function persistProfileLocally() {
  try {
    localStorage.setItem(BANK_STORAGE_KEY, JSON.stringify(importedBanks));
    localStorage.setItem(COMPLETED_KEY, JSON.stringify([...completedSet]));
    localStorage.setItem(WRONG_KEY, JSON.stringify([...wrongSet]));
    localStorage.setItem(FAVORITE_KEY, JSON.stringify([...favoriteSet]));
    if (state.resumeBookmark) localStorage.setItem(LAST_PRACTICE_KEY, JSON.stringify(state.resumeBookmark));
    else localStorage.removeItem(LAST_PRACTICE_KEY);
  } catch { /* Large题库仍会由 SQLite 保存。 */ }
  saveBooleanPreference(AUTO_NEXT_CORRECT_KEY, state.autoNextCorrect);
  saveBooleanPreference(SHUFFLE_OPTIONS_KEY, state.shufflePracticeOptions);
}

function applyProfileSnapshot(snapshot) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const sourceBanks = Array.isArray(source.banks) ? source.banks : [];
  const requiresNormalisationSave = sourceBanks.some((bank) => Number(bank?.normalisationVersion || 0) < BANK_NORMALISATION_VERSION);
  importedBanks = sourceBanks.map(normaliseBank);
  const knownQuestionIds = new Set(allQuestions().map((question) => question.id));
  completedSet.clear();
  wrongSet.clear();
  favoriteSet.clear();
  (Array.isArray(source.completed) ? source.completed : []).forEach((questionId) => {
    if (knownQuestionIds.has(String(questionId))) completedSet.add(String(questionId));
  });
  (Array.isArray(source.wrong) ? source.wrong : []).forEach((questionId) => {
    if (knownQuestionIds.has(String(questionId))) wrongSet.add(String(questionId));
  });
  (Array.isArray(source.favorites) ? source.favorites : []).forEach((questionId) => {
    if (knownQuestionIds.has(String(questionId))) favoriteSet.add(String(questionId));
  });
  state.autoNextCorrect = Boolean(source.preferences?.autoNextCorrect);
  state.shufflePracticeOptions = Boolean(source.preferences?.shuffleOptions);
  const bookmark = source.lastPractice && typeof source.lastPractice === 'object' ? source.lastPractice : null;
  state.resumeBookmark = bookmark && (bookmark.bankId === 'all' || getBank(bookmark.bankId)) ? bookmark : null;
  if (state.resumeBookmark?.mode === 'mock' && state.resumeBookmark.spec) {
    state.mockConfig = { ...state.resumeBookmark.spec };
  }
  state.session = null;
  persistProfileLocally();
  return requiresNormalisationSave;
}

function setSyncStatus(message, status = 'saved') {
  const indicator = $('sync-status');
  if (!indicator) return;
  indicator.textContent = message;
  indicator.dataset.state = status;
}

function queueCloudSync() {
  if (!state.cloud.ready) return;
  state.cloud.pending = true;
  window.clearTimeout(state.cloud.timer);
  setSyncStatus('等待保存', 'pending');
  state.cloud.timer = window.setTimeout(() => flushCloudState(), CLOUD_SYNC_DELAY_MS);
}

async function flushCloudState() {
  if (!state.cloud.ready) return false;
  if (state.cloud.saving) {
    state.cloud.pending = true;
    return false;
  }
  window.clearTimeout(state.cloud.timer);
  state.cloud.timer = null;
  state.cloud.pending = false;
  state.cloud.saving = true;
  setSyncStatus('正在保存', 'saving');
  try {
    const response = await fetch(`${API_BASE}/api/state`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: profileSnapshot() })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '保存失败');
    state.cloud.revision = Number(result.revision || state.cloud.revision);
    setLocalStateDirty(false);
    setSyncStatus('已保存', 'saved');
    return true;
  } catch {
    setLocalStateDirty(true);
    setSyncStatus('仅本机', 'offline');
    return false;
  } finally {
    state.cloud.saving = false;
    if (state.cloud.pending) queueCloudSync();
  }
}

async function initialiseProfileState() {
  setSyncStatus('连接存储', 'saving');
  try {
    const response = await fetch(`${API_BASE}/api/state`, { credentials: 'same-origin', cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '读取保存记录失败');
    state.cloud.ready = true;
    state.cloud.revision = Number(result.revision || 0);
    const localHasState = importedBanks.length > 0 || completedSet.size > 0 || wrongSet.size > 0 || favoriteSet.size > 0 || Boolean(state.resumeBookmark) || state.autoNextCorrect;
    if (result.hasState && !localStateIsDirty()) {
      const migrated = applyProfileSnapshot(result.state);
      if (migrated) {
        setLocalStateDirty(true);
        const saved = await flushCloudState();
        if (saved) setSyncStatus('已修复并保存', 'saved');
      } else {
        setLocalStateDirty(false);
        setSyncStatus('已恢复', 'saved');
      }
    } else if (!result.hasState || localHasState || localStateIsDirty()) {
      await flushCloudState();
    } else {
      setSyncStatus('已保存', 'saved');
    }
  } catch {
    state.cloud.ready = false;
    setSyncStatus('仅本机', 'offline');
  }
}

function savePracticeBookmark(session = state.session) {
  if (!session?.questions?.length || !String(session.routeKey || '').startsWith('#')) return;
  const question = session.questions[session.current];
  const nextBookmark = {
    routeKey: session.routeKey,
    questionId: question?.id || '',
    bankId: session.bankId,
    mode: session.mode,
    current: session.current,
    spec: { ...session.spec }
  };
  const previous = state.resumeBookmark;
  const unchanged = previous
    && previous.routeKey === nextBookmark.routeKey
    && previous.questionId === nextBookmark.questionId
    && previous.bankId === nextBookmark.bankId
    && previous.mode === nextBookmark.mode
    && previous.current === nextBookmark.current
    && JSON.stringify(previous.spec || {}) === JSON.stringify(nextBookmark.spec);
  if (unchanged) return;
  state.resumeBookmark = nextBookmark;
  try { localStorage.setItem(LAST_PRACTICE_KEY, JSON.stringify(state.resumeBookmark)); } catch { /* SQLite remains the primary store. */ }
  markProfileChanged();
}

function clearPracticeBookmark() {
  if (!state.resumeBookmark) return;
  state.resumeBookmark = null;
  try { localStorage.removeItem(LAST_PRACTICE_KEY); } catch { /* Ignore local storage failures. */ }
  markProfileChanged();
}
function questionAnswers(question) { return [...new Set((question.answer || []).map((answer) => String(answer).toUpperCase()))].sort(); }
function sameAnswers(left, right) { return left.length === right.length && left.every((answer, index) => answer === right[index]); }
function isWrongbookQuestion(questionId) { return wrongSet.has(questionId) || favoriteSet.has(questionId); }
function bankWrongCount(bank) { return bankAllQuestions(bank).filter((question) => isWrongbookQuestion(question.id)).length; }
function bankFavoriteCount(bank) { return bankAllQuestions(bank).filter((question) => favoriteSet.has(question.id)).length; }
function globalWrongCount() { return allQuestions().filter((question) => isWrongbookQuestion(question.id)).length; }

function pruneUnusedSavedRelatedQuestions() {
  let changed = false;
  importedBanks.forEach((bank) => {
    const saved = bank.savedRelatedQuestions || [];
    const retained = saved.filter((question) => wrongSet.has(question.id) || favoriteSet.has(question.id));
    if (retained.length !== saved.length) {
      bank.savedRelatedQuestions = retained;
      changed = true;
    }
  });
  return changed;
}

function purgeBankState(bank) {
  bankAllQuestions(bank).forEach((question) => {
    completedSet.delete(question.id);
    wrongSet.delete(question.id);
    favoriteSet.delete(question.id);
  });
}

function deleteBank(bankId) {
  const bank = importedBanks.find((item) => item.id === bankId);
  if (!bank) return;
  if (!window.confirm(`确定删除题库“${bank.name}”吗？\n该题库的练习进度、错题和收藏记录也会一并删除。`)) return;
  purgeBankState(bank);
  if (state.resumeBookmark?.bankId === bankId) clearPracticeBookmark();
  importedBanks = importedBanks.filter((item) => item.id !== bankId);
  saveBanks();
  saveProgress();
  updateGlobalCounts();
  renderLibrary();
}

function showView(viewId) {
  if (viewId !== 'view-practice') clearAutoNextTimer();
  const wasPracticeActive = document.body.classList.contains('practice-active');
  const isPracticeActive = viewId === 'view-practice';
  const isMobile = window.matchMedia('(max-width: 720px)').matches;
  document.body.classList.toggle('practice-active', isPracticeActive);
  document.querySelectorAll('.view').forEach((view) => { view.hidden = view.id !== viewId; });
  if (!isPracticeActive || !wasPracticeActive || !isMobile) window.scrollTo({ top: 0, behavior: 'auto' });
}

function navigate(hash) {
  if (location.hash === hash) renderRoute(); else location.hash = hash;
}

function setShuffleOptionsPreference(value, sync = true) {
  const nextValue = Boolean(value);
  const changed = state.shufflePracticeOptions !== nextValue;
  state.shufflePracticeOptions = nextValue;
  saveBooleanPreference(SHUFFLE_OPTIONS_KEY, nextValue);
  if (changed && sync) markProfileChanged();
}

function routeParts() {
  const hash = location.hash || '#/banks';
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean).map((part) => decodeURIComponent(part));
}

function updateGlobalCounts() {
  $('nav-wrong-count').textContent = globalWrongCount();
}

function renderLibrary() {
  showView('view-library');
  updateGlobalCounts();
  const keyword = $('bank-search').value.trim().toLowerCase();
  const banks = allBanks().filter((bank) => `${bank.name} ${bank.filename}`.toLowerCase().includes(keyword));
  const grid = $('bank-grid');
  if (!banks.length) {
    grid.innerHTML = '<div class="empty-state">没有找到匹配的题库。</div>';
    return;
  }
  grid.innerHTML = banks.map((bank) => {
    const singleCount = bank.questions.filter((question) => question.type === 'single').length;
    const multiCount = bank.questions.filter((question) => question.type === 'multi').length;
    const completed = bank.questions.filter((question) => completedSet.has(question.id)).length;
    const progress = bank.questions.length ? Math.round(completed / bank.questions.length * 100) : 0;
    return `<article class="bank-card">
      <div class="bank-card-top"><span class="folder-mark">▱</span><span class="bank-card-tools"><span class="bank-kind">${bank.ai?.used ? 'AI 题库' : 'Word 题库'}</span><button class="bank-delete" type="button" data-delete-bank="${escapeHtml(bank.id)}" aria-label="删除题库 ${escapeHtml(bank.name)}">删除</button></span></div>
      <h3>${escapeHtml(bank.name)}</h3><p>${escapeHtml(bank.filename)}</p>
      <div class="bank-type-row"><span>单选 <strong>${singleCount}</strong></span><span>多选 <strong>${multiCount}</strong></span><span>错题集 <strong>${bankWrongCount(bank)}</strong></span></div>
      <div class="bank-progress"><span style="width:${progress}%"></span></div>
      <div class="bank-card-foot"><small>已完成 ${completed} / ${bank.questions.length}</small><button type="button" data-open-bank="${escapeHtml(bank.id)}">进入题库 →</button></div>
    </article>`;
  }).join('');
  grid.querySelectorAll('[data-open-bank]').forEach((button) => button.addEventListener('click', () => navigate(`#/bank/${encodeURIComponent(button.dataset.openBank)}`)));
  grid.querySelectorAll('[data-delete-bank]').forEach((button) => button.addEventListener('click', () => deleteBank(button.dataset.deleteBank)));
}

const MODE_CARDS = [
  { key: 'ordered-single', icon: '01', title: '顺序单选', description: '按原题目顺序，只练单选题。' },
  { key: 'ordered-multi', icon: '02', title: '顺序多选', description: '按原题目顺序，只练多选题。' },
  { key: 'random-single', icon: '↝', title: '乱序单选', description: '随机题目顺序，只练单选题。' },
  { key: 'random-multi', icon: '⌁', title: '乱序多选', description: '随机题目顺序，只练多选题。' },
  { key: 'mock', icon: '▤', title: '模拟练习', description: '自定义单选、多选数量组成一套练习。' },
  { key: 'wrong', icon: '↺', title: '错题练习', description: '练习当前题库中答错或收藏的题目。' },
  { key: 'wrongbook', icon: '◇', title: '错题集', description: '查看、整理和移出答错或收藏的题目。' },
  { key: 'favorites', icon: '★', title: '收藏夹', description: '查看并练习当前题库中收藏的题目。' }
];

function renderBank(bank) {
  state.activeBankId = bank.id;
  showView('view-bank');
  const single = bank.questions.filter((question) => question.type === 'single');
  const multi = bank.questions.filter((question) => question.type === 'multi');
  const wrong = bankWrongCount(bank);
  const favorites = bankFavoriteCount(bank);
  $('bank-title').textContent = bank.name;
  $('bank-filename').textContent = bank.filename;
  $('bank-total').textContent = bank.questions.length;
  $('bank-single').textContent = single.length;
  $('bank-multi').textContent = multi.length;
  $('bank-wrong').textContent = wrong;
  const shuffleToggle = $('shuffle-options-toggle');
  shuffleToggle.checked = state.shufflePracticeOptions;
  shuffleToggle.onchange = (event) => setShuffleOptionsPreference(event.currentTarget.checked);

  $('mode-grid').innerHTML = MODE_CARDS.map((mode) => {
    const count = mode.key.includes('single') ? single.length : mode.key.includes('multi') ? multi.length : ['wrong', 'wrongbook'].includes(mode.key) ? wrong : mode.key === 'favorites' ? favorites : bank.questions.length;
    const disabled = count === 0 && !['wrongbook', 'favorites'].includes(mode.key);
    return `<button class="mode-card${['wrongbook', 'favorites'].includes(mode.key) ? ' wrongbook-card' : ''}" type="button" data-mode="${mode.key}" ${disabled ? 'disabled' : ''}>
      <span class="mode-icon">${mode.icon}</span><span class="mode-copy"><strong>${mode.title}</strong><small>${mode.description}</small></span><span class="mode-count">${count} 题</span><span class="mode-arrow">→</span>
    </button>`;
  }).join('');
  $('mode-grid').querySelectorAll('[data-mode]:not([disabled])').forEach((button) => button.addEventListener('click', () => {
    const mode = button.dataset.mode;
    if (mode === 'mock') navigate(`#/bank/${encodeURIComponent(bank.id)}/mock`);
    else if (mode === 'wrongbook') navigate(`#/bank/${encodeURIComponent(bank.id)}/wrongbook`);
    else if (mode === 'favorites') navigate(`#/bank/${encodeURIComponent(bank.id)}/favorites`);
    else if (OPTION_ORDER_MODES.has(mode)) {
      const optionOrder = state.shufflePracticeOptions ? 'shuffle' : 'fixed';
      navigate(`#/bank/${encodeURIComponent(bank.id)}/practice/${mode}/${optionOrder}`);
    }
    else navigate(`#/bank/${encodeURIComponent(bank.id)}/practice/${mode}`);
  }));

}

function renderWrongbook(bank = null, collectionKind = 'wrongbook') {
  const favoritesOnly = collectionKind === 'favorites';
  state.wrongbookBankId = bank?.id || 'all';
  showView('view-wrongbook');
  const source = bank ? bankAllQuestions(bank) : allQuestions();
  const questions = source.filter((question) => favoritesOnly ? favoriteSet.has(question.id) : isWrongbookQuestion(question.id));
  $('wrongbook-eyebrow').textContent = favoritesOnly ? 'FAVORITE QUESTION COLLECTION' : 'WRONG QUESTION COLLECTION';
  $('wrongbook-title').textContent = bank ? `${bank.name} · ${favoritesOnly ? '收藏夹' : '错题集'}` : favoritesOnly ? '全部收藏夹' : '全部错题集';
  $('wrongbook-subtitle').textContent = favoritesOnly
    ? '收藏的题目集中保存在这里，可随时重新练习。'
    : bank ? '本题库答错或收藏的题目会持续保留，直到你手动移出。' : '所有题库中答错或收藏的题目都会集中保存在这里。';
  $('wrongbook-count').textContent = questions.length;
  $('wrongbook-back').onclick = () => navigate(bank ? `#/bank/${encodeURIComponent(bank.id)}` : '#/banks');
  $('wrongbook-practice').disabled = questions.length === 0;
  $('wrongbook-clear').disabled = questions.length === 0;
  $('wrongbook-practice').innerHTML = `${favoritesOnly ? '开始收藏练习' : '开始错题练习'} <span>→</span>`;
  $('wrongbook-clear').textContent = favoritesOnly ? '清空收藏夹' : '清空错题集';
  $('wrongbook-practice').onclick = () => {
    if (!questions.length) return;
    const mode = favoritesOnly ? 'favorite' : 'wrong';
    navigate(bank ? `#/bank/${encodeURIComponent(bank.id)}/practice/${mode}` : `#/practice/all/${mode}`);
  };
  $('wrongbook-clear').onclick = () => {
    const collectionLabel = favoritesOnly ? '收藏夹' : '错题集';
    if (!questions.length || !window.confirm(`确定清空${bank ? `“${bank.name}”的` : '全部'}${collectionLabel}吗？`)) return;
    questions.forEach((question) => {
      favoriteSet.delete(question.id);
      if (!favoritesOnly) wrongSet.delete(question.id);
    });
    const banksChanged = pruneUnusedSavedRelatedQuestions();
    if (banksChanged) saveBanks();
    saveProgress();
    updateGlobalCounts();
    renderWrongbook(bank, collectionKind);
  };

  const list = $('wrongbook-list');
  if (!questions.length) {
    list.innerHTML = `<div class="wrongbook-empty"><span>${favoritesOnly ? '☆' : '✓'}</span><h2>${favoritesOnly ? '暂无收藏' : '暂无题目'}</h2><p>${favoritesOnly ? '在答题页或相关题目上点击收藏即可加入。' : '答错或收藏的题目会自动收集到这里。'}</p></div>`;
    return;
  }
  list.innerHTML = questions.map((question, index) => {
    const answers = questionAnswers(question);
    const answerOptions = question.options.filter(([key]) => answers.includes(key));
    const bankName = getBank(question.bankId)?.name || question.bankName || '题库';
    const reasonBadges = `${wrongSet.has(question.id) ? '<span class="wrongbook-reason mistake">答错</span>' : ''}${favoriteSet.has(question.id) ? '<span class="wrongbook-reason favorite">★ 已收藏</span>' : ''}`;
    return `<article class="wrongbook-item">
      <div class="wrongbook-item-top"><span class="wrongbook-index">${String(index + 1).padStart(2, '0')}</span><span>${escapeHtml(bankName)}</span><span>${question.type === 'multi' ? '多选题' : '单选题'}</span>${reasonBadges}<button type="button" data-remove-collection="${escapeHtml(question.id)}">${favoritesOnly ? '取消收藏' : '移出错题集'}</button></div>
      <h2>${escapeHtml(question.prompt)}</h2>
      <div class="wrongbook-answer"><strong>正确答案：${answers.join('、')}</strong>${answerOptions.length ? `<p>${answerOptions.map(([key, text]) => `${key}. ${escapeHtml(text)}`).join('　')}</p>` : ''}<small>${escapeHtml(question.explanation || '本题未生成解析。')}</small></div>
    </article>`;
  }).join('');
  list.querySelectorAll('[data-remove-collection]').forEach((button) => button.addEventListener('click', () => {
    const questionId = button.dataset.removeCollection;
    favoriteSet.delete(questionId);
    if (!favoritesOnly) wrongSet.delete(questionId);
    const banksChanged = pruneUnusedSavedRelatedQuestions();
    if (banksChanged) saveBanks();
    saveProgress();
    updateGlobalCounts();
    renderWrongbook(bank, collectionKind);
  }));
}

function renderMock(bank) {
  state.activeBankId = bank.id;
  showView('view-mock');
  const singleCount = bank.questions.filter((question) => question.type === 'single').length;
  const multiCount = bank.questions.filter((question) => question.type === 'multi').length;
  $('mock-bank-name').textContent = `从“${bank.name}”中选择单选题、多选题数量，随机组成一套练习。`;
  $('mock-single-help').textContent = `最多可选 ${singleCount} 题`;
  $('mock-multi-help').textContent = `最多可选 ${multiCount} 题`;
  $('mock-single-count').max = singleCount;
  $('mock-multi-count').max = multiCount;
  $('mock-single-count').value = Math.min(10, singleCount);
  $('mock-multi-count').value = Math.min(5, multiCount);
  $('mock-back').onclick = () => navigate(`#/bank/${encodeURIComponent(bank.id)}`);
  updateMockTotal();
}

function updateMockTotal() {
  const single = Math.max(0, Number($('mock-single-count').value || 0));
  const multi = Math.max(0, Number($('mock-multi-count').value || 0));
  $('mock-total').textContent = `共 ${single + multi} 题`;
  $('mock-error').hidden = true;
}

function prepareQuestion(question, shouldShuffleOptions) {
  const sourceOptions = question.options.map(([key, text]) => ({ key, text }));
  if (!shouldShuffleOptions) return { ...question, displayOptions: question.options.map((option) => [...option]), displayAnswers: questionAnswers(question) };
  const shuffled = shuffle(sourceOptions);
  const answerMap = new Map(shuffled.map((option, index) => [option.key, LETTERS[index]]));
  return {
    ...question,
    displayOptions: shuffled.map((option, index) => [LETTERS[index], option.text]),
    displayAnswers: questionAnswers(question).map((answer) => answerMap.get(answer) || answer).sort()
  };
}

function buildSession(spec, routeKey = '') {
  const config = MODE_CONFIG[spec.mode];
  const shouldShuffleOptions = typeof spec.shuffleOptions === 'boolean' ? spec.shuffleOptions : config.shuffleOptions;
  let bank = spec.bankId === 'all' ? null : getBank(spec.bankId);
  const collectionMode = ['wrong', 'favorite'].includes(spec.mode);
  let source = bank ? [...(collectionMode ? bankAllQuestions(bank) : bank.questions)] : allQuestions();
  if (spec.mode === 'wrong') source = source.filter((question) => isWrongbookQuestion(question.id));
  else if (spec.mode === 'favorite') source = source.filter((question) => favoriteSet.has(question.id));
  else if (spec.mode === 'mock') {
    const singles = shuffle(source.filter((question) => question.type === 'single')).slice(0, spec.singleCount);
    const multis = shuffle(source.filter((question) => question.type === 'multi')).slice(0, spec.multiCount);
    source = shuffle([...singles, ...multis]);
  } else source = source.filter((question) => question.type === config.type);
  if (config.shuffleQuestions && spec.mode !== 'mock') source = shuffle(source);
  const questions = source.map((question) => prepareQuestion(question, shouldShuffleOptions));
  const optionOrderLabel = OPTION_ORDER_MODES.has(spec.mode) ? ` · ${shouldShuffleOptions ? '选项乱序' : '选项原序'}` : '';
  return {
    spec,
    routeKey,
    bankId: spec.bankId,
    bankName: bank ? bank.name : '全部题库',
    mode: spec.mode,
    modeLabel: `${config.label}${optionOrderLabel}`,
    questions,
    current: 0,
    responses: questions.map(() => ({
      selected: [], submitted: false, correct: false, hasAnswer: false,
      aiExplanation: '', aiModel: '', aiLoading: false, aiSkipped: false, aiError: '',
      aiConversation: [], aiFollowupLoading: false, aiFollowupError: '',
      relatedLoading: false, relatedLoaded: false, relatedError: '',
      relatedLocal: [], relatedWeb: [], relatedSources: [],
      relatedSelections: {}, relatedSubmitted: {}
    })),
    autoNextTimer: null,
    aiAnalyses: [],
    aiAnalysisCompletedIds: [],
    aiAnalysisError: '',
    aiAnalysisSkipped: false,
    aiAnalysisLoading: false
  };
}

function beginSession(spec, routeKey = '') {
  clearAutoNextTimer();
  if (OPTION_ORDER_MODES.has(spec.mode)) {
    const effectiveShuffle = typeof spec.shuffleOptions === 'boolean'
      ? spec.shuffleOptions
      : MODE_CONFIG[spec.mode].shuffleOptions;
    setShuffleOptionsPreference(effectiveShuffle);
  }
  state.lastSpec = { ...spec };
  state.session = buildSession(spec, routeKey);
  if (!state.session.questions.length) {
    window.alert('当前模式没有可练习的题目。');
    if (spec.mode === 'wrong') navigate(spec.bankId === 'all' ? '#/wrongbook' : `#/bank/${encodeURIComponent(spec.bankId)}/wrongbook`);
    else if (spec.mode === 'favorite') navigate(spec.bankId === 'all' ? '#/banks' : `#/bank/${encodeURIComponent(spec.bankId)}/favorites`);
    else if (spec.bankId === 'all') navigate('#/banks');
    else navigate(`#/bank/${encodeURIComponent(spec.bankId)}`);
    return;
  }
  const bookmark = state.resumeBookmark;
  if (bookmark?.routeKey === routeKey && bookmark.bankId === spec.bankId && bookmark.mode === spec.mode) {
    const bookmarkedIndex = state.session.questions.findIndex((question) => question.id === bookmark.questionId);
    if (bookmarkedIndex >= 0) state.session.current = bookmarkedIndex;
    else if (Number.isInteger(bookmark.current)) state.session.current = Math.min(Math.max(0, bookmark.current), state.session.questions.length - 1);
  }
  showView('view-practice');
  renderCurrentQuestion();
  savePracticeBookmark(state.session);
}

function renderQuestionFavorite(question) {
  const button = $('question-favorite');
  if (!button) return;
  const active = favoriteSet.has(question.id);
  button.classList.toggle('active', active);
  button.setAttribute('aria-pressed', String(active));
  button.setAttribute('aria-label', active ? '取消收藏当前题目' : '收藏当前题目');
  button.title = active ? '取消收藏当前题目' : '收藏当前题目';
  $('question-favorite-icon').textContent = active ? '★' : '☆';
  $('question-favorite-label').textContent = active ? '已收藏' : '收藏题目';
  button.onclick = () => {
    if (favoriteSet.has(question.id)) {
      favoriteSet.delete(question.id);
      if (question.relatedSaved && !wrongSet.has(question.id)) {
        const bank = getBank(question.bankId);
        if (bank) {
          bank.savedRelatedQuestions = (bank.savedRelatedQuestions || []).filter((item) => item.id !== question.id);
          saveBanks();
        }
      }
    } else favoriteSet.add(question.id);
    saveProgress();
    updateGlobalCounts();
    renderQuestionFavorite(question);
  };
}

function renderCurrentQuestion() {
  const session = state.session;
  const question = session.questions[session.current];
  const response = session.responses[session.current];
  showView('view-practice');
  $('practice-bank').textContent = session.bankName;
  $('practice-mode').textContent = session.modeLabel;
  $('practice-count').textContent = `${session.current + 1} / ${session.questions.length}`;
  $('practice-progress').style.width = `${(session.current + 1) / session.questions.length * 100}%`;
  $('auto-next-correct').checked = state.autoNextCorrect;
  renderQuestionFavorite(question);
  $('question-number').textContent = String(session.current + 1).padStart(2, '0');
  $('question-type').textContent = question.type === 'multi' ? '多选题 · 可选择多项' : '单选题 · 请选择 1 项';
  $('quiz-question').textContent = question.prompt;
  $('quiz-options').innerHTML = question.displayOptions.length ? question.displayOptions.map(([key, text]) => `<button class="option" type="button" data-key="${key}" aria-pressed="${response.selected.includes(key)}"><span class="option-control">${question.type === 'multi' ? '□' : '○'}</span><span class="option-key">${key}</span><span class="option-text">${escapeHtml(text)}</span></button>`).join('') : '<div class="option-missing">该题没有识别到完整选项，请检查原题库文件后重新导入。</div>';
  $('quiz-options').querySelectorAll('[data-key]').forEach((button) => button.addEventListener('click', () => chooseOption(button.dataset.key)));
  $('previous-button').disabled = session.current === 0;
  $('submit-button').hidden = response.submitted;
  $('submit-button').disabled = !question.displayOptions.length;
  $('next-button').hidden = !response.submitted;
  $('next-button').innerHTML = session.current === session.questions.length - 1 ? '查看结果 <span>→</span>' : '下一题 <span>→</span>';
  const jumpInput = $('question-jump-input');
  jumpInput.min = '1';
  jumpInput.max = String(session.questions.length);
  jumpInput.value = String(session.current + 1);
  jumpInput.setCustomValidity('');
  const feedback = $('answer-feedback');
  feedback.hidden = !response.submitted;
  feedback.className = `answer-feedback${response.submitted && response.hasAnswer && !response.correct ? ' incorrect' : ''}`;
  if (response.submitted) {
    const expected = question.displayAnswers;
    const documentExplanation = question.explanation ? ` ${escapeHtml(question.explanation)}` : '';
    feedback.innerHTML = response.hasAnswer ? `<strong>${response.correct ? '回答正确。' : `正确答案：${expected.join('、')}。`}</strong>${documentExplanation}` : '<strong>已记录。</strong> 这道题未识别到答案，不计入正确率。';
  }
  renderQuestionAiPanel(question, response);
  updateOptionState();
  $('practice-back').onclick = () => {
    if (session.mode === 'wrong') navigate(session.bankId === 'all' ? '#/wrongbook' : `#/bank/${encodeURIComponent(session.bankId)}/wrongbook`);
    else if (session.mode === 'favorite') navigate(session.bankId === 'all' ? '#/banks' : `#/bank/${encodeURIComponent(session.bankId)}/favorites`);
    else navigate(session.bankId === 'all' ? '#/banks' : `#/bank/${encodeURIComponent(session.bankId)}`);
  };
}

function tutorMessageMarkup(item, index, conversation, loading) {
  const isUser = item.role === 'user';
  const isStreaming = !isUser && loading && index === conversation.length - 1;
  const content = isUser
    ? `<p>${escapeHtml(item.content)}</p>`
    : (item.content ? markdownHtml(item.content) : '<p class="tutor-stream-placeholder">正在回答…</p>');
  return `<div class="tutor-message ${isUser ? 'user' : 'assistant'}${isStreaming ? ' streaming' : ''}">
    <span>${isUser ? '你' : '助教'}</span>
    <div class="tutor-message-content${isUser ? '' : ' markdown-body'}">${content}</div>
  </div>`;
}

const RELATED_STOP_TOKENS = new Set([
  '下列', '以下', '关于', '的是', '属于', '正确', '错误', '说法', '选项', '其中', '可以', '应当',
  '哪项', '一项', '多项', '根据', '对于', '主要', '体现', '包括', '不包括', '符合', '不符合'
]);

function relatedQuestionTokens(question) {
  const optionText = (question.options || []).map((option) => Array.isArray(option) ? option[1] : option?.text).join(' ');
  const text = `${question.prompt || ''} ${optionText}`.toLowerCase();
  const tokens = new Set((text.match(/[a-z0-9]{2,}/g) || []).filter((token) => !RELATED_STOP_TOKENS.has(token)));
  (text.match(/[\u4e00-\u9fff]{2,}/g) || []).forEach((segment) => {
    for (let index = 0; index < segment.length - 1; index += 1) {
      const bigram = segment.slice(index, index + 2);
      if (!RELATED_STOP_TOKENS.has(bigram)) tokens.add(bigram);
    }
    for (let index = 0; index < segment.length - 2; index += 1) {
      const trigram = segment.slice(index, index + 3);
      if (!RELATED_STOP_TOKENS.has(trigram)) tokens.add(trigram);
    }
  });
  return tokens;
}

function relatedQuestionScore(sourceTokens, candidate) {
  const candidateTokens = relatedQuestionTokens(candidate);
  if (!sourceTokens.size || !candidateTokens.size) return 0;
  let common = 0;
  sourceTokens.forEach((token) => { if (candidateTokens.has(token)) common += token.length > 2 ? 1.35 : 1; });
  return common / Math.sqrt(sourceTokens.size * candidateTokens.size);
}

function findLocalRelatedQuestions(question, limit = 3) {
  const sourceTokens = relatedQuestionTokens(question);
  return allQuestions()
    .filter((candidate) => candidate.id !== question.id && candidate.options.length >= 2 && questionAnswers(candidate).length)
    .map((candidate) => ({ candidate, score: relatedQuestionScore(sourceTokens, candidate) }))
    .filter((item) => item.score >= 0.03)
    .sort((left, right) => right.score - left.score || String(left.candidate.id).localeCompare(String(right.candidate.id)))
    .slice(0, limit)
    .map(({ candidate }) => ({
      id: candidate.id,
      source: 'bank',
      bankName: getBank(candidate.bankId)?.name || candidate.bankName || '题库',
      prompt: candidate.prompt,
      options: candidate.options.map(([key, text]) => ({ key, text })),
      answer: questionAnswers(candidate),
      type: candidate.type,
      explanation: candidate.explanation || ''
    }));
}

function stableRelatedQuestionSourceId(item) {
  const source = JSON.stringify({
    prompt: item.prompt,
    options: (item.options || []).map((option) => [option.key, option.text]),
    answer: item.answer || []
  });
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `saved-related-${(hash >>> 0).toString(16).padStart(8, '0')}-${source.length}`;
}

function findStoredRelatedQuestion(item, bankId = '') {
  if (item.source === 'bank') return allQuestions().find((question) => question.id === item.id) || null;
  const sourceId = item.storageSourceId || stableRelatedQuestionSourceId(item);
  const banks = bankId ? [getBank(bankId)].filter(Boolean) : allBanks();
  return banks.flatMap((bank) => bank.savedRelatedQuestions || [])
    .find((question) => String(question.sourceId) === sourceId) || null;
}

function ensureRelatedQuestionStored(item, sourceQuestion) {
  if (item.source === 'bank') return findStoredRelatedQuestion(item);
  const bank = getBank(sourceQuestion.bankId);
  if (!bank) return null;
  const sourceId = item.storageSourceId || stableRelatedQuestionSourceId(item);
  let stored = findStoredRelatedQuestion({ ...item, storageSourceId: sourceId }, bank.id);
  if (!stored) {
    stored = normaliseQuestion({
      id: sourceId,
      sourceId,
      prompt: item.prompt,
      options: item.options.map((option) => [option.key, option.text]),
      answer: item.answer,
      type: item.type,
      explanation: item.explanation || '',
      category: '相关题目',
      tags: ['相关题目', '收藏'],
      relatedSaved: true
    }, bank.id, bank.name, bank.questions.length + (bank.savedRelatedQuestions || []).length);
    bank.savedRelatedQuestions = [...(bank.savedRelatedQuestions || []), stored];
    saveBanks();
  }
  item.storageSourceId = sourceId;
  item.savedQuestionId = stored.id;
  return stored;
}

function toggleRelatedQuestionFavorite(item, sourceQuestion) {
  let stored = findStoredRelatedQuestion(item, sourceQuestion.bankId);
  let questionId = item.source === 'bank' ? item.id : stored?.id;
  if (questionId && favoriteSet.has(questionId)) {
    favoriteSet.delete(questionId);
    if (item.source === 'web' && !wrongSet.has(questionId)) {
      const bank = getBank(stored.bankId);
      if (bank) {
        bank.savedRelatedQuestions = (bank.savedRelatedQuestions || []).filter((question) => question.id !== questionId);
        saveBanks();
      }
      item.savedQuestionId = '';
    }
  } else {
    stored = ensureRelatedQuestionStored(item, sourceQuestion);
    questionId = stored?.id || '';
    if (!questionId) return;
    favoriteSet.add(questionId);
  }
  saveProgress();
  updateGlobalCounts();
}

function normaliseExternalRelatedQuestion(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const options = (Array.isArray(raw.options) ? raw.options : []).map((option, optionIndex) => ({
    key: String(option?.key || LETTERS[optionIndex] || '').toUpperCase(),
    text: String(option?.text || '').trim()
  })).filter((option) => /^[A-H]$/.test(option.key) && option.text);
  const optionKeys = new Set(options.map((option) => option.key));
  const answer = [...new Set((Array.isArray(raw.answer) ? raw.answer : []).map((letter) => String(letter).toUpperCase()))]
    .filter((letter) => optionKeys.has(letter)).sort();
  const prompt = String(raw.prompt || '').trim();
  if (!prompt || options.length < 2 || !answer.length) return null;
  const question = {
    id: String(raw.id || `web-related-${index}`),
    source: 'web',
    bankName: '联网拓展',
    prompt,
    options,
    answer,
    type: answer.length > 1 ? 'multi' : 'single',
    explanation: String(raw.explanation || '').trim(),
    sourceIndexes: (Array.isArray(raw.sourceIndexes) ? raw.sourceIndexes : []).map(Number).filter(Number.isInteger)
  };
  question.storageSourceId = stableRelatedQuestionSourceId(question);
  return question;
}

function normaliseRelatedSource(raw) {
  try {
    const url = new URL(String(raw?.url || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return { index: Number(raw?.index), title: String(raw?.title || url.hostname).trim(), url: url.href };
  } catch (_) {
    return null;
  }
}

function relatedQuestionById(response, questionId) {
  return [...(response.relatedLocal || []), ...(response.relatedWeb || [])]
    .find((question) => question.id === questionId);
}

function relatedQuestionMarkup(item, response) {
  const selected = Array.isArray(response.relatedSelections[item.id]) ? response.relatedSelections[item.id] : [];
  const submitted = Boolean(response.relatedSubmitted[item.id]);
  const correct = submitted && sameAnswers([...selected].sort(), [...item.answer].sort());
  const origin = item.source === 'web' ? '联网拓展' : item.bankName;
  const stored = findStoredRelatedQuestion(item);
  const favoriteQuestionId = item.source === 'bank' ? item.id : stored?.id || item.savedQuestionId || '';
  const isFavorite = Boolean(favoriteQuestionId && favoriteSet.has(favoriteQuestionId));
  const options = item.options.map((option) => {
    const isSelected = selected.includes(option.key);
    const isCorrect = submitted && item.answer.includes(option.key);
    const isWrong = submitted && isSelected && !isCorrect;
    const classes = ['related-option', isSelected ? 'selected' : '', isCorrect ? 'correct' : '', isWrong ? 'wrong' : ''].filter(Boolean).join(' ');
    return `<button class="${classes}" type="button" data-related-option="${escapeHtml(option.key)}" data-related-id="${escapeHtml(item.id)}" aria-pressed="${isSelected}" ${submitted ? 'disabled' : ''}>
      <span class="related-option-key">${escapeHtml(option.key)}</span><span>${escapeHtml(option.text)}</span>
    </button>`;
  }).join('');
  const explanation = item.explanation || (item.source === 'bank' ? '原题库未提供解析。' : '暂无解析。');
  const feedback = submitted ? `<div class="related-feedback${correct ? '' : ' incorrect'}">
    <strong>${correct ? '回答正确。' : `正确答案：${escapeHtml(item.answer.join('、'))}。`}</strong>
    <span>${escapeHtml(explanation)}</span>
  </div>` : '';
  return `<article class="related-card" data-related-card="${escapeHtml(item.id)}">
    <div class="related-card-top"><span class="related-origin">${escapeHtml(origin)}</span><div class="related-card-tools"><button class="related-favorite${isFavorite ? ' active' : ''}" type="button" data-related-favorite="${escapeHtml(item.id)}" aria-pressed="${isFavorite}">${isFavorite ? '★ 已收藏' : '☆ 收藏'}</button><span class="related-type">${item.type === 'multi' ? '多选题' : '单选题'}</span></div></div>
    <h3>${escapeHtml(item.prompt)}</h3>
    <div class="related-options">${options}</div>
    ${submitted ? '' : `<div class="related-card-actions"><span class="related-selection-hint">${item.type === 'multi' ? '可选择多项' : '请选择 1 项'}</span><button class="secondary-button" type="button" data-related-submit="${escapeHtml(item.id)}" ${selected.length ? '' : 'disabled'}>提交答案</button></div>`}
    ${feedback}
  </article>`;
}

function renderRelatedPractice(question, response) {
  const section = $('related-practice');
  const visible = Boolean(response.aiExplanation && !response.aiLoading && response.submitted && response.hasAnswer && !response.correct);
  section.hidden = !visible;
  if (!visible) return;
  const button = $('related-generate');
  button.disabled = Boolean(response.relatedLoading);
  button.textContent = response.relatedLoading ? '正在获取…' : response.relatedLoaded ? '重新获取' : '获取相关题目';
  const status = $('related-status');
  status.hidden = !response.relatedLoading && !response.relatedError;
  status.className = `related-status${response.relatedError ? ' error' : ''}`;
  if (response.relatedLoading) status.textContent = `已在题库中找到 ${response.relatedLocal.length} 道，正在联网搜索并生成新题…`;
  else if (response.relatedError) status.textContent = `${response.relatedError} 题库内匹配结果仍可继续练习。`;

  const results = $('related-results');
  results.hidden = !response.relatedLoaded && !response.relatedLoading;
  if (results.hidden) return;
  $('related-local-list').innerHTML = response.relatedLocal.length
    ? response.relatedLocal.map((item) => relatedQuestionMarkup(item, response)).join('')
    : '<p class="related-empty">当前题库暂未找到足够相近且带答案的题目。</p>';
  $('related-web-list').innerHTML = response.relatedWeb.length
    ? response.relatedWeb.map((item) => relatedQuestionMarkup(item, response)).join('')
    : `<p class="related-empty">${response.relatedLoading ? '正在检索公开网页并设计拓展题，请稍候…' : '暂未生成联网拓展题。'}</p>`;
  const sources = $('related-sources');
  sources.hidden = !response.relatedSources.length;
  sources.innerHTML = response.relatedSources.length ? `<strong>联网参考来源</strong><div class="related-source-links">${response.relatedSources.map((source) => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(source.index)}. ${escapeHtml(source.title)}</a>`).join('')}</div>` : '';
}

function renderQuestionAiPanel(question, response) {
  const panel = $('question-ai-panel');
  const prompt = $('question-ai-prompt');
  const status = $('question-ai-status');
  const content = $('question-ai-content');
  const generateButton = $('question-ai-generate');
  const skipButton = $('question-ai-skip');
  const canExplain = response.submitted && response.hasAnswer;
  panel.hidden = !canExplain || response.aiSkipped;
  if (panel.hidden) return;

  generateButton.disabled = response.aiLoading;
  skipButton.disabled = response.aiLoading;
  prompt.hidden = Boolean(response.aiExplanation);
  content.hidden = !response.aiExplanation;
  content.classList.toggle('streaming', Boolean(response.aiLoading));
  status.hidden = !response.aiLoading && !response.aiError;
  status.className = `question-ai-status${response.aiError ? ' error' : ''}`;
  if (response.aiLoading) status.textContent = response.aiExplanation ? '正在实时生成解析…' : '正在连接解析服务…';
  else if (response.aiError) status.textContent = response.aiError;

  if (response.aiExplanation) {
    renderMarkdown($('question-ai-text'), response.aiExplanation);
    const conversation = Array.isArray(response.aiConversation) ? response.aiConversation : [];
    const messages = $('tutor-messages');
    messages.hidden = !conversation.length;
    messages.innerHTML = conversation.map((item, index) => tutorMessageMarkup(item, index, conversation, Boolean(response.aiFollowupLoading))).join('');
    $('tutor-form').hidden = Boolean(response.aiLoading);
    $('tutor-input').disabled = Boolean(response.aiFollowupLoading || response.aiLoading);
    $('tutor-send').disabled = Boolean(response.aiFollowupLoading || response.aiLoading);
    const tutorStatus = $('tutor-status');
    tutorStatus.hidden = !response.aiFollowupLoading && !response.aiFollowupError;
    tutorStatus.className = `tutor-status${response.aiFollowupError ? ' error' : ''}`;
    if (response.aiFollowupLoading) tutorStatus.textContent = '正在实时生成回答…';
    else if (response.aiFollowupError) tutorStatus.textContent = response.aiFollowupError;
    renderRelatedPractice(question, response);
    return;
  }
  $('related-practice').hidden = true;
}

function updateOptionState() {
  const session = state.session;
  const question = session.questions[session.current];
  const response = session.responses[session.current];
  $('quiz-options').querySelectorAll('.option').forEach((button) => {
    const key = button.dataset.key;
    const selected = response.selected.includes(key);
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
    const control = button.querySelector('.option-control');
    if (control) control.textContent = question.type === 'multi' ? (selected ? '☑' : '□') : (selected ? '●' : '○');
    if (response.submitted) {
      button.disabled = true;
      if (question.displayAnswers.includes(key)) button.classList.add('correct');
      if (selected && !question.displayAnswers.includes(key)) button.classList.add('wrong');
    }
  });
}

function chooseOption(key) {
  const session = state.session;
  const question = session.questions[session.current];
  const response = session.responses[session.current];
  if (response.submitted) return;
  if (question.type === 'multi') response.selected = response.selected.includes(key) ? response.selected.filter((answer) => answer !== key) : [...response.selected, key];
  else response.selected = [key];
  updateOptionState();
}

function submitCurrentAnswer() {
  const session = state.session;
  const questionIndex = session.current;
  const question = session.questions[session.current];
  const response = session.responses[session.current];
  if (!response.selected.length) {
    const feedback = $('answer-feedback');
    feedback.hidden = false;
    feedback.className = 'answer-feedback incorrect';
    feedback.textContent = '请先选择答案。';
    return;
  }
  const expected = [...question.displayAnswers].sort();
  const selected = [...response.selected].sort();
  response.hasAnswer = expected.length > 0;
  response.correct = response.hasAnswer && sameAnswers(selected, expected);
  response.submitted = true;
  completedSet.add(question.id);
  if (response.hasAnswer && !response.correct) wrongSet.add(question.id);
  saveProgress();
  updateGlobalCounts();
  renderCurrentQuestion();
  scheduleAutoNext(session, questionIndex);
}

async function generateCurrentQuestionExplanation() {
  const session = state.session;
  if (!session) return;
  const questionIndex = session.current;
  const question = session.questions[questionIndex];
  const responseState = session.responses[questionIndex];
  if (!responseState.submitted || !responseState.hasAnswer || responseState.aiLoading || responseState.aiExplanation) return;

  responseState.aiLoading = true;
  responseState.aiSkipped = false;
  responseState.aiError = '';
  responseState.aiExplanation = '';
  responseState.aiConversation = [];
  renderQuestionAiPanel(question, responseState);
  try {
    const apiResponse = await fetch(`${API_BASE}/api/explanations/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questions: [{
        sourceId: question.id,
        prompt: question.prompt,
        options: question.displayOptions.map(([key, text]) => ({ key, text })),
        answer: question.displayAnswers,
        userAnswer: responseState.selected
      }] })
    });
    await consumeEventStream(apiResponse, {
      meta: (payload) => { responseState.aiModel = String(payload?.model || 'deepseek-v4-flash'); },
      delta: (payload) => {
        if (String(payload?.sourceId || '') !== String(question.id) || !payload?.delta) return;
        responseState.aiExplanation += String(payload.delta);
        if (state.session === session && session.current === questionIndex) renderQuestionAiPanel(question, responseState);
      }
    });
    responseState.aiExplanation = responseState.aiExplanation.trim();
    if (!responseState.aiExplanation) throw new Error('DeepSeek 未返回完整解析，请重试');
  } catch (error) {
    responseState.aiExplanation = '';
    responseState.aiConversation = [];
    responseState.aiError = error.message || '生成解析失败，请稍后重试。';
  } finally {
    responseState.aiLoading = false;
    if (state.session === session && session.current === questionIndex) renderQuestionAiPanel(question, responseState);
  }
}

async function submitQuestionFollowup(event) {
  event.preventDefault();
  const session = state.session;
  if (!session) return;
  const questionIndex = session.current;
  const question = session.questions[questionIndex];
  const responseState = session.responses[questionIndex];
  const input = $('tutor-input');
  const message = input.value.trim();
  if (!message || !responseState?.aiExplanation || responseState.aiFollowupLoading) return;

  const previousConversation = Array.isArray(responseState.aiConversation)
    ? responseState.aiConversation.map((item) => ({ role: item.role, content: item.content }))
    : [];
  responseState.aiConversation = [
    ...previousConversation,
    { role: 'user', content: message },
    { role: 'assistant', content: '' }
  ];
  responseState.aiFollowupLoading = true;
  responseState.aiFollowupError = '';
  input.value = '';
  renderQuestionAiPanel(question, responseState);
  try {
    const apiResponse = await fetch(`${API_BASE}/api/tutor/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: {
          sourceId: question.id,
          prompt: question.prompt,
          options: question.displayOptions.map(([key, text]) => ({ key, text })),
          answer: question.displayAnswers,
          userAnswer: responseState.selected
        },
        explanation: responseState.aiExplanation,
        history: previousConversation,
        message
      })
    });
    await consumeEventStream(apiResponse, {
      meta: (payload) => { responseState.aiModel = String(payload?.model || responseState.aiModel || 'deepseek-v4-flash'); },
      delta: (payload) => {
        if (!payload?.delta) return;
        const assistantMessage = responseState.aiConversation[responseState.aiConversation.length - 1];
        if (!assistantMessage || assistantMessage.role !== 'assistant') return;
        assistantMessage.content += String(payload.delta);
        if (state.session === session && session.current === questionIndex) renderQuestionAiPanel(question, responseState);
      }
    });
    const assistantMessage = responseState.aiConversation[responseState.aiConversation.length - 1];
    if (!assistantMessage?.content?.trim()) throw new Error('没有收到完整回答，请重试');
    assistantMessage.content = assistantMessage.content.trim();
  } catch (error) {
    responseState.aiConversation = previousConversation;
    responseState.aiFollowupError = error.message || '追问失败，请稍后重试。';
    input.value = message;
  } finally {
    responseState.aiFollowupLoading = false;
    if (state.session === session && session.current === questionIndex) renderQuestionAiPanel(question, responseState);
  }
}

function handleTutorInputKeydown(event) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  const input = event.currentTarget;
  const form = $('tutor-form');
  const sendButton = $('tutor-send');
  if (!input.value.trim() || input.disabled || sendButton.disabled) return;
  if (typeof form.requestSubmit === 'function') form.requestSubmit(sendButton);
  else sendButton.click();
}

async function generateRelatedQuestions() {
  const session = state.session;
  if (!session) return;
  const questionIndex = session.current;
  const question = session.questions[questionIndex];
  const response = session.responses[questionIndex];
  if (!response?.submitted || response.correct || !response.aiExplanation || response.relatedLoading) return;

  response.relatedLocal = findLocalRelatedQuestions(question);
  response.relatedWeb = [];
  response.relatedSources = [];
  response.relatedSelections = {};
  response.relatedSubmitted = {};
  response.relatedLoaded = true;
  response.relatedLoading = true;
  response.relatedError = '';
  renderRelatedPractice(question, response);
  try {
    const apiResponse = await fetch(`${API_BASE}/api/related`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: {
          sourceId: question.id,
          prompt: question.prompt,
          options: question.displayOptions.map(([key, text]) => ({ key, text })),
          answer: question.displayAnswers,
          userAnswer: response.selected
        },
        explanation: response.aiExplanation
      })
    });
    if (!apiResponse.ok) throw new Error(await readApiError(apiResponse, '获取联网相关题失败'));
    const result = await apiResponse.json();
    response.relatedWeb = (Array.isArray(result.questions) ? result.questions : [])
      .map(normaliseExternalRelatedQuestion).filter(Boolean);
    response.relatedSources = (Array.isArray(result.sources) ? result.sources : [])
      .map(normaliseRelatedSource).filter(Boolean);
    if (!response.relatedWeb.length) throw new Error('联网服务未返回可练习的新题。');
  } catch (error) {
    response.relatedWeb = [];
    response.relatedSources = [];
    response.relatedError = error.message || '获取联网相关题失败，请稍后重试。';
  } finally {
    response.relatedLoading = false;
    if (state.session === session && session.current === questionIndex) renderRelatedPractice(question, response);
  }
}

function handleRelatedResultsClick(event) {
  const action = event.target.closest('[data-related-option],[data-related-submit],[data-related-favorite]');
  const session = state.session;
  if (!action || !session) return;
  const question = session.questions[session.current];
  const response = session.responses[session.current];
  const relatedId = String(action.dataset.relatedId || action.dataset.relatedSubmit || action.dataset.relatedFavorite || '');
  const relatedQuestion = relatedQuestionById(response, relatedId);
  if (!relatedQuestion) return;
  if (action.dataset.relatedFavorite) {
    toggleRelatedQuestionFavorite(relatedQuestion, question);
    renderRelatedPractice(question, response);
    return;
  }
  if (response.relatedSubmitted[relatedId]) return;
  if (action.dataset.relatedOption) {
    const key = String(action.dataset.relatedOption);
    const selected = Array.isArray(response.relatedSelections[relatedId]) ? response.relatedSelections[relatedId] : [];
    response.relatedSelections[relatedId] = relatedQuestion.type === 'multi'
      ? (selected.includes(key) ? selected.filter((answer) => answer !== key) : [...selected, key])
      : [key];
  } else {
    const selected = response.relatedSelections[relatedId] || [];
    if (!selected.length) return;
    response.relatedSubmitted[relatedId] = true;
    const correct = sameAnswers([...selected].sort(), [...relatedQuestion.answer].sort());
    if (!correct && relatedQuestion.source === 'bank') {
      wrongSet.add(relatedQuestion.id);
      saveProgress();
      updateGlobalCounts();
    }
  }
  renderRelatedPractice(question, response);
}

function skipCurrentQuestionExplanation() {
  const session = state.session;
  if (!session) return;
  const response = session.responses[session.current];
  if (!response?.submitted || response.aiLoading) return;
  response.aiSkipped = true;
  renderCurrentQuestion();
}

function clearAutoNextTimer(session = state.session) {
  if (!session?.autoNextTimer) return;
  window.clearTimeout(session.autoNextTimer);
  session.autoNextTimer = null;
}

function scheduleAutoNext(session, questionIndex) {
  clearAutoNextTimer(session);
  const response = session?.responses?.[questionIndex];
  if (!state.autoNextCorrect || !response?.submitted || !response.correct) return;
  session.autoNextTimer = window.setTimeout(() => {
    session.autoNextTimer = null;
    if (state.session !== session || session.current !== questionIndex || !state.autoNextCorrect) return;
    nextQuestion();
  }, AUTO_NEXT_DELAY_MS);
}

function resetQuestionCardOnMobile() {
  if (!window.matchMedia('(max-width: 720px)').matches) return;
  window.requestAnimationFrame(() => {
    const card = document.querySelector('#view-practice .quiz-card');
    if (!card) return;
    card.scrollTo({ top: 0, behavior: 'auto' });
  });
}

function nextQuestion() {
  const session = state.session;
  clearAutoNextTimer(session);
  if (session.current >= session.questions.length - 1) { renderResult(); return; }
  session.current += 1;
  $('tutor-input').value = '';
  renderCurrentQuestion();
  savePracticeBookmark(session);
  resetQuestionCardOnMobile();
}

function previousQuestion() {
  clearAutoNextTimer();
  if (state.session.current > 0) {
    state.session.current -= 1;
    $('tutor-input').value = '';
    renderCurrentQuestion();
    savePracticeBookmark(state.session);
    resetQuestionCardOnMobile();
  }
}

function renderResult() {
  const session = state.session;
  const graded = session.responses.filter((response) => response.submitted && response.hasAnswer);
  const correct = graded.filter((response) => response.correct).length;
  const accuracy = graded.length ? Math.round(correct / graded.length * 100) : 0;
  const wrongItems = getSessionWrongItems(session);
  clearPracticeBookmark();
  showView('view-result');
  $('result-total').textContent = session.questions.length;
  $('result-correct').textContent = correct;
  $('result-accuracy').textContent = `${accuracy}%`;
  $('result-subtitle').textContent = `${session.bankName} · ${session.modeLabel}，本次答错 ${wrongItems.length} 道。`;
  renderResultAnalyses(session, wrongItems);
  $('result-bank-button').onclick = () => navigate(session.bankId === 'all' ? '#/banks' : `#/bank/${encodeURIComponent(session.bankId)}`);
  $('result-again-button').onclick = () => beginSession({ ...state.lastSpec }, 'repeat');
}

function getSessionWrongItems(session) {
  return session.questions.map((question, index) => ({ question, response: session.responses[index], index }))
    .filter(({ response }) => response.submitted && response.hasAnswer && !response.correct);
}

function renderResultAnalyses(session, wrongItems = getSessionWrongItems(session)) {
  const prompt = $('result-ai-prompt');
  const status = $('result-ai-status');
  const list = $('result-ai-list');
  const generateButton = $('result-ai-generate');
  const skipButton = $('result-ai-skip');
  generateButton.disabled = Boolean(session.aiAnalysisLoading);
  skipButton.disabled = Boolean(session.aiAnalysisLoading);
  status.className = `result-ai-status${session.aiAnalysisError ? ' error' : ''}`;
  list.innerHTML = '';

  if (!wrongItems.length) {
    prompt.hidden = false;
    $('result-ai-title').textContent = '全部作答正确，无需生成错题解析。';
    generateButton.hidden = true;
    skipButton.hidden = true;
    status.hidden = true;
    return;
  }

  generateButton.hidden = false;
  skipButton.hidden = false;
  $('result-ai-title').textContent = `需要解析这 ${wrongItems.length} 道错题吗？`;

  const visibleAnalyses = (Array.isArray(session.aiAnalyses) ? session.aiAnalyses : [])
    .filter((analysis) => String(analysis?.explanation || '').trim());
  if (session.aiAnalysisLoading || visibleAnalyses.length) {
    prompt.hidden = true;
    status.hidden = false;
    const completedCount = Array.isArray(session.aiAnalysisCompletedIds) ? session.aiAnalysisCompletedIds.length : visibleAnalyses.length;
    status.textContent = session.aiAnalysisLoading
      ? `正在实时生成错题解析，已完成 ${completedCount} / ${wrongItems.length} 道…`
      : `已生成 ${visibleAnalyses.length} 道错题解析。`;
    const wrongById = new Map(wrongItems.map((item) => [String(item.question.id), item]));
    list.innerHTML = visibleAnalyses.map((analysis, index) => {
      const item = wrongById.get(String(analysis.sourceId));
      if (!item) return '';
      return `<article class="result-ai-item">
        <div class="result-ai-item-top"><span>错题 ${String(index + 1).padStart(2, '0')}</span><span>你的答案：${escapeHtml(item.response.selected.join('、'))}</span><span>正确答案：${escapeHtml(item.question.displayAnswers.join('、'))}</span></div>
        <h2>${escapeHtml(item.question.prompt)}</h2>
        <div class="result-ai-explanation markdown-body">${markdownHtml(analysis.explanation)}</div>
      </article>`;
    }).join('');
    return;
  }

  if (session.aiAnalysisError) {
    prompt.hidden = false;
    status.hidden = false;
    status.textContent = session.aiAnalysisError;
    return;
  }

  if (session.aiAnalysisSkipped) {
    prompt.hidden = true;
    status.hidden = false;
    status.textContent = '已按你的选择跳过解析。';
    return;
  }

  prompt.hidden = false;
  status.hidden = !session.aiAnalysisLoading;
  if (session.aiAnalysisLoading) status.textContent = `正在生成 ${wrongItems.length} 道错题解析，请稍候…`;
}

async function generateResultAnalyses() {
  const session = state.session;
  if (!session || session.aiAnalysisLoading) return;
  const wrongItems = getSessionWrongItems(session);
  if (!wrongItems.length) return;
  session.aiAnalysisLoading = true;
  session.aiAnalysisSkipped = false;
  session.aiAnalysisError = '';
  renderResultAnalyses(session, wrongItems);
  try {
    const questions = wrongItems.map(({ question, response }) => ({
      sourceId: question.id,
      prompt: question.prompt,
      options: question.displayOptions.map(([key, text]) => ({ key, text })),
      answer: question.displayAnswers,
      userAnswer: response.selected
    }));
    session.aiAnalyses = questions.map((question) => ({ sourceId: question.sourceId, explanation: '' }));
    session.aiAnalysisCompletedIds = [];
    let renderPending = false;
    const scheduleStreamRender = () => {
      if (renderPending) return;
      renderPending = true;
      window.requestAnimationFrame(() => {
        renderPending = false;
        if (state.session === session) renderResultAnalyses(session, wrongItems);
      });
    };
    const response = await fetch(`${API_BASE}/api/explanations/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questions })
    });
    await consumeEventStream(response, {
      delta: (payload) => {
        if (!payload?.delta) return;
        const analysis = session.aiAnalyses.find((item) => String(item.sourceId) === String(payload.sourceId));
        if (!analysis) return;
        analysis.explanation += String(payload.delta);
        scheduleStreamRender();
      },
      item_done: (payload) => {
        const sourceId = String(payload?.sourceId || '');
        if (sourceId && !session.aiAnalysisCompletedIds.includes(sourceId)) session.aiAnalysisCompletedIds.push(sourceId);
        scheduleStreamRender();
      }
    });
    session.aiAnalyses.forEach((analysis) => { analysis.explanation = String(analysis.explanation || '').trim(); });
    if (session.aiAnalyses.length !== wrongItems.length || session.aiAnalyses.some((analysis) => !analysis.explanation)) {
      throw new Error('解析结果数量不完整，请重试');
    }
  } catch (error) {
    session.aiAnalyses = [];
    session.aiAnalysisCompletedIds = [];
    session.aiAnalysisError = error.message || '生成解析失败，请稍后重试。';
  } finally {
    session.aiAnalysisLoading = false;
    if (state.session === session) renderResultAnalyses(session, wrongItems);
  }
}

function jumpToQuestion(event) {
  event.preventDefault();
  const session = state.session;
  const input = $('question-jump-input');
  if (!session || !input) return;
  const targetNumber = Number(input.value);
  if (!input.value.trim() || !Number.isInteger(targetNumber) || targetNumber < 1 || targetNumber > session.questions.length) {
    input.setCustomValidity(`请输入 1 到 ${session.questions.length} 之间的整数题号`);
    input.reportValidity();
    return;
  }
  input.setCustomValidity('');
  clearAutoNextTimer(session);
  session.current = targetNumber - 1;
  $('tutor-input').value = '';
  renderCurrentQuestion();
  savePracticeBookmark(session);
  resetQuestionCardOnMobile();
}

function skipResultAnalyses() {
  if (!state.session || state.session.aiAnalysisLoading) return;
  state.session.aiAnalysisError = '';
  state.session.aiAnalysisSkipped = true;
  renderResultAnalyses(state.session);
}

function renderRoute() {
  const parts = routeParts();
  if (!parts.length || parts[0] === 'banks') { renderLibrary(); return; }
  if (parts[0] === 'bank') {
    const bank = getBank(parts[1]);
    if (!bank) { navigate('#/banks'); return; }
    if (parts[2] === 'wrongbook') { renderWrongbook(bank); return; }
    if (parts[2] === 'favorites') { renderWrongbook(bank, 'favorites'); return; }
    if (parts[2] === 'mock') { renderMock(bank); return; }
    if (parts[2] === 'practice' && MODE_CONFIG[parts[3]]) {
      const routeKey = location.hash;
      if (!state.session || state.session.routeKey !== routeKey) {
        if (parts[3] === 'mock') {
          if (!state.mockConfig || state.mockConfig.bankId !== bank.id) { navigate(`#/bank/${encodeURIComponent(bank.id)}/mock`); return; }
          beginSession({ bankId: bank.id, mode: 'mock', singleCount: state.mockConfig.singleCount, multiCount: state.mockConfig.multiCount }, routeKey);
        } else {
          const optionOrder = parts[4];
          const shuffleOptions = optionOrder === 'shuffle' ? true : optionOrder === 'fixed' ? false : undefined;
          beginSession({ bankId: bank.id, mode: parts[3], ...(typeof shuffleOptions === 'boolean' ? { shuffleOptions } : {}) }, routeKey);
        }
      } else renderCurrentQuestion();
      return;
    }
    renderBank(bank);
    return;
  }
  if (parts[0] === 'wrongbook') { renderWrongbook(); return; }
  if (parts[0] === 'practice' && parts[1] === 'all' && ['wrong', 'favorite'].includes(parts[2])) {
    const routeKey = location.hash;
    if (!state.session || state.session.routeKey !== routeKey) beginSession({ bankId: 'all', mode: parts[2] }, routeKey); else renderCurrentQuestion();
    return;
  }
  navigate('#/banks');
}

function showImportPanel() {
  navigate('#/banks');
  $('import-panel').hidden = false;
  setTimeout(() => $('import-panel').scrollIntoView({ behavior: 'smooth', block: 'center' }), 20);
}

function showImportStatus(message, error = false) {
  $('import-status').textContent = message;
  $('import-status').className = `import-status${error ? ' error' : ''}`;
}

const IMPORT_FILE_PATTERN = /\.(?:docx?|pdf|png|jpe?g|webp|bmp|tiff?|txt|md|csv|html?|odt|xlsx|pptx)$/i;
const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;

async function importQuestionFile(file) {
  if (!file) return;
  if (!IMPORT_FILE_PATTERN.test(file.name)) {
    showImportStatus('暂不支持该格式，请选择 Word、PDF、图片、文本、XLSX 或 PPTX 文件。', true);
    return;
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    showImportStatus('单个文件不能超过 25 MB。', true);
    return;
  }
  const useAI = $('ai-recognition').checked;
  showImportStatus(useAI ? `正在提取并精确识别 ${file.name}，PDF 或图片可能需要几分钟…` : `正在本地提取并拆分 ${file.name}，请稍候…`);
  const form = new FormData();
  form.append('file', file);
  form.append('use_ai', useAI ? '1' : '0');
  $('question-file').disabled = true;
  $('ai-recognition').disabled = true;
  $('local-recognition').disabled = true;
  try {
    const response = await fetch(`${API_BASE}/api/import`, { method: 'POST', body: form });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '导入失败');
    const bank = normaliseBank({ ...(result.bank || {}), name: result.bank?.name || file.name.replace(/\.[^.]+$/, ''), filename: file.name, questions: result.questions });
    const existing = importedBanks.findIndex((item) => item.filename === bank.filename);
    if (existing >= 0) {
      purgeBankState(importedBanks[existing]);
      importedBanks.splice(existing, 1, bank);
      saveProgress();
    } else importedBanks.push(bank);
    saveBanks();
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    const warningText = warnings.length ? `；发现 ${warnings.length} 条格式提醒：${warnings.slice(0, 2).join('；')}${warnings.length > 2 ? '…' : ''}` : '';
    const aiText = result.ai?.used ? `；精确校对完成${result.ai.inferredAnswerCount ? `，推断 ${result.ai.inferredAnswerCount} 道缺失答案` : ''}` : '；普通识别完成';
    const extraction = result.extraction || {};
    const extractionText = extraction.ocrUsed ? `；本地 OCR ${extraction.ocrPageCount || 1} 页` : '';
    showImportStatus(`导入完成：${bank.questionCount} 题，单选 ${bank.singleCount}，多选 ${bank.multiCount}${extractionText}${aiText}${warningText}`);
    setTimeout(() => navigate(`#/bank/${encodeURIComponent(bank.id)}`), 700);
  } catch (error) {
    showImportStatus(error.message || '导入失败，请检查文件内容和格式。', true);
  } finally {
    $('question-file').disabled = false;
    $('question-file').value = '';
    $('ai-recognition').disabled = false;
    $('local-recognition').disabled = false;
  }
}

document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.nav)));
$('hero-import-button').addEventListener('click', showImportPanel);
$('close-import').addEventListener('click', () => { $('import-panel').hidden = true; });
$('question-file').addEventListener('change', (event) => importQuestionFile(event.target.files[0]));
$('bank-search').addEventListener('input', renderLibrary);
$('global-wrong-button').addEventListener('click', () => navigate('#/wrongbook'));
$('mock-single-count').addEventListener('input', updateMockTotal);
$('mock-multi-count').addEventListener('input', updateMockTotal);
$('mock-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const bank = getBank(state.activeBankId);
  if (!bank) return;
  const singleAvailable = bank.questions.filter((question) => question.type === 'single').length;
  const multiAvailable = bank.questions.filter((question) => question.type === 'multi').length;
  const singleCount = Math.max(0, Number($('mock-single-count').value || 0));
  const multiCount = Math.max(0, Number($('mock-multi-count').value || 0));
  let error = '';
  if (!Number.isInteger(singleCount) || !Number.isInteger(multiCount)) error = '题目数量必须是整数。';
  else if (singleCount > singleAvailable || multiCount > multiAvailable) error = '选择数量不能超过题库中的可用题目。';
  else if (singleCount + multiCount === 0) error = '请至少选择 1 道题。';
  if (error) { $('mock-error').textContent = error; $('mock-error').hidden = false; return; }
  state.mockConfig = { bankId: bank.id, singleCount, multiCount };
  state.session = null;
  navigate(`#/bank/${encodeURIComponent(bank.id)}/practice/mock`);
});
$('submit-button').addEventListener('click', submitCurrentAnswer);
$('auto-next-correct').addEventListener('change', (event) => {
  state.autoNextCorrect = event.currentTarget.checked;
  saveBooleanPreference(AUTO_NEXT_CORRECT_KEY, state.autoNextCorrect);
  markProfileChanged();
  if (!state.autoNextCorrect) clearAutoNextTimer();
});
$('question-ai-generate').addEventListener('click', generateCurrentQuestionExplanation);
$('question-ai-skip').addEventListener('click', skipCurrentQuestionExplanation);
$('tutor-form').addEventListener('submit', submitQuestionFollowup);
$('tutor-input').addEventListener('keydown', handleTutorInputKeydown);
$('related-generate').addEventListener('click', generateRelatedQuestions);
$('related-results').addEventListener('click', handleRelatedResultsClick);
$('next-button').addEventListener('click', nextQuestion);
$('previous-button').addEventListener('click', previousQuestion);
$('question-jump-form').addEventListener('submit', jumpToQuestion);
$('question-jump-input').addEventListener('input', (event) => event.currentTarget.setCustomValidity(''));
$('question-jump-input').addEventListener('focus', (event) => event.currentTarget.select());
$('result-ai-generate').addEventListener('click', generateResultAnalyses);
$('result-ai-skip').addEventListener('click', skipResultAnalyses);
window.addEventListener('hashchange', renderRoute);
window.addEventListener('online', () => {
  if (state.cloud.ready) flushCloudState();
  else initialiseProfileState();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && state.cloud.ready && localStateIsDirty()) flushCloudState();
});

async function bootstrapApplication() {
  await initialiseProfileState();
  updateGlobalCounts();
  if (!location.hash) location.hash = '#/banks'; else renderRoute();
}

bootstrapApplication();
