// Точная копия физики arena/engine.js для расчётов внутри бота.
// Совпадение с движком до бита проверяется lab/tools/verify-sim.mjs.

export const DT = 1 / 30;
export const W = 1600;
export const H = 900;
export const TANK_R = 24;
export const BULLET_R = 5;
export const HIT_R = TANK_R + BULLET_R;
export const HIT_R2 = HIT_R * HIT_R;
export const MUZZLE = TANK_R + 10;
export const TURRET_RATE = 2.8;
export const TURRET_STEP = TURRET_RATE * DT;
export const ACCEL = 420;
export const REV = 0.6;
export const BULLET_LIFE = 4;
export const ROUND_T = 120;
export const KIT_R = 16;
export const KIT_PICK = TANK_R + KIT_R;
export const ZONE_START = 60;
export const ZONE_END = 100;
export const ZONE_FINAL = 170;
export const ZONE_DPS = 20;
export const ZONE_R0 = Math.hypot(W / 2, H / 2) + 60;
export const CLASH_D = BULLET_R * 2 + 2;

const DV = ACCEL * DT;

export function norm(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function deriveStats(s) {
  return {
    maxHp: 100 + 25 * s.armor,
    maxSpeed: 110 + 22 * s.engine,
    turnRate: 1.8 + 0.25 * s.engine,
    damage: 18 + 5 * s.gun,
    bulletSpeed: 450 + 50 * s.gun,
    reloadTime: Math.round((1.3 - 0.16 * s.reload) * 100) / 100,
  };
}

// Стены с предвычисленными правыми/нижними краями (те же операции, что в движке)
// и сеткой 40 px: в клетке — стены (в исходном порядке), до которых ближе 80 px.
// Порядок обхода сохраняется, дальние стены пропускаются — результат тот же, что в движке.
export const WG = 40;
const WGC = Math.ceil(W / WG), WGR = Math.ceil(H / WG);
export function prepWalls(walls) {
  const out = walls.map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h, x2: w.x + w.w, y2: w.y + w.h }));
  const cells = new Array(WGC * WGR);
  for (let r = 0; r < WGR; r++) {
    for (let c = 0; c < WGC; c++) {
      const x0 = c * WG, y0 = r * WG, x1 = x0 + WG, y1 = y0 + WG;
      const list = [];
      for (const w of out) {
        const dx = Math.max(0, w.x - x1, x0 - w.x2);
        const dy = Math.max(0, w.y - y1, y0 - w.y2);
        if (dx * dx + dy * dy < 80 * 80) list.push(w);
      }
      cells[r * WGC + c] = list;
    }
  }
  out.cells = cells;
  return out;
}
function cellWalls(walls, x, y) {
  const cells = walls.cells;
  if (!cells) return walls;
  let c = Math.floor(x / WG), r = Math.floor(y / WG);
  if (c < 0) c = 0; else if (c >= WGC) c = WGC - 1;
  if (r < 0) r = 0; else if (r >= WGR) r = WGR - 1;
  return cells[r * WGC + c];
}

export function zoneRadiusAt(t) {
  if (t <= ZONE_START) return ZONE_R0;
  const k = clamp((t - ZONE_START) / (ZONE_END - ZONE_START), 0, 1);
  return ZONE_R0 + (ZONE_FINAL - ZONE_R0) * k;
}

// Выталкивание танка из стен: копия resolveTankWalls. Возвращает true при ударе.
export function resolveWalls(t, allWalls) {
  let bumped = false;
  const walls = cellWalls(allWalls, t.x, t.y);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < walls.length; i++) {
      const w = walls[i];
      const cx = t.x;
      const cy = t.y;
      if (cx < w.x - 25 || cx > w.x2 + 25 || cy < w.y - 25 || cy > w.y2 + 25) continue;
      const px = cx < w.x ? w.x : cx > w.x2 ? w.x2 : cx;
      const py = cy < w.y ? w.y : cy > w.y2 ? w.y2 : cy;
      const dx = cx - px;
      const dy = cy - py;
      const d2 = dx * dx + dy * dy;
      if (d2 >= TANK_R * TANK_R) continue;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        const depth = TANK_R - d;
        t.x += (dx / d) * depth;
        t.y += (dy / d) * depth;
      } else {
        const left = cx - w.x;
        const right = w.x2 - cx;
        const top = cy - w.y;
        const bottom = w.y2 - cy;
        const m = Math.min(left, right, top, bottom);
        if (m === left) t.x += -1 * (left + TANK_R);
        else if (m === right) t.x += 1 * (right + TANK_R);
        else if (m === top) t.y += -1 * (top + TANK_R);
        else t.y += 1 * (bottom + TANK_R);
      }
      bumped = true;
    }
    const nx = t.x < TANK_R ? TANK_R : t.x > W - TANK_R ? W - TANK_R : t.x;
    const ny = t.y < TANK_R ? TANK_R : t.y > H - TANK_R ? H - TANK_R : t.y;
    if (nx !== t.x || ny !== t.y) bumped = true;
    t.x = nx;
    t.y = ny;
  }
  if (bumped) t.v *= 0.6;
  return bumped;
}

// Движение танка за тик без учёта столкновения танков: t = { x, y, h, v }.
// Движок вызывает выталкивание из стен дважды (до и после столкновения танков).
export function stepTank(t, throttle, turn, st, walls) {
  t.h = norm(t.h + turn * st.turnRate * DT);
  const target = throttle >= 0 ? throttle * st.maxSpeed : throttle * st.maxSpeed * REV;
  let dv = target - t.v;
  if (dv < -DV) dv = -DV;
  else if (dv > DV) dv = DV;
  t.v += dv;
  t.x += Math.cos(t.h) * t.v * DT;
  t.y += Math.sin(t.h) * t.v * DT;
  const b1 = resolveWalls(t, walls);
  const b2 = resolveWalls(t, walls);
  return b1 || b2;
}

// Столкновение пули радиуса 5 со стеной или краем: копия boundsHit + circleRect.
// Возвращает нормаль и глубину в out, true при касании.
export function bulletContact(x, y, allWalls, out) {
  if (x < BULLET_R) { out.nx = 1; out.ny = 0; out.depth = BULLET_R - x; return true; }
  if (x > W - BULLET_R) { out.nx = -1; out.ny = 0; out.depth = x - (W - BULLET_R); return true; }
  if (y < BULLET_R) { out.nx = 0; out.ny = 1; out.depth = BULLET_R - y; return true; }
  if (y > H - BULLET_R) { out.nx = 0; out.ny = -1; out.depth = y - (H - BULLET_R); return true; }
  const walls = cellWalls(allWalls, x, y);
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    if (x < w.x - 6 || x > w.x2 + 6 || y < w.y - 6 || y > w.y2 + 6) continue;
    const px = x < w.x ? w.x : x > w.x2 ? w.x2 : x;
    const py = y < w.y ? w.y : y > w.y2 ? w.y2 : y;
    const dx = x - px;
    const dy = y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 >= BULLET_R * BULLET_R) continue;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      out.nx = dx / d; out.ny = dy / d; out.depth = BULLET_R - d;
      return true;
    }
    const left = x - w.x;
    const right = w.x2 - x;
    const top = y - w.y;
    const bottom = w.y2 - y;
    const m = Math.min(left, right, top, bottom);
    if (m === left) { out.nx = -1; out.ny = 0; out.depth = left + BULLET_R; }
    else if (m === right) { out.nx = 1; out.ny = 0; out.depth = right + BULLET_R; }
    else if (m === top) { out.nx = 0; out.ny = -1; out.depth = top + BULLET_R; }
    else { out.nx = 0; out.ny = 1; out.depth = bottom + BULLET_R; }
    return true;
  }
  return false;
}

// Точка вылета в стене или за краем — выстрел пропадает.
export function muzzleBlocked(x, y, walls) {
  return bulletContact(x, y, walls, _c);
}
const _c = { nx: 0, ny: 0, depth: 0 };

export function makeBullet(x, y, vx, vy, owner, bouncesLeft = 1, bounced = false, age = 0) {
  return { x, y, vx, vy, owner, bouncesLeft, bounced, age, dead: false };
}

// Выстрел: пуля из дула. Возвращает null, если дуло в стене.
export function spawnBullet(tx, ty, turret, speed, owner, walls) {
  const dx = Math.cos(turret);
  const dy = Math.sin(turret);
  const x = tx + dx * MUZZLE;
  const y = ty + dy * MUZZLE;
  if (bulletContact(x, y, walls, _c)) return null;
  return makeBullet(x, y, dx * speed, dy * speed, owner);
}

export function bulletSteps(b) {
  const speed = Math.hypot(b.vx, b.vy);
  return Math.max(1, Math.ceil((speed * DT) / 6));
}

// Полёт пуль на nTicks вперёд без танков, с рикошетом и взаимным уничтожением.
// Для каждой пули — трасса подшагов: tr.xs/ys[k*S+s], tr.code[k*S+s]:
//   0 — проверки танка нет (мертва или подшаг отскока), 1 — бьёт только чужих, 2 — может попасть и в стрелка.
// tr.deadAt — первый тик без проверок попадания; tr.goneAt — тик, в котором пуля исчезла (Infinity — жива весь горизонт).
export function traceBullets(bullets, walls, nTicks) {
  const n = bullets.length;
  const sims = new Array(n);
  const tracks = new Array(n);
  for (let i = 0; i < n; i++) {
    const b = bullets[i];
    sims[i] = { x: b.x, y: b.y, vx: b.vx, vy: b.vy, bouncesLeft: b.bouncesLeft, bounced: b.bounced, age: b.age, dead: false };
    const S = bulletSteps(b);
    tracks[i] = { S, xs: new Float64Array(nTicks * S), ys: new Float64Array(nTicks * S), code: new Uint8Array(nTicks * S), deadAt: Infinity, goneAt: Infinity, owner: b.owner, damage: b.damage };
  }
  const c = { nx: 0, ny: 0, depth: 0 };
  for (let k = 0; k < nTicks; k++) {
    for (let i = 0; i < n; i++) {
      const b = sims[i];
      if (b.dead) continue;
      const tr = tracks[i];
      b.age += DT;
      if (b.age > BULLET_LIFE) { b.dead = true; tr.deadAt = k; tr.goneAt = k; continue; }
      const speed = Math.hypot(b.vx, b.vy);
      const steps = Math.max(1, Math.ceil((speed * DT) / 6));
      const sdt = DT / steps;
      const S = tr.S;
      for (let s = 0; s < steps && !b.dead; s++) {
        b.x += b.vx * sdt;
        b.y += b.vy * sdt;
        const j = k * S + (s < S ? s : S - 1);
        if (bulletContact(b.x, b.y, walls, c)) {
          if (b.bouncesLeft > 0) {
            b.bouncesLeft--;
            b.bounced = true;
            b.x += c.nx * c.depth;
            b.y += c.ny * c.depth;
            const dot = b.vx * c.nx + b.vy * c.ny;
            b.vx -= 2 * dot * c.nx;
            b.vy -= 2 * dot * c.ny;
          } else {
            b.dead = true;
            tr.deadAt = k + 1;
            tr.goneAt = k;
          }
          tr.xs[j] = b.x; tr.ys[j] = b.y; tr.code[j] = 0;
          continue;
        }
        tr.xs[j] = b.x; tr.ys[j] = b.y; tr.code[j] = b.bounced ? 2 : 1;
      }
    }
    for (let i = 0; i < n; i++) {
      const a = sims[i];
      if (a.dead) continue;
      for (let j = i + 1; j < n; j++) {
        const b = sims[j];
        if (b.dead || a.dead) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) < CLASH_D) {
          a.dead = true; b.dead = true;
          tracks[i].deadAt = k + 1; tracks[j].deadAt = k + 1;
          tracks[i].goneAt = k; tracks[j].goneAt = k;
        }
      }
    }
  }
  return tracks;
}

// Первый тик (0..), когда трасса пули попадает в танк на позиции (x, y) после хода тика k.
export function trackHitAt(tr, k, x, y, owner) {
  if (k >= tr.deadAt) return false;
  const S = tr.S;
  const base = k * S;
  for (let s = 0; s < S; s++) {
    const code = tr.code[base + s];
    if (code === 0) continue;
    if (code === 1 && owner === tr.owner) continue;
    const dx = x - tr.xs[base + s];
    const dy = y - tr.ys[base + s];
    if (dx * dx + dy * dy < HIT_R2) return true;
  }
  return false;
}

// Минимальный квадрат расстояния трассы до точки на тике k (для запаса уклонения).
export function trackMinD2(tr, k, x, y, owner) {
  if (k >= tr.deadAt) return Infinity;
  const S = tr.S;
  const base = k * S;
  let best = Infinity;
  for (let s = 0; s < S; s++) {
    const code = tr.code[base + s];
    if (code === 0) continue;
    if (code === 1 && owner === tr.owner) continue;
    const dx = x - tr.xs[base + s];
    const dy = y - tr.ys[base + s];
    const d2 = dx * dx + dy * dy;
    if (d2 < best) best = d2;
  }
  return best;
}

// Отрезок против прямоугольника, расширенного на pad (метод плит).
export function segHitsRect(x1, y1, x2, y2, w, pad) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const minX = w.x - pad, maxX = w.x2 + pad, minY = w.y - pad, maxY = w.y2 + pad;
  if (Math.abs(dx) < 1e-12) {
    if (x1 < minX || x1 > maxX) return false;
  } else {
    let ta = (minX - x1) / dx, tb = (maxX - x1) / dx;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  if (Math.abs(dy) < 1e-12) {
    if (y1 < minY || y1 > maxY) return false;
  } else {
    let ta = (minY - y1) / dy, tb = (maxY - y1) / dy;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  return true;
}

export function segClear(x1, y1, x2, y2, walls, pad) {
  for (let i = 0; i < walls.length; i++) if (segHitsRect(x1, y1, x2, y2, walls[i], pad)) return false;
  return true;
}
