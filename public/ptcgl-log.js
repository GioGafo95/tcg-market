// Lector del historial de partida que exporta Pokémon TCG Live (texto en inglés).
// Lo usan el navegador (vista previa y análisis turno por turno) y el servidor (al guardar).
//
// parseLog(texto) → {
//   players: [a, b], me, opp, first, coin: { winner, choice }, mulligans: { [jugador]: n },
//   turns: [{ n, player, number, draws, plays: [...], attacks: [...], kos: [...], prizes: {..}, events: [...] }],
//   winner, reason, prizes: { [jugador]: n }, pokemon: { [jugador]: Set→[] }, openingHand: [...]
// }
// analyze(parsed) → { highlights, tips, timeline } con observaciones para mejorar.

const BULLET = /^\s*[•·]\s*/;

export function parseLog(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const st = {
    players: [], me: null, opp: null, first: null, coin: {}, mulligans: {}, turns: [], winner: null, reason: null,
    prizes: {}, pokemon: {}, openingHand: [], setup: { active: {}, bench: {} }, lineCount: 0,
  };
  const addPlayer = p => { if (p && !st.players.includes(p)) { st.players.push(p); st.prizes[p] = 0; st.mulligans[p] = 0; st.pokemon[p] = new Map(); } };
  const seen = (p, name) => { if (!p || !name) return; const m = st.pokemon[p]; if (m) m.set(name, (m.get(name) || 0) + 1); };

  // Encabezados de jugador desde las líneas iniciales
  for (const l of lines) {
    const m = /^(.+?) drew 7 cards for the opening hand\.$/.exec(l.trim());
    if (m) addPlayer(m[1]);
    if (st.players.length === 2) break;
  }
  // Por si el log empieza más abajo: buscar "X's Turn"
  if (st.players.length < 2) for (const l of lines) { const m = /^(.+?)'s Turn$/.exec(l.trim()); if (m) addPlayer(m[1]); if (st.players.length === 2) break; }
  const P = st.players;
  const who = s => P.slice().sort((a, b) => b.length - a.length).find(p => s === p || s.startsWith(p + ' ') || s.startsWith(p + "'s ")) || null;
  const other = p => P.find(x => x !== p) || null;

  let turn = null, phase = 'setup', last = null, expectHand = null, number = { };
  const newTurn = player => {
    number[player] = (number[player] || 0) + 1;
    turn = { n: st.turns.length + 1, player, number: number[player], draws: 0, drawn: [], plays: [], attacks: [], abilities: [],
             evolutions: [], attachments: [], retreats: [], kos: [], koBy: [], prizesTaken: 0, events: [], supporters: [], boss: false,
             discardedEnergyRetreat: 0, selfKo: [] };
    st.turns.push(turn);
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    st.lineCount++;
    if (line === 'Setup') { phase = 'setup'; continue; }
    if (line === 'Pokémon Checkup') { phase = 'checkup'; continue; }
    const turnM = /^(.+?)'s Turn$/.exec(line);
    if (turnM && P.includes(turnM[1])) { phase = 'turn'; newTurn(turnM[1]); if (!st.first) st.first = turnM[1]; continue; }

    // Sub-líneas ("- ..." y "• ...") pertenecen a la acción anterior
    if (line.startsWith('-') || BULLET.test(line)) {
      const sub = line.replace(/^-\s*/, '').replace(BULLET, '');
      if (BULLET.test(line) && expectHand) {
        const cards = sub.split(',').map(s => s.trim()).filter(Boolean);
        if (expectHand === 'hand') st.openingHand.push(...cards);
        if (expectHand === 'drawn' && turn) turn.drawn.push(...cards);
        if (expectHand === 'bench' && last?.player) cards.forEach(c => seen(last.player, c));
        continue;
      }
      if (last) last.subs = [...(last.subs || []), sub];
      // "- GioGafo drew Dreepy." dentro de una carta (búsqueda)
      const dr = /^(.+?) drew (\d+) cards?\.?$/.exec(sub);
      if (dr && turn && who(dr[1]) === turn.player) { turn.draws += Number(dr[2]); expectHand = 'drawn'; continue; }
      const dr1 = /^(.+?) drew (.+?)\.$/.exec(sub);
      if (dr1 && turn && who(dr1[1]) === turn.player && !/^\d/.test(dr1[2])) { turn.draws += 1; turn.drawn.push(dr1[2]); }
      if (/drew \d+ cards and played them to the Bench/.test(sub) || /drew .+ and played it to the Bench/.test(sub)) {
        expectHand = 'bench';
        const one = /drew (.+?) and played it to the Bench/.exec(sub);
        if (one && last?.player) seen(last.player, one[1]);
      }
      if (/Basic .+ Energy was discarded from .+'s/.test(sub) && last?.type === 'retreat') turn && (turn.discardedEnergyRetreat += 1);
      const sw = /^(.+?)'s (.+?) was switched with .+ to become the Active Pokémon.$/.exec(sub);
      if (sw && turn && last?.type === 'trainer' && /Boss's Orders|Counter Catcher|Prime Catcher|Lysandre/.test(last.card) && who(sw[1]) !== turn.player) turn.gusted = sw[2];
      if (/^Cards revealed from Mulligan/.test(sub)) expectHand = 'mull';
      if (/^\d+ drawn cards\.$/.test(sub)) expectHand = expectHand || 'hand';
      continue;
    }
    expectHand = null;

    // Lanzamiento de moneda y quién empieza
    let m;
    if ((m = /^(.+?) won the coin toss\.$/.exec(line))) { st.coin.winner = m[1]; continue; }
    if ((m = /^(.+?) decided to go (first|second)\.$/.exec(line))) {
      st.coin.choice = m[2];
      st.first = m[2] === 'first' ? m[1] : other(m[1]);
      continue;
    }
    if ((m = /^(.+?) drew 7 cards for the opening hand\.$/.exec(line))) { expectHand = 'hand-' + m[1]; last = { player: m[1] }; expectHand = 'hand'; if (st.openingHand.length) expectHand = 'other-hand'; continue; }
    if ((m = /^(.+?) took a mulligan\.$/.exec(line))) { st.mulligans[m[1]] = (st.mulligans[m[1]] || 0) + 1; continue; }

    const p = who(line);
    const rest = p ? line.slice(p.length).replace(/^'s /, "'s ").trim() : line;

    // Fin de partida
    if ((m = /(\S.*?) wins\.$/.exec(line)) && P.includes(m[1].replace(/^.*\. /, ''))) {
      st.winner = m[1].replace(/^.*\. /, '');
      if (/took all of their Prize cards/.test(line)) st.reason = 'prizes';
      else if (/conceded/i.test(line)) st.reason = 'concede';
      else if (/no Pokémon|no more Pokémon|Bench/i.test(line)) st.reason = 'no-pokemon';
      else if (/deck|cards to draw/i.test(line)) st.reason = 'deck-out';
      else st.reason = st.reason || 'other';
      continue;
    }
    if (/conceded/i.test(line) && p) { st.reason = 'concede'; st.winner = other(p); continue; }

    if (!p) continue;
    if (phase === 'setup') {
      if ((m = /^played (.+?) to the (Active Spot|Bench)\.$/.exec(rest))) { seen(p, m[1]); st.setup[m[2] === 'Bench' ? 'bench' : 'active'][p] = [...(st.setup[m[2] === 'Bench' ? 'bench' : 'active'][p] || []), m[1]]; }
      if ((m = /^drew 1 more card because/.exec(rest))) { /* carta extra por mulligan */ }
      continue;
    }
    if (!turn) continue;
    const mine = p === turn.player;

    if ((m = /^drew a card\.$/.exec(rest)) || (m = /^drew (.+?)\.$/.exec(rest))) {
      if (mine) { turn.draws += 1; if (m[1]) turn.drawn.push(m[1]); }
      last = { type: 'draw', player: p }; continue;
    }
    if ((m = /^played (.+?) to the (Bench|Active Spot)\.$/.exec(rest))) {
      seen(p, m[1]); turn.plays.push({ player: p, card: m[1], kind: 'pokemon' }); last = { type: 'play', player: p, card: m[1] }; continue;
    }
    if ((m = /^played (.+?) to the Stadium spot\.$/.exec(rest))) {
      turn.plays.push({ player: p, card: m[1], kind: 'stadium' }); last = { type: 'stadium', player: p }; continue;
    }
    if ((m = /^played (.+?)\.$/.exec(rest))) {
      const card = m[1];
      turn.plays.push({ player: p, card, kind: 'trainer' });
      if (SUPPORTERS.has(card)) turn.supporters.push(card);
      if (/Boss's Orders|Counter Catcher|Prime Catcher|Lysandre/.test(card)) turn.boss = true;
      last = { type: 'trainer', player: p, card }; continue;
    }
    if ((m = /^evolved (.+?) to (.+?) (?:on the Bench|in the Active Spot)\.$/.exec(rest))) {
      seen(p, m[2]); turn.evolutions.push({ player: p, from: m[1], to: m[2] }); last = { type: 'evolve', player: p }; continue;
    }
    if ((m = /^attached (.+?) to (.+?) (?:on the Bench|in the Active Spot)\.$/.exec(rest))) {
      turn.attachments.push({ player: p, card: m[1], to: m[2] }); last = { type: 'attach', player: p }; continue;
    }
    if ((m = /^retreated (.+?) to the Bench\.$/.exec(rest))) {
      turn.retreats.push({ player: p, pokemon: m[1] }); last = { type: 'retreat', player: p }; continue;
    }
    // "X's Pokémon used Ataque on Y’s Pokémon for N damage."
    if ((m = /^'s (.+?) used (.+?) on (.+?)[’'']s (.+?) for (\d+) damage/.exec(rest))) {
      seen(p, m[1]);
      turn.attacks.push({ player: p, attacker: m[1], attack: m[2], target: m[4], targetOwner: m[3], damage: Number(m[5]) });
      last = { type: 'attack', player: p }; continue;
    }
    if ((m = /^'s (.+?) used (.+?)\.$/.exec(rest))) {
      seen(p, m[1]); turn.abilities.push({ player: p, pokemon: m[1], ability: m[2] }); last = { type: 'ability', player: p, pokemon: m[1], ability: m[2] }; continue;
    }
    if ((m = /^'s (.+?) was Knocked Out!$/.exec(rest))) {
      turn.kos.push({ owner: p, pokemon: m[1], selfInflicted: p === turn.player && last?.type === 'ability' });
      if (p === turn.player && last?.type === 'ability') turn.selfKo.push(m[1]);
      last = { type: 'ko', player: p }; continue;
    }
    if ((m = /^took (a|\d+) Prize cards?\.$/.exec(rest))) {
      const n = m[1] === 'a' ? 1 : Number(m[1]);
      st.prizes[p] = (st.prizes[p] || 0) + n;
      turn.events.push({ type: 'prize', player: p, n, total: st.prizes[p] });
      if (p === turn.player) turn.prizesTaken += n;
      last = { type: 'prize', player: p }; continue;
    }
    if ((m = /^'s (.+?) is now in the Active Spot\.$/.exec(rest))) { seen(p, m[1]); continue; }
  }

  // ¿Quién soy? El jugador cuya mano inicial aparece en el log (Pokémon TCG Live solo muestra la tuya)
  const handOwner = (() => {
    for (let i = 0; i < lines.length; i++) {
      const m = /^(.+?) drew 7 cards for the opening hand\.$/.exec(lines[i].trim());
      if (!m) continue;
      // Las 3 líneas siguientes: "- 7 drawn cards." y, solo para ti, "• carta, carta…"
      if (lines.slice(i + 1, i + 4).some(l => BULLET.test(l))) return m[1];
    }
    return null;
  })();
  st.me = handOwner && P.includes(handOwner) ? handOwner : P[0] || null;
  st.opp = other(st.me);
  // Cartas vistas por jugador (de la más usada a la menos)
  st.pokemon = Object.fromEntries(P.map(p => [p, [...st.pokemon[p]].sort((a, b) => b[1] - a[1]).map(([n]) => n)]));
  st.turnCount = st.turns.length;
  return st;
}

// Entrenadores de apoyo (Supporter) frecuentes en Estándar; sirven para contar si jugaste tu "supporter del turno"
const SUPPORTERS = new Set([
  "Boss's Orders", "Lillie's Determination", 'Iono', "Professor's Research", 'Arven', 'Crispin', 'Dawn', "Rosa's Encouragement",
  'Cyrano', "Janine's Secret Art", 'Carmine', 'Briar', 'Penny', 'Jacq', 'Irida', 'Kieran', 'Lacey', 'Hilda', 'Lana\'s Aid',
  'Professor Turo\'s Scenario', 'Professor Sada\'s Vitality', 'Judge', 'Raihan', 'Thorton', 'Ciphermaniac\'s Codebreaking',
  'Giacomo', 'Ryme', 'Clavell', 'Explorer\'s Guidance', 'Black Belt\'s Training', 'Eri', 'Salvatore', 'Brock\'s Scouting',
  'Team Rocket\'s Petrel', 'Team Rocket\'s Proton', 'Team Rocket\'s Ariana', 'Team Rocket\'s Archer', 'Team Rocket\'s Giovanni',
  'Kofu', 'Tulip', 'Roxanne', 'Morty\'s Conviction', 'Hassel', 'Grimsley\'s Move', 'Arezu', 'Lucian', 'Firebreather',
  "N's Plan", 'Hop\'s Choice', 'Cynthia\'s Power Weight', 'Ethan\'s Adventure', 'Lillie\'s Pearl', 'Surfer', 'Larry\'s Skill',
]);

// Deck probable a partir de los Pokémon vistos y de los decks conocidos del metajuego (nombre + íconos)
export function guessDeck(pokemonSeen, archetypes = []) {
  const norm = s => String(s).toLowerCase().replace(/['’]/g, '').replace(/\b(ex|v|vstar|vmax|gx)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const seen = pokemonSeen.map(norm);
  let best = null;
  for (const a of archetypes) {
    const icons = (a.icons || []).map(i => i.replace(/-/g, ' ').replace(/\bmega\b/, '').trim());
    if (!icons.length) continue;
    const hits = icons.filter(i => seen.some(s => s.includes(i) || i.includes(s.split(' ').pop())));
    const score = hits.length / icons.length + hits.length * 0.1 + (a.share || 0) / 1000;
    if (hits.length && (!best || score > best.score)) best = { name: a.name, score, full: hits.length === icons.length };
  }
  if (best && best.full) return best.name;
  // Sin coincidencia completa: los dos Pokémon "estrella" (ex / evoluciones) más vistos
  const stars = pokemonSeen.filter(n => / ex$|Mega |VSTAR|VMAX/.test(n));
  const pick = (stars.length ? stars : pokemonSeen).slice(0, 2).map(n => n.replace(/ ex$/, ''));
  return best?.name || pick.join(' ') || '';
}

// Observaciones para mejorar (desde tu punto de vista)
export function analyze(st) {
  const me = st.me, opp = st.opp;
  const tips = [];
  const myTurns = st.turns.filter(t => t.player === me);
  const oppTurns = st.turns.filter(t => t.player === opp);
  const tip = (level, title, text, turnN) => tips.push({ level, title, text, turn: turnN ?? null });

  // Inicio
  const wentFirst = st.first === me;
  if (st.mulligans[me]) tip('info', `Hiciste ${st.mulligans[me]} mulligan(s)`, 'Si pasa seguido, revisa cuántos Pokémon básicos lleva tu lista (lo usual es 10-14).');
  if (st.mulligans[opp]) tip('info', `Tu rival hizo ${st.mulligans[opp]} mulligan(s)`, 'Robaste cartas extra al inicio; es una ventaja para presionar temprano.');

  // Premios regalados por efectos propios (ej. Dusknoir Cursed Blast se noquea a sí mismo)
  for (const t of myTurns) for (const ko of t.selfKo) {
    tip('warn', `Premio regalado en tu turno ${t.number}`, `Tu ${ko} quedó fuera de combate por su propio efecto y tu rival tomó premio. Úsalo solo cuando el daño asegure un KO importante o el intercambio te convenga.`, t.n);
  }
  // Pokémon de banca jalados con Boss's Orders y noqueados ese turno
  for (const t of oppTurns) {
    if (!t.boss) continue;
    const ko = t.gusted && t.kos.find(k => k.owner === me && k.pokemon === t.gusted);
    if (ko) tip('warn', `Te jalaron a ${ko.pokemon} con Boss y lo noquearon (turno ${t.number} rival)`,
      'Los Pokémon de fase 1 o con poca vida en la banca son blanco fácil. Considera evolucionar antes, no llenar la banca de piezas frágiles o tener cómo cambiar.', t.n);
  }
  // Energía perdida al retirar
  for (const t of myTurns) if (t.discardedEnergyRetreat) {
    tip('info', `Retiraste y perdiste energía (turno ${t.number})`, 'Cada retiro con costo frena tu ataque. Busca cartas de cambio (Switch, Poké Pad + pivote sin costo) o empezar con un Pokémon de retiro gratis.', t.n);
  }
  // Turnos sin atacar
  const noAttack = myTurns.filter(t => !t.attacks.length && !(wentFirst && t.number === 1));
  if (noAttack.length >= 2) tip('warn', `${noAttack.length} turnos sin atacar`, `Turnos: ${noAttack.map(t => t.number).join(', ')}. Cada turno sin daño le da tiempo a tu rival; revisa si te faltó energía o un atacante listo.`);
  // Turnos sin "supporter"
  const noSup = myTurns.filter(t => !t.supporters.length && !(wentFirst && t.number === 1));
  if (noSup.length >= 2) tip('info', `${noSup.length} turnos sin carta de Partidario`, `Turnos: ${noSup.map(t => t.number).join(', ')}. Si no tenías, considera más robo o búsqueda (Lillie's Determination, Iono, Arven…).`);
  // Golpes grandes recibidos
  const big = oppTurns.flatMap(t => t.attacks.filter(a => a.targetOwner === me && a.damage >= 200).map(a => ({ ...a, turn: t })));
  for (const a of big) tip('info', `Recibiste ${a.damage} de daño (${a.attacker}, ${a.attack})`,
    'Si el rival escala daño (por ejemplo, por contadores en su propio Pokémon), quítale ese atacante antes o evita dejarle tu Pokémon de más premios al frente.', a.turn.n);

  // Carrera de premios
  const race = [];
  const pz = { [me]: 0, [opp]: 0 };
  for (const t of st.turns) { for (const e of t.events) if (e.type === 'prize') pz[e.player] = e.total; race.push({ turn: t.n, player: t.player, number: t.number, me: pz[me], opp: pz[opp] }); }
  const firstKo = st.turns.find(t => t.kos.length);
  if (firstKo) {
    const tookFirst = firstKo.kos.some(k => k.owner === opp);
    tip(tookFirst ? 'good' : 'info', tookFirst ? 'Tomaste el primer KO' : 'Tu rival tomó el primer KO',
      tookFirst ? 'Llevar la delantera en premios te deja decidir el ritmo de la partida.' : 'Ir atrás en premios no es malo si puedes responder con KOs de 2 premios (contra Pokémon ex).', firstKo.n);
  }

  const totalDamage = p => st.turns.flatMap(t => t.attacks).filter(a => a.player === p).reduce((n, a) => n + a.damage, 0);
  return {
    wentFirst, myTurns: myTurns.length, oppTurns: oppTurns.length,
    damage: { me: totalDamage(me), opp: totalDamage(opp) },
    race, tips,
    highlights: {
      biggestHit: st.turns.flatMap(t => t.attacks.map(a => ({ ...a, turn: t.n }))).sort((a, b) => b.damage - a.damage)[0] || null,
      kos: st.turns.flatMap(t => t.kos.map(k => ({ ...k, turn: t.n }))),
    },
  };
}

// Resumen corto de cada turno (para la línea de tiempo)
export function turnSummary(t) {
  const parts = [];
  if (t.evolutions.length) parts.push(`Evolucionó ${t.evolutions.map(e => e.to).join(', ')}`);
  const pk = t.plays.filter(p => p.kind === 'pokemon').map(p => p.card);
  if (pk.length) parts.push(`Bajó ${pk.join(', ')}`);
  if (t.supporters.length) parts.push(`Partidario: ${t.supporters.join(', ')}`);
  const items = t.plays.filter(p => p.kind === 'trainer' && !t.supporters.includes(p.card)).map(p => p.card);
  if (items.length) parts.push(`Entrenadores: ${items.join(', ')}`);
  const st = t.plays.filter(p => p.kind === 'stadium').map(p => p.card);
  if (st.length) parts.push(`Estadio: ${st.join(', ')}`);
  const energy = t.attachments.filter(a => /Energy$/.test(a.card)), tools = t.attachments.filter(a => !/Energy$/.test(a.card));
  if (energy.length) parts.push(`Energía: ${energy.map(a => `${a.card.replace('Basic ', '').replace(' Energy', '')} → ${a.to}`).join(', ')}`);
  if (tools.length) parts.push(`Herramienta: ${tools.map(a => `${a.card} → ${a.to}`).join(', ')}`);
  if (t.retreats.length) parts.push(`Retiró ${t.retreats.map(r => r.pokemon).join(', ')}`);
  if (t.abilities.length) parts.push(`Habilidades: ${[...new Set(t.abilities.map(a => `${a.ability}`))].join(', ')}`);
  return parts;
}
