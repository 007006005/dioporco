'use strict';

/*
 * Server ZeroAgar per Railway (Express + WebSockets)
 * Serve i file statici dalla cartella ./public e gestisce il protocollo binario di gioco.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- Variabili d'ambiente (Login / Salvataggi)
const AUTH_SECRET  = process.env.AUTH_SECRET  || '';
const SERVER_KEY   = process.env.SERVER_KEY   || '';
const API_SAVE_URL = process.env.API_SAVE_URL || '';

// ---- Middleware & CORS
app.use(cors());

// Forzatura Header per manifest.json e file JSON
app.use((req, res, next) => {
    if (req.url.endsWith('.json')) {
        res.setHeader('Content-Type', 'application/json');
    }
    next();
});

// Servizio file statici da public/
app.use(express.static(PUBLIC_DIR, {
    setHeaders: (res, reqPath) => {
        if (reqPath.endsWith('.webp') || reqPath.endsWith('.png') || reqPath.endsWith('.svg') || reqPath.endsWith('.json')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000');
        }
    }
}));

// Endpoint Health Check per Railway
app.get('/health', (req, res) => res.status(200).send('OK'));

// Redirezioni e gestione percorsi del gioco
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'game.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'game.html')));
app.get('/games/agar', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'game.html')));
app.get('/games/agar/*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'game.html')));

// Fallback generale
app.get('*', (req, res) => {
    const requestedPath = path.join(PUBLIC_DIR, req.path);
    if (fs.existsSync(requestedPath) && fs.statSync(requestedPath).isFile()) {
        return res.sendFile(requestedPath);
    }
    res.sendFile(path.join(PUBLIC_DIR, 'game.html'));
});

// ---- Configurazione Mondo di Gioco
const CFG = {
    border: 14000,
    tickMs: 40,             // 25 tick/s
    foodMax: 800, foodSize: 10,
    virusMax: 15, virusSize: 100,
    startSize: 32, minSplitSize: 60, maxCells: 16,
    ejectSize: 36, ejectCostArea: 1600, minEjectSize: 57,
    maxSize: 1500,
    mergeBaseTicks: 375,   // ~15s
    viewHalfW: 1100, viewHalfH: 700,
    maxPlayers: 100,
};

let nextId = 1, tickCount = 0, foodCount = 0, virusCount = 0;
const cells = new Map();
const players = new Set();
let eatEvents = [];

const rnd = (a, b) => a + Math.random() * (b - a);
const randColor = () => {
    const h = Math.random() * 6, x = Math.floor(255 * (1 - Math.abs((h % 2) - 1)));
    const [r, g, b] = [[255, x, 0], [x, 255, 0], [0, 255, x], [0, x, 255], [x, 0, 255], [255, 0, x]][Math.floor(h) % 6];
    return [r, g, b];
};

function addCell(type, x, y, size, color, owner) {
    const c = { id: nextId++, type, x, y, size, color, owner: owner || null,
                bx: 0, by: 0, bs: 0, born: tickCount, mergeAt: 0, feeds: 0, dead: false };
    if (nextId > 0xfffffff0) nextId = 1;
    cells.set(c.id, c);
    if (type === 'food') foodCount++;
    if (type === 'virus') virusCount++;
    return c;
}

function removeCell(c) {
    if (c.dead) return;
    c.dead = true;
    cells.delete(c.id);
    if (c.type === 'food') foodCount--;
    if (c.type === 'virus') virusCount--;
    if (c.type === 'player' && c.owner) {
        const i = c.owner.cells.indexOf(c);
        if (i >= 0) c.owner.cells.splice(i, 1);
    }
}

const mergeDelay = (size) => CFG.mergeBaseTicks + Math.floor(size * size / 100 * 0.5);

function newPlayerCell(p, x, y, size) {
    const c = addCell('player', x, y, size, p.color, p);
    c.mergeAt = tickCount + mergeDelay(size);
    p.cells.push(c);
    send32(p, c.id);
    return c;
}

// ---- Utility Binarie WebSocket
const strBytes = (s) => (s.length + 1) * 2;
function putStr(buf, off, s) {
    for (let i = 0; i < s.length; i++) buf.writeUInt16LE(s.charCodeAt(i), off + 2 * i);
    buf.writeUInt16LE(0, off + 2 * s.length);
    return off + strBytes(s);
}

function sendRaw(p, buf) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(buf, { binary: true });
}

function sendBorder(p) {
    const b = Buffer.alloc(33);
    b[0] = 64;
    b.writeDoubleLE(0, 1); b.writeDoubleLE(0, 9);
    b.writeDoubleLE(CFG.border, 17); b.writeDoubleLE(CFG.border, 25);
    sendRaw(p, b);
}

function send32(p, id) {
    const b = Buffer.alloc(5); b[0] = 32; b.writeUInt32LE(id, 1); sendRaw(p, b);
}

function sendChatMsg(p, name, color, text) {
    const b = Buffer.alloc(5 + strBytes(name) + strBytes(text));
    b[0] = 99; b[1] = 0; b[2] = color[0]; b[3] = color[1]; b[4] = color[2];
    let o = putStr(b, 5, name); putStr(b, o, text);
    sendRaw(p, b);
}

function totalArea(p) { 
    return p.cells.reduce((s, c) => s + c.size * c.size, 0); 
}

// ---- Logica Giocatore
function spawnPlayer(p, name) {
    if (p.cells.length) return;
    p.name = name; p.alive = true; p.spectate = false;
    const x = rnd(500, CFG.border - 500);
    const y = rnd(500, CFG.border - 500);
    p.mouseX = x; p.mouseY = y;
    newPlayerCell(p, x, y, CFG.startSize);
}

function split(p) {
    const n0 = p.cells.length;
    for (let i = 0; i < n0; i++) {
        if (p.cells.length >= CFG.maxCells) break;
        const c = p.cells[i];
        if (!c || c.size < CFG.minSplitSize) continue;
        let dx = p.mouseX - c.x, dy = p.mouseY - c.y;
        const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
        const s = Math.sqrt(c.size * c.size / 2);
        c.size = s; c.mergeAt = tickCount + mergeDelay(s);
        const nc = newPlayerCell(p, c.x, c.y, s);
        nc.bx = dx; nc.by = dy; nc.bs = 40;
    }
}

function eject(p) {
    for (const c of p.cells.slice()) {
        if (c.size < CFG.minEjectSize) continue;
        let dx = p.mouseX - c.x, dy = p.mouseY - c.y;
        const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
        c.size = Math.sqrt(Math.max(1, c.size * c.size - CFG.ejectCostArea));
        const e = addCell('eject', c.x + dx * c.size, c.y + dy * c.size, CFG.ejectSize, c.color, p);
        e.bx = dx; e.by = dy; e.bs = 36;
    }
}

function popCell(p, c, virus) {
    removeCell(virus);
    const total = Math.min(c.size * c.size + virus.size * virus.size, CFG.maxSize * CFG.maxSize);
    const extra = Math.min(CFG.maxCells - p.cells.length, 7);
    if (extra <= 0) { c.size = Math.sqrt(total); return; }
    const ps = Math.sqrt(total / (extra + 1));
    c.size = ps; c.mergeAt = tickCount + mergeDelay(ps);
    const a0 = Math.random() * Math.PI * 2;
    for (let i = 0; i < extra; i++) {
        const a = a0 + i * (Math.PI * 2 / extra);
        const nc = newPlayerCell(p, c.x, c.y, ps);
        nc.bx = Math.cos(a); nc.by = Math.sin(a); nc.bs = 36;
    }
}

function eatCell(eater, prey) {
    eater.size = Math.min(CFG.maxSize, Math.sqrt(eater.size * eater.size + prey.size * prey.size));
    eatEvents.push({ k: eater.id, v: prey.id });
    const owner = prey.type === 'player' ? prey.owner : null;
    removeCell(prey);
    if (owner && !owner.cells.length) {
        owner.alive = false;
    }
}

// ---- Loop Tick del Server
function tick() {
    tickCount++;
    eatEvents = [];
    const B = CFG.border;

    for (const c of cells.values()) {
        if (c.type === 'player') {
            const p = c.owner;
            const dx = p.mouseX - c.x, dy = p.mouseY - c.y;
            const d = Math.hypot(dx, dy);
            if (d > 1) {
                const sp = Math.min(d, 88 * Math.pow(c.size, -0.439));
                c.x += dx / d * sp; c.y += dy / d * sp;
            }
        }
        if (c.bs > 0.5) {
            c.x += c.bx * c.bs; c.y += c.by * c.bs;
            c.bs *= (c.type === 'eject' ? 0.88 : 0.9);
        } else c.bs = 0;
        
        const r = c.size / 2;
        c.x = Math.max(r, Math.min(B - r, c.x));
        c.y = Math.max(r, Math.min(B - r, c.y));
    }

    for (const p of players) {
        const cs = p.cells;
        for (let i = 0; i < cs.length; i++) {
            for (let j = i + 1; j < cs.length; j++) {
                const a = cs[i], b = cs[j];
                if (!a || !b || a.dead || b.dead) continue;
                const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.001;
                if (tickCount >= a.mergeAt && tickCount >= b.mergeAt) {
                    const big = a.size >= b.size ? a : b, small = big === a ? b : a;
                    if (d < big.size) { eatCell(big, small); j = i; }
                } else {
                    const ov = a.size + b.size - d;
                    if (ov > 0) {
                        const ma = a.size * a.size, mb = b.size * b.size, t = ma + mb;
                        const ux = dx / d, uy = dy / d;
                        a.x -= ux * ov * mb / t; a.y -= uy * ov * mb / t;
                        b.x += ux * ov * ma / t; b.y += uy * ov * ma / t;
                    }
                }
            }
        }
    }

    for (const p of players) {
        for (const c of p.cells.slice()) {
            if (c.dead) continue;
            for (const o of cells.values()) {
                if (o === c || o.dead || c.dead) continue;
                if (o.type === 'player' && o.owner === p) continue;
                if (o.type === 'eject' && o.owner === p && tickCount - o.born < 12) continue;
                const dx = o.x - c.x, dy = o.y - c.y;
                if (Math.abs(dx) > c.size || Math.abs(dy) > c.size) continue;
                const d = Math.hypot(dx, dy);
                if (o.type === 'food' || o.type === 'eject') {
                    if (c.size > o.size * 1.1 && d < c.size) eatCell(c, o);
                } else if (o.type === 'player') {
                    if (c.size > o.size * 1.15 && d < c.size - o.size * 0.4) eatCell(c, o);
                } else if (o.type === 'virus') {
                    if (c.size > o.size * 1.15 && d < c.size - o.size * 0.4) popCell(p, c, o);
                }
            }
        }
    }

    for (let i = 0; i < 6 && foodCount < CFG.foodMax; i++) {
        addCell('food', rnd(20, CFG.border - 20), rnd(20, CFG.border - 20), CFG.foodSize, randColor());
    }
    if (virusCount < CFG.virusMax && tickCount % 50 === 0) {
        addCell('virus', rnd(300, CFG.border - 300), rnd(300, CFG.border - 300), CFG.virusSize, [51, 255, 51]);
    }

// Costruzione pacchetto Classifica (Opcode 49) - Sempre 10 slot per evitare il crash client
    let lbBuf = null;
    if (tickCount % 25 === 0) {
        const top = Array.from(players)
            .filter(p => p.cells && p.cells.length > 0)
            .map(p => ({ p, a: totalArea(p) }))
            .sort((a, b) => b.a - a.a)
            .slice(0, 10);

        // Popola sempre 10 elementi (riempie con slot vuoti se ci sono meno di 10 giocatori)
        const lbItems = [];
        for (let i = 0; i < 10; i++) {
            if (i < top.length && top[i].p) {
                const p = top[i].p;
                const cellId = (p.cells && p.cells[0]) ? p.cells[0].id : 0;
                const name = p.name || 'Player';
                lbItems.push({ id: cellId, name });
            } else {
                lbItems.push({ id: 0, name: '' });
            }
        }

        let size = 5; 
        for (const item of lbItems) {
            size += 4 + strBytes(item.name);
        }

        lbBuf = Buffer.alloc(size); 
        lbBuf[0] = 49; 
        lbBuf.writeUInt32LE(lbItems.length, 1);
        let o = 5;
        for (const item of lbItems) { 
            lbBuf.writeUInt32LE(item.id, o); 
            o = putStr(lbBuf, o + 4, item.name); 
        }
    }

    let leader = null;
    for (const p of players) if (p.cells.length && (!leader || totalArea(p) > totalArea(leader))) leader = p;
    
    for (const p of players) {
        if (!p.ws || p.ws.readyState !== 1) continue;
        let cx = CFG.border / 2, cy = CFG.border / 2, total = 64;
        const ref = p.cells.length ? p : (p.spectate ? leader : null);
        if (ref && ref.cells.length) {
            cx = ref.cells.reduce((s, c) => s + c.x, 0) / ref.cells.length;
            cy = ref.cells.reduce((s, c) => s + c.size, 0) / ref.cells.length;
            total = ref.cells.reduce((s, c) => s + c.size, 0);
        }
        const scale = Math.pow(Math.min(64 / total, 1), 0.4);
        const hw = CFG.viewHalfW / scale, hh = CFG.viewHalfH / scale;
        
        if (!p.cells.length && p.spectate && ref && ref.cells.length) {
            const cam = Buffer.alloc(13); cam[0] = 17;
            cam.writeFloatLE(cx, 1); cam.writeFloatLE(cy, 5); cam.writeFloatLE(scale, 9);
            sendRaw(p, cam);
        }

        const vis = [];
        for (const c of cells.values()) {
            if (Math.abs(c.x - cx) < hw + c.size && Math.abs(c.y - cy) < hh + c.size) vis.push(c);
        }
        const now = new Set(vis.map(c => c.id));
        const evs = eatEvents.filter(e => p.visible.has(e.v));
        const removed = [];
        for (const id of p.visible) if (!now.has(id)) removed.push(id);
        for (const e of evs) if (!removed.includes(e.v)) removed.push(e.v);

        let size = 3 + evs.length * 8 + 4 + 4 + removed.length * 4;
        for (const c of vis) size += 14 + strBytes(c.type === 'player' ? c.owner.name : '');
        const b = Buffer.alloc(size);
        let o = 0;
        b[o++] = 16; b.writeUInt16LE(evs.length, o); o += 2;
        for (const e of evs) { b.writeUInt32LE(e.k, o); b.writeUInt32LE(e.v, o + 4); o += 8; }
        for (const c of vis) {
            b.writeUInt32LE(c.id, o); o += 4;
            b.writeInt16LE(Math.round(c.x), o); b.writeInt16LE(Math.round(c.y), o + 2);
            b.writeInt16LE(Math.round(c.size), o + 4); o += 6;
            b[o++] = c.color[0]; b[o++] = c.color[1]; b[o++] = c.color[2];
            b[o++] = c.type === 'virus' ? 1 : 0;
            o = putStr(b, o, c.type === 'player' ? c.owner.name : '');
        }
        b.writeUInt32LE(0, o); o += 4;
        b.writeUInt32LE(removed.length, o); o += 4;
        for (const id of removed) { b.writeUInt32LE(id, o); o += 4; }
        
        sendRaw(p, b);
        p.visible = now;
        if (lbBuf) sendRaw(p, lbBuf);
    }
}

// ---- Avvio WebSockets & Server HTTP
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 2048 });

wss.on('connection', (ws) => {
    if (players.size >= CFG.maxPlayers) return ws.close();
    
    const p = { 
        ws, cells: [], name: '', color: randColor(), 
        mouseX: 0, mouseY: 0, alive: false, spectate: false, 
        visible: new Set(), lastChat: 0 
    };
    players.add(p);
    
    sendBorder(p);

    ws.on('message', (data, isBinary) => {
        if (!isBinary || !data.length) return;
        const op = data[0];

        switch (op) {
            case 254:
            case 255:
                sendBorder(p);
                break;
            case 0:
            case 192: {
                let name = '';
                if (data.length > 1) {
                    name = data.toString('utf16le', 1).replace(/[\u0000-\u001f]/g, '').slice(0, 30);
                }
                spawnPlayer(p, name || 'ZeroPlayer');
                break;
            }
            case 1:
                if (!p.cells.length) p.spectate = true;
                break;
            case 16:
                if (data.length >= 13) {
                    const x = data.readDoubleLE(1);
                    const y = data.readDoubleLE(5);
                    if (Number.isFinite(x) && Number.isFinite(y)) { p.mouseX = x; p.mouseY = y; }
                } else if (data.length >= 9) {
                    const x = data.readInt16LE(1);
                    const y = data.readInt16LE(3);
                    if (Number.isFinite(x) && Number.isFinite(y)) { p.mouseX = x; p.mouseY = y; }
                }
                break;
            case 17:
                split(p);
                break;
            case 21:
                eject(p);
                break;
            case 99:
            case 206: {
                const text = data.toString('utf16le', 2).replace(/[\u0000-\u001f]/g, '').slice(0, 100);
                const now = Date.now();
                if (!text || now - p.lastChat < 1000 || !p.name) break;
                p.lastChat = now;
                for (const q of players) sendChatMsg(q, p.name, p.color, text);
                break;
            }
        }
    });

    ws.on('close', () => {
        for (const c of p.cells.slice()) removeCell(c);
        players.delete(p);
    });

    ws.on('error', () => {});
});

setInterval(tick, CFG.tickMs);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 ZeroAgar Server running on port ${PORT}`);
});
