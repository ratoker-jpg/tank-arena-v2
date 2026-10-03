const PI = Math.PI;
const TAU = PI * 2;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const norm = (a) => {
  a = (a + PI) % TAU;
  if (a < 0) a += TAU;
  return a - PI;
};
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const hypot2 = (x, y) => Math.hypot(x, y) || 1;

let orbit = 1;
let waypoint = null;
let waypointKind = '';
let navRefresh = -100;
let sampleTick = 0;
let sampleX = 0;
let sampleY = 0;
let lastThrottle = 0;
let escapeUntil = -1;

function rectBounds(w, pad = 0) {
  return {
    x1: w.x - pad,
    y1: w.y - pad,
    x2: w.x + w.w + pad,
    y2: w.y + w.h + pad,
  };
}

function pointInExpandedWall(x, y, wall, pad = 0) {
  const r = rectBounds(wall, pad);
  return x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2;
}

function segmentHitsWall(ax, ay, bx, by, wall, pad = 0) {
  const r = rectBounds(wall, pad);
  const dx = bx - ax;
  const dy = by - ay;
  let lo = 0;
  let hi = 1;
  const clip = (p, q) => {
    if (Math.abs(p) < 1e-9) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > hi) return false;
      if (t > lo) lo = t;
    } else {
      if (t < lo) return false;
      if (t < hi) hi = t;
    }
    return true;
  };
  return clip(-dx, ax - r.x1) && clip(dx, r.x2 - ax) &&
    clip(-dy, ay - r.y1) && clip(dy, r.y2 - ay) && lo <= hi;
}

function clearLine(a, b, walls, pad = 0) {
  for (const wall of walls) {
    if (segmentHitsWall(a.x, a.y, b.x, b.y, wall, pad)) return false;
  }
  return true;
}

function freePoint(x, y, state, pad = 27) {
  if (x < pad || y < pad || x > state.arena.width - pad || y > state.arena.height - pad) return false;
  return !state.arena.walls.some((w) => pointInExpandedWall(x, y, w, pad));
}

function zoneSafeRadius(state, margin = 70) {
  return Math.max(state.zone.finalRadius + 20, state.zone.radius - margin);
}

function insideFutureZone(state, p, margin = 55) {
  return Math.hypot(p.x - state.zone.x, p.y - state.zone.y) <= zoneSafeRadius(state, margin);
}

function pickRepairGoal(state) {
  const missing = state.me.maxHp - state.me.hp;
  if (missing < 35) return null;
  let best = null;
  let bestScore = Infinity;
  for (const kit of state.repairKits) {
    const d = distance(state.me, kit);
    const eta = d / Math.max(80, state.me.stats.maxSpeed);
    if (!kit.active && kit.respawnIn > eta + 1.3) continue;
    if (!insideFutureZone(state, kit, 25) && state.time > state.zone.shrinkStart - 3) continue;
    const enemyD = distance(state.enemy, kit);
    const enemyPenalty = enemyD + 80 < d ? 180 : 0;
    const waitPenalty = kit.active ? 0 : Math.max(0, kit.respawnIn - eta) * 90;
    const score = d + enemyPenalty + waitPenalty;
    if (score < bestScore && (d < 760 || state.me.hp < state.me.maxHp * 0.52)) {
      best = kit;
      bestScore = score;
    }
  }
  return best;
}

function firstBlockingWall(state, goal, pad = 28) {
  let best = null;
  let bestD = Infinity;
  for (const wall of state.arena.walls) {
    if (!segmentHitsWall(state.me.x, state.me.y, goal.x, goal.y, wall, pad)) continue;
    const cx = clamp(state.me.x, wall.x, wall.x + wall.w);
    const cy = clamp(state.me.y, wall.y, wall.y + wall.h);
    const d = Math.hypot(state.me.x - cx, state.me.y - cy);
    if (d < bestD) {
      best = wall;
      bestD = d;
    }
  }
  return best;
}

function pickDetour(state, goal) {
  const wall = firstBlockingWall(state, goal, 28);
  if (!wall) return null;
  const m = 40;
  const corners = [
    { x: wall.x - m, y: wall.y - m },
    { x: wall.x + wall.w + m, y: wall.y - m },
    { x: wall.x - m, y: wall.y + wall.h + m },
    { x: wall.x + wall.w + m, y: wall.y + wall.h + m },
  ];
  let best = null;
  let bestScore = Infinity;
  for (const c of corners) {
    if (!freePoint(c.x, c.y, state, 27)) continue;
    if (!clearLine(state.me, c, state.arena.walls, 24.5)) continue;
    let score = distance(state.me, c) + distance(c, goal) * 0.75;
    if (!insideFutureZone(state, c, 35) && state.time > state.zone.shrinkStart - 5) score += 500;
    const enemyGap = distance(c, state.enemy);
    if (enemyGap < 130) score += (130 - enemyGap) * 3;
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

function nearestWallRepulsion(state) {
  let vx = 0;
  let vy = 0;
  const me = state.me;
  for (const w of state.arena.walls) {
    const qx = clamp(me.x, w.x, w.x + w.w);
    const qy = clamp(me.y, w.y, w.y + w.h);
    let dx = me.x - qx;
    let dy = me.y - qy;
    let d = Math.hypot(dx, dy);
    if (d < 1e-6 && pointInExpandedWall(me.x, me.y, w, 1)) {
      const left = Math.abs(me.x - w.x);
      const right = Math.abs(w.x + w.w - me.x);
      const top = Math.abs(me.y - w.y);
      const bottom = Math.abs(w.y + w.h - me.y);
      const m = Math.min(left, right, top, bottom);
      if (m === left) { dx = -1; dy = 0; }
      else if (m === right) { dx = 1; dy = 0; }
      else if (m === top) { dx = 0; dy = -1; }
      else { dx = 0; dy = 1; }
      d = 1;
    }
    if (d < 95) {
      const k = ((95 - d) / 95) ** 2 * 2.8;
      const n = hypot2(dx, dy);
      vx += (dx / n) * k;
      vy += (dy / n) * k;
    }
  }
  const edge = 70;
  if (me.x < edge) vx += (edge - me.x) / edge * 2.6;
  if (me.x > state.arena.width - edge) vx -= (me.x - (state.arena.width - edge)) / edge * 2.6;
  if (me.y < edge) vy += (edge - me.y) / edge * 2.6;
  if (me.y > state.arena.height - edge) vy -= (me.y - (state.arena.height - edge)) / edge * 2.6;
  return { x: vx, y: vy };
}

function bulletAvoidance(state) {
  let vx = 0;
  let vy = 0;
  let danger = 0;
  for (const b of state.bullets) {
    if (b.mine && !b.canHitOwner) continue;
    const v2 = b.vx * b.vx + b.vy * b.vy;
    if (v2 < 1) continue;
    const rx = state.me.x - b.x;
    const ry = state.me.y - b.y;
    const t = clamp((rx * b.vx + ry * b.vy) / v2, 0, 1.05);
    const px = b.x + b.vx * t;
    const py = b.y + b.vy * t;
    let dx = state.me.x - px;
    let dy = state.me.y - py;
    let d = Math.hypot(dx, dy);
    if (d > 115) continue;
    if (d < 3) {
      const n = hypot2(b.vx, b.vy);
      dx = -b.vy / n * orbit;
      dy = b.vx / n * orbit;
      d = 3;
    }
    const urgency = (1 - t / 1.05) * (1 - d / 115);
    const k = 0.8 + urgency * 5.8;
    const n = hypot2(dx, dy);
    vx += dx / n * k;
    vy += dy / n * k;
    danger = Math.max(danger, urgency);
  }
  return { x: vx, y: vy, danger };
}

function chooseBaseVector(state) {
  const me = state.me;
  const enemy = state.enemy;
  const center = { x: state.zone.x, y: state.zone.y };
  const myCenterD = distance(me, center);
  const safe = zoneSafeRadius(state, 78);
  const repair = pickRepairGoal(state);

  let goal = null;
  let kind = 'fight';
  if (myCenterD > safe || state.time > state.zone.shrinkStart && myCenterD > safe - 20) {
    goal = center;
    kind = 'zone';
  } else if (repair) {
    goal = repair;
    kind = 'repair';
  }

  const hasLos = clearLine(me, enemy, state.arena.walls, 5.5);
  if (!goal && !hasLos) {
    goal = enemy;
    kind = 'hunt';
  }

  if (goal) {
    if (state.tick - navRefresh >= 6 || !waypoint || waypointKind !== kind || distance(me, waypoint) < 28) {
      waypoint = pickDetour(state, goal);
      waypointKind = kind;
      navRefresh = state.tick;
    }
    const p = waypoint || goal;
    const dx = p.x - me.x;
    const dy = p.y - me.y;
    const n = hypot2(dx, dy);
    return { x: dx / n * 1.7, y: dy / n * 1.7, kind, goal: p };
  }

  waypoint = null;
  waypointKind = '';

  const d = distance(me, enemy) || 1;
  const ox = (me.x - enemy.x) / d;
  const oy = (me.y - enemy.y) / d;
  const tx = -oy * orbit;
  const ty = ox * orbit;
  const enemyDps = enemy.stats.damage / enemy.stats.reloadTime;
  const myDps = me.stats.damage / me.stats.reloadTime;
  let desiredRange = enemyDps > myDps * 1.25 ? 440 : 385;
  if (state.timeLeft < 18 && me.hp / me.maxHp < enemy.hp / enemy.maxHp) desiredRange = 270;
  if (state.timeLeft < 18 && me.hp / me.maxHp > enemy.hp / enemy.maxHp + 0.12) desiredRange = 500;
  const radial = clamp((desiredRange - d) / 150, -1.55, 1.55);
  return {
    x: tx * 1.35 + ox * radial,
    y: ty * 1.35 + oy * radial,
    kind: 'fight',
    goal: enemy,
  };
}

function movement(state) {
  const base = chooseBaseVector(state);
  const wall = nearestWallRepulsion(state);
  const bullet = bulletAvoidance(state);
  let vx = base.x + wall.x + bullet.x;
  let vy = base.y + wall.y + bullet.y;

  const centerDx = state.zone.x - state.me.x;
  const centerDy = state.zone.y - state.me.y;
  const centerD = hypot2(centerDx, centerDy);
  const safe = zoneSafeRadius(state, 62);
  if (centerD > safe) {
    const k = 2.2 + Math.min(2.2, (centerD - safe) / 80);
    vx += centerDx / centerD * k;
    vy += centerDy / centerD * k;
  }

  const enemyD = distance(state.me, state.enemy);
  if (enemyD < 125) {
    const dx = state.me.x - state.enemy.x;
    const dy = state.me.y - state.enemy.y;
    const n = hypot2(dx, dy);
    const k = (125 - enemyD) / 125 * 2.2;
    vx += dx / n * k;
    vy += dy / n * k;
  }

  if (state.tick - sampleTick >= 30) {
    const moved = Math.hypot(state.me.x - sampleX, state.me.y - sampleY);
    if (lastThrottle > 0.55 && moved < 26 && state.me.speed < 50) {
      orbit *= -1;
      escapeUntil = state.tick + 42;
      waypoint = null;
    }
    sampleTick = state.tick;
    sampleX = state.me.x;
    sampleY = state.me.y;
  }

  if (state.tick < escapeUntil) {
    const a = state.me.heading + orbit * 1.15;
    vx += Math.cos(a) * 3.5;
    vy += Math.sin(a) * 3.5;
  }

  if (Math.abs(vx) + Math.abs(vy) < 1e-6) {
    vx = Math.cos(state.me.heading);
    vy = Math.sin(state.me.heading);
  }

  const desired = Math.atan2(vy, vx);
  const diff = norm(desired - state.me.heading);
  const turn = clamp(diff / Math.max(0.12, state.me.stats.turnRate * state.dt * 2.2), -1, 1);
  let throttle;
  const ad = Math.abs(diff);
  if (bullet.danger > 0.15) throttle = 1;
  else if (ad < 0.45) throttle = 1;
  else if (ad < 0.95) throttle = 0.72;
  else if (ad < 1.5) throttle = 0.4;
  else throttle = 0.18;

  if (base.kind === 'repair' && distance(state.me, base.goal) < 20) throttle = 0.2;
  lastThrottle = throttle;
  return { throttle, turn };
}

function predictedAimPoint(state) {
  const me = state.me;
  const e = state.enemy;
  const speed = me.stats.bulletSpeed;
  let px = e.x;
  let py = e.y;
  let t = distance(me, e) / speed;
  const leadFactor = e.stats.maxSpeed > 175 ? 0.66 : 0.84;
  for (let i = 0; i < 3; i++) {
    px = clamp(e.x + e.vx * t * leadFactor, 24, state.arena.width - 24);
    py = clamp(e.y + e.vy * t * leadFactor, 24, state.arena.height - 24);
    t = Math.hypot(px - me.x, py - me.y) / speed;
  }
  const p = { x: px, y: py };
  if (!freePoint(p.x, p.y, state, 5)) return { x: e.x, y: e.y };
  return p;
}

function aim(state) {
  const me = state.me;
  const target = predictedAimPoint(state);
  const a = Math.atan2(target.y - me.y, target.x - me.x);
  const diff = norm(a - me.turret);
  const turretTurn = clamp(diff / (me.stats.turretRate * state.dt), -1, 1);
  const nextTurret = me.turret + turretTurn * me.stats.turretRate * state.dt;
  const error = Math.abs(norm(a - nextTurret));
  const muzzle = { x: me.x + Math.cos(a) * 34, y: me.y + Math.sin(a) * 34 };
  const d = distance(me, target);
  const tolerance = Math.max(0.022, Math.atan2(18, Math.max(40, d)));
  const los = freePoint(muzzle.x, muzzle.y, state, 5.2) && clearLine(muzzle, target, state.arena.walls, 5.1);
  const fire = me.reloadLeft <= state.dt + 1e-6 && error <= tolerance && los;
  return { turretTurn, fire };
}

export default {
  name: 'ВЕКТОР',
  motto: 'Сначала меняю угол. Потом ты промахиваешься.',
  stats: { armor: 1, engine: 5, gun: 2, reload: 2 },
  init(info) {
    orbit = info.side ? -1 : 1;
    waypoint = null;
    waypointKind = '';
    navRefresh = -100;
    sampleTick = info.view.tick;
    sampleX = info.view.me.x;
    sampleY = info.view.me.y;
    lastThrottle = 0;
    escapeUntil = -1;
  },
  tick(state) {
    const move = movement(state);
    const shot = aim(state);
    return {
      throttle: clamp(move.throttle, -1, 1),
      turn: clamp(move.turn, -1, 1),
      turretTurn: clamp(shot.turretTurn, -1, 1),
      fire: Boolean(shot.fire),
    };
  },
};
