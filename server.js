const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const rooms = new Map();
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']]
]);
const normalize = word => word.trim().toLowerCase();
const player = name => ({ id: crypto.randomUUID(), name: String(name || '').trim().slice(0, 12) || '玩家' });
const fail = (status, message) => Object.assign(new Error(message), { status });
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 8192) throw fail(413, '请求过大');
  }
  try {
    const value = JSON.parse(text || '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object') throw Error();
    return value;
  } catch { throw fail(400, '请求格式不正确'); }
}
function reset(room) {
  room.gameId = crypto.randomUUID();
  room.round = 1;
  room.phase = room.players.length === 2 ? 'playing' : 'waiting';
  room.answers = {};
  room.ready = [];
  room.history = [];
}
function view(room, id) {
  return {
    code: room.code, gameId: room.gameId, revision: room.revision,
    you: room.players.findIndex(p => p.id === id),
    players: room.players.map(p => ({ name: p.name, submitted: Boolean(room.answers[p.id]), ready: room.ready.includes(p.id) })),
    phase: room.phase, round: room.round, history: room.history,
    ownAnswer: room.answers[id] || ''
  };
}
function changed(room) { room.revision++; room.updated = Date.now(); }
const cleanup = setInterval(() => {
  for (const [code, room] of rooms) if (Date.now() - room.updated > 6 * 60 * 60 * 1000) rooms.delete(code);
}, 60_000);
cleanup.unref();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && assets.has(url.pathname)) {
      const [file, type] = assets.get(url.pathname);
      const content = await fs.promises.readFile(path.join(__dirname, 'public', file));
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return res.end(content);
    }
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const data = await body(req);
      if (rooms.size >= 5000) throw fail(503, '房间较多，请稍后再试');
      let code;
      do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
      const owner = player(data.name);
      const room = { code, players: [owner], revision: 0, updated: Date.now() };
      reset(room); rooms.set(code, room);
      return json(res, 201, { playerId: owner.id, state: view(room, owner.id) });
    }
    const match = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})(?:\/(join|answer|next|restart))?$/);
    if (!match) throw fail(404, '找不到这个页面');
    // Read before checking mutable room state: concurrent requests must see the latest state.
    const data = req.method === 'POST' ? await body(req) : {};
    const room = rooms.get(match[1]);
    if (!room) throw fail(404, '房间不存在或已过期，请重新创建房间');
    const action = match[2];
    if (req.method === 'POST' && action === 'join') {
      if (room.players.length >= 2) throw fail(409, '房间已满；原玩家请使用原浏览器返回');
      const guest = player(data.name);
      room.players.push(guest); room.phase = 'playing'; changed(room);
      return json(res, 201, { playerId: guest.id, state: view(room, guest.id) });
    }
    const id = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!room.players.some(p => p.id === id)) throw fail(403, '玩家身份失效，请重新加入房间');
    room.updated = Date.now();
    if (req.method === 'GET' && !action) return json(res, 200, view(room, id));
    if (req.method !== 'POST' || !action) throw fail(405, '不支持这个操作');
    if (data.gameId !== room.gameId || data.round !== room.round) throw fail(409, '本轮已更新，请稍后重试');
    if (action === 'answer') {
      if (room.phase !== 'playing') throw fail(409, '当前不能提交词语');
      if (room.answers[id]) throw fail(409, '已经锁定，不能更改本轮词语');
      const word = typeof data.answer === 'string' ? data.answer.trim() : '';
      if (!word || word.length > 24 || /[\u0000-\u001f\u007f]/.test(word)) throw fail(400, '请输入 1～24 个字符的词语');
      room.answers[id] = word;
      if (room.players.every(p => room.answers[p.id])) {
        const words = room.players.map(p => room.answers[p.id]);
        const matched = normalize(words[0]) === normalize(words[1]);
        room.history.push({ round: room.round, words, matched });
        room.phase = matched ? 'finished' : 'reveal';
        room.ready = [];
      }
    } else if (action === 'next' || action === 'restart') {
      const expected = action === 'next' ? 'reveal' : 'finished';
      if (room.phase !== expected) throw fail(409, '当前不能执行这个操作');
      if (!room.ready.includes(id)) room.ready.push(id);
      if (room.ready.length === 2) {
        if (action === 'restart') reset(room);
        else { room.round++; room.phase = 'playing'; room.answers = {}; room.ready = []; }
      }
    }
    changed(room);
    return json(res, 200, view(room, id));
  } catch (error) {
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '服务暂时出错，请稍后重试' });
  }
});

if (require.main === module) {
  server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log(`同词相遇：http://localhost:${server.address().port}`));
}
module.exports = { server };
