// Tank Arena engine. Pure, deterministic, no DOM and no Node APIs:
// the same file drives the CLI sandbox and the browser viewer.

export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;
export const ARENA = { width: 1600, height: 900 };
export const ROUND_SECONDS = 120;
export const TANK_RADIUS = 24;
export const BULLET_RADIUS = 5;
export const BULLET_LIFETIME = 4;
export const BULLET_BOUNCES = 1;
export const MUZZLE_OFFSET = TANK_RADIUS + 10;
export const TURRET_RATE = 2.8;
export const ACCEL = 420;
export const REVERSE_FACTOR = 0.6;
export const KIT = { radius: 16, heal: 50, firstSpawn: 15, respawn: 20 };
export const ZONE = { startShrink: 60, endShrink: 100, finalRadius: 170, damagePerSecond: 20 };
export const STAT_POINTS = 10;
export const STAT_MAX = 5;
export const STAT_KEYS = ['armor', 'engine', 'gun', 'reload'];
export const DEFAULT_STATS = { armor: 3, engine: 3, gun: 2, reload: 2 };

const W = ARENA.width;
const H = ARENA.height;
const ZONE_START_RADIUS = Math.hypot(W / 2, H / 2) + 60;

// ---------- stats ----------

export function checkStats(stats) {
  if (!stats || typeof stats !== 'object') return { ok: false, error: 'stats не заданы' };
  let total = 0;
  for (const k of STAT_KEYS) {
    const v = stats[k];
    if (!Number.isInteger(v) || v < 0 || v > STAT_MAX) {
      return { ok: false, error: `stats.${k} должно быть целым от 0 до ${STAT_MAX}` };
    }
    total += v;
  }
  if (total > STAT_POINTS) return { ok: false, error: `сумма очков ${total} больше ${STAT_POINTS}` };
  return { ok: true, total };
}

export function deriveStats(stats) {
  const s = checkStats(stats).ok ? stats : DEFAULT_STATS;
  return {
    armor: s.armor,
    engine: s.engine,
    gun: s.gun,
    reload: s.reload,
    maxHp: 100 + 25 * s.armor,
    maxSpeed: 110 + 22 * s.engine,
    turnRate: 1.8 + 0.25 * s.engine,
    turretRate: TURRET_RATE,
    damage: 18 + 5 * s.gun,
    bulletSpeed: 450 + 50 * s.gun,
    reloadTime: Math.round((1.3 - 0.16 * s.reload) * 100) / 100,
  };
}

// ---------- maps ----------
// Every map is point-symmetric around the centre, so both spawns are equal.

function mirrorWall(w) {
  return { x: W - w.x - w.w, y: H - w.y - w.h, w: w.w, h: w.h };
}

function buildMap(name, half, kits) {
  const walls = [];
  for (const w of half) walls.push({ ...w }, mirrorWall(w));
  return {
    name,
    walls,
    spawns: [
      { x: 140, y: H / 2, heading: 0 },
      { x: W - 140, y: H / 2, heading: Math.PI },
    ],
    kits,
  };
}

export const MAPS = [
  buildMap('Полигон', [
    { x: 330, y: 160, w: 44, h: 200 },
    { x: 330, y: 540, w: 44, h: 200 },
    { x: 600, y: 300, w: 160, h: 44 },
    { x: 770, y: 390, w: 30, h: 120 },
  ], [{ x: 800, y: 130 }, { x: 800, y: 770 }]),
  buildMap('Лабиринт', [
    { x: 250, y: 250, w: 40, h: 400 },
    { x: 450, y: 0, w: 40, h: 330 },
    { x: 450, y: 570, w: 40, h: 330 },
    { x: 640, y: 200, w: 200, h: 40 },
    { x: 780, y: 330, w: 20, h: 240 },
  ], [{ x: 800, y: 110 }, { x: 800, y: 790 }]),
  buildMap('Крепости', [
    { x: 230, y: 330, w: 40, h: 240 },
    { x: 90, y: 290, w: 180, h: 40 },
    { x: 90, y: 570, w: 180, h: 40 },
    { x: 560, y: 120, w: 44, h: 220 },
    { x: 560, y: 560, w: 44, h: 220 },
    { x: 740, y: 420, w: 60, h: 60 },
  ], [{ x: 800, y: 130 }, { x: 800, y: 770 }]),
  buildMap('Каньон', [
    { x: 300, y: 280, w: 420, h: 40 },
    { x: 300, y: 580, w: 260, h: 40 },
    { x: 780, y: 110, w: 40, h: 160 },
  ], [{ x: 620, y: 450 }, { x: 980, y: 450 }]),
];

// Round i of a match: maps rotate, and every map is played from both sides.
export function roundPlan(i) {
  return { mapIndex: i % MAPS.length, swap: (i + Math.floor(i / MAPS.length)) % 2 === 1 };
}

// ---------- geometry ----------

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function normalizeAngle(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

function circleRect(cx, cy, r, w) {
  const px = clamp(cx, w.x, w.x + w.w);
  const py = clamp(cy, w.y, w.y + w.h);
  const dx = cx - px;
  const dy = cy - py;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return null;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    return { nx: dx / d, ny: dy / d, depth: r - d };
  }
  const left = cx - w.x;
  const right = w.x + w.w - cx;
  const top = cy - w.y;
  const bottom = w.y + w.h - cy;
  const m = Math.min(left, right, top, bottom);
  if (m === left) return { nx: -1, ny: 0, depth: left + r };
  if (m === right) return { nx: 1, ny: 0, depth: right + r };
  if (m === top) return { nx: 0, ny: -1, depth: top + r };
  return { nx: 0, ny: 1, depth: bottom + r };
}

function boundsHit(x, y, r) {
  if (x < r) return { nx: 1, ny: 0, depth: r - x };
  if (x > W - r) return { nx: -1, ny: 0, depth: x - (W - r) };
  if (y < r) return { nx: 0, ny: 1, depth: r - y };
  if (y > H - r) return { nx: 0, ny: -1, depth: y - (H - r) };
  return null;
}

// ---------- round ----------

function sanitizeAction(a) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, -1, 1) : 0);
  if (!a || typeof a !== 'object') return { throttle: 0, turn: 0, turretTurn: 0, fire: false };
  return { throttle: num(a.throttle), turn: num(a.turn), turretTurn: num(a.turretTurn), fire: !!a.fire };
}

function emptyTally() {
  return { shots: 0, hits: 0, damageDealt: 0, damageTaken: 0, selfDamage: 0, ricochetHits: 0, intercepts: 0, kits: 0, zoneDamage: 0 };
}

export function createRound({ mapIndex = 0, tanks }) {
  const map = MAPS[mapIndex % MAPS.length];
  return {
    tick: 0,
    time: 0,
    mapIndex: mapIndex % MAPS.length,
    map,
    nextBulletId: 1,
    tanks: tanks.map((t, side) => {
      const st = deriveStats(t.stats);
      const sp = map.spawns[side];
      return {
        side,
        name: t.name,
        stats: st,
        x: sp.x,
        y: sp.y,
        heading: sp.heading,
        turret: sp.heading,
        speed: 0,
        hp: st.maxHp,
        reloadLeft: 0,
        alive: true,
        tally: emptyTally(),
      };
    }),
    bullets: [],
    kits: map.kits.map((k) => ({ x: k.x, y: k.y, active: false, respawnIn: KIT.firstSpawn })),
    zone: { x: W / 2, y: H / 2, radius: ZONE_START_RADIUS },
    over: false,
    winner: null,
    endReason: null,
  };
}

function zoneRadiusAt(t) {
  if (t <= ZONE.startShrink) return ZONE_START_RADIUS;
  const k = clamp((t - ZONE.startShrink) / (ZONE.endShrink - ZONE.startShrink), 0, 1);
  return ZONE_START_RADIUS + (ZONE.finalRadius - ZONE_START_RADIUS) * k;
}

function tankView(t) {
  return {
    x: t.x,
    y: t.y,
    heading: t.heading,
    turret: t.turret,
    speed: t.speed,
    vx: Math.cos(t.heading) * t.speed,
    vy: Math.sin(t.heading) * t.speed,
    hp: t.hp,
    maxHp: t.stats.maxHp,
    reloadLeft: t.reloadLeft,
    alive: t.alive,
    stats: { ...t.stats },
  };
}

// What a bot sees on its turn. Always a fresh object: bots cannot touch engine state.
export function botView(round, side) {
  return {
    tick: round.tick,
    time: round.time,
    timeLeft: Math.max(0, ROUND_SECONDS - round.time),
    dt: DT,
    side,
    arena: {
      width: W,
      height: H,
      mapName: round.map.name,
      walls: round.map.walls.map((w) => ({ ...w })),
    },
    me: tankView(round.tanks[side]),
    enemy: tankView(round.tanks[1 - side]),
    bullets: round.bullets.map((b) => ({
      id: b.id,
      x: b.x,
      y: b.y,
      vx: b.vx,
      vy: b.vy,
      mine: b.owner === side,
      bouncesLeft: b.bouncesLeft,
      damage: b.damage,
      canHitOwner: b.bounced,
    })),
    repairKits: round.kits.map((k) => ({ ...k })),
    zone: {
      x: round.zone.x,
      y: round.zone.y,
      radius: round.zone.radius,
      finalRadius: ZONE.finalRadius,
      shrinkStart: ZONE.startShrink,
      shrinkEnd: ZONE.endShrink,
      damagePerSecond: ZONE.damagePerSecond,
    },
  };
}

function damageTank(round, victim, amount, events, info) {
  if (!victim.alive || amount <= 0) return;
  const dealt = Math.min(victim.hp, amount);
  victim.hp -= amount;
  victim.tally.damageTaken += dealt;
  events.push({ type: 'hit', side: victim.side, x: victim.x, y: victim.y, damage: dealt, ...info });
  if (victim.hp <= 0) {
    victim.hp = 0;
    victim.alive = false;
    victim.speed = 0;
    events.push({ type: 'death', side: victim.side, x: victim.x, y: victim.y, cause: info.cause });
  }
}

function moveTank(round, t, a) {
  const st = t.stats;
  t.heading = normalizeAngle(t.heading + a.turn * st.turnRate * DT);
  t.turret = normalizeAngle(t.turret + a.turretTurn * st.turretRate * DT);
  const target = a.throttle >= 0 ? a.throttle * st.maxSpeed : a.throttle * st.maxSpeed * REVERSE_FACTOR;
  const dv = clamp(target - t.speed, -ACCEL * DT, ACCEL * DT);
  t.speed += dv;
  t.x += Math.cos(t.heading) * t.speed * DT;
  t.y += Math.sin(t.heading) * t.speed * DT;
}

function resolveTankWalls(round, t, events) {
  let bumped = false;
  for (let pass = 0; pass < 2; pass++) {
    for (const w of round.map.walls) {
      const c = circleRect(t.x, t.y, TANK_RADIUS, w);
      if (c) {
        t.x += c.nx * c.depth;
        t.y += c.ny * c.depth;
        bumped = true;
      }
    }
    const nx = clamp(t.x, TANK_RADIUS, W - TANK_RADIUS);
    const ny = clamp(t.y, TANK_RADIUS, H - TANK_RADIUS);
    if (nx !== t.x || ny !== t.y) bumped = true;
    t.x = nx;
    t.y = ny;
  }
  if (bumped && Math.abs(t.speed) > 60) events.push({ type: 'bump', side: t.side, x: t.x, y: t.y });
  if (bumped) t.speed *= 0.6;
}

function resolveTankTank(a, b) {
  if (!a.alive && !b.alive) return;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const min = TANK_RADIUS * 2;
  if (d >= min || d < 1e-6) return;
  const push = (min - d) / 2;
  const nx = dx / d;
  const ny = dy / d;
  // A wreck does not move; the living tank takes the whole push.
  const pa = a.alive ? (b.alive ? push : push * 2) : 0;
  const pb = b.alive ? (a.alive ? push : push * 2) : 0;
  a.x -= nx * pa;
  a.y -= ny * pa;
  b.x += nx * pb;
  b.y += ny * pb;
}

function fire(round, t, events) {
  const dx = Math.cos(t.turret);
  const dy = Math.sin(t.turret);
  const x = t.x + dx * MUZZLE_OFFSET;
  const y = t.y + dy * MUZZLE_OFFSET;
  t.reloadLeft = t.stats.reloadTime;
  t.tally.shots++;
  events.push({ type: 'shot', side: t.side, x, y, angle: t.turret });
  const blocked = boundsHit(x, y, BULLET_RADIUS) || round.map.walls.some((w) => circleRect(x, y, BULLET_RADIUS, w));
  if (blocked) {
    events.push({ type: 'impact', x, y, owner: t.side });
    return;
  }
  round.bullets.push({
    id: round.nextBulletId++,
    owner: t.side,
    x,
    y,
    vx: dx * t.stats.bulletSpeed,
    vy: dy * t.stats.bulletSpeed,
    damage: t.stats.damage,
    bouncesLeft: BULLET_BOUNCES,
    bounced: false,
    age: 0,
    dead: false,
  });
}

function stepBullets(round, events) {
  for (const b of round.bullets) {
    if (b.dead) continue;
    b.age += DT;
    if (b.age > BULLET_LIFETIME) {
      b.dead = true;
      events.push({ type: 'fizzle', x: b.x, y: b.y, owner: b.owner });
      continue;
    }
    const speed = Math.hypot(b.vx, b.vy);
    const steps = Math.max(1, Math.ceil((speed * DT) / 6));
    const sdt = DT / steps;
    for (let s = 0; s < steps && !b.dead; s++) {
      b.x += b.vx * sdt;
      b.y += b.vy * sdt;
      let c = boundsHit(b.x, b.y, BULLET_RADIUS);
      if (!c) {
        for (const w of round.map.walls) {
          c = circleRect(b.x, b.y, BULLET_RADIUS, w);
          if (c) break;
        }
      }
      if (c) {
        if (b.bouncesLeft > 0) {
          b.bouncesLeft--;
          b.bounced = true;
          b.x += c.nx * c.depth;
          b.y += c.ny * c.depth;
          const dot = b.vx * c.nx + b.vy * c.ny;
          b.vx -= 2 * dot * c.nx;
          b.vy -= 2 * dot * c.ny;
          events.push({ type: 'ricochet', x: b.x, y: b.y, owner: b.owner, nx: c.nx, ny: c.ny });
        } else {
          b.dead = true;
          events.push({ type: 'impact', x: b.x, y: b.y, owner: b.owner });
        }
        continue;
      }
      for (const t of round.tanks) {
        if (!t.alive) continue;
        if (t.side === b.owner && !b.bounced) continue;
        if (Math.hypot(t.x - b.x, t.y - b.y) < TANK_RADIUS + BULLET_RADIUS) {
          b.dead = true;
          const shooter = round.tanks[b.owner];
          const self = t.side === b.owner;
          const dealt = Math.min(t.hp, b.damage);
          if (self) shooter.tally.selfDamage += dealt;
          else {
            shooter.tally.hits++;
            shooter.tally.damageDealt += dealt;
            if (b.bounced) shooter.tally.ricochetHits++;
          }
          damageTank(round, t, b.damage, events, {
            cause: self ? 'self' : 'bullet',
            by: b.owner,
            ricochet: b.bounced,
            bx: b.x,
            by_: b.y,
            dirx: b.vx / speed,
            diry: b.vy / speed,
          });
          break;
        }
      }
    }
  }
  // Bullets destroy each other: shooting down an incoming round is allowed.
  const live = round.bullets.filter((b) => !b.dead);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (a.dead || b.dead) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) < BULLET_RADIUS * 2 + 2) {
        a.dead = true;
        b.dead = true;
        if (a.owner !== b.owner) {
          // Credit the interception to whoever's bullet was fired later (the defensive shot).
          const later = a.id > b.id ? a : b;
          round.tanks[later.owner].tally.intercepts++;
        }
        events.push({ type: 'clash', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      }
    }
  }
  round.bullets = round.bullets.filter((b) => !b.dead);
}

function stepKits(round, events) {
  for (const k of round.kits) {
    if (!k.active) {
      k.respawnIn = Math.max(0, k.respawnIn - DT);
      if (k.respawnIn === 0) {
        k.active = true;
        events.push({ type: 'kitSpawn', x: k.x, y: k.y });
      }
      continue;
    }
    let best = null;
    let bestD = Infinity;
    let tie = false;
    for (const t of round.tanks) {
      if (!t.alive) continue;
      const d = Math.hypot(t.x - k.x, t.y - k.y);
      if (d > TANK_RADIUS + KIT.radius) continue;
      if (Math.abs(d - bestD) < 1e-9) tie = true;
      else if (d < bestD) {
        best = t;
        bestD = d;
        tie = false;
      }
    }
    if (best && !tie) {
      const healed = Math.min(KIT.heal, best.stats.maxHp - best.hp);
      best.hp += healed;
      best.tally.kits++;
      k.active = false;
      k.respawnIn = KIT.respawn;
      events.push({ type: 'pickup', side: best.side, x: k.x, y: k.y, healed });
    }
  }
}

// Advance one tick. actions[side] = { throttle, turn, turretTurn, fire }.
export function stepRound(round, actions) {
  if (round.over) return [];
  const events = [];
  const acts = [sanitizeAction(actions[0]), sanitizeAction(actions[1])];

  for (const t of round.tanks) {
    if (!t.alive) continue;
    t.reloadLeft = Math.max(0, t.reloadLeft - DT);
    moveTank(round, t, acts[t.side]);
  }
  for (const t of round.tanks) if (t.alive) resolveTankWalls(round, t, events);
  resolveTankTank(round.tanks[0], round.tanks[1]);
  for (const t of round.tanks) if (t.alive) resolveTankWalls(round, t, events);

  for (const t of round.tanks) {
    if (t.alive && acts[t.side].fire && t.reloadLeft <= 0) fire(round, t, events);
  }

  stepBullets(round, events);
  stepKits(round, events);

  const prevRadius = round.zone.radius;
  round.zone.radius = zoneRadiusAt(round.time + DT);
  if (prevRadius === ZONE_START_RADIUS && round.zone.radius < prevRadius) events.push({ type: 'zoneStart' });
  for (const t of round.tanks) {
    if (!t.alive) continue;
    if (Math.hypot(t.x - round.zone.x, t.y - round.zone.y) > round.zone.radius) {
      const dmg = ZONE.damagePerSecond * DT;
      t.tally.zoneDamage += Math.min(t.hp, dmg);
      damageTank(round, t, dmg, events, { cause: 'zone', quiet: true });
    }
  }

  round.tick++;
  round.time = round.tick * DT;

  const [a, b] = round.tanks;
  if (!a.alive || !b.alive) {
    round.over = true;
    round.endReason = 'kill';
    round.winner = !a.alive && !b.alive ? null : a.alive ? 0 : 1;
  } else if (round.time >= ROUND_SECONDS - 1e-9) {
    round.over = true;
    round.endReason = 'time';
    const fa = a.hp / a.stats.maxHp;
    const fb = b.hp / b.stats.maxHp;
    round.winner = Math.abs(fa - fb) < 1e-9 ? null : fa > fb ? 0 : 1;
  }
  if (round.over) events.push({ type: 'roundOver', winner: round.winner, reason: round.endReason });
  return events;
}
