// «ГРАНИТ» — танк с дисциплиной позиции. Стратегия «якорь и волна».
// Якорь: держим позицию внутри будущей зоны с запасом, стеной за спиной и
// дистанцией боя в свою пользу; аптечки при ранении. Волна: давим, когда пушка
// врага перезаряжается, сбавляем ход перед его выстрелом. От пуль — рывок вбок
// со случайной стороной и амплитудой; отскок пули от стены предсказываем заранее
// и уходим ещё до него. Стрельба — по мини-прогнозу движения врага на копии
// физики движка; свой выстрел проверяем на возврат рикошетом в себя.
// Против скорострельных «снайперов» (DPS вдвое выше нашего) отдельная игра:
// держим предельную дистанцию в открытом поле, перехватываем аптечки и
// доживаем до таймаута; на ловушку стреляем, когда край зоны или стена
// отрезает уклонение. Рикошетов сами не делаем сознательно.

const PI = Math.PI, TAU = PI * 2, DT = 1 / 30;
const W = 1600, H = 900;
const TR = 24, BR = 5, HITR = TR + BR, MUZ = TR + 10, ACC = 420;
const ZC = { x: W / 2, y: H / 2 };
const EPS = 1e-6;

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const angle = a => { a = (a + PI) % TAU; return (a < 0 ? a + TAU : a) - PI; };
const lerp = (a, b, k) => a + (b - a) * k;
const tri = t => 4 * Math.abs(t - Math.floor(t) - 0.5) - 1; // треугольная волна −1..1

let walls = [];
let prevEnemy = null, evx = 0, evy = 0, eturn = 0;     // сглаженная скорость и темп поворота врага
let anchor = null, anchorTick = -99;                    // якорная точка
let orbitSign = 1, orbitFlipAt = 0;                     // сторона бокового лавирования
let dodgeSide = 0;                                      // гистерезис стороны уклонения
let swaySign = 1, swayUntil = 0, swayAmp = 60;          // случайное боковое блуждание
let stuckTicks = 0, lastPos = null, burstLeft = 0, burstTurn = 0;
let myLastHp = 0, lastHurtAt = -99;
let seenEnemyAt = 0;

// ---------- геометрия ----------

function contact(x, y, r, w) {
  const dx = x - clamp(x, w.x, w.x + w.w), dy = y - clamp(y, w.y, w.y + w.h);
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return null;
  if (d2 > EPS) { const d = Math.sqrt(d2); return { nx: dx / d, ny: dy / d, depth: r - d }; }
  const l = x - w.x, rr = w.x + w.w - x, t = y - w.y, bb = w.y + w.h - y;
  const m = Math.min(l, rr, t, bb);
  if (m === l) return { nx: -1, ny: 0, depth: l + r };
  if (m === rr) return { nx: 1, ny: 0, depth: rr + r };
  if (m === t) return { nx: 0, ny: -1, depth: t + r };
  return { nx: 0, ny: 1, depth: bb + r };
}

function posSafe(x, y, pad) {
  if (x < pad || x > W - pad || y < pad || y > H - pad) return false;
  for (const w of walls) if (contact(x, y, pad, w)) return false;
  return true;
}

// Пересекает ли отрезок «стены, раздутые на pad» (дискретная, но надёжная проверка).
function segBlocked(ax, ay, bx, by, pad) {
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(len / 12));
  for (let i = 0; i <= steps; i++) {
    const x = ax + dx * i / steps, y = ay + dy * i / steps;
    if (!posSafe(x, y, pad)) return true;
  }
  return false;
}

const los = (a, b, pad = 27) => !segBlocked(a.x, a.y, b.x, b.y, pad);

// Первая стена на пути отрезка (для обхода углом).
function firstWallBetween(a, b, pad) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const steps = Math.max(2, Math.ceil(len / 8));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, x = a.x + dx * t, y = a.y + dy * t;
    if (posSafe(x, y, pad)) continue;
    for (const w of walls) if (contact(x, y, pad, w)) return w;
  }
  return null;
}

// ---------- зона ----------

function zoneRadiusAt(s, time) {
  const k = clamp((time - s.zone.shrinkStart) / (s.zone.shrinkEnd - s.zone.shrinkStart), 0, 1);
  // The observation contains the live radius, so use the arena's original radius
  // when extrapolating the complete linear shrink curve.
  const initialRadius = Math.hypot(s.arena.width / 2, s.arena.height / 2) + 60;
  return initialRadius + (s.zone.finalRadius - initialRadius) * k;
}

// ---------- движение ----------

// Разгон/поворот по формулам движка; ощупывание стены перед носом.
function driveToPoint(s, tx, ty, opts = {}) {
  const me = s.me, st = me.stats;
  const d = Math.hypot(tx - me.x, ty - me.y);
  const want = Math.atan2(ty - me.y, tx - me.x);
  const diff = angle(want - me.heading);
  const reverse = opts.allowReverse && Math.abs(diff) > 2.05 && d > 70;
  let throttle = reverse ? -1 : 1;
  let steer = reverse ? angle(want - me.heading - PI) : diff;
  const stopR = opts.arriveR ?? 26;
  if (d < stopR * 3) throttle *= clamp(d / (stopR * 3), opts.minThrottle ?? 0.12, 1);
  const probe = 62;
  const px = me.x + Math.cos(me.heading) * probe, py = me.y + Math.sin(me.heading) * probe;
  if (!posSafe(px, py, 27) && !reverse) {
    const lOk = posSafe(me.x + Math.cos(me.heading - 0.7) * probe, me.y + Math.sin(me.heading - 0.7) * probe, 27);
    const rOk = posSafe(me.x + Math.cos(me.heading + 0.7) * probe, me.y + Math.sin(me.heading + 0.7) * probe, 27);
    throttle *= 0.55;
    if (lOk && !rOk) steer -= 0.55;
    else if (rOk && !lOk) steer += 0.55;
    else if (!lOk && !rOk) steer += PI / 2;
  }
  const turn = clamp(steer / (st.turnRate * DT), -1, 1);
  return { throttle, turn, d };
}

// Обход: если путь к цели закрыт — целимся в ближний удобный угол той стены.
function waypointAround(s, tx, ty) {
  const me = s.me;
  if (los(me, { x: tx, y: ty }, 28)) return { x: tx, y: ty };
  let cur = { x: tx, y: ty }, hop = 0;
  while (hop < 3) {
    const w = firstWallBetween(me, cur, 28);
    if (!w) break;
    const cands = [
      { x: w.x - 30, y: w.y - 30 }, { x: w.x + w.w + 30, y: w.y - 30 },
      { x: w.x - 30, y: w.y + w.h + 30 }, { x: w.x + w.w + 30, y: w.y + w.h + 30 },
      { x: w.x - 30, y: clamp(me.y, w.y, w.y + w.h) },
      { x: w.x + w.w + 30, y: clamp(me.y, w.y, w.y + w.h) },
      { x: clamp(me.x, w.x, w.x + w.w), y: w.y - 30 },
      { x: clamp(me.x, w.x, w.x + w.w), y: w.y + w.h + 30 },
    ];
    let best = null, bestCost = Infinity;
    for (const c of cands) {
      if (!posSafe(c.x, c.y, 30)) continue;
      const cost = dist(me, c) + dist(c, cur);
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    if (!best) break;
    if (los(me, best, 28)) return best;
    cur = best; hop++;
  }
  return cur;
}

// ---------- угрозы ----------

// Пули, которые сейчас накрывают нас (включая свои рикошеты и ЕЩЁ НЕ СЛУЧИВШИЕСЯ отскоки).
function bulletRayWall(b) {
  // первый отскок по прямой: ищем ближайшую стену/границу на пути
  const sp = Math.hypot(b.vx, b.vy) || 1;
  const dx = b.vx / sp, dy = b.vy / sp;
  let bestT = Infinity, nx = 0, ny = 0;
  const bounds = [
    { t: (BR - b.x) / dx, n: [1, 0] }, { t: (W - BR - b.x) / dx, n: [-1, 0] },
    { t: (BR - b.y) / dy, n: [0, 1] }, { t: (H - BR - b.y) / dy, n: [0, -1] },
  ];
  for (const c of bounds) if (c.t > 0.001 && c.t < bestT) { bestT = c.t; nx = c.n[0]; ny = c.n[1]; }
  for (const w of walls) {
    const cand = [];
    if (Math.abs(dx) > EPS) cand.push((w.x - BR - b.x) / dx, (w.x + w.w + BR - b.x) / dx);
    if (Math.abs(dy) > EPS) cand.push((w.y - BR - b.y) / dy, (w.y + w.h + BR - b.y) / dy);
    for (let t of cand) {
      if (t <= 0.001 || t >= bestT) continue;
      const x = b.x + dx * t, y = b.y + dy * t;
      if (x >= w.x - BR && x <= w.x + w.w + BR && y >= w.y - BR && y <= w.y + w.h + BR) {
        // нормаль грани, о которую придётся удариться
        const dl = x - (w.x - BR), dr = (w.x + w.w + BR) - x, dtp = y - (w.y - BR), db = (w.y + w.h + BR) - y;
        const m = Math.min(dl, dr, dtp, db);
        bestT = t;
        if (m === dl) { nx = -1; ny = 0; } else if (m === dr) { nx = 1; ny = 0; }
        else if (m === dtp) { nx = 0; ny = -1; } else { nx = 0; ny = 1; }
      }
    }
  }
  return bestT < Infinity ? { t: bestT, nx, ny, dx, dy } : null;
}

// Траектория вражеской пули до второго препятствия: прямая + отскок.
function bulletSegments(b) {
  const sp = Math.hypot(b.vx, b.vy);
  if (sp < EPS) return null;
  const dx = b.vx / sp, dy = b.vy / sp;
  const hit = b.bouncesLeft > 0 ? bulletRayWall(b) : null;
  const tB = hit ? hit.t / sp : 9;
  const segs = [{ t0: 0, t1: tB, x0: b.x, y0: b.y, dx, dy }];
  if (hit && tB < 9) {
    const dot = dx * hit.nx + dy * hit.ny;
    segs.push({ t0: tB, t1: tB + 2.5, x0: b.x + dx * hit.t, y0: b.y + dy * hit.t,
      dx: dx - 2 * dot * hit.nx, dy: dy - 2 * dot * hit.ny });
  }
  return { sp, segs };
}

// Перехват: сбить вражескую пулю своей (пули взаимно уничтожаются).
// Траектория пули известна заранее — решаем, куда встать стволом.
function interceptSolution(s) {
  const me = s.me, bs = me.stats.bulletSpeed;
  let best = null;
  for (const b of s.bullets) {
    if (b.mine && !b.canHitOwner) continue;
    const path = bulletSegments(b);
    if (!path) continue;
    for (const seg of path.segs) {
      let T = Math.max(0.05, (dist(me, { x: seg.x0, y: seg.y0 }) - MUZ) / path.sp);
      let ix = 0, iy = 0, miss = Infinity;
      for (let k = 0; k < 4; k++) {
        const bt = seg.t0 + T;
        if (bt < seg.t0 || bt > seg.t1) break;
        ix = seg.x0 + seg.dx * path.sp * bt;
        iy = seg.y0 + seg.dy * path.sp * bt;
        const d = Math.hypot(ix - me.x, iy - me.y);
        T = Math.max(0.03, (d - MUZ) / bs);
        miss = d;
      }
      if (miss === Infinity || T > 1.15) continue;
      // боковой промах при выстреле в найденную точку
      const a = Math.atan2(iy - me.y, ix - me.x);
      const rx = ix - me.x, ry = iy - me.y;
      const lateral = Math.abs(rx * -Math.sin(a) + ry * Math.cos(a));
      if (lateral > 10) continue;
      const score = T + lateral * 0.01;
      if (!best || score < best.score) best = { a, T, score };
    }
  }
  return best;
}

function threatsOn(s) {
  const me = s.me, out = [];
  for (const b of s.bullets) {
    if (b.mine && !b.canHitOwner) continue;
    const sp = Math.hypot(b.vx, b.vy);
    if (sp < EPS) continue;
    const dx = b.vx / sp, dy = b.vy / sp;
    const rx = me.x - b.x, ry = me.y - b.y;
    const along = rx * dx + ry * dy;
    if (along > 0) {
      const cpa = Math.sqrt(Math.max(0, rx * rx + ry * ry - along * along));
      const tHit = along / sp;
      if (cpa < HITR + 12 && tHit < 2.0) { out.push({ id: b.id, dx, dy, cpa, tHit }); continue; }
    }
    // прямой угрозы нет — проверяем отскок заранее, чтобы успеть отойти ДО него
    if (b.bouncesLeft > 0) {
      const hit = bulletRayWall(b);
      if (!hit) continue;
      const tB = hit.t / sp;
      if (tB > 1.4) continue;
      const bx = b.x + hit.dx * hit.t, by = b.y + hit.dy * hit.t;
      const dot = hit.dx * hit.nx + hit.dy * hit.ny;
      const rxd = hit.dx - 2 * dot * hit.nx, ryd = hit.dy - 2 * dot * hit.ny;
      const rx2 = me.x - bx, ry2 = me.y - by;
      const along2 = rx2 * rxd + ry2 * ryd;
      if (along2 <= 0) continue;
      const cpa2 = Math.sqrt(Math.max(0, rx2 * rx2 + ry2 * ry2 - along2 * along2));
      const tHit2 = tB + along2 / sp;
      if (cpa2 < HITR + 14 && tHit2 < 2.0) out.push({ id: b.id, dx: rxd, dy: ryd, cpa: cpa2, tHit: tHit2 });
    }
  }
  out.sort((a, b) => a.tHit - b.tHit);
  return out;
}

// ---------- якорь ----------

function nearestWallDist(x, y) {
  let m = Math.min(x, W - x, y, H - y);
  for (const w of walls) {
    const dx = x - clamp(x, w.x, w.x + w.w), dy = y - clamp(y, w.y, w.y + w.h);
    m = Math.min(m, Math.hypot(dx, dy));
  }
  return m;
}

// Оценка размена: хватит ли нашего HP при текущих DPS.
function tradeFavours(s) {
  const me = s.me, e = s.enemy;
  const myDps = me.stats.damage / me.stats.reloadTime;
  const eDps = e.stats.damage / e.stats.reloadTime;
  const tMe = e.hp / myDps, tE = me.hp / eDps;
  return tMe <= tE * 1.12;
}

function pickAnchor(s) {
  const me = s.me, e = s.enemy;
  const zr = zoneRadiusAt(s, s.time + 6);
  const vulnerable = me.hp < Math.max(110, e.hp * 0.72);
  const myDps = me.stats.damage / me.stats.reloadTime;
  const eDps = e.stats.damage / e.stats.reloadTime;
  const wantRange = clamp(eDps > myDps * 1.25 ? 330 : 250, 170, 360);
  const deficit = me.maxHp - me.hp;
  const cands = [{ x: ZC.x, y: ZC.y }];
  for (let a = 0; a < 8; a++) {
    const ang = a * TAU / 8 + 0.3;
    for (const r of [110, 230]) {
      cands.push({ x: ZC.x + Math.cos(ang) * r, y: ZC.y + Math.sin(ang) * r });
    }
  }
  if (deficit >= 45) for (const k of s.repairKits) cands.push({ x: k.x, y: k.y, kit: k });
  let best = null, bestScore = Infinity;
  for (const c of cands) {
    const p = { x: clamp(c.x, 40, W - 40), y: clamp(c.y, 40, H - 40) };
    if (!posSafe(p.x, p.y, 30)) continue;
    const dz = dist(p, ZC);
    if (dz > zr - 46 && !(c.kit && dist(c.kit, ZC) < zr + 60)) continue;
    let score = 0;
    score += dz * 0.22;
    const dE = dist(p, e);
    score += Math.abs(dE - wantRange) * 0.85;
    const covered = !los(p, e, 9);
    if (covered) score += vulnerable ? -260 : +90;
    if (dE < 150) score += (150 - dE) * 2.2;
    score += (50 - Math.min(50, nearestWallDist(p.x, p.y))) * 0.5;
    score += dist(me, p) * 0.6;
    if (c.kit && !c.kit.active) score += 1e4;
    if (deficit >= 45 && c.kit && c.kit.active) score -= 300;
    const myEta = dist(me, p) / me.stats.maxSpeed;
    const eEta = dist(e, p) / Math.max(60, e.stats.maxSpeed);
    if (c.kit && eEta + 1.2 < myEta && e.hp < e.maxHp - 30) score += 800;
    if (score < bestScore) { bestScore = score; best = p; }
  }
  return best || { x: ZC.x, y: ZC.y };
}

// ---------- мини-прогноз врага (копия физики движка) ----------

let ePath = [], ePathTick = -99;

function enemyPath(s) {
  const e = s.enemy;
  if (ePathTick === s.tick - 1 && ePath.length) return ePath; // кэш на тик
  const pts = [{ x: e.x, y: e.y }];
  const p = { x: e.x, y: e.y, heading: e.heading, speed: e.speed };
  const tr = clamp(eturn / (e.stats.turnRate || 1), -1, 1);
  for (let i = 1; i <= 48; i++) {
    p.heading = angle(p.heading + tr * e.stats.turnRate * DT);
    const target = p.speed * (1 - 0.015 * i); // газ врага неизвестен — считаем, что ход гаснет
    p.speed += clamp(target - p.speed, -ACC * DT, ACC * DT);
    p.x += Math.cos(p.heading) * p.speed * DT;
    p.y += Math.sin(p.heading) * p.speed * DT;
    // стены движок гасит — отражаем позицию, чтобы прогноз не уводил внутрь
    for (const w of walls) {
      const c = contact(p.x, p.y, TR, w);
      if (c) { p.x += c.nx * c.depth; p.y += c.ny * c.depth; }
    }
    p.x = clamp(p.x, TR, W - TR); p.y = clamp(p.y, TR, H - TR);
    pts.push({ x: p.x, y: p.y });
  }
  ePath = pts; ePathTick = s.tick;
  return pts;
}

// Свободный ход поперёк линии выстрела: сколько враг успевает сместиться вбок
// за время полёта снаряда и сколько места у него с каждой стороны.
function dodgeRooms(s, predicted, flightT, shotDir) {
  const e = s.enemy;
  const nx = -shotDir.y, ny = shotDir.x;
  const latNow = Math.abs(evx * nx + evy * ny);
  const cap = Math.min(e.stats.maxSpeed, latNow + ACC * flightT * 0.5) * flightT + 6;
  const rooms = [];
  for (const side of [1, -1]) {
    const zr = zoneRadiusAt(s, s.time + flightT);
    let room = cap + 42;
    const step = 10;
    for (let d = step; d <= cap + 42; d += step) {
      const x = predicted.x + nx * side * d, y = predicted.y + ny * side * d;
      if (!posSafe(x, y, 30) || dist({ x, y }, ZC) > zr - 10) { room = d - step; break; }
    }
    rooms.push(room);
  }
  return { cap, rooms, nx, ny };
}

// Безопасность выстрела: не стреляем, если наш снаряд после отскока может вернуться в нас.
function shotSafeForMe(s, a) {
  const me = s.me, bs = me.stats.bulletSpeed;
  const dx = Math.cos(a), dy = Math.sin(a);
  const muz = { x: me.x + dx * MUZ, y: me.y + dy * MUZ };
  const fake = { x: muz.x, y: muz.y, vx: dx * bs, vy: dy * bs, bouncesLeft: 1 };
  const hit = bulletRayWall(fake);
  if (!hit) return true; // уйдёт без отскока
  const bx = muz.x + dx * hit.t, by = muz.y + dy * hit.t;
  const dot = dx * hit.nx + dy * hit.ny;
  const rxd = dx - 2 * dot * hit.nx, ryd = dy - 2 * dot * hit.ny;
  const rx = me.x - bx, ry = me.y - by;
  const along = rx * rxd + ry * ryd;
  if (along <= 0) return true;
  const cpa = Math.sqrt(Math.max(0, rx * rx + ry * ry - along * along));
  const tHit = (hit.t + along) / bs;
  return !(cpa < HITR + 45 && tHit < 3.5); // запас на неточность прогноза отскока у углов
}

// Умный отход: перебираем 8 направлений, ищем просторное и прочь от врага.
function retreatDirection(s) {
  const me = s.me, e = s.enemy;
  const zr = zoneRadiusAt(s, s.time + 4);
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < 8; i++) {
    const a = i * TAU / 8;
    const dx = Math.cos(a), dy = Math.sin(a);
    // простор: как далеко можно проехать в этом направлении
    let room = 0;
    for (let d = 20; d <= 240; d += 20) {
      if (!posSafe(me.x + dx * d, me.y + dy * d, 30)) break;
      room = d;
    }
    // дальше от врага, ближе к центру зоны, подальше от стен (у стен не отбить рикошет)
    const px = me.x + dx * 120, py = me.y + dy * 120;
    const gainE = dist({ x: px, y: py }, e) - dist(me, e);
    const gainZ = (zr - dist({ x: px, y: py }, ZC)) - (zr - dist(me, ZC));
    const wallPen = Math.max(0, 70 - nearestWallDist(px, py)) * 2.2;
    const score = room * 1.1 + gainE * 0.9 + gainZ * 0.7 - wallPen;
    if (score > bestScore) { bestScore = score; best = { x: dx, y: dy }; }
  }
  return best || { x: ZC.x - me.x, y: ZC.y - me.y };
}

// Прицеливание. Приоритет: 1) ловушка против снайпера, 2) обычное упреждение.
function aim(s, sniperClass, th) {
  const me = s.me, e = s.enemy, bs = me.stats.bulletSpeed;

  const spd = Math.hypot(evx, evy);
  let t = dist(me, e) / bs, px = e.x, py = e.y;
  if (spd < 25) {
    px = e.x; py = e.y;
  } else {
    const path = enemyPath(s);
    const idx = clamp(Math.round(t / DT), 0, path.length - 1);
    px = path[idx].x; py = path[idx].y;
    const linT = Math.min(t, 0.7);
    px = lerp(px, e.x + evx * linT, 0.3);
    py = lerp(py, e.y + evy * linT, 0.3);
    t = Math.hypot(px - me.x, py - me.y) / bs;
  }
  const dE = dist(me, e);
  let want = Math.atan2(py - me.y, px - me.x);
  if (sniperClass) {
    // ловушка: если сторона отхода отрезана — целимся в точку вынужденного рывка;
    // в открытых полях стреляем обычным упреждением — давим, не ждём погоды
    const shotDir = { x: (px - me.x) / (dE || 1), y: (py - me.y) / (dE || 1) };
    const dr = dodgeRooms(s, { x: px, y: py }, t, shotDir);
    const blockedL = dr.rooms[0] <= dr.cap + 40, blockedR = dr.rooms[1] <= dr.cap + 40;
    if (dE >= 175 && (blockedL || blockedR)) {
      const openSide = blockedL ? -1 : 1;
      const expected = clamp(Math.min(dr.cap, dr.rooms[openSide === 1 ? 0 : 1] * 0.6) * 0.7, 10, 34);
      px += dr.nx * openSide * expected;
      py += dr.ny * openSide * expected;
      want = Math.atan2(py - me.y, px - me.x);
    }
  }
  const diff = angle(want - me.turret);
  const turretTurn = clamp(diff / (2.8 * DT), -1, 1);
  const residual = Math.abs(diff) - Math.min(Math.abs(diff), 2.8 * DT);
  const muzzle = { x: me.x + Math.cos(want) * MUZ, y: me.y + Math.sin(want) * MUZ };
  const muzzleOk = posSafe(muzzle.x, muzzle.y, BR + 0.5);
  const clearShot = muzzleOk && los(me, e, 8);
  let gate = Math.atan2(13, t * bs + MUZ);
  const lateral = Math.abs(evx * -Math.sin(want) + evy * Math.cos(want));
  if (lateral < 45) gate = Math.atan2(19, t * bs + MUZ);
  if (dE < 140) gate = Math.atan2(24, dE);
  if (e.hp <= me.stats.damage + 4 && clearShot) gate = Math.atan2(45, Math.max(60, dE));
  const fire = clearShot && shotSafeForMe(s, want) && me.reloadLeft <= DT + EPS && residual < gate;
  return { turretTurn, fire };
}

// ---------- основной цикл ----------

export default {
  name: 'ГРАНИТ',
  motto: 'Прочность важнее скорости.',
  stats: { armor: 2, engine: 3, gun: 2, reload: 3 },

  init(info) {
    walls = info.view.arena.walls;
    prevEnemy = null; evx = 0; evy = 0; eturn = 0;
    anchor = null; anchorTick = -99; ePath = []; ePathTick = -99;
    orbitSign = info.side ? -1 : 1; orbitFlipAt = 0;
    dodgeSide = 0;
    swaySign = Math.random() < 0.5 ? -1 : 1; swayUntil = 0; swayAmp = 60;
    stuckTicks = 0; lastPos = null; burstLeft = 0; burstTurn = 0;
    myLastHp = info.view.me.hp; lastHurtAt = -99;
    seenEnemyAt = 0;
  },

  tick(s) {
    const me = s.me, e = s.enemy;
    walls = s.arena.walls;

    // --- телеметрия врага ---
    if (prevEnemy && s.tick > prevEnemy.tick) {
      const dt = (s.tick - prevEnemy.tick) * s.dt;
      if (dt > 0) {
        const vx = (e.x - prevEnemy.x) / dt, vy = (e.y - prevEnemy.y) / dt;
        evx = evx * 0.65 + vx * 0.35;
        evy = evy * 0.65 + vy * 0.35;
        const tr = clamp(angle(e.heading - prevEnemy.heading) / dt, -e.stats.turnRate, e.stats.turnRate);
        eturn = eturn * 0.6 + tr * 0.4;
      }
    }
    prevEnemy = { tick: s.tick, x: e.x, y: e.y, heading: e.heading };
    if (me.hp < myLastHp - 0.5) lastHurtAt = s.time;
    myLastHp = me.hp;

    if (e.alive) seenEnemyAt = s.time;
    const visible = los(me, e, 9);

    // --- случайное боковое блуждание: ломает прогнозы на упреждение ---
    if (s.time >= swayUntil) {
      if (Math.random() < 0.7) swaySign = -swaySign;
      swayAmp = 55 + Math.random() * 65;
      swayUntil = s.time + 0.3 + Math.random() * 0.55;
    }

    // --- антизастревание ---
    if (lastPos) stuckTicks = dist(me, lastPos) < 2.2 ? stuckTicks + 1 : 0;
    lastPos = { x: me.x, y: me.y };
    if (stuckTicks > 40 && burstLeft <= 0) {
      burstLeft = 18;
      burstTurn = ((s.tick & 1) * 2 - 1);
      stuckTicks = 0;
    }

    // --- якорь ---
    const zrNow = zoneRadiusAt(s, s.time);
    const zrSoon = zoneRadiusAt(s, s.time + 5);
    const needZone = dist(me, ZC) > zrSoon - 40;
    if (needZone || s.tick - anchorTick >= 15 || !anchor) {
      anchor = pickAnchor(s);
      anchorTick = s.tick;
    }

    // --- выбор точки движения ---
    const th = threatsOn(s);
    if (!th.length) dodgeSide = 0;
    const deficit = me.maxHp - me.hp;
    const eDpsAll = e.stats.damage / e.stats.reloadTime;
    const myDpsAll = me.stats.damage / me.stats.reloadTime;
    const sniperClass = eDpsAll > myDpsAll * 2.0; // скорострельный «снайпер» — другая игра
    const losing = !tradeFavours(s);
    let point = null, allowReverse = true, minThrottle = 0.12;

    const kitWant = deficit >= 45 || sniperClass ? s.repairKits.find(k => {
      if (!k.active) return false;
      const myEta = dist(me, k) / me.stats.maxSpeed;
      const eEta = dist(e, k) / Math.max(60, e.stats.maxSpeed);
      if (sniperClass) {
        // против снайпера аптечка — оружие по времени: отбираем всё, до чего мы быстрее
        return myEta < eEta - 0.5 && dist(me, k) < 520;
      }
      return myEta < eEta + 1.5 && (dist(me, k) < 280 || me.hp < me.maxHp * 0.55);
    }) : null;

    if (th.length && th[0].tHit < 1.6) {
      // решительный рывок поперёк линии пули, чуть назад — тянем время;
      // сторону и амплитуду выбираем случайно — чтобы не читали
      const n1 = { x: -th[0].dy, y: th[0].dx };
      if (!dodgeSide) {
        const pos = posSafe(me.x + n1.x * 70, me.y + n1.y * 70, 30) &&
          dist({ x: me.x + n1.x * 70, y: me.y + n1.y * 70 }, ZC) < zrNow - 15;
        dodgeSide = pos ? 1 : (posSafe(me.x - n1.x * 70, me.y - n1.y * 70, 30) ? (Math.random() < 0.5 ? -1 : 1) : -1);
      }
      const amp = 62 + Math.random() * 45;
      point = {
        x: me.x + n1.x * amp * dodgeSide - th[0].dx * 22,
        y: me.y + n1.y * amp * dodgeSide - th[0].dy * 22,
      };
      allowReverse = false;
    } else if (kitWant) {
      point = waypointAround(s, kitWant.x, kitWant.y);
    } else if (needZone || !e.alive) {
      point = waypointAround(s, anchor.x, anchor.y);
    } else if (visible && sniperClass) {
      // против «снайпера»: до 58-й секунды — серпантинный отход и удержание дистанции;
      // в эндгейме — обычная волна вплотную: край зоны отрезает его уклонения,
      // и наши ловушки начинают попадать
      const dE = dist(me, e);
      const bx = (e.x - me.x) / dE, by = (e.y - me.y) / dE; // на врага
      const lateEndgame = zrNow < 380;               // зона мала — играем от центра
      let tx, ty;
      if (!lateEndgame) {
        // умный отход на предельную дистанцию: на 550+ его выстрел летит 0.8с
        // и мы успеваем уйти; наша задача — дожить до таймаута и не отдать аптечки
        const rd = retreatDirection(s);
        const sw = swaySign * swayAmp;
        const retreat = clamp(560 - dE, 0, 340);
        tx = me.x + rd.x * (60 + retreat) - rd.y * sw * 0.5;
        ty = me.y + rd.y * (60 + retreat) + rd.x * sw * 0.5;
        point = posSafe(tx, ty, 30) ? { x: tx, y: ty } : { x: me.x + rd.x * 90, y: me.y + rd.y * 90 };
        allowReverse = false;
      } else {
        // финал: встаём кольцом у центра зоны — тогда враг у края зоны всегда
        // отрезан с одной стороны, и наши ловушки бьют в точку вынужденного рывка
        const rad = dist(me, ZC);
        const dirOut = rad > 1 ? { x: (me.x - ZC.x) / rad, y: (me.y - ZC.y) / rad } : { x: 1, y: 0 };
        const ringR = clamp(rad, 110, 150);
        tx = ZC.x + dirOut.x * ringR - dirOut.y * swaySign * 45;
        ty = ZC.y + dirOut.y * ringR + dirOut.x * swaySign * 45;
      }
      point = posSafe(tx, ty, 30) ? { x: tx, y: ty } : { x: ZC.x + (me.x - ZC.x) * 0.4, y: ZC.y + (me.y - ZC.y) * 0.4 };
      allowReverse = false;
    } else if (visible) {
      // бой: «волна» по перезарядке врага + резкое боковое лавирование;
      // невыгодный размен не отменяет активность — просто держим дистанцию дальше
      const dE = dist(me, e);
      const eDps = e.stats.damage / e.stats.reloadTime;
      const myDps = me.stats.damage / me.stats.reloadTime;
      let band = 195;
      if (eDps > myDps * 1.25 || losing) band = 300;
      if (eDps < myDps * 0.8 && !losing) band = 185;
      if (s.time > 96) band = Math.min(band, 195);
      const rl = e.reloadLeft;
      const radial = clamp(dE - band, -80, 110) * (rl > 0.8 ? 1 : rl < 0.45 ? 0.15 : 0.4);
      if (s.time > orbitFlipAt && (s.tick % 70) === 0) { orbitSign *= -1; orbitFlipAt = s.time + 1.2; }
      const bx = (e.x - me.x) / dE, by = (e.y - me.y) / dE;
      const amp = rl < 0.45 ? 46 : 58;               // к выстрелу врага — уже в движении
      const jig = tri(s.tick * 0.13) * amp;          // треугольная волна — резче синуса
      const wx = -by * orbitSign * jig, wy = bx * orbitSign * jig;
      const tx = me.x + bx * radial + wx, ty = me.y + by * radial + wy;
      point = posSafe(tx, ty, 30) ? { x: tx, y: ty } : { x: me.x + bx * radial, y: me.y + by * radial };
    } else if (losing) {
      // врага не видно, размен невыгоден — сидим в укрытии у якоря
      point = waypointAround(s, anchor.x, anchor.y);
    } else {
      // врага не видно: если мы впереди по HP — стоим на якоре, иначе ищем
      const ahead = me.hp / me.maxHp >= e.hp / Math.max(1, e.maxHp) - 0.02;
      if (ahead) {
        point = waypointAround(s, anchor.x, anchor.y);
        minThrottle = 0.25;
      } else {
        point = waypointAround(s, e.x, e.y);
      }
    }

    // --- движение ---
    let move;
    if (burstLeft > 0) {
      burstLeft--;
      move = { throttle: -1, turn: burstTurn };
    } else {
      const wp = waypointAround(s, point.x, point.y);
      move = driveToPoint(s, wp.x, wp.y, { allowReverse, minThrottle, arriveR: 22 });
    }

    // --- башня и огонь ---
    let shot = { turretTurn: 0, fire: false };
    if (e.alive) {
      shot = aim(s, sniperClass, th);
    }

    return { throttle: move.throttle, turn: move.turn, turretTurn: shot.turretTurn, fire: shot.fire };
  },
};
