'use strict';
// Server minimale Agar-style: serve il client (./public) e il gioco via WebSocket sulla stessa porta.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const W = 6000, H = 6000, FOOD_MAX = 700, TICK = 40, DT = TICK / 1000;
const START_MASS = 10, MIN_SPLIT = 35, MAX_CELLS = 16;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'game.html';
  const f = path.join(PUB, path.normalize(p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(d);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 2048 });

let nextId = 1, foodCount = 0;
const cells = new Map();
const players = new Set();

const rad = m => Math.sqrt(m * 100);
const rnd = (a, b) => a + Math.random() * (b - a);
function randColor() {
  const h = Math.random() * 6, x = Math.round(255 * (1 - Math.abs(h % 2 - 1)));
  const v = [[255, x, 90], [x, 255, 90], [90, 255, x], [90, x, 255], [x, 90, 255], [255, 90, x]][Math.floor(h)];
  return v;
}
function mkCell(o) {
  const c = Object.assign({ id: nextId++, x: 0, y: 0, mass: 1, color: [255, 255, 255], type: 'food', owner: null, bx: 0, by: 0, mergeAt: 0 }, o);
  c.r = rad(c.mass);
  cells.set(c.id, c);
  if (c.type === 'food') foodCount++;
  return c;
}
function removeCell(c) {
  cells.delete(c.id);
  if (c.type === 'food') foodCount--;
  if (c.owner) { const i = c.owner.cells.indexOf(c); if (i >= 0) c.owner.cells.splice(i, 1); }
}

function send(p, buf) { if (p.ws.readyState === 1) p.ws.send(buf, { binary: true }); }
function putStr(b, o, s) { for (let i = 0; i < s.length; i++) { b.writeUInt16LE(s.charCodeAt(i), o); o += 2; } b.writeUInt16LE(0, o); return o + 2; }

function sendBorder(p) {
  const b = Buffer.alloc(33); b.writeUInt8(64, 0);
  b.writeDoubleLE(0, 1); b.writeDoubleLE(0, 9); b.writeDoubleLE(W, 17); b.writeDoubleLE(H, 25);
  send(p, b);
}
function sendAddNode(p, id) { const b = Buffer.alloc(5); b.writeUInt8(32, 0); b.writeUInt32LE(id, 1); send(p, b); }

function spawn(p, name) {
  if (p.cells.length) return;
  p.name = name.slice(0, 40);
  p.known.clear();
  send(p, Buffer.from([20]));
  const c = mkCell({ x: rnd(200, W - 200), y: rnd(200, H - 200), mass: START_MASS, type: 'player', owner: p, color: p.color });
  p.cells.push(c);
  sendAddNode(p, c.id);
}

wss.on('connection', ws => {
  const p = { ws, name: '', cells: [], mx: W / 2, my: H / 2, color: randColor(), known: new Set(), cx: W / 2, cy: H / 2, range: 1500 };
  players.add(p);
  sendBorder(p);
  ws.on('message', data => {
    const b = Buffer.from(data); if (!b.length) return;
    const op = b[0];
    if (op === 16 && b.length >= 17) {
      const x = b.readDoubleLE(1), y = b.readDoubleLE(9);
      if (isFinite(x) && isFinite(y)) { p.mx = x; p.my = y; }
    } else if (op === 192) {
      let s = ''; for (let i = 1; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16LE(i));
      spawn(p, s);
    } else if (op === 17) split(p);
    else if (op === 21) eject(p);
    else if (op === 206 && b.length > 2) {
      let s = ''; for (let i = 2; i + 1 < b.length && s.length < 200; i += 2) s += String.fromCharCode(b.readUInt16LE(i));
      chat(p, b[1], s);
    }
  });
  ws.on('close', () => { p.cells.slice().forEach(removeCell); players.delete(p); });
  ws.on('error', () => {});
});

function dirTo(p, c) {
  const dx = p.mx - c.x, dy = p.my - c.y, d = Math.hypot(dx, dy) || 1;
  return [dx / d, dy / d];
}
function split(p) {
  const now = Date.now();
  for (const c of p.cells.slice()) {
    if (p.cells.length >= MAX_CELLS) break;
    if (c.mass < MIN_SPLIT) continue;
    c.mass /= 2; c.r = rad(c.mass);
    const [dx, dy] = dirTo(p, c);
    const n = mkCell({ x: c.x, y: c.y, mass: c.mass, type: 'player', owner: p, color: p.color, bx: dx * 900, by: dy * 900 });
    c.mergeAt = n.mergeAt = now + 15000;
    p.cells.push(n);
    sendAddNode(p, n.id);
  }
}
function eject(p) {
  for (const c of p.cells) {
    if (c.mass < MIN_SPLIT) continue;
    c.mass -= 18; c.r = rad(c.mass);
    const [dx, dy] = dirTo(p, c);
    mkCell({ x: c.x + dx * c.r, y: c.y + dy * c.r, mass: 14, type: 'eject', color: p.color, bx: dx * 750, by: dy * 750 });
  }
}
function chat(p, flags, msg) {
  msg = msg.trim(); if (!msg) return;
  const name = p.name || 'UnnamedCell';
  const b = Buffer.alloc(5 + name.length * 2 + 2 + msg.length * 2 + 2);
  b.writeUInt8(99, 0); b.writeUInt8(flags & 1, 1);
  b[2] = p.color[0]; b[3] = p.color[1]; b[4] = p.color[2];
  let o = putStr(b, 5, name); putStr(b, o, msg);
  for (const q of players) send(q, b);
}

function tick() {
  const now = Date.now(), eaten = [];
  // movimento
  for (const c of cells.values()) {
    if (c.owner) {
      const p = c.owner, dx = p.mx - c.x, dy = p.my - c.y, d = Math.hypot(dx, dy);
      if (d > 1) {
        const sp = 600 * Math.pow(c.mass, -0.28) * Math.min(1, d / 50);
        c.x += dx / d * sp * DT; c.y += dy / d * sp * DT;
      }
      if (c.mass > 20) c.mass -= c.mass * 0.002 * DT;
    }
    if (c.bx || c.by) {
      c.x += c.bx * DT; c.y += c.by * DT;
      const f = Math.exp(-4 * DT); c.bx *= f; c.by *= f;
      if (Math.abs(c.bx) < 5 && Math.abs(c.by) < 5) c.bx = c.by = 0;
    }
    c.r = rad(c.mass);
  }
  // celle dello stesso giocatore: separazione / fusione
  for (const p of players) {
    const L = p.cells;
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      const a = L[i], b = L[j]; if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01, ov = a.r + b.r - d;
      if (ov <= 0) continue;
      if (now >= a.mergeAt && now >= b.mergeAt) {
        if (d < Math.max(a.r, b.r) * 0.6) {
          const big = a.mass >= b.mass ? a : b, small = big === a ? b : a;
          big.mass += small.mass; big.r = rad(big.mass);
          eaten.push([big.id, small.id]); removeCell(small); j = i;
        }
      } else {
        const k = ov / 2 / d; a.x -= dx * k; a.y -= dy * k; b.x += dx * k; b.y += dy * k;
      }
    }
  }
  // bordi
  for (const c of cells.values()) {
    c.x = Math.max(c.r, Math.min(W - c.r, c.x)); c.y = Math.max(c.r, Math.min(H - c.r, c.y));
  }
  // mangiare
  const all = Array.from(cells.values());
  for (const p of players) for (const c of p.cells.slice()) {
    if (!cells.has(c.id)) continue;
    for (const o of all) {
      if (o === c || !cells.has(o.id) || o.owner === p) continue;
      if (o.owner && c.mass <= o.mass * 1.25) continue;
      if (!o.owner && o.type === 'eject' && c.mass <= o.mass * 1.25) continue;
      if (Math.hypot(o.x - c.x, o.y - c.y) < c.r - o.r * 0.4) {
        c.mass += o.mass; c.r = rad(c.mass);
        eaten.push([c.id, o.id]); removeCell(o);
      }
    }
  }
  while (foodCount < FOOD_MAX) mkCell({ x: rnd(20, W - 20), y: rnd(20, H - 20), mass: 1, color: randColor() });
  for (const p of players) update(p, eaten);
  if (now - lastLB > 1000) { lastLB = now; leaderboard(); }
}
let lastLB = 0;

function update(p, eaten) {
  if (p.cells.length) {
    let sx = 0, sy = 0, sm = 0;
    for (const c of p.cells) { sx += c.x; sy += c.y; sm += c.mass; }
    p.cx = sx / p.cells.length; p.cy = sy / p.cells.length;
    p.range = Math.min(3500, 1200 + 2 * rad(sm));
  }
  const vis = [], visIds = new Set();
  for (const c of cells.values()) {
    if (Math.abs(c.x - p.cx) > p.range || Math.abs(c.y - p.cy) > p.range) continue;
    visIds.add(c.id);
    if (c.type !== 'food' || !p.known.has(c.id)) vis.push(c);
  }
  const ev = [], rem = [];
  for (const e of eaten) {
    if (!p.known.has(e[1])) continue;
    if (p.known.has(e[0])) ev.push(e); else rem.push(e[1]);
    p.known.delete(e[1]);
  }
  for (const id of p.known) if (!visIds.has(id)) rem.push(id);
  for (const id of rem) p.known.delete(id);
  for (const c of vis) p.known.add(c.id);
  if (!vis.length && !ev.length && !rem.length) return;

  let size = 1 + 2 + ev.length * 8 + 4 + 4 + rem.length * 4;
  for (const c of vis) size += 14 + 2 + (c.owner ? c.owner.name.length * 2 : 0);
  const b = Buffer.alloc(size); let o = 0;
  b.writeUInt8(16, o++); b.writeUInt16LE(ev.length, o); o += 2;
  for (const e of ev) { b.writeUInt32LE(e[0], o); b.writeUInt32LE(e[1], o + 4); o += 8; }
  for (const c of vis) {
    b.writeUInt32LE(c.id, o); o += 4;
    b.writeInt16LE(Math.round(c.x), o); b.writeInt16LE(Math.round(c.y), o + 2); b.writeInt16LE(Math.round(c.r), o + 4); o += 6;
    b[o++] = c.color[0]; b[o++] = c.color[1]; b[o++] = c.color[2]; b[o++] = 0;
    o = putStr(b, o, c.owner ? c.owner.name : '');
  }
  b.writeUInt32LE(0, o); o += 4;
  b.writeUInt32LE(rem.length, o); o += 4;
  for (const id of rem) { b.writeUInt32LE(id, o); o += 4; }
  send(p, b);
}

function leaderboard() {
  const list = [];
  for (const p of players) if (p.cells.length) list.push([p, p.cells.reduce((s, c) => s + c.mass, 0)]);
  list.sort((a, b) => b[1] - a[1]);
  const top = list.slice(0, 10);
  let size = 1 + 4; for (const [p] of top) size += 4 + p.name.length * 2 + 2;
  const b = Buffer.alloc(size); let o = 0;
  b.writeUInt8(49, o++); b.writeUInt32LE(top.length, o); o += 4;
  for (const [p] of top) { b.writeUInt32LE(p.cells[0].id, o); o += 4; o = putStr(b, o, p.name); }
  for (const p of players) send(p, b);
}

setInterval(tick, TICK);
server.listen(PORT, () => console.log('Server in ascolto sulla porta ' + PORT));
