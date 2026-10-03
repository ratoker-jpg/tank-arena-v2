// Геометрия поля: лучи против стен, навигационная сетка, прямая видимость.
import { W, H, TANK_R, segClear } from './sim.js';

// Луч из (x, y) по (dx, dy): свободный путь круга танка до стены или края (стены расширены на r).
// Если старт уже внутри расширенной стены и луч уходит от неё — эта стена не мешает.
export function rayFree(x, y, dx, dy, walls, r = TANK_R, maxT = 1e9) {
  let best = maxT;
  // края поля
  if (dx > 1e-9) best = Math.min(best, (W - r - x) / dx);
  else if (dx < -1e-9) best = Math.min(best, (r - x) / dx);
  if (dy > 1e-9) best = Math.min(best, (H - r - y) / dy);
  else if (dy < -1e-9) best = Math.min(best, (r - y) / dy);
  if (best < 0) best = 0;
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    const minX = w.x - r, maxX = w.x2 + r, minY = w.y - r, maxY = w.y2 + r;
    let t0 = -1e9, t1 = 1e9;
    if (Math.abs(dx) < 1e-12) { if (x < minX || x > maxX) continue; }
    else {
      let ta = (minX - x) / dx, tb = (maxX - x) / dx;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    }
    if (Math.abs(dy) < 1e-12) { if (y < minY || y > maxY) continue; }
    else {
      let ta = (minY - y) / dy, tb = (maxY - y) / dy;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    }
    if (t0 > t1 || t1 < 0) continue;
    if (t0 < 0) {
      // Старт внутри расширенной стены: мешает, только если движемся к её телу.
      const px = x < w.x ? w.x : x > w.x2 ? w.x2 : x;
      const py = y < w.y ? w.y : y > w.y2 ? w.y2 : y;
      if ((x - px) * dx + (y - py) * dy >= 0) continue;
      return 0;
    }
    if (t0 < best) best = t0;
  }
  return best;
}

// Навигационная сетка: клетки 20 px, свободна, если круг танка (с запасом) не задевает стен.
export const CELL = 20;
export const GC = Math.ceil(W / CELL);
export const GR = Math.ceil(H / CELL);

export function buildFree(walls, pad = TANK_R + 4) {
  const free = new Uint8Array(GC * GR);
  for (let r = 0; r < GR; r++) {
    for (let c = 0; c < GC; c++) {
      const x = c * CELL + CELL / 2, y = r * CELL + CELL / 2;
      let ok = x > pad && x < W - pad && y > pad && y < H - pad;
      for (let i = 0; ok && i < walls.length; i++) {
        const w = walls[i];
        const px = x < w.x ? w.x : x > w.x2 ? w.x2 : x;
        const py = y < w.y ? w.y : y > w.y2 ? w.y2 : y;
        if ((x - px) ** 2 + (y - py) ** 2 < pad * pad) ok = false;
      }
      free[r * GC + c] = ok ? 1 : 0;
    }
  }
  return free;
}

// Расстояние от каждой клетки до цели по сетке (Дейкстра на 8 соседях).
export function navField(free, gx, gy, out) {
  const N = GC * GR;
  const dist = out || new Float32Array(N);
  dist.fill(1e9);
  let c0 = Math.max(0, Math.min(GC - 1, Math.floor(gx / CELL)));
  let r0 = Math.max(0, Math.min(GR - 1, Math.floor(gy / CELL)));
  let start = r0 * GC + c0;
  if (!free[start]) {
    let best = -1, bd = 1e18;
    for (let i = 0; i < N; i++) {
      if (!free[i]) continue;
      const x = (i % GC) * CELL + CELL / 2, y = Math.floor(i / GC) * CELL + CELL / 2;
      const d = (x - gx) ** 2 + (y - gy) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return dist;
    start = best;
  }
  // Дейкстра с двоичной кучей.
  const heapI = new Int32Array(N * 4);
  const heapD = new Float64Array(N * 4);
  let hn = 0;
  const push = (i, d) => {
    let k = hn++;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heapD[p] <= d) break;
      heapI[k] = heapI[p]; heapD[k] = heapD[p]; k = p;
    }
    heapI[k] = i; heapD[k] = d;
  };
  const pop = () => {
    const top = heapI[0];
    const li = heapI[--hn], ld = heapD[hn];
    let k = 0;
    for (;;) {
      let c = 2 * k + 1;
      if (c >= hn) break;
      if (c + 1 < hn && heapD[c + 1] < heapD[c]) c++;
      if (heapD[c] >= ld) break;
      heapI[k] = heapI[c]; heapD[k] = heapD[c]; k = c;
    }
    heapI[k] = li; heapD[k] = ld;
    return top;
  };
  const sx = (start % GC) * CELL + CELL / 2, sy = Math.floor(start / GC) * CELL + CELL / 2;
  dist[start] = Math.hypot(sx - gx, sy - gy);
  push(start, dist[start]);
  const D1 = CELL, D2 = CELL * Math.SQRT2;
  const NB = [1, 0, D1, -1, 0, D1, 0, 1, D1, 0, -1, D1, 1, 1, D2, 1, -1, D2, -1, 1, D2, -1, -1, D2];
  const done = new Uint8Array(N);
  while (hn > 0) {
    const i = pop();
    if (done[i]) continue;
    done[i] = 1;
    const d = dist[i];
    const c = i % GC, r = (i / GC) | 0;
    for (let q = 0; q < 24; q += 3) {
      const dc = NB[q], dr = NB[q + 1];
      const cc = c + dc, rr = r + dr;
      if (cc < 0 || cc >= GC || rr < 0 || rr >= GR) continue;
      const j = rr * GC + cc;
      if (!free[j] || done[j]) continue;
      if (dc && dr && (!free[r * GC + cc] || !free[rr * GC + c])) continue;
      const nd = d + NB[q + 2];
      if (nd < dist[j]) { dist[j] = nd; if (hn < heapI.length) push(j, nd); }
    }
  }
  return dist;
}

// Значение поля в точке (билинейно по центрам клеток, непроходимые клетки — штраф).
export function navAt(field, free, x, y) {
  const fx = x / CELL - 0.5, fy = y / CELL - 0.5;
  let c = Math.floor(fx), r = Math.floor(fy);
  if (c < 0) c = 0; if (c > GC - 2) c = GC - 2;
  if (r < 0) r = 0; if (r > GR - 2) r = GR - 2;
  const tx = Math.min(1, Math.max(0, fx - c)), ty = Math.min(1, Math.max(0, fy - r));
  const i00 = r * GC + c, i10 = i00 + 1, i01 = i00 + GC, i11 = i01 + 1;
  let sum = 0, wsum = 0;
  const add = (i, w) => { if (w <= 0) return; const v = field[i]; if (v < 1e8) { sum += v * w; wsum += w; } };
  add(i00, (1 - tx) * (1 - ty)); add(i10, tx * (1 - ty)); add(i01, (1 - tx) * ty); add(i11, tx * ty);
  if (wsum === 0) return 1e6;
  return sum / wsum;
}

export function los(x1, y1, x2, y2, walls, pad = 5) {
  return segClear(x1, y1, x2, y2, walls, pad);
}

// Расстояние от точки до ближайшей стены/края (для запаса хода).
export function wallClearance(x, y, walls) {
  let d = Math.min(x, W - x, y, H - y);
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    const px = x < w.x ? w.x : x > w.x2 ? w.x2 : x;
    const py = y < w.y ? w.y : y > w.y2 ? w.y2 : y;
    const dd = Math.hypot(x - px, y - py);
    if (dd < d) d = dd;
  }
  return d;
}

// Луч до первой стены с нормалью грани: { t, nx, ny } (круг радиуса r, стены расширены на r).
// Углы расширенных стен считаются прямыми — для оценки направлений отскока этого достаточно.
export function rayHit(x, y, dx, dy, walls, r = 5, maxT = 4000) {
  let best = maxT, bnx = 0, bny = 0;
  if (dx > 1e-9) { const t = (W - r - x) / dx; if (t < best) { best = t; bnx = -1; bny = 0; } }
  else if (dx < -1e-9) { const t = (r - x) / dx; if (t < best) { best = t; bnx = 1; bny = 0; } }
  if (dy > 1e-9) { const t = (H - r - y) / dy; if (t < best) { best = t; bnx = 0; bny = -1; } }
  else if (dy < -1e-9) { const t = (r - y) / dy; if (t < best) { best = t; bnx = 0; bny = 1; } }
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    const minX = w.x - r, maxX = w.x2 + r, minY = w.y - r, maxY = w.y2 + r;
    let t0 = -1e9, t1 = 1e9, ax = 0, ay = 0;
    if (Math.abs(dx) < 1e-12) { if (x < minX || x > maxX) continue; }
    else {
      let ta = (minX - x) / dx, tb = (maxX - x) / dx, nx = -1;
      if (ta > tb) { const t = ta; ta = tb; tb = t; nx = 1; }
      if (ta > t0) { t0 = ta; ax = nx; ay = 0; }
      if (tb < t1) t1 = tb;
    }
    if (Math.abs(dy) < 1e-12) { if (y < minY || y > maxY) continue; }
    else {
      let ta = (minY - y) / dy, tb = (maxY - y) / dy, ny = -1;
      if (ta > tb) { const t = ta; ta = tb; tb = t; ny = 1; }
      if (ta > t0) { t0 = ta; ax = 0; ay = ny; }
      if (tb < t1) t1 = tb;
    }
    if (t0 > t1 || t1 < 0 || t0 < 0) continue;
    if (t0 < best) { best = t0; bnx = ax; bny = ay; }
  }
  return { t: Math.max(0, best), nx: bnx, ny: bny };
}
