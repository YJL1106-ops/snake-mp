import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const PUBLIC_DIR = path.resolve('./public');

// ===== Utils =====
const now = () => Date.now();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const randInt = (a, b) => (Math.random() * (b - a + 1) + a) | 0;
const makeCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += alphabet[(Math.random() * alphabet.length) | 0];
  return s;
};

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(data);
  }
}

// ===== Game constants =====
const GRID = 20;
const TICK_HZ = 20;
const TICK_MS = 1000 / TICK_HZ;
const ROUND_MS = 120_000;

// Movement speed (cells per second). You can tune this.
const BASE_CPS = 7.5;

// ===== Rooms =====
/** @type {Map<string, any>} */
const rooms = new Map();

function createRoom() {
  let code;
  do code = makeCode(); while (rooms.has(code));

  const room = {
    code,
    createdAt: now(),
    state: 'lobby', // lobby|running|ended
    startedAt: null,
    endsAt: null,
    tickHandle: null,

    food: null,
    tick: 0,
    cps: BASE_CPS,
    moveAcc: 0,

    players: new Map(), // id -> player
    inputs: new Map(),  // id -> {dir, seq}
  };

  rooms.set(code, room);
  return room;
}

function roomSnapshot(room) {
  return {
    code: room.code,
    state: room.state,
    startedAt: room.startedAt,
    endsAt: room.endsAt,
    grid: GRID,
    cps: room.cps,
    food: room.food,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      score: p.score,
      alive: p.alive,
      respawnAt: p.respawnAt,
      snake: p.snake,
      dir: p.dir,
      ackSeq: p.lastSeq || 0,
    }))
  };
}

function randomFreeCell(room) {
  const occ = new Set();
  for (const p of room.players.values()) {
    for (const s of p.snake) occ.add(s.x + ',' + s.y);
  }
  if (room.food) occ.add(room.food.x + ',' + room.food.y);

  const free = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const k = x + ',' + y;
      if (!occ.has(k)) free.push({ x, y });
    }
  }
  return free.length ? free[(Math.random() * free.length) | 0] : null;
}

function placeFood(room) {
  room.food = randomFreeCell(room);
}

function safeSpawn(room) {
  // try some spawn presets, then fallback random
  const presets = [
    { x: 3, y: 3, dx: 1, dy: 0 },
    { x: GRID - 4, y: 3, dx: -1, dy: 0 },
    { x: 3, y: GRID - 4, dx: 1, dy: 0 },
    { x: GRID - 4, y: GRID - 4, dx: -1, dy: 0 },
  ];

  for (const sp of presets) {
    const cells = [
      { x: sp.x - sp.dx * 2, y: sp.y - sp.dy * 2 },
      { x: sp.x - sp.dx, y: sp.y - sp.dy },
      { x: sp.x, y: sp.y },
    ];
    if (cells.every(c => c.x >= 0 && c.y >= 0 && c.x < GRID && c.y < GRID)) {
      const ok = cells.every(c => {
        for (const p of room.players.values()) {
          if (p.snake.some(s => s.x === c.x && s.y === c.y)) return false;
        }
        return true;
      });
      if (ok) return { snake: cells, dir: { x: sp.dx, y: sp.dy } };
    }
  }

  // random fallback: try a bunch of times
  for (let i = 0; i < 300; i++) {
    const head = randomFreeCell(room);
    if (!head) break;
    const dxdy = [
      { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }
    ][randInt(0, 3)];
    const cells = [
      { x: head.x - dxdy.x * 2, y: head.y - dxdy.y * 2 },
      { x: head.x - dxdy.x, y: head.y - dxdy.y },
      { x: head.x, y: head.y }
    ];
    if (cells.every(c => c.x >= 0 && c.y >= 0 && c.x < GRID && c.y < GRID)) {
      return { snake: cells, dir: dxdy };
    }
  }
  // worst case
  return { snake: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }], dir: { x: 1, y: 0 } };
}

function startRound(room) {
  if (room.state === 'running') return;
  room.state = 'running';
  room.startedAt = now();
  room.endsAt = room.startedAt + ROUND_MS;

  // reset players (keep score? here reset score per round)
  for (const p of room.players.values()) {
    const sp = safeSpawn(room);
    p.snake = sp.snake;
    p.dir = sp.dir;
    p.alive = true;
    p.respawnAt = null;
    p.score = 0;
  }

  placeFood(room);
  broadcast(room, { t: 'room', room: roomSnapshot(room) });

  room.tickHandle = setInterval(() => tick(room), TICK_MS);
}

function endRound(room) {
  if (room.state !== 'running') return;
  room.state = 'ended';
  if (room.tickHandle) clearInterval(room.tickHandle);
  room.tickHandle = null;

  broadcast(room, { t: 'ended', room: roomSnapshot(room) });
}

function killPlayer(room, p, reason = 'dead') {
  if (!p.alive) return;
  p.alive = false;
  p.respawnAt = now() + 2000;
  // keep snake on board as a corpse for this tick (optional). We'll shrink to 0 to avoid blocking.
  p.snake = [];
  broadcast(room, { t: 'death', id: p.id, reason, respawnAt: p.respawnAt });
}

function maybeRespawn(room, p) {
  if (p.alive) return;
  if (!p.respawnAt || now() < p.respawnAt) return;
  const sp = safeSpawn(room);
  p.snake = sp.snake;
  p.dir = sp.dir;
  p.alive = true;
  p.respawnAt = null;
  broadcast(room, { t: 'respawn', id: p.id, snake: p.snake, dir: p.dir });
}

function applyInput(p, inputDir) {
  if (!inputDir) return;
  const { x, y } = p.dir;
  // prevent reverse
  if (inputDir.x === -x && inputDir.y === -y) return;
  p.dir = inputDir;
}

function moveStep(room) {
  // compute next heads
  const next = [];
  for (const p of room.players.values()) {
    if (!p.alive || p.snake.length === 0) continue;
    const head = p.snake[p.snake.length - 1];
    next.push({ p, x: head.x + p.dir.x, y: head.y + p.dir.y });
  }

  // collision map of all bodies (current)
  const body = new Set();
  for (const p of room.players.values()) {
    for (const s of p.snake) body.add(s.x + ',' + s.y);
  }

  // resolve each move
  for (const m of next) {
    const { p } = m;

    // wall
    if (m.x < 0 || m.y < 0 || m.x >= GRID || m.y >= GRID) {
      killPlayer(room, p, 'wall');
      continue;
    }

    // body collision (including other snakes)
    if (body.has(m.x + ',' + m.y)) {
      killPlayer(room, p, 'body');
      continue;
    }

    // ok move
    p.snake.push({ x: m.x, y: m.y });

    const ate = room.food && m.x === room.food.x && m.y === room.food.y;
    if (ate) {
      p.score += 10;
      placeFood(room);
    } else {
      // move tail
      p.snake.shift();
    }
  }
}

function tick(room) {
  if (room.state !== 'running') return;

  room.tick++;
  const t = now();
  if (room.endsAt && t >= room.endsAt) {
    endRound(room);
    return;
  }

  // respawn
  for (const p of room.players.values()) maybeRespawn(room, p);

  // apply latest inputs
  for (const p of room.players.values()) {
    if (!p.alive) continue;
    const inp = room.inputs.get(p.id);
    if (inp?.dir) {
      applyInput(p, inp.dir);
      if (typeof inp.seq === 'number' && inp.seq > (p.lastSeq || 0)) p.lastSeq = inp.seq;
    }
  }

  // fixed movement speed independent from tick rate
  room.moveAcc += TICK_MS / 1000;
  const step = 1 / room.cps;
  // Avoid bursty multi-steps on lag spikes (bursts feel like "teleport"/missed turns)
  room.moveAcc = Math.min(room.moveAcc, step * 2);
  while (room.moveAcc >= step) {
    // Re-apply latest inputs before each logical move step.
    // This improves turn responsiveness when the server catches up (multiple steps in one tick).
    for (const p of room.players.values()) {
      if (!p.alive) continue;
      const inp = room.inputs.get(p.id);
      if (inp?.dir) {
        applyInput(p, inp.dir);
        if (typeof inp.seq === 'number' && inp.seq > (p.lastSeq || 0)) p.lastSeq = inp.seq;
      }
    }

    moveStep(room);
    room.moveAcc -= step;
  }

  // broadcast state
  const snapshot = {
    t: 'state',
    now: t,
    endsAt: room.endsAt,
    tick: room.tick,
    cps: room.cps,
    food: room.food,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      score: p.score,
      alive: p.alive,
      respawnAt: p.respawnAt,
      snake: p.snake,
      dir: p.dir,
      ackSeq: p.lastSeq || 0,
      color: p.color,
      name: p.name,
    }))
  };
  broadcast(room, snapshot);
}

// ===== HTTP static =====
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = url.pathname;
  if (filePath === '/') filePath = '/index.html';

  const abs = path.join(PUBLIC_DIR, filePath);
  if (!abs.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(abs);
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
      : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// ===== WS =====
const wss = new WebSocketServer({ server });
let nextId = 1;

wss.on('connection', (ws) => {
  const id = String(nextId++);
  ws._id = id;

  let joinedRoom = null;

  send(ws, { t: 'hello', id, grid: GRID, tickHz: TICK_HZ, roundMs: ROUND_MS, cps: BASE_CPS });

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); }
    catch { return; }

    if (msg.t === 'create') {
      const room = createRoom();
      joinedRoom = room;
      const player = {
        id,
        ws,
        name: String(msg.name || '玩家').slice(0, 16),
        color: String(msg.color || 'green'),
        score: 0,
        alive: true,
        respawnAt: null,
        snake: [],
        dir: { x: 1, y: 0 },
        lastSeq: 0,
      };
      room.players.set(id, player);
      const sp = safeSpawn(room);
      player.snake = sp.snake;
      player.dir = sp.dir;
      placeFood(room);

      send(ws, { t: 'joined', room: roomSnapshot(room), you: { id } });
      broadcast(room, { t: 'players', room: roomSnapshot(room) });
      return;
    }

    if (msg.t === 'join') {
      const code = String(msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'error', message: '房间不存在' });
      if (room.players.size >= 4) return send(ws, { t: 'error', message: '房间已满（最多4人）' });

      joinedRoom = room;
      const player = {
        id,
        ws,
        name: String(msg.name || '玩家').slice(0, 16),
        color: String(msg.color || 'green'),
        score: 0,
        alive: true,
        respawnAt: null,
        snake: [],
        dir: { x: 1, y: 0 },
        lastSeq: 0,
      };
      room.players.set(id, player);
      const sp = safeSpawn(room);
      player.snake = sp.snake;
      player.dir = sp.dir;
      if (!room.food) placeFood(room);

      send(ws, { t: 'joined', room: roomSnapshot(room), you: { id } });
      broadcast(room, { t: 'players', room: roomSnapshot(room) });
      return;
    }

    if (msg.t === 'start') {
      if (!joinedRoom) return;
      // anyone can start
      startRound(joinedRoom);
      return;
    }

    if (msg.t === 'ping') {
      // echo back for RTT measurement
      send(ws, { t: 'pong', ts: msg.ts });
      return;
    }

    if (msg.t === 'input') {
      if (!joinedRoom) return;
      // store last direction per player
      const dir = msg.dir;
      if (dir && typeof dir.x === 'number' && typeof dir.y === 'number') {
        const seq = typeof msg.seq === 'number' ? msg.seq : 0;
        joinedRoom.inputs.set(id, { dir: { x: clamp(dir.x, -1, 1), y: clamp(dir.y, -1, 1) }, seq });
        const p = joinedRoom.players.get(id);
        if (p && seq > (p.lastSeq || 0)) p.lastSeq = seq;
      }
      return;
    }
  });

  ws.on('close', () => {
    if (!joinedRoom) return;
    joinedRoom.inputs.delete(id);
    joinedRoom.players.delete(id);
    if (joinedRoom.players.size === 0) {
      if (joinedRoom.tickHandle) clearInterval(joinedRoom.tickHandle);
      rooms.delete(joinedRoom.code);
    } else {
      broadcast(joinedRoom, { t: 'players', room: roomSnapshot(joinedRoom) });
    }
  });
});

server.listen(PORT, () => {
  console.log(`[snake-mp] http://localhost:${PORT}`);
});
