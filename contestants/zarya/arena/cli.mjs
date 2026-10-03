#!/usr/bin/env node
// Sandbox: run your tank against sparring bots without a browser.
//   node arena/cli.mjs                      -> tank/ vs hunter, 8 rounds (all maps, both sides)
//   node arena/cli.mjs --vs dummy --rounds 4
//   node arena/cli.mjs --vs tank            -> mirror match against yourself
//   node arena/cli.mjs --map Каньон --verbose
//   node arena/cli.mjs --fresh                -> each round loads both bots anew: no memory between rounds
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  MAPS, STAT_POINTS, checkStats, createRound, stepRound, botView, roundPlan, DT,
} from './engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function parseArgs(argv) {
  const opts = { tank: 'tank', vs: 'hunter', rounds: 8, map: null, verbose: false, fresh: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vs') opts.vs = argv[++i];
    else if (a === '--rounds') opts.rounds = Number(argv[++i]);
    else if (a === '--map') opts.map = argv[++i];
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--fresh') opts.fresh = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else rest.push(a);
  }
  if (rest[0]) opts.tank = rest[0];
  return opts;
}

function resolveBotDir(spec) {
  const candidates = [resolve(process.cwd(), spec), resolve(root, spec), join(here, 'sparring', spec)];
  for (const c of candidates) if (existsSync(join(c, 'bot.js'))) return c;
  throw new Error(`Не нашёл bot.js для «${spec}». Искал: ${candidates.join(', ')}`);
}

// The query string gives each side its own module instance (mirror matches);
// a distinct `fresh` value forces a brand-new instance with empty module state.
async function importBot(dir, instance, fresh) {
  const url = pathToFileURL(join(dir, 'bot.js')).href + `?instance=${instance}&fresh=${fresh}`;
  const mod = await import(url);
  const bot = mod.default ?? mod;
  if (!bot || typeof bot.tick !== 'function') throw new Error(`${dir}/bot.js: нет export default { tick(state) { ... } }`);
  return bot;
}

async function loadBot(dir, instance) {
  const bot = await importBot(dir, instance, 0);
  const check = checkStats(bot.stats);
  if (!check.ok) throw new Error(`${dir}/bot.js: неверные stats — ${check.error} (всего ${STAT_POINTS} очков, каждое 0..5)`);
  return { bot, dir, instance, name: String(bot.name || 'Без имени'), errors: 0, timeMax: 0, timeSum: 0, calls: 0 };
}

function callBot(entry, fn, arg) {
  const t0 = performance.now();
  try {
    return entry.bot[fn]?.(arg);
  } catch (err) {
    entry.errors++;
    if (entry.errors <= 3) console.error(`  ! ${entry.name}.${fn} бросил ошибку: ${err?.stack || err}`);
    return null;
  } finally {
    const dt = performance.now() - t0;
    if (fn === 'tick') {
      entry.timeMax = Math.max(entry.timeMax, dt);
      entry.timeSum += dt;
      entry.calls++;
    }
  }
}

const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '—');

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('node arena/cli.mjs [папка-танка=tank] [--vs hunter|dummy|tank|путь] [--rounds 8] [--map имя] [--verbose] [--fresh]');
    return;
  }
  const me = await loadBot(resolveBotDir(opts.tank), 0);
  const foe = await loadBot(resolveBotDir(opts.vs), 1);
  const mapFilter = opts.map
    ? MAPS.findIndex((m, i) => m.name.toLowerCase() === opts.map.toLowerCase() || String(i) === opts.map)
    : -1;
  if (opts.map && mapFilter < 0) throw new Error(`Нет карты «${opts.map}». Есть: ${MAPS.map((m) => m.name).join(', ')}`);

  console.log(`\n${me.name}  vs  ${foe.name}   (${opts.rounds} раундов${opts.fresh ? ', боты без памяти между раундами' : ''})\n`);
  const score = { win: 0, loss: 0, draw: 0 };
  const total = { dealt: 0, taken: 0, shots: 0, hits: 0, self: 0 };

  for (let i = 0; i < opts.rounds; i++) {
    if (opts.fresh && i > 0) {
      for (const e of [me, foe]) e.bot = await importBot(e.dir, e.instance, i);
    }
    const plan = roundPlan(i);
    const mapIndex = mapFilter >= 0 ? mapFilter : plan.mapIndex;
    const mySide = plan.swap ? 1 : 0;
    const bySide = mySide === 0 ? [me, foe] : [foe, me];
    const round = createRound({ mapIndex, tanks: bySide.map((e) => ({ name: e.name, stats: e.bot.stats })) });
    for (let s = 0; s < 2; s++) {
      callBot(bySide[s], 'init', {
        round: i, side: s, mapName: round.map.name, view: botView(round, s),
      });
    }
    while (!round.over) {
      const actions = [0, 1].map((s) => callBot(bySide[s], 'tick', botView(round, s)));
      const events = stepRound(round, actions);
      if (opts.verbose) {
        for (const e of events) {
          if (e.type === 'hit' && e.cause !== 'zone') {
            console.log(`  ${round.time.toFixed(1)}с  попадание по ${bySide[e.side].name}: -${e.damage.toFixed(0)}${e.ricochet ? ' (рикошет)' : ''}${e.cause === 'self' ? ' (сам себя)' : ''}`);
          }
          if (e.type === 'pickup') console.log(`  ${round.time.toFixed(1)}с  ${bySide[e.side].name} взял аптечку (+${e.healed})`);
        }
      }
    }
    const mine = round.tanks[mySide];
    const theirs = round.tanks[1 - mySide];
    let result;
    if (round.winner === null) { result = 'НИЧЬЯ '; score.draw++; }
    else if (round.winner === mySide) { result = 'ПОБЕДА'; score.win++; }
    else { result = 'ПОРАЖ.'; score.loss++; }
    total.dealt += mine.tally.damageDealt;
    total.taken += mine.tally.damageTaken;
    total.shots += mine.tally.shots;
    total.hits += mine.tally.hits;
    total.self += mine.tally.selfDamage;
    const how = round.endReason === 'time' ? 'по времени' : 'уничтожение';
    console.log(
      `Раунд ${String(i + 1).padStart(2)} · ${round.map.name.padEnd(9)} · ты ${mySide === 0 ? 'слева ' : 'справа'} · ${result} · ${round.time.toFixed(1).padStart(5)}с ${how.padEnd(11)}` +
      ` · HP ${Math.ceil(mine.hp)}/${mine.stats.maxHp} vs ${Math.ceil(theirs.hp)}/${theirs.stats.maxHp}` +
      ` · точность ${pct(mine.tally.hits, mine.tally.shots)}${mine.tally.selfDamage ? ` · урон себе ${mine.tally.selfDamage.toFixed(0)}` : ''}`,
    );
  }

  console.log(`\nИтог: ${score.win} побед, ${score.loss} поражений, ${score.draw} ничьих`);
  console.log(`Урон нанесён ${total.dealt.toFixed(0)}, получен ${total.taken.toFixed(0)}, точность ${pct(total.hits, total.shots)}, урон себе ${total.self.toFixed(0)}`);
  for (const e of [me, foe]) {
    const avg = e.calls ? e.timeSum / e.calls : 0;
    const warn = e.timeMax > 50 || avg > 5 ? '  ← СЛИШКОМ МЕДЛЕННО: в браузере будут пропуски ходов' : '';
    console.log(`${e.name}: tick в среднем ${avg.toFixed(3)} мс, максимум ${e.timeMax.toFixed(1)} мс, ошибок ${e.errors}${warn}`);
  }
  console.log(`(один тик = ${(DT * 1000).toFixed(1)} мс игрового времени; лимит на ход в браузере — 50 мс)\n`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
