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
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k).catch(() => null); }
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
  return chosen.map((t, i) => ({
    id: t.id, name: t.name, date: t.date.slice(0, 10), players: t.players,
    url: `https://play.limitlesstcg.com/tournament/${t.id}/standings`,
    standings: (standings[i] || []).filter(s => s.deck?.id && s.deck.id !== 'other').map(s => ({
      placing: s.placing, name: s.name, country: s.country,
      deck: { id: s.deck.id, name: s.deck.name, icons: s.deck.icons || [] }, record: s.record || null,
    })),
  })).filter(t => t.standings.length >= 8);
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
  const onl = online ? { ...aggregate(online), list: summarize(online, true) } : previous?.online || { decks: [], list: [], weeks: [], total: 0, events: 0 };
  const predictions = official && online ? predict(official, online) : previous?.predictions || predict(official || [], online || []);
  const icons = [...off.decks, ...onl.decks].flatMap(d => d.icons || []);
  const sprites = await resolveSprites(icons, previous?.sprites || {});
  return { updated_at: new Date().toISOString(), official: off, online: onl, predictions, sprites,
           partial: !official || !online };
}
