// Sparring bot "Охотник": grid pathfinding, lead aiming, simple dodging,
// picks up repair kits and respects the zone. A fair baseline, not a champion.

const CELL = 25;
const PAD = 26; // tank radius + margin
let grid = null;
let gridMap = null;
let path = [];
let pathTick = -999;

const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function segHitsRect(x1, y1, x2, y2, r, pad) {
  const minX = r.x - pad, maxX = r.x + r.w + pad, minY = r.y - pad, maxY = r.y + r.h + pad;
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const clip = (p, q) => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, x1 - minX) && clip(dx, maxX - x1) && clip(-dy, y1 - minY) && clip(dy, maxY - y1);
}

function clear(walls, x1, y1, x2, y2, pad) {
  return !walls.some((w) => segHitsRect(x1, y1, x2, y2, w, pad));
}

function buildGrid(arena) {
  const cols = Math.ceil(arena.width / CELL), rows = Math.ceil(arena.height / CELL);
  const g = { cols, rows, free: new Uint8Array(cols * rows) };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * CELL + CELL / 2, y = r * CELL + CELL / 2;
      const inBounds = x > PAD && x < arena.width - PAD && y > PAD && y < arena.height - PAD;
      const hit = arena.walls.some((w) => x > w.x - PAD && x < w.x + w.w + PAD && y > w.y - PAD && y < w.y + w.h + PAD);
      g.free[r * cols + c] = inBounds && !hit ? 1 : 0;
    }
  }
  return g;
}

function nearestFree(g, x, y) {
  let c = clamp(Math.floor(x / CELL), 0, g.cols - 1), r = clamp(Math.floor(y / CELL), 0, g.rows - 1);
  if (g.free[r * g.cols + c]) return r * g.cols + c;
  for (let rad = 1; rad < 6; rad++) {
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < g.rows && cc >= 0 && cc < g.cols && g.free[rr * g.cols + cc]) return rr * g.cols + cc;
    }
  }
  return r * g.cols + c;
}

function bfs(g, from, to) {
  const prev = new Int32Array(g.cols * g.rows).fill(-1);
  const q = [from];
  prev[from] = from;
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    if (cur === to) break;
    const r = Math.floor(cur / g.cols), c = cur % g.cols;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= g.rows || cc < 0 || cc >= g.cols) continue;
      const n = rr * g.cols + cc;
      if (!g.free[n] || prev[n] !== -1) continue;
      if (dr && dc && (!g.free[r * g.cols + cc] || !g.free[rr * g.cols + c])) continue;
      prev[n] = cur;
      q.push(n);
    }
  }
  if (prev[to] === -1) return [];
  const out = [];
  for (let n = to; n !== from; n = prev[n]) out.push({ x: (n % g.cols) * CELL + CELL / 2, y: Math.floor(n / g.cols) * CELL + CELL / 2 });
  return out.reverse();
}

function driveTo(me, x, y, walls) {
  const want = Math.atan2(y - me.y, x - me.x);
  const diff = norm(want - me.heading);
  // Reversing is often faster than turning around.
  if (Math.abs(diff) > 2.2) {
    const back = norm(diff + Math.PI);
    return { throttle: -1, turn: clamp(-back * 3, -1, 1) };
  }
  return { throttle: Math.cos(diff) > 0.5 ? 1 : 0.15, turn: clamp(diff * 3, -1, 1) };
}

function leadPoint(me, enemy) {
  const s = me.stats.bulletSpeed;
  let px = enemy.x, py = enemy.y;
  for (let i = 0; i < 4; i++) {
    const t = Math.hypot(px - me.x, py - me.y) / s;
    px = enemy.x + enemy.vx * t;
    py = enemy.y + enemy.vy * t;
  }
  return { x: px, y: py };
}

function threat(me, bullets) {
  let worst = null;
  for (const b of bullets) {
    if (b.mine && !b.canHitOwner) continue;
    const rx = me.x - b.x, ry = me.y - b.y;
    const v2 = b.vx * b.vx + b.vy * b.vy;
    const t = (rx * b.vx + ry * b.vy) / v2;
    if (t < 0 || t > 0.9) continue;
    const cx = b.x + b.vx * t - me.x, cy = b.y + b.vy * t - me.y;
    const miss = Math.hypot(cx, cy);
    if (miss < 40 && (!worst || t < worst.t)) worst = { b, t, cx, cy };
  }
  return worst;
}

export default {
  name: 'Охотник',
  motto: 'Спарринг-партнёр. Не обижайся.',
  stats: { armor: 3, engine: 3, gun: 2, reload: 2 },

  init() {
    grid = null;
    path = [];
    pathTick = -999;
  },

  tick(s) {
    const { me, enemy, arena } = s;
    const walls = arena.walls;
    if (!grid || gridMap !== arena.mapName) {
      grid = buildGrid(arena);
      gridMap = arena.mapName;
    }

    // --- turret: lead the target ---
    const aim = leadPoint(me, enemy);
    const aimAngle = Math.atan2(aim.y - me.y, aim.x - me.x);
    const turretDiff = norm(aimAngle - me.turret);
    const turretTurn = clamp(turretDiff * 8, -1, 1);
    const mx = me.x + Math.cos(me.turret) * 34, my = me.y + Math.sin(me.turret) * 34;
    const los = clear(walls, me.x, me.y, enemy.x, enemy.y, 6);
    const fire = enemy.alive && Math.abs(turretDiff) < 0.07 && clear(walls, mx, my, aim.x, aim.y, 6);

    // --- hull: dodge > zone > repair kit > hunt ---
    let drive;
    const danger = threat(me, s.bullets);
    const zoneDist = Math.hypot(me.x - s.zone.x, me.y - s.zone.y);
    const kit = s.repairKits.filter((k) => k.active).sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0];

    if (danger) {
      const perp = Math.atan2(danger.b.vy, danger.b.vx) + Math.PI / 2;
      const side = Math.sign(-(danger.cx * Math.cos(perp) + danger.cy * Math.sin(perp))) || 1;
      const tx = me.x + Math.cos(perp) * 80 * side, ty = me.y + Math.sin(perp) * 80 * side;
      drive = driveTo(me, tx, ty, walls);
    } else {
      let goal = { x: enemy.x, y: enemy.y };
      if (zoneDist > s.zone.radius - 80) goal = { x: s.zone.x, y: s.zone.y };
      else if (kit && me.hp < me.maxHp * 0.6) goal = kit;

      const dist = Math.hypot(enemy.x - me.x, enemy.y - me.y);
      if (goal.x === enemy.x && los && dist < 420) {
        // In a fire fight: strafe around the enemy instead of rushing in.
        const around = Math.atan2(me.y - enemy.y, me.x - enemy.x) + (s.tick % 180 < 90 ? 0.6 : -0.6);
        const r = dist < 250 ? 330 : 300;
        drive = driveTo(me, enemy.x + Math.cos(around) * r, enemy.y + Math.sin(around) * r, walls);
      } else {
        if (s.tick - pathTick > 10 || path.length === 0) {
          path = bfs(grid, nearestFree(grid, me.x, me.y), nearestFree(grid, goal.x, goal.y));
          pathTick = s.tick;
        }
        while (path.length > 1 && clear(walls, me.x, me.y, path[1].x, path[1].y, 24)) path.shift();
        const wp = path[0] || goal;
        if (Math.hypot(wp.x - me.x, wp.y - me.y) < 14) path.shift();
        drive = driveTo(me, wp.x, wp.y, walls);
      }
    }

    return { throttle: drive.throttle, turn: drive.turn, turretTurn, fire };
  },
};
