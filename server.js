'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;

// أبعاد الملعب المطابقة تماماً للعميل
const W = 450;
const H = 800;
const PAD = 14;
const WALL_THICK = 7;
const GOAL_W = 166;
const GOAL_L = (W - GOAL_W) / 2;
const GOAL_R = (W + GOAL_W) / 2;
const BASE_MALLET_R = 38;
const PUCK_R = 18;

const THEMES = {
  classic: { tl: '#22ff44', tr: '#ff2222', bl: '#2277ff', br: '#ffee22', topMallet: '#15e628', botMallet: '#f21d1d', puckGlow: '#ffcb2b' },
  ice:     { tl: '#00f5ff', tr: '#a855f7', bl: '#3b82f6', br: '#38bdf8', topMallet: '#c084fc', botMallet: '#00e5ff', puckGlow: '#7dd3fc' },
  lava:    { tl: '#fb923c', tr: '#ef4444', bl: '#facc15', br: '#f97316', topMallet: '#facc15', botMallet: '#ff2e2e', puckGlow: '#ff7b00' },
  matrix:  { tl: '#22ff66', tr: '#00e5a0', bl: '#10b981', br: '#84cc16', topMallet: '#2dd4bf', botMallet: '#22ff44', puckGlow: '#a3e635' },
  royal:   { tl: '#f59e0b', tr: '#ec4899', bl: '#a855f7', br: '#facc15', topMallet: '#ec4899', botMallet: '#fbbf24', puckGlow: '#fde047' }
};

const PU_TYPES = [
  { type: 'giant',  color: '#22c55e', label: 'مضرب عملاق! 🛡️' },
  { type: 'shield', color: '#38bdf8', label: 'درع المرمى! 🧱' },
  { type: 'fire',   color: '#f97316', label: 'ضربة نارية! 🔥' },
  { type: 'freeze', color: '#67e8f9', label: 'تجميد الخصم! ❄️' }
];

const rooms = new Map();

// ===== خادم HTTP للفحص (Health Check) + تشغيل اللعبة مباشرة لو فُتح رابط السيرفر =====
const publicDir = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const urlPath = (req.url || '/').split('?')[0];

  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }));
    return;
  }

  if (urlPath === '/manifest.json') {
    const mf = path.join(publicDir, 'manifest.json');
    if (fs.existsSync(mf)) {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      fs.createReadStream(mf).pipe(res);
      return;
    }
  }

  if (urlPath === '/' || urlPath === '/index.html') {
    const idx = path.join(publicDir, 'index.html');
    if (fs.existsSync(idx)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(idx).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Glow Hockey Cloud Server is running! Connect from your Netlify game.');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) {}
}

function clampMalletTarget(m, isTop, x, y) {
  const minX = PAD + m.r + 3;
  const maxX = W - PAD - m.r - 3;
  const minY = isTop ? PAD + m.r + 3 : H / 2 + m.r + 2;
  const maxY = isTop ? H / 2 - m.r - 2 : H - PAD - m.r - 3;
  m.targetX = Math.max(minX, Math.min(maxX, x));
  m.targetY = Math.max(minY, Math.min(maxY, y));
}

function createRoom(id, opts) {
  const room = {
    id,
    p1: null, // أسفل (Bot)
    p2: null, // أعلى (Top)
    state: 'waiting', // waiting | playing | goalPause | paused | win
    targetScore: [5, 7, 10].includes(Number(opts.win)) ? Number(opts.win) : 7,
    themeId: THEMES[opts.th] ? opts.th : 'classic',
    botShape: String(opts.sb || 'ring').slice(0, 12),
    topShape: String(opts.st || 'ring').slice(0, 12),
    puckStyle: String(opts.pk || 'classic').slice(0, 12),
    powerUps: !!opts.pu,
    scoreTop: 0,
    scoreBot: 0,
    maxShotKmh: 0,
    currentRally: 0,
    bestRally: 0,
    totalHits: 0,
    stuckTimer: 0,
    goalPauseTimer: 0,
    activeOrb: null,
    orbSpawnTimer: 5.5,
    events: [],
    seq: 0,
    tickCount: 0,
    lastTick: Date.now(),
    lastHitFxMs: 0,
    lastWallFxMs: 0,
    interval: null,
    botMallet: { x: W / 2, y: H - 145, vx: 0, vy: 0, r: BASE_MALLET_R, targetX: W / 2, targetY: H - 145, giantTimer: 0, freezeTimer: 0, shieldTimer: 0 },
    topMallet: { x: W / 2, y: 145, vx: 0, vy: 0, r: BASE_MALLET_R, targetX: W / 2, targetY: 145, giantTimer: 0, freezeTimer: 0, shieldTimer: 0 },
    puck: { x: W / 2, y: H / 2, vx: 0, vy: 0, r: PUCK_R, lastHitter: null, fireTimer: 0, nextServe: 'center' }
  };
  return room;
}

function resetPositions(room, serveTo) {
  const tm = room.topMallet;
  const bm = room.botMallet;
  const pk = room.puck;

  tm.x = tm.targetX = W / 2;
  tm.y = tm.targetY = 145;
  tm.vx = tm.vy = 0;

  bm.x = bm.targetX = W / 2;
  bm.y = bm.targetY = H - 145;
  bm.vx = bm.vy = 0;

  pk.x = W / 2;
  pk.y = serveTo === 'top' ? H / 2 - 78 : (serveTo === 'bottom' ? H / 2 + 78 : H / 2);
  pk.vx = pk.vy = 0;
  pk.fireTimer = 0;
  room.currentRally = 0;
  room.stuckTimer = 0;
}

function startMatchInRoom(room) {
  room.scoreTop = 0;
  room.scoreBot = 0;
  room.maxShotKmh = 0;
  room.currentRally = 0;
  room.bestRally = 0;
  room.totalHits = 0;
  room.goalPauseTimer = 0;
  room.activeOrb = null;
  room.orbSpawnTimer = 5.5;
  room.events = [];
  room.botMallet.giantTimer = room.botMallet.freezeTimer = room.botMallet.shieldTimer = 0;
  room.topMallet.giantTimer = room.topMallet.freezeTimer = room.topMallet.shieldTimer = 0;
  room.botMallet.r = room.topMallet.r = BASE_MALLET_R;
  resetPositions(room, 'center');
  room.state = 'playing';
  room.lastTick = Date.now();

  const basePayload = {
    t: 'start',
    win: room.targetScore,
    th: room.themeId,
    sb: room.botShape,
    st: room.topShape,
    pk: room.puckStyle,
    pu: room.powerUps
  };
  safeSend(room.p1, Object.assign({ slot: 1 }, basePayload));
  safeSend(room.p2, Object.assign({ slot: 2 }, basePayload));

  broadcastState(room);
  if (!room.interval) {
    room.interval = setInterval(() => stepRoom(room), 16);
  }
}

function destroyRoom(room, notifyRemaining) {
  if (room.interval) { clearInterval(room.interval); room.interval = null; }
  if (notifyRemaining) {
    if (room.p1 && room.p1.readyState === 1) safeSend(room.p1, { t: 'left' });
    if (room.p2 && room.p2.readyState === 1) safeSend(room.p2, { t: 'left' });
  }
  rooms.delete(room.id);
}

function moveMallet(m, isTop, dt) {
  const prevX = m.x, prevY = m.y;
  const freezeFactor = m.freezeTimer > 0 ? 0.45 : 1;
  const follow = Math.min(1, dt * (38 * freezeFactor));
  m.x += (m.targetX - m.x) * follow;
  m.y += (m.targetY - m.y) * follow;

  const minX = PAD + m.r + 3, maxX = W - PAD - m.r - 3;
  const minY = isTop ? PAD + m.r + 3 : H / 2 + m.r + 2;
  const maxY = isTop ? H / 2 - m.r - 2 : H - PAD - m.r - 3;
  m.x = Math.max(minX, Math.min(maxX, m.x));
  m.y = Math.max(minY, Math.min(maxY, m.y));

  let ivx = (m.x - prevX) / Math.max(dt, 0.001);
  let ivy = (m.y - prevY) / Math.max(dt, 0.001);
  const ispd = Math.hypot(ivx, ivy);
  if (ispd > 1650) { ivx = (ivx / ispd) * 1650; ivy = (ivy / ispd) * 1650; }
  if (ispd < 12) { m.vx *= 0.4; m.vy *= 0.4; }
  else { m.vx = m.vx * 0.35 + ivx * 0.65; m.vy = m.vy * 0.35 + ivy * 0.65; }
}

function collideMallet(room, m, who, color) {
  const pk = room.puck;
  const dx = pk.x - m.x;
  const dy = pk.y - m.y;
  const dist = Math.hypot(dx, dy);
  const minDist = pk.r + m.r;
  if (dist >= minDist) return;

  const nx = dist > 0.001 ? dx / dist : 0;
  const ny = dist > 0.001 ? dy / dist : (who === 'top' ? 1 : -1);

  const overlap = minDist - dist;
  pk.x += nx * (overlap + 0.6);
  pk.y += ny * (overlap + 0.6);

  const rvx = pk.vx - m.vx;
  const rvy = pk.vy - m.vy;
  const velAlongNormal = rvx * nx + rvy * ny;

  if (velAlongNormal < 0) {
    const j = -1.93 * velAlongNormal;
    pk.vx += j * nx + m.vx * 0.28;
    pk.vy += j * ny + m.vy * 0.28;

    const malletSpd = Math.hypot(m.vx, m.vy);
    let spd = Math.hypot(pk.vx, pk.vy);
    if (spd < 290 && malletSpd > 60) {
      const boost = 330 / Math.max(spd, 1);
      pk.vx *= boost; pk.vy *= boost; spd = 330;
    }
    const maxSpd = pk.fireTimer > 0 ? 1420 : 1280;
    if (spd > maxSpd) {
      pk.vx = (pk.vx / spd) * maxSpd;
      pk.vy = (pk.vy / spd) * maxSpd;
      spd = maxSpd;
    }

    if (pk.lastHitter !== who) {
      room.currentRally += 1;
      if (room.currentRally > room.bestRally) room.bestRally = room.currentRally;
    }
    pk.lastHitter = who;
    room.totalHits += 1;
    const kmh = Math.round(spd * 0.145);
    if (kmh > room.maxShotKmh) room.maxShotKmh = kmh;

    const nowMs = Date.now();
    if (nowMs - room.lastHitFxMs > 55) {
      room.lastHitFxMs = nowMs;
      const impact = Math.min(1.6, Math.abs(velAlongNormal) / 520 + 0.45);
      const isSuper = spd > 960;
      room.events.push({
        k: 'hit',
        x: Math.round(m.x + nx * m.r),
        y: Math.round(m.y + ny * m.r),
        c: color,
        p: Math.round(impact * 10) / 10,
        sup: isSuper ? kmh : 0
      });
    }
  }
}

function activatePowerup(room, orb, who) {
  const actor = who === 'top' ? room.topMallet : room.botMallet;
  const opp = who === 'top' ? room.botMallet : room.topMallet;
  const info = PU_TYPES.find(x => x.type === orb.type) || PU_TYPES[0];

  if (orb.type === 'giant') actor.giantTimer = 7.0;
  else if (orb.type === 'shield') actor.shieldTimer = 7.5;
  else if (orb.type === 'fire') {
    room.puck.fireTimer = 4.5;
    const sp = Math.hypot(room.puck.vx, room.puck.vy);
    if (sp > 20) {
      const mult = Math.min(1380 / sp, 1.48);
      room.puck.vx *= mult; room.puck.vy *= mult;
    }
  } else if (orb.type === 'freeze') opp.freezeTimer = 4.5;

  room.events.push({ k: 'pu', x: Math.round(orb.x), y: Math.round(orb.y), c: info.color, tx: info.label });
}

function handleGoal(room, scorer) {
  if (scorer === 'bottom') room.scoreBot += 1;
  else room.scoreTop += 1;

  const theme = THEMES[room.themeId] || THEMES.classic;
  const color = scorer === 'bottom' ? theme.botMallet : theme.topMallet;
  const gx = Math.max(GOAL_L + 20, Math.min(GOAL_R - 20, room.puck.x));
  const gy = scorer === 'bottom' ? PAD + 14 : H - PAD - 14;

  room.events.push({ k: 'goal', x: Math.round(gx), y: Math.round(gy), c: color });

  if (room.scoreBot >= room.targetScore || room.scoreTop >= room.targetScore) {
    room.events.push({ k: 'win' });
    room.state = 'win';
    broadcastState(room);
    const winMsg = { t: 'win', sb: room.scoreBot, st: room.scoreTop, ms: room.maxShotKmh, br: room.bestRally, th: room.totalHits };
    safeSend(room.p1, winMsg);
    safeSend(room.p2, winMsg);
    return;
  }

  room.state = 'goalPause';
  room.goalPauseTimer = 1.1;
  room.puck.vx = room.puck.vy = 0;
  room.puck.y = scorer === 'bottom' ? -60 : H + 60;
  room.puck.nextServe = scorer === 'bottom' ? 'top' : 'bottom';
}

function broadcastState(room) {
  const pk = room.puck;
  const bm = room.botMallet;
  const tm = room.topMallet;
  const msg = {
    t: 'st',
    q: ++room.seq,
    d: [
      Math.round(pk.x), Math.round(pk.y),
      Math.round(pk.vx), Math.round(pk.vy),
      Math.round(bm.x), Math.round(bm.y),
      Math.round(tm.x), Math.round(tm.y),
      room.scoreTop, room.scoreBot,
      Math.round(bm.r), Math.round(tm.r),
      Math.round(bm.freezeTimer * 10) / 10, Math.round(tm.freezeTimer * 10) / 10,
      Math.round(bm.shieldTimer * 10) / 10, Math.round(tm.shieldTimer * 10) / 10,
      Math.round(pk.fireTimer * 10) / 10
    ]
  };
  if (room.activeOrb) msg.orb = [room.activeOrb.x, room.activeOrb.y, room.activeOrb.type];
  if (room.events.length > 0) {
    msg.ev = room.events;
    room.events = [];
  }
  const raw = JSON.stringify(msg);
  if (room.p1 && room.p1.readyState === 1 && room.p1.bufferedAmount < 4096) room.p1.send(raw);
  if (room.p2 && room.p2.readyState === 1 && room.p2.bufferedAmount < 4096) room.p2.send(raw);
}

function stepRoom(room) {
  const now = Date.now();
  const dt = Math.min((now - room.lastTick) / 1000, 0.035);
  room.lastTick = now;

  if (room.state !== 'playing' && room.state !== 'goalPause') return;

  const theme = THEMES[room.themeId] || THEMES.classic;
  const bm = room.botMallet;
  const tm = room.topMallet;
  const pk = room.puck;

  for (const m of [tm, bm]) {
    if (m.giantTimer > 0) m.giantTimer = Math.max(0, m.giantTimer - dt);
    if (m.freezeTimer > 0) m.freezeTimer = Math.max(0, m.freezeTimer - dt);
    if (m.shieldTimer > 0) m.shieldTimer = Math.max(0, m.shieldTimer - dt);
    const targetR = m.giantTimer > 0 ? BASE_MALLET_R * 1.3 : BASE_MALLET_R;
    m.r += (targetR - m.r) * Math.min(1, dt * 10);
  }
  if (pk.fireTimer > 0) pk.fireTimer = Math.max(0, pk.fireTimer - dt);

  if (room.powerUps && room.state === 'playing' && !room.activeOrb) {
    room.orbSpawnTimer -= dt;
    if (room.orbSpawnTimer <= 0) {
      const pick = PU_TYPES[Math.floor(Math.random() * PU_TYPES.length)];
      room.activeOrb = {
        x: Math.round(95 + Math.random() * (W - 190)),
        y: Math.round(H / 2 + (Math.random() - 0.5) * 210),
        type: pick.type, r: 22
      };
    }
  }

  moveMallet(bm, false, dt);
  moveMallet(tm, true, dt);

  if (room.state === 'goalPause') {
    room.goalPauseTimer -= dt;
    if (room.goalPauseTimer <= 0) {
      resetPositions(room, pk.nextServe || 'center');
      room.state = 'playing';
    }
  } else if (room.state === 'playing') {
    const SUBS = 4;
    const sdt = dt / SUBS;
    const drag = Math.pow(pk.fireTimer > 0 ? 0.996 : 0.992, sdt * 60);
    const leftWall = PAD + WALL_THICK / 2;
    const rightWall = W - PAD - WALL_THICK / 2;
    const topWall = PAD + WALL_THICK / 2;
    const botWall = H - PAD - WALL_THICK / 2;

    const triggerWall = (wx, wy, q, vel) => {
      const nowMs = Date.now();
      if (nowMs - room.lastWallFxMs < 45) return;
      room.lastWallFxMs = nowMs;
      const pwr = Math.min(1.4, Math.abs(vel) / 480 + 0.35);
      room.events.push({ k: 'wall', x: Math.round(wx), y: Math.round(wy), q, p: Math.round(pwr * 10) / 10 });
    };

    for (let s = 0; s < SUBS; s++) {
      pk.x += pk.vx * sdt;
      pk.y += pk.vy * sdt;
      pk.vx *= drag;
      pk.vy *= drag;

      collideMallet(room, bm, 'bottom', theme.botMallet);
      collideMallet(room, tm, 'top', theme.topMallet);

      if (room.activeOrb && pk.lastHitter && Math.hypot(pk.x - room.activeOrb.x, pk.y - room.activeOrb.y) < pk.r + room.activeOrb.r) {
        const collected = room.activeOrb;
        room.activeOrb = null;
        room.orbSpawnTimer = 8.5 + Math.random() * 3.5;
        activatePowerup(room, collected, pk.lastHitter);
      }

      if (pk.x - pk.r < leftWall) {
        pk.x = leftWall + pk.r;
        pk.vx = Math.abs(pk.vx) * 0.94;
        triggerWall(leftWall, pk.y, pk.y < H / 2 ? 'tl' : 'bl', pk.vx);
      } else if (pk.x + pk.r > rightWall) {
        pk.x = rightWall - pk.r;
        pk.vx = -Math.abs(pk.vx) * 0.94;
        triggerWall(rightWall, pk.y, pk.y < H / 2 ? 'tr' : 'br', pk.vx);
      }

      const inGoalMouth = pk.x > GOAL_L + pk.r * 0.35 && pk.x < GOAL_R - pk.r * 0.35;

      if (pk.y - pk.r < topWall) {
        if (inGoalMouth && tm.shieldTimer <= 0) {
          if (pk.y < -pk.r * 0.6) { handleGoal(room, 'bottom'); break; }
        } else {
          pk.y = topWall + pk.r;
          pk.vy = Math.abs(pk.vy) * 0.96;
          triggerWall(pk.x, topWall, pk.x < W / 2 ? 'tl' : 'tr', pk.vy);
        }
      } else if (pk.y + pk.r > botWall) {
        if (inGoalMouth && bm.shieldTimer <= 0) {
          if (pk.y > H + pk.r * 0.6) { handleGoal(room, 'top'); break; }
        } else {
          pk.y = botWall - pk.r;
          pk.vy = -Math.abs(pk.vy) * 0.96;
          triggerWall(pk.x, botWall, pk.x < W / 2 ? 'bl' : 'br', pk.vy);
        }
      }

      const posts = [
        { x: GOAL_L, y: topWall }, { x: GOAL_R, y: topWall },
        { x: GOAL_L, y: botWall }, { x: GOAL_R, y: botWall }
      ];
      for (const post of posts) {
        const pdx = pk.x - post.x, pdy = pk.y - post.y;
        const pd = Math.hypot(pdx, pdy);
        const pMin = pk.r + 5;
        if (pd < pMin && pd > 0.001) {
          const pnx = pdx / pd, pny = pdy / pd;
          pk.x = post.x + pnx * pMin;
          pk.y = post.y + pny * pMin;
          const dot = pk.vx * pnx + pk.vy * pny;
          if (dot < 0) { pk.vx -= 1.85 * dot * pnx; pk.vy -= 1.85 * dot * pny; }
        }
      }
    }

    const spd = Math.hypot(pk.vx, pk.vy);
    const nearCorner = (pk.x < PAD + 48 || pk.x > W - PAD - 48) && (pk.y < PAD + 48 || pk.y > H - PAD - 48);
    if (nearCorner && spd < 35) {
      room.stuckTimer += dt;
      if (room.stuckTimer > 1.3) {
        room.stuckTimer = 0;
        const toCenter = Math.atan2(H / 2 - pk.y, W / 2 - pk.x);
        pk.vx += Math.cos(toCenter) * 260;
        pk.vy += Math.sin(toCenter) * 260;
      }
    } else {
      room.stuckTimer = 0;
    }
  }

  room.tickCount++;
  // بث الحالة 30 مرة بالثانية (أو فوراً عند وجود هدف/ضربة)
  if (room.tickCount % 2 === 0 || room.events.length > 0) {
    broadcastState(room);
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.slot = 0;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || !msg.t) return;

    if (msg.t === 'ping') {
      safeSend(ws, { t: 'pong', ts: msg.ts });
      return;
    }

    if (msg.t === 'join') {
      if (ws.room) return;
      const roomId = String(msg.room || 'auto').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'auto';
      let room = rooms.get(roomId);

      if (!room) {
        room = createRoom(roomId, msg);
        room.p1 = ws;
        ws.room = room;
        ws.slot = 1;
        rooms.set(roomId, room);
        safeSend(ws, { t: 'wait', room: roomId, slot: 1 });
      } else if (!room.p2 && room.p1 && room.p1.readyState === 1) {
        room.p2 = ws;
        ws.room = room;
        ws.slot = 2;
        startMatchInRoom(room);
      } else {
        safeSend(ws, { t: 'err', msg: 'الغرفة ممتلئة الآن! اختر رقمين آخرين.' });
        try { ws.close(); } catch (e) {}
      }
      return;
    }

    const room = ws.room;
    if (!room) return;

    if (msg.t === 'in') {
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (ws.slot === 1) clampMalletTarget(room.botMallet, false, x, y);
      else if (ws.slot === 2) clampMalletTarget(room.topMallet, true, x, y);
    } else if (msg.t === 'pause') {
      if (room.state === 'playing' || room.state === 'goalPause') {
        room.state = 'paused';
        safeSend(room.p1, { t: 'pause', p: true });
        safeSend(room.p2, { t: 'pause', p: true });
      } else if (room.state === 'paused') {
        room.state = room.goalPauseTimer > 0 ? 'goalPause' : 'playing';
        room.lastTick = Date.now();
        safeSend(room.p1, { t: 'pause', p: false });
        safeSend(room.p2, { t: 'pause', p: false });
      }
    } else if (msg.t === 'rematch') {
      if (room.p1 && room.p2 && room.p1.readyState === 1 && room.p2.readyState === 1) {
        startMatchInRoom(room);
      }
    }
  });

  ws.on('close', () => {
    if (ws.room) {
      const r = ws.room;
      if (r.p1 === ws) r.p1 = null;
      if (r.p2 === ws) r.p2 = null;
      ws.room = null;
      destroyRoom(r, true);
    }
  });
});

// تنظيف الاتصالات الميتة كل 25 ثانية
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 25000);

server.listen(PORT, () => {
  console.log(`Glow Hockey Cloud Server listening on port ${PORT}`);
});
