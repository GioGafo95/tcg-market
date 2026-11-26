// Lógica de torneos (formato suizo + top cut opcional) con las reglas oficiales de cada juego:
//  - Yu-Gi-Oh! (KONAMI, como KTS): Victoria 3 / Derrota 0; si se acaba el tiempo es doble derrota (no hay empates).
//    Desempate KTS "AABBBCCCDDD": puntos, % de victorias de los rivales, % de los rivales de los rivales y la suma
//    de los cuadrados de las rondas perdidas (perder tarde pesa más). Fuente: Tournament Policy KDE-US v2.5.
//  - Pokémon (Play! Pokémon, como TOM): Victoria 3 / Empate 1 / Derrota 0. Desempates: % de victorias de los
//    rivales (mínimo 25 %; máximo 75 % si el rival se retiró), % de los rivales de los rivales y enfrentamiento
//    directo. El bye cuenta como victoria pero no entra en los desempates. Fuente: Tournament Rules Handbook.
// Funciones puras: no tocan el almacenamiento.

const key = id => String(id);
export const POINTS = { W: 3, T: 1, L: 0 };
export const GAMES = ['pokemon', 'yugioh'];
export const RULESET = {
  pokemon: { label: 'Play! Pokémon (como TOM)', ties: true },
  yugioh: { label: 'KONAMI (como KTS)', ties: false },
};

// Rondas de suizo y top cut recomendados según los jugadores inscritos
// Yu-Gi-Oh!: tabla oficial (Tier 1 y 2) del Tournament Policy de KONAMI.
// Pokémon: estructura habitual de Play! Pokémon en TOM (editable por el organizador).
export function recommendedStructure(game, n) {
  if (n < 2) return { rounds: 0, top_cut: 0 };
  if (n < 4) return { rounds: Math.max(1, n - 1), top_cut: 0 };
  const table = game === 'yugioh'
    ? [[8, 3, 0], [16, 4, 4], [32, 5, 4], [64, 6, 8], [128, 7, 8], [256, 8, 8], [512, 9, 8], [1024, 10, 8], [2048, 11, 8], [Infinity, 12, 8]]
    : [[8, 3, 0], [12, 4, 2], [20, 5, 4], [32, 5, 8], [64, 6, 8], [128, 7, 8], [226, 8, 16], [409, 9, 16], [Infinity, 10, 32]];
  const [, rounds, top_cut] = table.find(([max]) => n <= max);
  return { rounds, top_cut: Math.min(top_cut, n) };
}

// Resultado de una partida desde el punto de vista de un jugador: 'W' | 'L' | 'T' | null (pendiente)
export function outcome(m, userId) {
  const me = key(userId);
  const isP1 = key(m.player1_id) === me;
  if (!isP1 && key(m.player2_id) !== me) return null;
  if (m.player2_id == null) return 'W'; // bye: victoria automática
  if (!m.result) return null;
  if (m.result === 'tie') return 'T';
  if (m.result === 'dl') return 'L'; // doble derrota: pierden los dos
  return (m.result === 'p1') === isP1 ? 'W' : 'L';
}

export const opponentOf = (m, userId) =>
  key(m.player1_id) === key(userId) ? m.player2_id : key(m.player2_id) === key(userId) ? m.player1_id : undefined;

const pct3 = v => String(Math.min(999, Math.round(v * 1000))).padStart(3, '0');

// Clasificación del suizo (las partidas de top cut no cuentan) con los desempates del juego
export function standings(players, matches, game = 'pokemon') {
  const swiss = matches.filter(m => !m.topcut);
  const roundsPlayed = Math.max(0, ...swiss.filter(m => m.result || m.player2_id == null).map(m => m.round));
  const rows = new Map(players.map(p => [key(p.user_id), {
    user_id: p.user_id, username: p.username, display_name: p.display_name, dropped: p.dropped || 0,
    wins: 0, losses: 0, ties: 0, points: 0, byes: 0, opponents: [], lostRounds: [], played: 0, realWins: 0,
  }]));
  for (const m of swiss) {
    for (const pid of [m.player1_id, m.player2_id]) {
      const row = pid != null && rows.get(key(pid));
      if (!row) continue;
      const r = outcome(m, pid);
      const opp = opponentOf(m, pid);
      if (!r) continue;
      row.played++;
      if (opp == null) row.byes++; else row.opponents.push({ id: key(opp), round: m.round });
      row[{ W: 'wins', L: 'losses', T: 'ties' }[r]]++;
      row.points += POINTS[r] * (game === 'yugioh' && r === 'T' ? 0 : 1);
      if (r === 'W' && opp != null) row.realWins++;
      if (r === 'L') row.lostRounds.push(m.round);
    }
  }
  // % de victorias de un jugador para los desempates (los byes no cuentan como victoria)
  const winPct = r => {
    if (game === 'yugioh') {
      const n = r.played - r.byes;
      return n ? r.realWins / n : 0;
    }
    const rounds = r.dropped ? r.played : Math.max(r.played, roundsPlayed);
    const v = rounds ? r.realWins / rounds : 0;
    return Math.min(r.dropped ? 0.75 : 1, Math.max(0.25, v));
  };
  for (const r of rows.values()) r.wp = winPct(r);
  for (const r of rows.values()) {
    const opps = r.opponents.map(o => rows.get(o.id)).filter(Boolean);
    r.owp = opps.length ? opps.reduce((s, o) => s + o.wp, 0) / opps.length : 0;
  }
  for (const r of rows.values()) {
    const opps = r.opponents.map(o => rows.get(o.id)).filter(Boolean);
    r.oowp = opps.length ? opps.reduce((s, o) => s + o.owp, 0) / opps.length : 0;
    r.ddd = r.lostRounds.reduce((s, n) => s + n * n, 0);
    r.kts = `${String(r.points).padStart(2, '0')}${pct3(r.owp)}${pct3(r.oowp)}${String(Math.min(999, r.ddd)).padStart(3, '0')}`;
  }
  const headToHead = (a, b) => {
    const m = swiss.find(x => x.result && x.player2_id != null &&
      ((key(x.player1_id) === key(a.user_id) && key(x.player2_id) === key(b.user_id)) || (key(x.player1_id) === key(b.user_id) && key(x.player2_id) === key(a.user_id))));
    if (!m) return 0;
    const r = outcome(m, a.user_id);
    return r === 'W' ? -1 : r === 'L' ? 1 : 0;
  };
  const list = [...rows.values()];
  const tieKey = r => `${r.points}|${r.owp.toFixed(6)}|${r.oowp.toFixed(6)}`;
  const tiedCount = new Map();
  list.forEach(r => tiedCount.set(tieKey(r), (tiedCount.get(tieKey(r)) || 0) + 1));
  list.sort((a, b) => b.points - a.points || b.owp - a.owp || b.oowp - a.oowp
    || (game === 'yugioh' ? b.ddd - a.ddd : (tiedCount.get(tieKey(a)) === 2 ? headToHead(a, b) : 0))
    || String(a.username).localeCompare(String(b.username)));
  return list.map((r, i) => ({
    user_id: r.user_id, username: r.username, display_name: r.display_name, dropped: r.dropped,
    wins: r.wins, losses: r.losses, ties: r.ties, points: r.points, byes: r.byes,
    opponents: r.opponents.map(o => o.id), place: i + 1,
    opp_win_pct: Math.round(r.owp * 1000) / 10, oopp_win_pct: Math.round(r.oowp * 1000) / 10,
    ...(game === 'yugioh' ? { kts: r.kts, ddd: r.ddd } : {}),
  }));
}

// Empareja la siguiente ronda del suizo.
// Ronda 1 al azar. Después, por puntos (al azar dentro de cada grupo), bajando de grupo cuando sobra alguien
// y evitando revanchas (con vuelta atrás si hace falta). Con número impar, el bye va al jugador peor
// clasificado que todavía no haya tenido bye.
export function pairRound(players, matches, round, game = 'pokemon') {
  const active = players.filter(p => !p.dropped);
  const table = standings(active, matches.filter(m => !m.topcut), game);
  let order = round === 1 ? shuffle(table) : groupShuffle(table);
  const played = new Set(matches.filter(m => m.player2_id != null)
    .flatMap(m => [`${key(m.player1_id)}|${key(m.player2_id)}`, `${key(m.player2_id)}|${key(m.player1_id)}`]));

  let bye = null;
  if (order.length % 2) {
    const fromBottom = [...table].reverse();
    const lowestPts = fromBottom[0]?.points;
    const candidates = game === 'pokemon' && round > 1
      ? shuffle(fromBottom.filter(p => p.points === lowestPts && p.byes === 0))
      : fromBottom.filter(p => p.byes === 0);
    bye = candidates[0] || fromBottom[0];
    order = order.filter(p => key(p.user_id) !== key(bye.user_id));
  }

  const pairs = pairWithoutRematches(order, played) || greedyPairs(order, played);
  const out = pairs
    .sort((x, y) => Math.max(y[0].points, y[1].points) - Math.max(x[0].points, x[1].points))
    .map(([a, b], i) => ({ round, table_no: i + 1, player1_id: a.user_id, player2_id: b.user_id, result: null, topcut: 0 }));
  if (bye) out.push({ round, table_no: out.length + 1, player1_id: bye.user_id, player2_id: null, result: 'p1', topcut: 0 });
  return out;
}

function groupShuffle(table) {
  const groups = new Map();
  for (const r of table) { if (!groups.has(r.points)) groups.set(r.points, []); groups.get(r.points).push(r); }
  return [...groups.keys()].sort((a, b) => b - a).flatMap(k => shuffle(groups.get(k)));
}

// Búsqueda con vuelta atrás: el primero de la lista se empareja con el siguiente disponible sin revancha
function pairWithoutRematches(list, played, budget = { n: 20000 }) {
  if (!list.length) return [];
  if (--budget.n < 0) return null;
  const [a, ...rest] = list;
  for (let i = 0; i < rest.length; i++) {
    const b = rest[i];
    if (played.has(`${key(a.user_id)}|${key(b.user_id)}`)) continue;
    const sub = pairWithoutRematches(rest.filter((_, j) => j !== i), played, budget);
    if (sub) return [[a, b], ...sub];
  }
  return null;
}
function greedyPairs(list, played) {
  const pool = [...list], pairs = [];
  while (pool.length > 1) {
    const a = pool.shift();
    let j = pool.findIndex(b => !played.has(`${key(a.user_id)}|${key(b.user_id)}`));
    if (j < 0) j = 0; // todos ya jugaron entre sí: se permite la revancha
    pairs.push([a, pool.splice(j, 1)[0]]);
  }
  return pairs;
}

// ---------- Top cut (eliminación directa) ----------

// Orden de siembra de un bracket: 8 → [1,8,4,5,2,7,3,6] (así 1 y 2 solo se cruzan en la final)
export function bracketOrder(size) {
  let seeds = [1, 2];
  while (seeds.length < size) {
    const n = seeds.length * 2 + 1;
    seeds = seeds.flatMap(s => [s, n - s]);
  }
  return seeds;
}

export function firstTopRound(table, size, round) {
  const qualified = table.filter(r => !r.dropped).slice(0, size);
  const seeds = bracketOrder(size);
  const out = [];
  for (let i = 0; i < seeds.length; i += 2) {
    const a = qualified[seeds[i] - 1], b = qualified[seeds[i + 1] - 1];
    if (!a) continue;
    out.push({ round, table_no: out.length + 1, player1_id: a.user_id, player2_id: b ? b.user_id : null, result: b ? null : 'p1', topcut: 1 });
  }
  return out;
}

const winnerOf = m => (m.player2_id == null ? m.player1_id : m.result === 'p1' ? m.player1_id : m.result === 'p2' ? m.player2_id : null);

export function nextTopRound(prev, round) {
  const winners = prev.sort((a, b) => a.table_no - b.table_no).map(winnerOf);
  if (winners.length < 2) return [];
  const out = [];
  for (let i = 0; i < winners.length; i += 2) out.push({ round, table_no: out.length + 1, player1_id: winners[i], player2_id: winners[i + 1] ?? null, result: winners[i + 1] == null ? 'p1' : null, topcut: 1 });
  return out;
}

// Lugar final: primero el top cut (campeón, finalista, semifinalistas…, ordenados por su lugar en el suizo); luego el resto
export function finalPlacement(table, matches) {
  const top = matches.filter(m => m.topcut);
  if (!top.length) return table;
  const rounds = [...new Set(top.map(m => m.round))].sort((a, b) => a - b);
  const swissPos = new Map(table.map(r => [key(r.user_id), r.place]));
  const placed = [];
  const last = top.filter(m => m.round === rounds[rounds.length - 1]);
  if (last.length === 1 && winnerOf(last[0]) != null) {
    const w = winnerOf(last[0]);
    placed.push(w);
    if (last[0].player2_id != null) placed.push(key(last[0].player1_id) === key(w) ? last[0].player2_id : last[0].player1_id);
  }
  for (const r of [...rounds].reverse()) {
    if (r === rounds[rounds.length - 1] && placed.length) continue;
    const losers = top.filter(m => m.round === r && m.player2_id != null && winnerOf(m) != null)
      .map(m => (key(winnerOf(m)) === key(m.player1_id) ? m.player2_id : m.player1_id))
      .sort((a, b) => (swissPos.get(key(a)) || 999) - (swissPos.get(key(b)) || 999));
    placed.push(...losers.filter(id => !placed.some(p => key(p) === key(id))));
  }
  const placedSet = new Set(placed.map(key));
  const rest = table.filter(r => !placedSet.has(key(r.user_id)));
  const byId = new Map(table.map(r => [key(r.user_id), r]));
  return [...placed.map(id => byId.get(key(id))).filter(Boolean), ...rest].map((r, i) => ({ ...r, place: i + 1, swiss_place: r.place }));
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
