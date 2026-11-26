// Metajuego competitivo de Pokémon TCG (formato Estándar).
//
// Fuentes:
//  - Torneos oficiales (Regionales, Internacionales, Special Events, Mundial): resultados públicos de
//    limitlesstcg.com (cada jugador con su lugar y su deck). Se leen las páginas HTML con caché.
//  - Torneos online: API pública de play.limitlesstcg.com (no requiere clave): torneos recientes y sus
//    clasificaciones, con el deck de cada jugador ya identificado y su récord.
//  - Torneos de esta página: decks que los jugadores registran al inscribirse.
//
// El resultado se guarda como una "foto" (snapshot) en la base de datos y se rehace cada pocas horas,
// para no consultar Limitless en cada visita.

const OFFICIAL_BASE = 'https://limitlesstcg.com';
const PLAY_API = 'https://play.limitlesstcg.com/api';
const UA = 'MacaiTCG/1.0 (estadisticas de metajuego)';
const DAY = 864e5;

const OFFICIAL_MAX_EVENTS = 10;      // eventos oficiales recientes (formato Estándar internacional)
const OFFICIAL_MAX_AGE_DAYS = 120;
const ONLINE_MAX_AGE_DAYS = 28;
const ONLINE_MIN_PLAYERS = 24;
const ONLINE_MAX_TOURNAMENTS = 20;   // pocas peticiones: la API de Limitless limita la frecuencia
const BUILD_DEADLINE_MS = 20000;     // la función en AWS tiene 30 s; se corta antes con lo que haya

async function get(url, type = 'json') {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: type === 'json' ? 'application/json' : 'text/html' },
                                  signal: AbortSignal.timeout(15000) });
  if (res.status === 429) throw new Error('Limitless pidió esperar (demasiadas peticiones)');
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return type === 'json' ? res.json() : res.text();
}

// Ejecuta tareas con un máximo de N a la vez
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await Promise.resolve().then(() => fn(items[k], k)).catch(() => null); }
  }));
  return out;
}

const decode = s => String(s || '').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------- Torneos oficiales (limitlesstcg.com) ----------

function parseOfficialList(html) {
  const rows = [];
  const re = /<tr data-date="([\d-]+)" data-country="([A-Z]*)"\s+data-name="([^"]*)" data-format="([^"]*)"\s+data-players="(\d*)" data-winner="([^"]*)">([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = re.exec(html))) {
    const id = /href="\/tournaments\/(\d+)"/.exec(m[7])?.[1];
    if (id) rows.push({ id, date: m[1], country: m[2], name: decode(m[3]), format: m[4], players: Number(m[5]) || 0 });
  }
  return rows;
}

// Filas: <tr data-rank="1" data-name=".." data-country="US" data-deck="Dragapult" > ... <img class="pokemon" alt="dragapult">
function parseOfficialStandings(html) {
  const out = [];
  const re = /<tr data-rank="(\d+)" data-name="([^"]*)" data-country="([A-Z]*)" data-deck="([^"]*)"\s*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = re.exec(html))) {
    const deck = decode(m[4]).trim();
    if (!deck) continue;
    const icons = [...m[5].matchAll(/<img class="pokemon"[^>]*alt="([^"]+)"/g)].map(x => x[1]);
    out.push({ placing: Number(m[1]), name: decode(m[2]), country: m[3], deck: { id: slug(deck), name: deck, icons } });
  }
  return out;
}

const isMajor = name => /regional|international|special event|world|championship|naic|euic|laic|ocic|open/i.test(name);

async function fetchOfficial() {
  const list = parseOfficialList(await get(`${OFFICIAL_BASE}/tournaments`, 'html'));
  const cutoff = Date.now() - OFFICIAL_MAX_AGE_DAYS * DAY;
  const chosen = list.filter(t => t.format === 'standard' && isMajor(t.name) && Date.parse(t.date) >= cutoff)
    .slice(0, OFFICIAL_MAX_EVENTS);
  const pages = await pool(chosen, 2, t => get(`${OFFICIAL_BASE}/tournaments/${t.id}`, 'html'));
  return chosen.map((t, i) => ({ ...t, url: `${OFFICIAL_BASE}/tournaments/${t.id}`, standings: pages[i] ? parseOfficialStandings(pages[i]) : [] }))
    .filter(t => t.standings.length);
}

// ---------- Torneos online (play.limitlesstcg.com) ----------

async function fetchOnline() {
  const cutoff = Date.now() - ONLINE_MAX_AGE_DAYS * DAY;
  const found = [];
  const started = Date.now();
  for (let page = 1; page <= 3; page++) {
    const batch = await get(`${PLAY_API}/tournaments?game=PTCG&format=STANDARD&limit=100&page=${page}`);
    if (!Array.isArray(batch) || !batch.length) break;
    found.push(...batch);
    if (Date.parse(batch[batch.length - 1].date) < cutoff) break;
  }
  const chosen = found.filter(t => Date.parse(t.date) >= cutoff && t.players >= ONLINE_MIN_PLAYERS && Date.parse(t.date) <= Date.now())
    .sort((a, b) => b.players - a.players).slice(0, ONLINE_MAX_TOURNAMENTS)
    .sort((a, b) => b.date.localeCompare(a.date));
  // De a 2 peticiones a la vez y con tope de tiempo (si se acaba, se usan los torneos ya leídos)
  const standings = await pool(chosen, 2, t => (Date.now() - started > BUILD_DEADLINE_MS ? null : get(`${PLAY_API}/tournaments/${t.id}/standings`)));
  // Emparejamientos (para el % de victorias de un deck contra otro) de los 10 torneos más grandes
  const pairings = await pool(chosen, 2, (t, i) => (i >= 10 || Date.now() - started > BUILD_DEADLINE_MS ? null : get(`${PLAY_API}/tournaments/${t.id}/pairings`)));
  return chosen.map((t, i) => ({
    id: t.id, name: t.name, date: t.date.slice(0, 10), players: t.players,
    url: `https://play.limitlesstcg.com/tournament/${t.id}/standings`,
    standings: (standings[i] || []).filter(s => s.deck?.id && s.deck.id !== 'other').map(s => ({
      placing: s.placing, name: s.name, country: s.country, player: s.player,
      deck: { id: s.deck.id, name: s.deck.name, icons: s.deck.icons || [] }, record: s.record || null,
      list: s.decklist && typeof s.decklist === 'object' ? s.decklist : null,
    })),
    pairings: Array.isArray(pairings[i]) ? pairings[i] : null,
  })).filter(t => t.standings.length >= 8);
}

// % de victorias de cada deck contra cada otro (partidas online, sin espejos). Victoria = 1, empate = 1/2.
export function matchupMatrix(online, top = 10, extended = 25) {
  const usage = new Map();
  online.forEach(t => t.standings.forEach(s => usage.set(s.deck.id, (usage.get(s.deck.id) || { deck: s.deck, n: 0 })) && usage.get(s.deck.id).n++));
  const decks = [...usage.values()].sort((a, b) => b.n - a.n).slice(0, extended).map(x => x.deck);
  const ids = new Set(decks.map(d => d.id));
  const cells = {};
  for (const t of online) {
    if (!t.pairings) continue;
    const deckOf = new Map(t.standings.map(s => [s.player, s.deck.id]));
    for (const p of t.pairings) {
      const a = deckOf.get(p.player1), b = deckOf.get(p.player2);
      if (!a || !b || a === b || !ids.has(a) || !ids.has(b) || p.winner === undefined || p.winner === null) continue;
      const add = (x, y, r) => { cells[x] ??= {}; cells[x][y] ??= { w: 0, l: 0, t: 0 }; cells[x][y][r]++; };
      if (p.winner === 0) { add(a, b, 't'); add(b, a, 't'); }
      else if (p.winner === p.player1) { add(a, b, 'w'); add(b, a, 'l'); }
      else if (p.winner === p.player2) { add(a, b, 'l'); add(b, a, 'w'); }
    }
  }
  const out = {};
  for (const a of decks) for (const b of decks) {
    const c = cells[a.id]?.[b.id];
    if (!c) continue;
    const g = c.w + c.l + c.t;
    (out[a.id] ??= {})[b.id] = { games: g, wr: Math.round((c.w + c.t / 2) / g * 1000) / 10 };
  }
  const pub = d => ({ key: d.id, name: d.name, icons: d.icons });
  return { decks: decks.slice(0, top).map(pub), all: decks.map(pub), cells: out };
}

// ---------- Agregación ----------

const weekOf = date => { const d = new Date(date); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const round1 = n => Math.round(n * 10) / 10;

// Familia de un deck = su primer Pokémon (permite juntar "Dragapult" oficial con "Dragapult Dusknoir" online)
const familyOf = deck => (deck.icons?.[0] || deck.id.split('-')[0] || deck.id);

// events: [{ date, players, standings: [{ placing, deck, record }] }]
export function aggregate(events, { by = 'id' } = {}) {
  const decks = new Map();
  const weeks = new Map();       // semana → Map(deck → jugadores)
  let total = 0;
  const now = Date.now();
  const recentCut = now - 14 * DAY, prevCut = now - 28 * DAY;
  let recentTotal = 0, prevTotal = 0;

  for (const ev of events) {
    const n = ev.standings.length;
    const cut = Math.max(8, Math.round(n * 0.125));            // "top cut" aproximado: 12.5 % mejor (mín. 8)
    const t = Date.parse(ev.date);
    const wk = weekOf(ev.date);
    if (!weeks.has(wk)) weeks.set(wk, { total: 0, decks: new Map() });
    const W = weeks.get(wk);
    for (const s of ev.standings) {
      const key = by === 'family' ? familyOf(s.deck) : s.deck.id;
      if (!decks.has(key)) decks.set(key, { key, name: s.deck.name, icons: s.deck.icons, players: 0, top8: 0, topcut: 0,
        wins: 0, losses: 0, ties: 0, wins1st: 0, recent: 0, prev: 0, names: new Map() });
      const d = decks.get(key);
      d.players++; total++;
      d.names.set(s.deck.name, (d.names.get(s.deck.name) || 0) + 1);
      if (s.placing && s.placing <= 8) d.top8++;
      if (s.placing && s.placing <= cut) d.topcut++;
      if (s.placing === 1) d.wins1st++;
      if (s.record) { d.wins += s.record.wins || 0; d.losses += s.record.losses || 0; d.ties += s.record.ties || 0; }
      if (t >= recentCut) { d.recent++; } else if (t >= prevCut) { d.prev++; }
      W.total++; W.decks.set(key, (W.decks.get(key) || 0) + 1);
    }
    if (t >= recentCut) recentTotal += n; else if (t >= prevCut) prevTotal += n;
  }

  const weekList = [...weeks.keys()].sort();
  const totalTop = [...decks.values()].reduce((a, d) => a + d.topcut, 0) || 1;
  const list = [...decks.values()].map(d => {
    const share = d.players / (total || 1) * 100;
    const games = d.wins + d.losses + d.ties;
    const recentShare = recentTotal ? d.recent / recentTotal * 100 : null;
    const prevShare = prevTotal ? d.prev / prevTotal * 100 : null;
    const weekly = weekList.map(w => ({ week: w, share: round1((weeks.get(w).decks.get(d.key) || 0) / weeks.get(w).total * 100) }));
    // Nombre más usado dentro de la familia
    const name = by === 'family' ? [...d.names].sort((a, b) => b[1] - a[1])[0][0] : d.name;
    return {
      key: d.key, name, icons: d.icons, players: d.players, share: round1(share),
      top8: d.top8, wins1st: d.wins1st, topcut: d.topcut,
      topcut_share: round1(d.topcut / totalTop * 100),
      conversion: d.players ? round1(d.topcut / d.players * 100) : 0,   // % de sus jugadores que llegaron al top cut
      winrate: games >= 10 ? round1((d.wins + d.ties / 3) / games * 100) : null,
      games,
      trend: recentShare != null && prevShare != null ? round1(recentShare - prevShare) : null,
      recent_share: recentShare != null ? round1(recentShare) : null,
      weekly,
    };
  }).filter(d => d.players >= 2).sort((a, b) => b.players - a.players);
  return { total, events: events.length, weeks: weekList, decks: list };
}

// Predicción simple para el siguiente torneo, por familia de deck:
// uso ponderado por antigüedad (vida media 10 días; oficiales cuentan doble) + tendencia lineal de las
// últimas semanas + fuerza (conversión a top cut frente a lo esperado). Es una estimación, no una certeza.
export function predict(official, online) {
  const fam = new Map();
  const now = Date.now();
  const add = (events, weight) => {
    for (const ev of events) {
      const age = (now - Date.parse(ev.date)) / DAY;
      const w = weight * Math.pow(0.5, age / 10);
      const n = ev.standings.length;
      const cut = Math.max(8, Math.round(n * 0.125));
      for (const s of ev.standings) {
        const k = familyOf(s.deck);
        if (!fam.has(k)) fam.set(k, { key: k, names: new Map(), icons: s.deck.icons, w: 0, top: 0, exp: 0 });
        const f = fam.get(k);
        f.names.set(s.deck.name, (f.names.get(s.deck.name) || 0) + 1);
        f.w += w;
        if (s.placing && s.placing <= cut) f.top += w;
        f.exp += w * (cut / n);
      }
    }
  };
  add(official, 2);
  add(online, 1);
  const totalW = [...fam.values()].reduce((a, f) => a + f.w, 0) || 1;
  const famAgg = aggregate([...official, ...online], { by: 'family' });
  const trendBy = new Map(famAgg.decks.map(d => [d.key, d]));

  return [...fam.values()].map(f => {
    const share = f.w / totalW * 100;
    const strength = f.exp ? f.top / f.exp : 1;                     // >1: llega al top más de lo esperado
    const weekly = trendBy.get(f.key)?.weekly || [];
    const pts = weekly.slice(-5).map((p, i) => [i, p.share]);
    const slope = pts.length >= 3 ? linSlope(pts) : 0;              // puntos de % por semana
    const predicted = Math.max(0, share + slope * 0.8);
    const name = [...f.names].sort((a, b) => b[1] - a[1])[0][0];
    const score = predicted * (0.7 + 0.3 * Math.min(2, strength));  // uso esperado ajustado por fuerza
    return {
      key: f.key, name, icons: f.icons, share: round1(share), predicted: round1(predicted),
      slope: round1(slope), strength: Math.round(strength * 100) / 100, score: round1(score),
      outlook: slope > 0.6 ? 'up' : slope < -0.6 ? 'down' : 'stable',
    };
  }).filter(p => p.share >= 0.8).sort((a, b) => b.score - a.score).slice(0, 15);
}

function linSlope(pts) {
  const n = pts.length, sx = pts.reduce((a, p) => a + p[0], 0), sy = pts.reduce((a, p) => a + p[1], 0);
  const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0), sxy = pts.reduce((a, p) => a + p[0] * p[1], 0);
  const den = n * sxx - sx * sx;
  return den ? (n * sxy - sx * sy) / den : 0;
}

// ---------- Sprites de los Pokémon de cada deck (PokeAPI, en caché permanente) ----------

export async function resolveSprites(names, known = {}) {
  const out = { ...known };
  const todo = [...new Set(names)].filter(n => n && !out[n]).slice(0, 40);   // los que fallaron antes se reintentan
  await pool(todo, 6, async n => {
    for (const cand of [n, n.replace(/-(ex|mega)$/, ''), n.split('-')[0]]) {
      try {
        const p = await get(`https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(cand)}`);
        out[n] = p.sprites?.front_default || p.sprites?.other?.['official-artwork']?.front_default || '';
        return;
      } catch { /* probar el siguiente nombre */ }
      // Algunas especies solo existen como forma (p. ej. dudunsparce → dudunsparce-two-segment)
      try {
        const sp = await get(`https://pokeapi.co/api/v2/pokemon-species/${encodeURIComponent(cand)}`);
        const form = sp.varieties?.find(v => v.is_default)?.pokemon?.name;
        if (form) {
          const p = await get(`https://pokeapi.co/api/v2/pokemon/${form}`);
          out[n] = p.sprites?.front_default || ''; return;
        }
      } catch { /* sin especie con ese nombre */ }
    }
    out[n] = '';
  });
  return out;
}

// ---------- Construcción de la foto completa ----------

// ---------- Cartas más usadas (listas de los torneos online) ----------

const CAT = { pokemon: 'pokemon', trainer: 'trainer', energy: 'energy' };
// Clasificación dentro de un arquetipo: núcleo (casi todas las listas), flexible y "tech" (pocas listas)
const roleOf = pct => (pct >= 85 ? 'core' : pct >= 30 ? 'flex' : 'tech');

function cardStats(lists, { topCut = new Set() } = {}) {
  const map = new Map();
  for (const [i, l] of lists.entries()) {
    const seen = new Set();
    for (const cat of Object.keys(CAT)) for (const c of l.list[cat] || []) {
      const key = c.name;
      if (!map.has(key)) map.set(key, { name: c.name, category: CAT[cat], set: c.set, number: c.number, decks: 0, copies: 0, top: 0, prints: new Map() });
      const r = map.get(key);
      const pk = `${c.set}-${c.number}`;
      r.prints.set(pk, (r.prints.get(pk) || 0) + c.count);
      if (!seen.has(key)) { r.decks++; if (topCut.has(i)) r.top++; seen.add(key); }
      r.copies += c.count;
    }
  }
  const n = lists.length || 1, nTop = topCut.size || 1;
  return [...map.values()].map(r => {
    const [print] = [...r.prints].sort((a, b) => b[1] - a[1])[0];
    const [set, number] = print.split('-');
    return { name: r.name, category: r.category, set, number, pct: Math.round(r.decks / n * 1000) / 10,
             avg: Math.round(r.copies / r.decks * 10) / 10, top_pct: topCut.size ? Math.round(r.top / nTop * 1000) / 10 : null };
  }).sort((a, b) => b.pct - a.pct || b.avg - a.avg);
}

export function pokemonCardUsage(online) {
  const lists = [];
  const topCut = new Set();
  for (const ev of online) {
    const cut = Math.max(8, Math.round(ev.standings.length * 0.125));
    for (const s of ev.standings) {
      if (!s.list) continue;
      if (s.placing && s.placing <= cut) topCut.add(lists.length);
      lists.push({ deck: s.deck, list: s.list });
    }
  }
  const overall = cardStats(lists, { topCut });
  // Por arquetipo (los 14 con más listas)
  const byDeck = new Map();
  lists.forEach(l => { if (!byDeck.has(l.deck.id)) byDeck.set(l.deck.id, { deck: l.deck, lists: [] }); byDeck.get(l.deck.id).lists.push(l); });
  const archetypes = [...byDeck.values()].filter(a => a.lists.length >= 5).sort((a, b) => b.lists.length - a.lists.length).slice(0, 14)
    .map(a => ({ key: a.deck.id, name: a.deck.name, icons: a.deck.icons, lists: a.lists.length,
                 cards: cardStats(a.lists).slice(0, 45).map(c => ({ ...c, role: roleOf(c.pct) })) }));
  return { lists: lists.length, events: online.length, overall: overall.slice(0, 120), archetypes };
}

// Imágenes de cartas por código de expansión + número (TCGdex). Se resuelven poco a poco y quedan en caché.
async function resolveCardImages(cards, known = {}, setIndex = {}) {
  const out = { ...known };
  const need = cards.filter(c => c.set && c.number && !out[`${c.set}-${c.number}`]);
  const codes = [...new Set(need.map(c => c.set))].slice(0, 12);
  if (!codes.length) return { images: out, setIndex };
  // Índice abreviatura → id de expansión de TCGdex (las expansiones recientes; se guarda)
  const idx = { ...setIndex };
  if (codes.some(c => !idx[c])) {
    try {
      const sets = await get('https://api.tcgdex.net/v2/en/sets');
      const recent = sets.filter(x => /^(sv|me|30th|svp|mep)/.test(x.id) && !Object.values(idx).includes(x.id)).slice(-40);
      await pool(recent, 3, async st => { const d = await get(`https://api.tcgdex.net/v2/en/sets/${st.id}`); if (d.abbreviation?.official) idx[d.abbreviation.official] = d.id; });
    } catch { /* sin índice: se reintenta en la próxima actualización */ }
  }
  await pool(codes.filter(c => idx[c]), 3, async code => {
    const d = await get(`https://api.tcgdex.net/v2/en/sets/${idx[code]}`);
    for (const c of need.filter(x => x.set === code)) {
      const card = (d.cards || []).find(k => parseInt(k.localId, 10) === parseInt(c.number, 10) && /^\d/.test(k.localId));
      if (card?.image) out[`${code}-${c.number}`] = `${card.image}/low.webp`;
    }
  });
  return { images: out, setIndex: idx };
}

export async function buildSnapshot(previous = null) {
  const [official, online] = await Promise.all([
    fetchOfficial().catch(err => { console.error('meta oficial:', err.message); return null; }),
    fetchOnline().catch(err => { console.error('meta online:', err.message); return null; }),
  ]);
  if (!official && !online && previous) return { ...previous, stale: true };
  const summarize = (evs, withRecord) => evs.map(e => ({
    id: e.id, name: e.name, date: e.date, players: e.players || e.standings.length, country: e.country || null, url: e.url,
    top: e.standings.filter(s => s.placing && s.placing <= 8).sort((a, b) => a.placing - b.placing)
      .map(s => ({ placing: s.placing, name: s.name, country: s.country, deck: s.deck, ...(withRecord ? { record: s.record } : {}) })),
  }));
  // Si una fuente falla, se conserva su parte de la foto anterior
  const off = official ? { ...aggregate(official), list: summarize(official, false) } : previous?.official || { decks: [], list: [], weeks: [], total: 0, events: 0 };
  const onl = online ? { ...aggregate(online), list: summarize(online, true), matchups: matchupMatrix(online) } : previous?.online || { decks: [], list: [], weeks: [], total: 0, events: 0 };
  const predictions = official && online ? predict(official, online) : previous?.predictions || predict(official || [], online || []);
  const icons = [...off.decks, ...onl.decks].flatMap(d => d.icons || []);
  const sprites = await resolveSprites(icons, previous?.sprites || {});
  // Cartas más usadas: se guardan aparte (otra entrada en la base de datos) por tamaño
  let cards = null;
  if (online) {
    cards = pokemonCardUsage(online);
    const all = [...cards.overall, ...cards.archetypes.flatMap(a => a.cards)];
    const { images, setIndex } = await resolveCardImages(all, previous?._cardImages || {}, previous?._setIndex || {})
      .catch(() => ({ images: previous?._cardImages || {}, setIndex: previous?._setIndex || {} }));
    cards.images = images; cards._setIndex = setIndex;
  }
  return { updated_at: new Date().toISOString(), official: off, online: onl, predictions, sprites,
           partial: !official || !online, _cards: cards };
}
