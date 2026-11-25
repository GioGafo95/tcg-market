// Lógica de torneos locales (formato suizo, como en los torneos de Play! Pokémon):
// clasificación, emparejamientos por ronda, récord y rachas de cada jugador.
// Funciones puras: no tocan el almacenamiento.

const key = id => String(id);
export const POINTS = { W: 3, T: 1, L: 0 };

// Resultado de una partida desde el punto de vista de un jugador: 'W' | 'L' | 'T' | null (pendiente)
export function outcome(m, userId) {
  const me = key(userId);
  const isP1 = key(m.player1_id) === me;
  if (!isP1 && key(m.player2_id) !== me) return null;
  if (m.player2_id == null) return 'W'; // bye: victoria automática
  if (!m.result) return null;
  if (m.result === 'tie') return 'T';
  if (m.result === 'dl') return 'L'; // doble derrota (TOM): pierden los dos
  return (m.result === 'p1') === isP1 ? 'W' : 'L';
}

export const opponentOf = (m, userId) =>
  key(m.player1_id) === key(userId) ? m.player2_id : key(m.player2_id) === key(userId) ? m.player1_id : undefined;

// Clasificación: puntos (3 victoria, 1 empate), luego % de victorias de los rivales y victorias
export function standings(players, matches) {
  const rows = new Map(players.map(p => [key(p.user_id), {
    user_id: p.user_id, username: p.username, display_name: p.display_name,
    wins: 0, losses: 0, ties: 0, points: 0, byes: 0, opponents: [],
  }]));
  for (const m of matches) {
    for (const pid of [m.player1_id, m.player2_id]) {
      const row = pid != null && rows.get(key(pid));
      if (!row) continue;
      const r = outcome(m, pid);
      const opp = opponentOf(m, pid);
      if (opp == null) row.byes++;
      else row.opponents.push(key(opp));
      if (!r) continue;
      row[{ W: 'wins', L: 'losses', T: 'ties' }[r]]++;
      row.points += POINTS[r];
    }
  }
  const winPct = r => {
    const played = r.wins + r.losses + r.ties;
    return played ? Math.max(0.25, (r.wins + r.ties * 0.5) / played) : 0.25;
  };
  for (const r of rows.values()) {
    const opps = r.opponents.map(o => rows.get(o)).filter(Boolean);
    r.opp_win_pct = opps.length ? opps.reduce((s, o) => s + winPct(o), 0) / opps.length : 0;
  }
  return [...rows.values()]
    .sort((a, b) => b.points - a.points || b.opp_win_pct - a.opp_win_pct || b.wins - a.wins
      || String(a.username).localeCompare(String(b.username)))
    .map((r, i) => ({ ...r, place: i + 1, opp_win_pct: Math.round(r.opp_win_pct * 1000) / 10 }));
}

// Empareja la siguiente ronda: ronda 1 al azar; después por puntos, evitando revanchas.
// Con número impar, el bye va al jugador peor clasificado que aún no haya tenido uno.
export function pairRound(players, matches, round) {
  let order = standings(players, matches);
  if (round === 1) order = shuffle(order);
  const played = new Set(matches.filter(m => m.player2_id != null)
    .flatMap(m => [`${key(m.player1_id)}|${key(m.player2_id)}`, `${key(m.player2_id)}|${key(m.player1_id)}`]));

  let bye = null;
  if (order.length % 2) {
    const candidates = [...order].reverse();
    bye = candidates.find(p => p.byes === 0) || candidates[0];
    order = order.filter(p => p !== bye);
  }

  const pool = [...order];
  const pairs = [];
  while (pool.length) {
    const a = pool.shift();
    let j = pool.findIndex(b => !played.has(`${key(a.user_id)}|${key(b.user_id)}`));
    if (j < 0) j = 0; // todos ya jugaron entre sí: se permite la revancha
    const [b] = pool.splice(j, 1);
    pairs.push([a, b]);
  }

  const out = pairs.map(([a, b], i) => ({ round, table_no: i + 1, player1_id: a.user_id, player2_id: b.user_id, result: null }));
  if (bye) out.push({ round, table_no: out.length + 1, player1_id: bye.user_id, player2_id: null, result: 'p1' });
  return out;
}

// Rachas a partir de los resultados en orden cronológico
export function streaks(results) {
  const done = results.filter(Boolean);
  let current = null;
  for (let i = done.length - 1; i >= 0; i--) {
    if (!current) current = { type: done[i], count: 1 };
    else if (done[i] === current.type) current.count++;
    else break;
  }
  let best = 0, run = 0;
  for (const r of done) { run = r === 'W' ? run + 1 : 0; best = Math.max(best, run); }
  const count = t => done.filter(r => r === t).length;
  return { wins: count('W'), losses: count('L'), ties: count('T'), current, best_win_streak: best, last: done.slice(-5) };
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
