const $ = id => document.getElementById(id);
let room = '', playerId = '', state = null, timer, busy = false, pollBusy = false, generation = 0, gameKey = '', historyKey = '';
const escapeHTML = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function stored(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
function remember(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
function draft(key, value) { try { if (value === undefined) return sessionStorage.getItem(key) || ''; sessionStorage.setItem(key, value); } catch {} return ''; }
function toast(message) { $('toast').textContent = message; $('toast').classList.remove('hidden'); setTimeout(() => $('toast').classList.add('hidden'), 2600); }
async function api(url, data, authenticated = true) {
  const response = await fetch(url, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${playerId}` } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(12000)
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(Error(result.error || '请求失败'), { status: response.status });
  return result;
}
function accept(next) {
  if (state && next.revision < state.revision) return;
  state = next; render();
}
function enter(data) {
  generation++; room = data.state.code; playerId = data.playerId;
  state = null; gameKey = ''; historyKey = '';
  remember(`sameword-player-${room}`, playerId); remember('sameword-name', $('name').value.trim());
  $('home').classList.add('hidden'); $('room').classList.remove('hidden'); $('roomError').textContent = '';
  history.replaceState({}, '', `?room=${room}`);
  accept(data.state); startPolling();
}
function home(message = '') {
  generation++; clearInterval(timer); room = ''; playerId = ''; state = null; gameKey = ''; historyKey = '';
  $('room').classList.add('hidden'); $('home').classList.remove('hidden'); $('homeError').textContent = message;
  history.replaceState({}, '', '/');
}
async function lobby(join) {
  if (busy) return;
  const code = $('roomCode').value.trim().toUpperCase();
  if (join && !/^[A-Z0-9]{6}$/.test(code)) { $('homeError').textContent = '请输入 6 位房间码'; return; }
  busy = true; $('create').disabled = $('join').disabled = true; $('homeError').textContent = '';
  try {
    const saved = join && stored(`sameword-player-${code}`);
    if (saved) {
      playerId = saved;
      try { const next = await api(`/api/rooms/${code}`); enter({ playerId: saved, state: next }); return; }
      catch (error) { if (![403, 404].includes(error.status)) throw error; }
    }
    enter(await api(join ? `/api/rooms/${code}/join` : '/api/rooms', { name: $('name').value.trim() }, false));
  } catch (error) { $('homeError').textContent = error.message; }
  finally { busy = false; $('create').disabled = $('join').disabled = false; }
}
function startPolling() { clearInterval(timer); timer = setInterval(refresh, 1200); }
async function refresh() {
  if (!room || document.hidden || pollBusy) return;
  pollBusy = true; const current = generation;
  try {
    const next = await api(`/api/rooms/${room}`);
    if (current !== generation) return;
    accept(next); $('connection').textContent = '已连接 · 双方提交后同时揭晓';
  } catch (error) {
    if (current !== generation) return;
    if ([403, 404].includes(error.status)) home(error.message);
    else $('connection').textContent = '连接中断，正在自动重连…';
  } finally { pollBusy = false; }
}
function wordPair(entry) { return `<div class="words"><div class="word">${escapeHTML(entry.words[0])}</div><span class="symbol">${entry.matched ? '=' : '×'}</span><div class="word">${escapeHTML(entry.words[1])}</div></div>`; }
function render() {
  const me = state.players[state.you];
  $('codeLabel').textContent = room;
  $('connection').textContent = '已连接 · 双方提交后同时揭晓';
  $('roundPill').textContent = state.phase === 'waiting' ? '等待加入' : `第 ${state.round} 轮`;
  $('roomTitle').textContent = state.phase === 'finished' ? '你们的脑回路相遇了' : '同词相遇';
  $('players').innerHTML = [0, 1].map(i => {
    const p = state.players[i];
    const status = !p ? '等朋友加入' : state.phase === 'playing' ? (p.submitted ? '已锁定词语 ✓' : '正在想词…') : p.ready ? '已准备 ✓' : '已加入';
    return `<div class="player"><strong>${escapeHTML(p?.name || '等待朋友')}${i === state.you ? ' · 你' : ''}</strong><small>${status}</small></div>`;
  }).join('');
  // Polling must preserve the input DOM, including Chinese IME composition and caret position.
  const key = `${state.gameId}/${state.round}/${state.phase}/${me.submitted}/${me.ready}`;
  if (key !== gameKey) {
    gameKey = key;
    const game = $('game');
    if (state.phase === 'waiting') game.innerHTML = '<div class="prompt">房间准备好了<small>把邀请链接发给朋友，加入后自动开始。</small></div>';
    else if (state.phase === 'playing') {
      game.innerHTML = `<div class="prompt">${state.round === 1 ? '先各自写一个词' : '继续联想，再各自写一个词'}<small>${state.round === 1 ? '想到什么就写什么。' : '可以看看下面的历史，猜猜对方会想到什么。'}</small></div><form id="answerForm"><label for="answer">你的词语</label><input id="answer" maxlength="24" autocomplete="off" placeholder="写下一个词" ${me.submitted ? 'disabled' : ''}><button class="primary" id="submit" ${me.submitted ? 'disabled' : ''}>${me.submitted ? '已锁定，等待朋友…' : '锁定词语'}</button></form><p class="wait">${me.submitted ? '对方提交后会自动揭晓。' : '提交后本轮不可修改，想好再锁定。'}</p>`;
      const draftKey = `draft-${room}-${state.gameId}-${state.round}`;
      $('answer').value = me.submitted ? state.ownAnswer : draft(draftKey);
      $('answer').oninput = () => draft(draftKey, $('answer').value);
      let composing = false;
      $('answer').oncompositionstart = () => { composing = true; };
      $('answer').oncompositionend = () => { composing = false; };
      $('answerForm').onsubmit = event => { event.preventDefault(); if (!composing) action('answer'); };
    } else {
      const finished = state.phase === 'finished';
      game.innerHTML = `<div class="prompt ${finished ? 'success' : ''}">${finished ? `第 ${state.round} 轮，相遇成功！` : '还没相同，再想一个词吧'}<small>${finished ? '你们终于想到了同一个词。' : '两人都准备好后，开始下一轮。'}</small></div>${wordPair(state.history.at(-1))}<button id="continue" class="primary" ${me.ready ? 'disabled' : ''}>${me.ready ? '已准备，等朋友…' : finished ? '再玩一局' : '准备下一轮'}</button>`;
      $('continue').onclick = () => action(finished ? 'restart' : 'next');
    }
  }
  const nextHistoryKey = `${state.gameId}/${state.history.length}`;
  if (nextHistoryKey !== historyKey) {
    historyKey = nextHistoryKey;
    $('historySection').classList.toggle('hidden', !state.history.length);
    $('history').innerHTML = state.history.map(entry => `<div class="round-label">第 ${entry.round} 轮${entry.matched ? ' · 相遇成功' : ''}</div>${wordPair(entry)}`).join('');
  }
}
async function action(kind) {
  if (busy || !state) return;
  const answer = kind === 'answer' ? $('answer').value.trim() : undefined;
  if (kind === 'answer' && !answer) { toast('先写下一个词吧'); return; }
  busy = true; const current = generation;
  const button = $('submit') || $('continue'); if (button) button.disabled = true;
  $('roomError').textContent = '';
  try {
    const next = await api(`/api/rooms/${room}/${kind}`, { gameId: state.gameId, round: state.round, ...(answer ? { answer } : {}) });
    if (current === generation) accept(next);
  } catch (error) { if (current === generation) { $('roomError').textContent = error.message; await refresh(); } }
  finally { busy = false; if (button?.isConnected) button.disabled = false; }
}
$('create').onclick = () => lobby(false); $('join').onclick = () => lobby(true);
$('roomCode').onkeydown = event => { if (event.key === 'Enter') lobby(true); };
$('homeButton').onclick = () => home();
$('copy').onclick = async () => {
  const link = `${location.origin}/?room=${room}`;
  try { await navigator.clipboard.writeText(link); toast('邀请链接已复制'); }
  catch { window.prompt('复制邀请链接发给朋友', link); }
};
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
$('name').value = stored('sameword-name') || '';
const query = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
if (query) {
  $('roomCode').value = query;
  const id = stored(`sameword-player-${query}`);
  if (id) {
    room = query; playerId = id;
    $('home').classList.add('hidden'); $('room').classList.remove('hidden');
    startPolling(); refresh();
  }
}
