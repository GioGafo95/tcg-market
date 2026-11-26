// Consulta de bases de datos públicas de cartas y precios de mercado.
//  - Pokémon:   api.tcgdex.net (precio "market" de TCGplayer, USD; nombres en español); si falla, api.pokemontcg.io
//  - Yu-Gi-Oh!: db.ygoprodeck.com  (precio de TCGplayer por edición/set, USD)
// Collectr no ofrece una API pública, por eso se usa TCGplayer como referencia de mercado.
import { createHash } from 'node:crypto';
import { putFile, fileExists, publicUrl } from './storage/files.js';

const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

// Reintenta una vez si el servicio responde 5xx (pokemontcg.io devuelve 502 con frecuencia)
async function getJSON(url, { retries = 1, timeout = 10000 } = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.data;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { Accept: 'application/json' } });
    if (res.status === 400 || res.status === 404) return { data: [] }; // ygoprodeck responde 400 cuando no hay resultados
    if (res.status >= 500 && attempt < retries) { await new Promise(r => setTimeout(r, 400)); continue; }
    if (!res.ok) throw new Error(`Error ${res.status} al consultar ${new URL(url).host}`);
    const data = await res.json();
    cache.set(url, { t: Date.now(), data });
    return data;
  }
}

const PAGE = 24;

// Separa la búsqueda en nombre y número de carta: "Pikachu 25", "Charizard ex 199/165", "025"
function parseQuery(q) {
  const words = q.split(/\s+/).filter(Boolean);
  const numIdx = words.findIndex(w => /^#?\d{1,3}(\/\d{1,3})?$/.test(w));
  const number = numIdx >= 0 ? String(parseInt(words[numIdx].replace('#', ''), 10)) : '';
  const name = words.filter((_, i) => i !== numIdx).join(' ');
  return { name, number };
}

const round2 = n => (Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null);

// ---------- Pokémon ----------

const PKM_FIELDS = 'id,name,number,rarity,set,images,tcgplayer,supertype,subtypes';

// Tipo de carta para armar decks: pokemon | trainer | energy, y si es energía básica (sin límite de copias).
// Si la fuente no lo dice, se deduce del nombre ("Fire Energy", "Basic Fire Energy").
const BASIC_ENERGY_RE = /^(basic\s+)?(grass|fire|water|lightning|psychic|fighting|darkness|metal|fairy)\s+energy$/i;
function pokemonKind(category, name, basicFlag) {
  const c = String(category || '').toLowerCase();
  const kind = c.startsWith('pok') ? 'pokemon' : c === 'trainer' ? 'trainer' : c === 'energy' ? 'energy'
    : BASIC_ENERGY_RE.test(name || '') ? 'energy' : '';
  return { category: kind, basic_energy: kind === 'energy' && (basicFlag ?? BASIC_ENERGY_RE.test(name || '')) };
}
const PKM_VARIANTS = ['holofoil', 'normal', 'reverseHolofoil', '1stEditionHolofoil', 'unlimitedHolofoil', '1stEditionNormal', 'unlimited', '1stEdition'];

function pokemonPrice(c) {
  const prices = c.tcgplayer?.prices || {};
  for (const v of [...PKM_VARIANTS, ...Object.keys(prices)]) {
    const p = prices[v];
    const value = round2(p?.market ?? p?.mid);
    if (value) return value;
  }
  return null;
}

const mapPokemon = c => ({
  ref_id: c.id,
  card_name: c.name,
  set_name: c.set?.name || '',
  card_code: c.set?.printedTotal ? `${c.number}/${c.set.printedTotal}` : c.number,
  rarity: c.rarity || '',
  image_url: c.images?.large || c.images?.small || '',
  image_small: c.images?.small || '',
  market_price: pokemonPrice(c),
  market_source: 'TCGplayer',
  ...pokemonKind(c.supertype, c.name, c.supertype === 'Energy' ? (c.subtypes || []).includes('Basic') : undefined),
});

// TCGdex (fuente principal de Pokémon; también trae precios de TCGplayer). Sus ids llevan el prefijo "tcgdex:".
const TCGDEX = 'https://api.tcgdex.net/v2/en';

function tcgdexPrice(c) {
  const tp = c.pricing?.tcgplayer || {};
  for (const v of ['holofoil', 'normal', 'reverse-holofoil', '1st-edition-holofoil', ...Object.keys(tp)]) {
    const value = round2(tp[v]?.marketPrice ?? tp[v]?.midPrice);
    if (value) return value;
  }
  return null;
}

const mapTcgdex = c => ({
  ref_id: `tcgdex:${c.id}`,
  card_name: c.name,
  set_name: c.set?.name || '',
  card_code: c.set?.cardCount?.official ? `${c.localId}/${c.set.cardCount.official}` : c.localId,
  rarity: c.rarity && c.rarity !== 'None' ? c.rarity : '',
  image_url: c.image ? `${c.image}/high.png` : '',
  image_small: c.image ? `${c.image}/low.webp` : '',
  market_price: tcgdexPrice(c),
  market_source: 'TCGplayer',
  ...pokemonKind(c.category, c.name, c.category === 'Energy' && c.energyType ? c.energyType === 'Normal' : undefined),
});

// Cartas solo digitales de Pokémon TCG Pocket: no existen físicamente, se excluyen
const isPocket = c => /\/tcgp\//.test(c.image || '') || /^(A\d|B\d|P-[AB]-)/.test(c.id);

// Expansiones de TCGdex con su fecha de salida (GraphQL, una sola consulta; caché de 6 h).
// La API de cartas no ordena por fecha, así que el orden "más nuevas primero" se calcula aquí.
let setsCache = { t: 0, data: null };
async function tcgdexSets() {
  if (setsCache.data && Date.now() - setsCache.t < 6 * 3600e3) return setsCache.data;
  const res = await fetch('https://api.tcgdex.net/v2/graphql', {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: '{ sets { id name releaseDate } }' }),
  });
  if (!res.ok) throw new Error(`Error ${res.status} al consultar las expansiones de TCGdex`);
  const sets = (await res.json()).data?.sets || [];
  const data = new Map(sets.map(s => [s.id, { name: s.name, date: s.releaseDate || '' }]));
  setsCache = { t: Date.now(), data };
  return data;
}
// El id de carta es "<set>-<número>" (el set puede llevar guiones: "tk-hs-r-2")
const setIdOf = cardId => cardId.slice(0, cardId.lastIndexOf('-'));

// Búsqueda principal de Pokémon en TCGdex. Trae todas las coincidencias (solo id, nombre e imagen), las ordena de
// la expansión más nueva a la más vieja y pide el detalle (expansión, rareza, precio) solo de la página pedida.
// lang 'es' busca por el nombre en español; el detalle se lee en inglés con el mismo id y se conserva el nombre.
// setWords: "Charizard Obsidian Flames" → nombre "Charizard" dentro de expansiones cuyo nombre contenga "Obsidian Flames".
async function searchTcgdex({ name, number, setWords = '' }, page, lang = 'en') {
  const params = new URLSearchParams();
  if (name) params.set('name', name);
  if (number) params.set('localId', number);
  const [raw, sets] = await Promise.all([
    getJSON(`https://api.tcgdex.net/v2/${lang}/cards?${params}`),
    tcgdexSets().catch(() => new Map()),   // sin fechas: se conserva el orden de la API
  ]);
  const wanted = setWords.toLowerCase();
  const all = (Array.isArray(raw) ? raw : [])
    .filter(c => !isPocket(c) && (!number || parseInt(c.localId, 10) === Number(number)))
    .filter(c => !wanted || (sets.get(setIdOf(c.id))?.name || '').toLowerCase().includes(wanted))
    .map((c, i) => ({ c, i, date: sets.get(setIdOf(c.id))?.date || '' }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.i - b.i)
    .map(x => x.c);
  const items = all.slice((page - 1) * PAGE, page * PAGE);
  const cards = await Promise.all(items.map(async it => {
    const c = await getJSON(`${TCGDEX}/cards/${encodeURIComponent(it.id)}`).catch(() => null);
    const card = c?.id ? mapTcgdex(c)
      : mapTcgdex({ ...it, image: it.image?.replace('/es/', '/en/'), set: { name: sets.get(setIdOf(it.id))?.name } });
    return lang === 'en' ? card : { ...card, card_name: it.name };
  }));
  return { results: cards, has_more: all.length > page * PAGE, total: all.length, source: lang === 'en' ? 'tcgdex' : 'tcgdex-es' };
}

// Respaldo: pokemontcg.io (ya ordena por fecha). Se usa si TCGdex no responde.
async function searchPokemontcg({ name, number }, page, retries = 1) {
  const clean = s => s.replace(/["*\\]/g, '');
  const words = clean(name).split(' ');
  const run = async parts => {
    const q = encodeURIComponent(parts.filter(Boolean).join(' '));
    const out = await getJSON(`https://api.pokemontcg.io/v2/cards?q=${q}&page=${page}&pageSize=${PAGE}` +
      `&orderBy=-set.releaseDate&select=${PKM_FIELDS}`, { retries });
    return { results: (out.data || []).map(mapPokemon), has_more: page * PAGE < (out.totalCount || 0), source: 'pokemontcg' };
  };
  const r = await run([name && `name:"${clean(name)}*"`, number && `number:${number}`]);
  if (r.results.length || words.length < 2) return r;
  return run([`name:"${words[0]}*"`, `set.name:"${words.slice(1).join(' ')}*"`, number && `number:${number}`]);
}

// source: la fuente que dio la página 1 ('tcgdex' | 'tcgdex-es' | 'tcgdex-set' | 'pokemontcg'). Las páginas
// siguientes la respetan para que no se mezclen ni se repitan cartas entre fuentes.
async function searchPokemon(query, page, source = '') {
  const { name, number } = parseQuery(query);
  const words = name.split(' ').filter(Boolean);
  const bySet = () => searchTcgdex({ name: words[0], number, setWords: words.slice(1).join(' ') }, page);

  if (source === 'tcgdex') return searchTcgdex({ name, number }, page);
  if (source === 'tcgdex-es') return searchTcgdex({ name, number }, page, 'es');
  if (source === 'tcgdex-set') return { ...(await bySet()), source: 'tcgdex-set' };
  if (source === 'pokemontcg') return searchPokemontcg({ name, number }, page, 3);
  try {
    const en = await searchTcgdex({ name, number }, page);
    if (en.results.length || page > 1) return en;
    const es = await searchTcgdex({ name, number }, page, 'es');           // nombre en español
    if (es.results.length || words.length < 2) return es;
    return { ...(await bySet()), source: 'tcgdex-set' };                    // "Charizard Obsidian Flames"
  } catch (err) {
    console.warn('TCGdex no disponible, usando pokemontcg.io:', err.message);
    return searchPokemontcg({ name, number }, page);
  }
}

// ---------- Yu-Gi-Oh! ----------
// Una carta tiene muchas ediciones (sets); cada edición es un resultado distinto con su propio precio.

function mapYugioh(c, set) {
  const general = round2(parseFloat(c.card_prices?.[0]?.tcgplayer_price));
  return {
    ref_id: `${c.id}|${set?.set_code || ''}|${set?.set_rarity || ''}`,
    card_name: c.name,
    set_name: set?.set_name || '',
    card_code: set?.set_code || '',
    rarity: set?.set_rarity || '',
    image_url: c.card_images?.[0]?.image_url || '',
    image_small: c.card_images?.[0]?.image_url_small || '',
    market_price: round2(parseFloat(set?.set_price)) ?? general,
    market_source: 'TCGplayer',
    // Para decks: fusión, sincronía, XYZ y link van al Extra Deck; el resto (monstruo, mágica, trampa) al principal
    category: /fusion|synchro|xyz|link/i.test(c.frameType || '') ? 'extra'
      : c.frameType === 'spell' ? 'spell' : c.frameType === 'trap' ? 'trap' : 'monster',
  };
}

// ---------- API pública del módulo ----------

// Yu-Gi-Oh!: por código de edición ("LOB-EN001", "MRD-060") o por nombre (todas las ediciones de cada carta)
const YGO_CARDS_PER_PAGE = 6;
async function searchYugioh(query, page) {
  if (/^[a-z0-9]{2,6}-[a-z]{0,2}\d{2,3}$/i.test(query)) {
    const info = await getJSON(`https://db.ygoprodeck.com/api/v7/cardsetsinfo.php?setcode=${encodeURIComponent(query.toUpperCase())}`);
    if (!info?.id) return { results: [], has_more: false };
    const { data = [] } = await getJSON(`https://db.ygoprodeck.com/api/v7/cardinfo.php?id=${info.id}`);
    const c = data[0];
    if (!c) return { results: [], has_more: false };
    const sets = (c.card_sets || []).filter(s => s.set_code.toUpperCase() === query.toUpperCase());
    return { results: (sets.length ? sets : [info]).map(s => mapYugioh(c, s)), has_more: false };
  }
  const out = await getJSON(`https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(query)}` +
    `&num=${YGO_CARDS_PER_PAGE}&offset=${(page - 1) * YGO_CARDS_PER_PAGE}`);
  const results = [];
  const seen = new Set();
  for (const c of out.data || []) {
    const sets = c.card_sets?.length ? c.card_sets : [null];
    for (const s of sets) {
      const r = mapYugioh(c, s);
      if (!seen.has(r.ref_id)) { seen.add(r.ref_id); results.push(r); }
    }
  }
  return { results, has_more: !!out.meta?.next_page };
}

// Devuelve { results, has_more } para la página pedida (1, 2, 3…)
export async function searchCards(game, query, page = 1, source = '') {
  query = query.trim().replace(/\s+/g, ' ');
  if (query.length < 2) return { results: [], has_more: false };
  return game === 'pokemon' ? searchPokemon(query, page, source) : searchYugioh(query, page);
}

// Vuelve a consultar una carta concreta por su ref_id (al guardar, para no confiar en el precio que mande el navegador)
export async function getCardByRef(game, refId) {
  if (!refId) return null;
  if (game === 'pokemon' && refId.startsWith('tcgdex:')) {
    const id = refId.slice(7);
    if (!/^[\w.-]+$/.test(id)) return null;
    const c = await getJSON(`${TCGDEX}/cards/${id}`);
    return c?.id ? mapTcgdex(c) : null;
  }
  if (game === 'pokemon') {
    if (!/^[\w.-]+$/.test(refId)) return null;
    const { data } = await getJSON(`https://api.pokemontcg.io/v2/cards/${refId}?select=${PKM_FIELDS}`);
    return data && !Array.isArray(data) ? mapPokemon(data) : null;
  }
  const [id, setCode = '', setRarity = ''] = refId.split('|');
  if (!/^\d+$/.test(id)) return null;
  const { data = [] } = await getJSON(`https://db.ygoprodeck.com/api/v7/cardinfo.php?id=${id}`);
  const c = data[0];
  if (!c) return null;
  const set = c.card_sets?.find(s => s.set_code === setCode && s.set_rarity === setRarity)
           || c.card_sets?.find(s => s.set_code === setCode) || null;
  return mapYugioh(c, set);
}

// Guarda una copia local de la imagen oficial (YGOPRODeck pide no enlazar sus imágenes directamente)
export async function cacheRefImage(game, url) {
  if (!/^https:\/\/(images\.pokemontcg\.io|images\.ygoprodeck\.com|assets\.tcgdex\.net)\//.test(url || '')) return '';
  const ext = url.endsWith('.png') ? '.png' : url.endsWith('.webp') ? '.webp' : '.jpg';
  const key = `ref/${game}-${createHash('sha1').update(url).digest('hex').slice(0, 20)}${ext}`;
  if (!(await fileExists(key))) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.startsWith('image/')) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) return '';
    await putFile(key, buf, type);
  }
  return publicUrl(key);
}
