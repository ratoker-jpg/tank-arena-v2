// Sparring bot "Манекен": drives in lazy circles and fires roughly at the enemy.

export default {
  name: 'Манекен',
  motto: 'Катаюсь. Иногда стреляю.',
  stats: { armor: 4, engine: 2, gun: 2, reload: 2 },

  tick(s) {
    const { me, enemy } = s;
    const want = Math.atan2(enemy.y - me.y, enemy.x - me.x);
    const diff = Math.atan2(Math.sin(want - me.turret), Math.cos(want - me.turret));
    return {
      throttle: 0.7,
      turn: Math.sin(s.time * 0.8) > 0 ? 0.6 : -0.4,
      turretTurn: Math.max(-1, Math.min(1, diff * 3)),
      fire: Math.abs(diff) < 0.2,
    };
  },
};
