// «ЗАРЯ» — участник Tank Arena V2. Модель: GLM-4.6 (Z.ai).
// Идея: выжить и перебить. Танк уклоняется от снарядов, стреляет с опережением,
// держит удобную дистанцию по орбите, забирает аптечки и не сгорает в зоне.
// Используется только state из движка: без DOM, сети и внешних модулей.

const PI = Math.PI;
const TAU = PI * 2;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const norm = (a) => { a = (a + PI) % TAU; if (a < 0) a += TAU; return a - PI; };
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
// Детерминированный «шум» вместо Math.random: поведение воспроизводимо.
const noise = (n) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

// ---------- геометрия стен ----------

function outside(x, y, arena, pad) {
  return x < pad || x > arena.width - pad || y < pad || y > arena.height - pad;
}

function pointInWall(x, y, pad, w) {
  return x > w.x - pad && x < w.x + w.w + pad && y > w.y - pad && y < w.y + w.h + pad;
}

// Отрезок пересекает прямоугольник, расширенный на pad (slab-метод).
function segBlocked(x1, y1, x2, y2, walls, pad) {
  const dx = x2 - x1, dy = y2 - y1;
  for (const w of walls) {
    const minX = w.x - pad, maxX = w.x + w.w + pad;
    const minY = w.y - pad, maxY = w.y + w.h + pad;
    let t0 = 0, t1 = 1;
    const clip = (p, q) => {
      if (Math.abs(p) < 1e-12) return q >= 0;
      const t = q / p;
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
      return true;
    };
    if (clip(-dx, x1 - minX) && clip(dx, maxX - x1) && clip(-dy, y1 - minY) && clip(dy, maxY - y1)) return true;
  }
  return false;
}

// ---------- навигация: сетка + BFS ----------

const CELL = 40;
let grid = null, gridMap = null, path = [], pathTick = -99, lastGoal = null;

function buildGrid(arena) {
  const cols = Math.floor(arena.width / CELL);
  const rows = Math.floor(arena.height / CELL);
  const free = new Uint8Array(cols * rows);
  const pad = 30; // корпус 24 + запас
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * CELL + CELL / 2, y = r * CELL + CELL / 2;
      free[r * cols + c] =
        x > pad && x < arena.width - pad && y > pad && y < arena.height - pad &&
        !arena.walls.some((w) => pointInWall(x, y, pad, w)) ? 1 : 0;
    }
  }
  return { cols, rows, free };
}

function cellOf(g, x, y) {
  const c = clamp(Math.floor(x / CELL), 0, g.cols - 1);
  const r = clamp(Math.floor(y / CELL), 0, g.rows - 1);
  return r * g.cols + c;
}

function nearestFreeCell(g, idx) {
  if (g.free[idx]) return idx;
  const r0 = Math.floor(idx / g.cols), c0 = idx % g.cols;
  for (let rad = 1; rad < 9; rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
        const r = r0 + dr, c = c0 + dc;
        if (r >= 0 && r < g.rows && c >= 0 && c < g.cols && g.free[r * g.cols + c]) return r * g.cols + c;
      }
    }
  }
  return idx;
}

function bfsPath(g, from, to) {
  if (from === to) return [];
  const prev = new Int32Array(g.cols * g.rows).fill(-1);
  const q = [from];
  prev[from] = from;
  for (let head = 0; head < q.length; head++) {
    const cur = q[head];
    if (cur === to) break;
    const r = Math.floor(cur / g.cols), c = cur % g.cols;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= g.rows || cc < 0 || cc >= g.cols) continue;
        const n = rr * g.cols + cc;
        if (!g.free[n] || prev[n] !== -1) continue;
        if (dr && dc && (!g.free[r * g.cols + cc] || !g.free[rr * g.cols + c])) continue; // без срезания углов
        prev[n] = cur;
        q.push(n);
      }
    }
  }
  if (prev[to] === -1) return [];
  const out = [];
  for (let n = to; n !== from; n = prev[n]) {
    out.push({ x: (n % g.cols) * CELL + CELL / 2, y: Math.floor(n / g.cols) * CELL + CELL / 2 });
  }
  return out.reverse();
}

// Путь к цели с перепланированием и срезанием лишних точек.
function navigate(s, gx, gy) {
  const { me, arena } = s;
  const walls = arena.walls;
  if (!grid || gridMap !== arena.mapName) { grid = buildGrid(arena); gridMap = arena.mapName; path = []; }
  const goalMoved = !lastGoal || dist(lastGoal.x, lastGoal.y, gx, gy) > 90;
  if (s.tick - pathTick > 12 || path.length === 0 || goalMoved) {
    const g = grid;
    path = bfsPath(g, nearestFreeCell(g, cellOf(g, me.x, me.y)), nearestFreeCell(g, cellOf(g, gx, gy)));
    pathTick = s.tick;
    lastGoal = { x: gx, y: gy };
  }
  while (path.length && dist(me.x, me.y, path[0].x, path[0].y) < 26) path.shift();
  while (path.length > 1 && !segBlocked(me.x, me.y, path[1].x, path[1].y, walls, 24)) path.shift();
  return path[0] || { x: gx, y: gy };
}

// Отталкивание от стен и границ поля, чтобы не тереть борт.
function wallRepel(me, arena) {
  let vx = 0, vy = 0;
  for (const w of arena.walls) {
    const cx = clamp(me.x, w.x, w.x + w.w), cy = clamp(me.y, w.y, w.y + w.h);
    const d = dist(me.x, me.y, cx, cy);
    if (d < 90 && d > 1e-6) {
      const k = ((90 - d) / 90) * 1.4;
      vx += ((me.x - cx) / d) * k;
      vy += ((me.y - cy) / d) * k;
    }
  }
  const m = 70;
  if (me.x < m) vx += ((m - me.x) / m) * 1.2;
  if (me.x > arena.width - m) vx -= ((me.x - (arena.width - m)) / m) * 1.2;
  if (me.y < m) vy += ((m - me.y) / m) * 1.2;
  if (me.y > arena.height - m) vy -= ((me.y - (arena.height - m)) / m) * 1.2;
  return { x: vx, y: vy };
}

// Вектор руления -> газ и поворот корпуса (с задним ходом, если цель позади).
function driveVec(me, vx, vy) {
  const len = Math.hypot(vx, vy);
  if (len < 1e-4) return { throttle: 0, turn: 0 };
  const want = Math.atan2(vy, vx);
  const diff = norm(want - me.heading);
  if (Math.abs(diff) > 2.15) {
    const back = norm(want + PI - me.heading);
    return { throttle: -0.9, turn: clamp(back * 3, -1, 1) };
  }
  return { throttle: Math.cos(diff) > 0.4 ? 1 : 0.3, turn: clamp(diff * 3.2, -1, 1) };
}

// ---------- состояние модуля ----------

let orbitDir = 1;
let orbitFlip = 3;
let jinkGate = 0;
let dodgeId = null;   // снаряд, от которого уклоняюсь
let dodgeSide = 1;    // выбранная сторона уклонения — не меняется в полёте
let stuckTicks = 0;
let lastPos = null;

export default {
  name: 'ЗАРЯ',
  motto: 'Рассвет не спрашивает разрешения.',
  stats: { armor: 2, engine: 3, gun: 3, reload: 2 },

  init(info) {
    orbitDir = noise(info.round * 7 + info.side * 13 + 3) > 0.5 ? 1 : -1;
    orbitFlip = 2.5 + noise(info.round + 1) * 2;
    jinkGate = 0;
    dodgeId = null;
    dodgeSide = 1;
    stuckTicks = 0;
    lastPos = null;
    grid = null; gridMap = null; path = []; pathTick = -99; lastGoal = null;
  },

  tick(s) {
    const { me, enemy, arena, zone } = s;
    const walls = arena.walls;

    // --- 1. Прицел с опережением (итеративное предсказание) ---
    let aim = { x: enemy.x, y: enemy.y };
    if (enemy.alive) {
      for (let i = 0; i < 4; i++) {
        const t = dist(me.x, me.y, aim.x, aim.y) / me.stats.bulletSpeed;
        aim = { x: enemy.x + enemy.vx * t, y: enemy.y + enemy.vy * t };
      }
    }
    const aimAngle = Math.atan2(aim.y - me.y, aim.x - me.x);
    const aimDiff = norm(aimAngle - me.turret);
    const turretTurn = clamp(aimDiff * 6, -1, 1);

    // --- 2. Выстрел: ровный угол + чистый ствол + чистая линия ---
    let fire = false;
    if (enemy.alive && Math.abs(aimDiff) < 0.05) {
      const mx = me.x + Math.cos(me.turret) * 34;
      const my = me.y + Math.sin(me.turret) * 34;
      const muzzleFree = !outside(mx, my, arena, 5) && !walls.some((w) => pointInWall(mx, my, 5, w));
      fire = muzzleFree && !segBlocked(mx, my, aim.x, aim.y, walls, 5);
    }

    // --- 3. Угроза: ближайший снаряд, который пройдёт рядом ---
    let threat = null;
    for (const b of s.bullets) {
      if (b.mine && !b.canHitOwner) continue;
      const vv = b.vx * b.vx + b.vy * b.vy;
      if (vv < 1e-6) continue;
      const rx = me.x - b.x, ry = me.y - b.y;
      const t = (rx * b.vx + ry * b.vy) / vv;
      if (t < 0 || t > 1.1) continue;
      const cx = b.x + b.vx * t - me.x, cy = b.y + b.vy * t - me.y;
      const miss = Math.hypot(cx, cy);
      if (miss < 46 && (!threat || t < threat.t)) threat = { b, t, cx, cy };
    }
    // Если уже уклоняюсь от снаряда и он всё ещё опасен — не переключаюсь.
    if (dodgeId !== null && threat && threat.b.id !== dodgeId) {
      const committed = s.bullets.find((b) => b.id === dodgeId);
      if (committed) {
        const vv = committed.vx * committed.vx + committed.vy * committed.vy;
        const rx = me.x - committed.x, ry = me.y - committed.y;
        const t = (rx * committed.vx + ry * committed.vy) / vv;
        const cx = committed.x + committed.vx * t - me.x, cy = committed.y + committed.vy * t - me.y;
        if (t >= 0 && t <= 1.1 && Math.hypot(cx, cy) < 46) threat = { b: committed, t, cx, cy, committed: true };
      }
    }

    // --- 3б. Джинк: соперник вот-вот выстрелит — ломаем предсказуемость,
    // чтобы его опережение било в пустоту (не чаще раза в секунду).
    const dEnemy = dist(me.x, me.y, enemy.x, enemy.y);
    if (enemy.alive && dEnemy < 640 && enemy.reloadLeft < 0.18 && s.time > jinkGate) {
      orbitDir = -orbitDir;
      jinkGate = s.time + 0.8 + noise(s.time * 5.1) * 0.8;
    }

    // --- 4. Выбор манёвра ---
    const zoneDist = dist(me.x, me.y, zone.x, zone.y);
    const zoneEdge = zone.radius - zoneDist;
    const prefRange = clamp(zone.radius * 0.62, 210, 380);
    let drive = null; // готовый вектор руления

    // 4а. Уклонение — приоритет номер один. Сторона выбирается один раз
    // на снаряд (сразу проверяем, где свободно) и держится до конца.
    if (threat) {
      const pa = Math.atan2(threat.b.vy, threat.b.vx) + PI / 2;
      if (dodgeId !== threat.b.id) {
        dodgeId = threat.b.id;
        let s0 = Math.sign(-(threat.cx * Math.cos(pa) + threat.cy * Math.sin(pa))) || orbitDir;
        const step = 90;
        const ax = me.x + Math.cos(pa) * step * s0, ay = me.y + Math.sin(pa) * step * s0;
        const bx = me.x - Math.cos(pa) * step * s0, by = me.y - Math.sin(pa) * step * s0;
        const badA = outside(ax, ay, arena, 30) || segBlocked(me.x, me.y, ax, ay, walls, 26);
        const badB = outside(bx, by, arena, 30) || segBlocked(me.x, me.y, bx, by, walls, 26);
        if (badA && !badB) s0 = -s0;
        dodgeSide = s0;
      }
      const w = threat.t < 0.4 ? 2.4 : 1.6;
      const rep = wallRepel(me, arena);
      drive = {
        x: Math.cos(pa) * dodgeSide * w + rep.x * 0.7,
        y: Math.sin(pa) * dodgeSide * w + rep.y * 0.7,
      };
    }

    // 4б. Без снарядов рядом: зона / аптечка / бой.
    if (!drive) {
      let vx = 0, vy = 0;

      if (!enemy.alive) {
        // Соперник уничтожен: выжить — стоять в центре зоны.
        const wp = navigate(s, zone.x, zone.y);
        const dw = dist(me.x, me.y, wp.x, wp.y);
        if (dw > 20) { vx = (wp.x - me.x) / dw; vy = (wp.y - me.y) / dw; }
      } else if (zoneEdge < 0) {
        // Уже жжёмся о зону: немедленно внутрь.
        const wp = navigate(s, zone.x, zone.y);
        const dw = dist(me.x, me.y, wp.x, wp.y);
        if (dw > 20) { vx = (wp.x - me.x) / dw; vy = (wp.y - me.y) / dw; }
      } else {
        let navGoal = null;
        // Аптечка: забрать свою или не отдать чужую.
        let kit = null, kitD = Infinity;
        for (const k of s.repairKits) {
          if (!k.active) continue;
          const d = dist(me.x, me.y, k.x, k.y);
          if (d < kitD) { kitD = d; kit = k; }
        }
        if (kit) {
          const enemyD = dist(enemy.x, enemy.y, kit.x, kit.y);
          const wantHeal = me.hp < 0.72 * me.maxHp;
          const wantDeny = me.hp < 0.95 * me.maxHp && kitD * 1.6 < enemyD && enemyD > 260;
          if ((wantHeal || wantDeny) && kitD < 750) navGoal = kit;
        }
        // Зона начинает сжиматься — заранее смещаемся внутрь.
        const zonePull = s.time > 50 ? clamp((190 - zoneEdge) / 190, 0, 1) * 1.7 : 0;

        if (navGoal) {
          const wp = navigate(s, navGoal.x, navGoal.y);
          const dw = dist(me.x, me.y, wp.x, wp.y);
          if (dw > 16) { vx = (wp.x - me.x) / dw; vy = (wp.y - me.y) / dw; }
        } else {
          // Бой: орбита вокруг соперника на рабочей дистанции.
          const ux = (me.x - enemy.x) / (dEnemy || 1), uy = (me.y - enemy.y) / (dEnemy || 1);
          if (s.time > orbitFlip) {
            orbitDir = -orbitDir;
            orbitFlip = s.time + 2.5 + noise(s.time * 3.7) * 2.5;
          }
          const radial = dEnemy > prefRange + 80 ? -0.85 : dEnemy < prefRange - 80 ? 0.9 : 0.15;
          // Пока соперник перезаряжается — движение спокойнее, прицел точнее.
          const tangW = enemy.reloadLeft > 0.7 && dEnemy < 520 ? 0.6 : 0.85;
          vx += ux * radial - uy * orbitDir * tangW;
          vy += uy * radial + ux * orbitDir * tangW;
          // Если врага не видно из-за стены — идём к нему по пути.
          if (!segBlocked(me.x, me.y, enemy.x, enemy.y, walls, 30)) {
            if (dEnemy > 560) { vx += -ux * 0.7; vy += -uy * 0.7; }
          } else {
            const wp = navigate(s, enemy.x, enemy.y);
            const dw = dist(me.x, me.y, wp.x, wp.y);
            if (dw > 20) { vx += ((wp.x - me.x) / dw) * 0.9; vy += ((wp.y - me.y) / dw) * 0.9; }
          }
        }

        // Тяга в центр зоны (мягкая) поверх основного манёвра.
        if (zonePull > 0 && zoneDist > 1) {
          vx += ((zone.x - me.x) / zoneDist) * zonePull;
          vy += ((zone.y - me.y) / zoneDist) * zonePull;
        }
      }

      // Отталкивание от стен и границ, чтобы не тереть борт.
      const rep = wallRepel(me, arena);
      vx += rep.x;
      vy += rep.y;

      drive = { x: vx, y: vy };
    }

    // --- 5. Антизастревание: дёргаемся назад, если стоим на месте ---
    if (s.tick % 24 === 0) {
      if (lastPos && dist(me.x, me.y, lastPos.x, lastPos.y) < 6) stuckTicks = 26;
      lastPos = { x: me.x, y: me.y };
    }
    if (stuckTicks > 0) {
      stuckTicks--;
      return { throttle: -1, turn: orbitDir, turretTurn, fire };
    }

    const cmd = driveVec(me, drive.x, drive.y);
    return { throttle: cmd.throttle, turn: cmd.turn, turretTurn, fire };
  },
};
