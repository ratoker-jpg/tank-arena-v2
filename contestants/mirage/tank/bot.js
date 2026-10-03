// «Мираж»: точная физика внутри, уклонение перебором манёвров, выстрел в центр
// множества достижимых точек соперника. Подробности — brain.js.
import { createBrain } from './brain.js';

const brain = createBrain();

export default {
  name: 'Мираж',
  motto: 'Ты целишься в мираж. Я — в тебя.',
  stats: { armor: 0, engine: 0, gun: 5, reload: 5 },
  init(info) {
    brain.init(info);
  },
  tick(state) {
    return brain.tick(state);
  },
  _brain: brain, // для лабораторных инструментов
};
