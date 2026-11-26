// Metajuego competitivo de Yu-Gi-Oh! (formato TCG).
//
// Fuentes:
//  - YGO Omega (omega.duelistsunite.org): estadísticas de la ladder TCG (uso, tier, win rate esperado, efecto de ir
//    primero) y el % de victorias de cada arquetipo contra los demás. Las páginas son públicas; se leen pocas veces
//    al día (sus términos piden no sobrecargar el sitio).
//  - YGOPRODeck: listas de "Tournament Meta Decks" (torneos oficiales: WCQ Regionales, YCS…) con main, extra y side,
//    para el uso por arquetipo y las cartas más jugadas. Los datos de cartas vienen de su API pública (v7).
//
// Las imágenes de cartas se descargan una sola vez y se guardan en nuestro almacenamiento (YGOPRODeck pide no
// enlazarlas directamente).
import { putFile, publicUrl } from './storage/index.js';

const OMEGA = 'https://omega.duelistsunite.org';
const YGOPRO_DECKS = 'https://ygoprodeck.com/api/decks/getDecks.php?format=Tournament%20Meta%20Decks';
const YGOPRO_API = 'https://db.ygoprodeck.com/api/v7';
const UA = 'MacaiTCG/1.0 (estadisticas de metajuego)';
const OMEGA_MATCHUP_DECKS = 8;    // arquetipos de los que se leen sus enfrentamientos (cada página ~600 KB)
const YGOPRO_PAGES = 6;           // 6 × 20 listas ≈ las últimas 2-3 semanas
const IMAGE_BUDGET = 150;         // imágenes nuevas por actualización (pequeñas, ~15 KB)

async function get(url, type = 'json') {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (res.status === 429) throw new Error('Demasiadas peticiones');
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return type === 'json' ? res.json() : type === 'buffer' ? Buffer.from(await res.arrayBuffer()) : res.text();
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await Promise.resolve().then(() => fn(items[k], k)).catch(() => null); }
  }));
  return out;
}
const decode = s => String(s || '').replace(/&#x27;|&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const r1 = n => Math.round(n * 10) / 10;

// Contenido incrustado de las páginas Next.js de Omega (self.__next_f.push([1,"..."]))
function nextPayload(html) {
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let all = '', m;
  while ((m = re.exec(html))) { try { all += JSON.parse(`"${m[1]}"`); } catch { /* fragmento raro */ } }
  return all;
}
// Extrae el arreglo JSON que sigue a una clave ("decks":[...]) respetando corchetes y comillas
function jsonArrayAfter(text, key, from = 0) {
  const k = text.indexOf(`"${key}":[`, from);
  if (k < 0) return null;
  let i = text.indexOf('[', k), depth = 0, inStr = false;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (inStr) { if (ch === '\\') j++; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === '[') depth++; else if (ch === ']' && --depth === 0) {
      try { return JSON.parse(text.slice(i, j + 1)); } catch { return null; }
    }
  }
  return null;
}

// ---------- Omega: ladder TCG ----------
async function fetchOmegaLadder() {
  const payload = nextPayload(await get(`${OMEGA}/statistics?ladder=tcg`, 'html'));
  const decks = jsonArrayAfter(payload, 'decks') || [];
  const built = /"builtAt":"([^"]+)"/.exec(payload)?.[1] || null;
  // Una entrada con "*" agrupa todas las variantes del arquetipo; se prefiere esa y se quitan duplicados por nombre
  const best = new Map();
  for (const d of decks) {
    if (!d?.name) continue;
    const prev = best.get(d.name);
    if (!prev || (String(d.key).endsWith('*') && !String(prev.key).endsWith('*')) || (d.share > prev.share && String(d.key).endsWith('*') === String(prev.key).endsWith('*'))) best.set(d.name, d);
  }
  return {
    built_at: built,
    decks: [...best.values()].sort((a, b) => b.share - a.share).slice(0, 40).map(d => ({
      key: String(d.key).replace(/\*$/, ''), name: d.name, face: d.face || null, tier: d.tier ?? null, share: r1(d.share * 100), players: d.players, games: d.games,
      winrate: d.wrExpected != null ? r1(d.wrExpected * 100) : null, wr_lo: d.wrLo != null ? r1(d.wrLo * 100) : null, wr_hi: d.wrHi != null ? r1(d.wrHi * 100) : null,
      first_wr: d.firstG1Wr != null ? r1(d.firstG1Wr * 100) : null, second_wr: d.secondG1Wr != null ? r1(d.secondG1Wr * 100) : null,
    })),
  };
}

// ---------- Omega: enfrentamientos entre los arquetipos principales ----------
async function fetchOmegaMatchups(decks) {
  const top = decks.slice(0, OMEGA_MATCHUP_DECKS);
  const names = new Set(top.map(d => d.name));
  const pages = await pool(top, 2, d => get(`${OMEGA}/statistics/archetypes/${encodeURIComponent(d.key)}?ladder=tcg`, 'html'));
  const cells = {};
  top.forEach((d, i) => {
    if (!pages[i]) return;
    const list = jsonArrayAfter(nextPayload(pages[i]), 'matchups') || [];
    for (const m of list) {
      if (!names.has(m.opponentName) || m.opponentName === d.name || !m.games) continue;
      (cells[d.name] ??= {})[m.opponentName] = { games: m.games, wr: r1((m.wrRaw ?? m.wins / m.games) * 100),
        first: m.firstWr != null ? r1(m.firstWr * 100) : null, second: m.secondWr != null ? r1(m.secondWr * 100) : null };
    }
  });
  return { decks: top.map(d => ({ name: d.name, face: d.face })), cells };
}

// ---------- YGOPRODeck: listas de torneos ----------
const parseIds = v => { try { return (Array.isArray(v) ? v : JSON.parse(v || '[]')).map(String); } catch { return []; } };

async function fetchYgoproDecks() {
  const pages = await pool([...Array(YGOPRO_PAGES).keys()], 2, i => get(`${YGOPRO_DECKS}${i ? `&offset=${i * 20}` : ''}`));
  const seen = new Set();
  return pages.flat().filter(Boolean).filter(d => d.deckNum && !seen.has(d.deckNum) && seen.add(d.deckNum)).map((d, idx) => ({
    id: d.deckNum, order: idx, archetype: decode(d.deck_name || '').trim() || 'Sin nombre',
    tournament: decode(d.tournamentName || ''), placement: decode(d.tournamentPlacement || ''),
    players: Number(d.tournamentPlayerCount) || null, player: decode(d.tournamentPlayerName || ''),
    cover: String(d.cover_card || ''), url: d.pretty_url ? `https://ygoprodeck.com/deck/${d.pretty_url}` : null,
    main: parseIds(d.main_deck), extra: parseIds(d.extra_deck), side: parseIds(d.side_deck),
  }));
}

// Lugar aproximado como número (Winner=1, Top 4=4, Top 8=8, "2nd"=2…)
const placeNum = p => { const s = String(p).toLowerCase(); if (/winner|1st|champ/.test(s)) return 1; if (/2nd|finalist|runner/.test(s)) return 2;
  const t = /top\s*(\d+)/.exec(s); if (t) return Number(t[1]); const n = parseInt(s, 10); return Number.isFinite(n) ? n : 99; };

function ygoArchetypes(decks) {
  const n = decks.length || 1;
  const half = Math.floor(decks.length / 2);          // las listas vienen de la más nueva a la más vieja
  const map = new Map();
  for (const d of decks) {
    if (!map.has(d.archetype)) map.set(d.archetype, { name: d.archetype, cover: d.cover, lists: 0, wins: 0, top4: 0, recent: 0, prev: 0 });
    const a = map.get(d.archetype);
    a.lists++; const p = placeNum(d.placement);
    if (p === 1) a.wins++; if (p <= 4) a.top4++;
    if (d.order < half) a.recent++; else a.prev++;
  }
  return [...map.values()].map(a => ({
    ...a, share: r1(a.lists / n * 100),
    trend: half ? r1(a.recent / Math.max(1, half) * 100 - a.prev / Math.max(1, decks.length - half) * 100) : null,
  })).sort((a, b) => b.lists - a.lists);
}

function ygoCardUsage(decks) {
  const n = decks.length || 1;
  const sections = { main: new Map(), extra: new Map(), side: new Map() };
  const archOf = new Map();                            // carta → arquetipos que la usan (para detectar "staples")
  for (const d of decks) for (const sec of Object.keys(sections)) {
    const counts = new Map();
    d[sec].forEach(id => counts.set(id, (counts.get(id) || 0) + 1));
    for (const [id, c] of counts) {
      const m = sections[sec];
      if (!m.has(id)) m.set(id, { id, decks: 0, copies: 0 });
      const r = m.get(id); r.decks++; r.copies += c;
      if (!archOf.has(id)) archOf.set(id, new Set()); archOf.get(id).add(d.archetype);
    }
  }
  const nArch = new Set(decks.map(d => d.archetype)).size || 1;
  const fmt = (m, limit) => [...m.values()].map(r => ({ id: r.id, pct: r1(r.decks / n * 100), avg: r1(r.copies / r.decks),
    archetypes: archOf.get(r.id)?.size || 0, staple: (archOf.get(r.id)?.size || 0) / nArch >= 0.3 }))
    .sort((a, b) => b.pct - a.pct).slice(0, limit);
  // Por arquetipo (los 12 con más listas): núcleo, flexibles y techs
  const groups = new Map();
  decks.forEach(d => { if (!groups.has(d.archetype)) groups.set(d.archetype, []); groups.get(d.archetype).push(d); });
  const archetypes = [...groups].filter(([, l]) => l.length >= 2).sort((a, b) => b[1].length - a[1].length).slice(0, 12).map(([name, l]) => {
    const per = { main: new Map(), extra: new Map(), side: new Map() };
    for (const d of l) for (const sec of Object.keys(per)) {
      const counts = new Map(); d[sec].forEach(id => counts.set(id, (counts.get(id) || 0) + 1));
      for (const [id, c] of counts) { if (!per[sec].has(id)) per[sec].set(id, { id, decks: 0, copies: 0 }); const r = per[sec].get(id); r.decks++; r.copies += c; }
    }
    const pack = (m, lim) => [...m.values()].map(r => { const pct = r1(r.decks / l.length * 100); return { id: r.id, pct, avg: r1(r.copies / r.decks), role: pct >= 85 ? 'core' : pct >= 30 ? 'flex' : 'tech' }; })
      .sort((a, b) => b.pct - a.pct).slice(0, lim);
    return { name, lists: l.length, cover: l[0].cover, main: pack(per.main, 30), extra: pack(per.extra, 15), side: pack(per.side, 15) };
  });
  return { lists: decks.length, main: fmt(sections.main, 80), extra: fmt(sections.extra, 40), side: fmt(sections.side, 50), archetypes };
}

// Nombres y tipos de las cartas (API v7 de YGOPRODeck, de a 40 ids por petición)
async function cardInfo(ids, known = {}) {
  const out = { ...known };
  const todo = [...new Set(ids)].filter(id => id && !out[id]);
  const batches = [];
  for (let i = 0; i < todo.length; i += 40) batches.push(todo.slice(i, i + 40));
  await pool(batches.slice(0, 14), 2, async b => {
    const { data = [] } = await get(`${YGOPRO_API}/cardinfo.php?id=${b.join(',')}`);
    for (const c of data) {
      const kind = /spell/i.test(c.type) ? 'spell' : /trap/i.test(c.type) ? 'trap' : /fusion|synchro|xyz|link/i.test(c.frameType || '') ? 'extra' : 'monster';
      const base = { name: c.name, kind, archetype: c.archetype || '', canon: String(c.id) };
      out[String(c.id)] = base;
      // Las artes alternativas comparten datos y apuntan a la misma id canónica
      for (const img of c.card_images || []) out[String(img.id)] = base;
    }
  });
  return out;
}

// Descarga la imagen pequeña de cada carta una vez y la guarda en nuestro almacenamiento
async function cacheImages(ids, known = {}) {
  const out = { ...known };
  const todo = [...new Set(ids)].filter(id => id && !out[id]).slice(0, IMAGE_BUDGET);
  await pool(todo, 4, async id => {
    const buf = await get(`https://images.ygoprodeck.com/images/cards_small/${id}.jpg`, 'buffer');
    const key = `ref/ygo-small-${id}.jpg`;
    await putFile(key, buf, 'image/jpeg');
    out[id] = publicUrl(key);
  });
  return out;
}

export async function buildYgoSnapshot(previous = null) {
  const [ladder, decks] = await Promise.all([
    fetchOmegaLadder().catch(err => { console.error('ygo omega ladder:', err.message); return null; }),
    fetchYgoproDecks().catch(err => { console.error('ygo ygoprodeck:', err.message); return null; }),
  ]);
  if (!ladder && !decks && previous) return { ...previous, stale: true };
  const matchups = ladder ? await fetchOmegaMatchups(ladder.decks).catch(err => { console.error('ygo matchups:', err.message); return null; }) : null;

  let tournaments = previous?.tournaments || { lists: 0, decks: [], list: [] };
  let cards = previous?.cards || null;
  let info = previous?._info || {};
  if (decks) {
    // Primero los nombres de todas las cartas; luego se unifican las artes alternativas y se cuentan los usos
    const allIds = decks.flatMap(d => [...d.main, ...d.extra, ...d.side, d.cover]);
    info = await cardInfo(allIds, info).catch(() => info);
    // Misma carta = mismo nombre (hay reimpresiones con otra id y artes alternativas)
    const byName = new Map();
    for (const id of allIds) { const nm = info[id]?.name; if (nm && !byName.has(nm)) byName.set(nm, info[id].canon || id); }
    const canon = id => (info[id] ? byName.get(info[id].name) || info[id].canon || id : id);
    for (const d of decks) { d.main = d.main.map(canon); d.extra = d.extra.map(canon); d.side = d.side.map(canon); d.cover = canon(d.cover); }
    const usage = ygoCardUsage(decks);
    const named = list => list.map(c => ({ ...c, name: info[c.id]?.name || `Carta ${c.id}`, kind: info[c.id]?.kind || '' }));
    cards = { lists: usage.lists, main: named(usage.main), extra: named(usage.extra), side: named(usage.side),
              archetypes: usage.archetypes.map(a => ({ ...a, main: named(a.main), extra: named(a.extra), side: named(a.side) })) };
    // Eventos (agrupados por torneo) con sus listas
    const byEvent = new Map();
    for (const d of decks) {
      const k = d.tournament || 'Torneo';
      if (!byEvent.has(k)) byEvent.set(k, { name: k, players: d.players, top: [] });
      byEvent.get(k).top.push({ placing: d.placement, place_n: placeNum(d.placement), name: d.player, archetype: d.archetype, cover: d.cover, url: d.url });
    }
    tournaments = { lists: decks.length, decks: ygoArchetypes(decks),
      list: [...byEvent.values()].slice(0, 24).map(e => ({ ...e, top: e.top.sort((a, b) => a.place_n - b.place_n).slice(0, 8) })) };
  }

  // Imágenes (caras de arquetipo de Omega, portadas y cartas más usadas)
  const imgIds = [
    ...(ladder?.decks || previous?.omega_ladder?.decks || []).map(d => String(d.face || '')),
    ...((matchups?.decks) || []).map(d => String(d.face || '')),
    ...tournaments.decks.map(d => d.cover),
    ...(cards ? [...cards.main.slice(0, 40), ...cards.extra.slice(0, 20), ...cards.side.slice(0, 25)].map(c => c.id) : []),
    ...(cards ? cards.archetypes.flatMap(a => [...a.main, ...a.extra, ...a.side].map(c => c.id)) : []),
  ];
  const images = await cacheImages(imgIds, previous?.images || {}).catch(() => previous?.images || {});

  // Mantener solo los nombres que se usan (para que la foto no crezca sin límite)
  const used = new Set(imgIds.concat(cards ? [...cards.main, ...cards.extra, ...cards.side].map(c => c.id) : []));
  const infoSlim = Object.fromEntries(Object.entries(info).filter(([id]) => used.has(id)));

  return {
    updated_at: new Date().toISOString(),
    omega_ladder: ladder ? { ...ladder, matchups: matchups || previous?.omega_ladder?.matchups || null } : previous?.omega_ladder || { decks: [] },
    tournaments, cards, images, _info: infoSlim,
    partial: !ladder || !decks,
  };
}
