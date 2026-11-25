// Consulta de bases de datos públicas de cartas y precios de mercado.
//  - Pokémon:   api.pokemontcg.io  (precio "market" de TCGplayer, USD); si falla, api.tcgdex.net
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

const PKM_FIELDS = 'id,name,number,rarity,set,images,tcgplayer';
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
});

// Respaldo para Pokémon: api.tcgdex.net (también trae precios de TCGplayer). Sus ids llevan el prefijo "tcgdex:".
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
});

// Cartas solo digitales de Pokémon TCG Pocket: no existen físicamente, se excluyen
const isPocket = c => /\/tcgp\//.test(c.image || '') || /^(A\d|B\d|P-[AB]-)/.test(c.id);

// Búsqueda en TCGdex. lang 'es' permite buscar por el nombre en español; el detalle (set y precio)
// siempre se lee de la base en inglés, con el mismo id, y se conserva el nombre en español.
async function searchTcgdex({ name, number }, page, lang = 'en') {
  const params = new URLSearchParams({ 'pagination:page': page, 'pagination:itemsPerPage': PAGE });
  if (name) params.set('name', name);
  if (number) params.set('localId', number);
  const raw = await getJSON(`https://api.tcgdex.net/v2/${lang}/cards?${params}`);
  const list = Array.isArray(raw) ? raw : [];
  const items = list.filter(c => !isPocket(c) && (!number || parseInt(c.localId, 10) === Number(number)));
  const cards = await Promise.all(items.map(async it => {
    const c = await getJSON(`${TCGDEX}/cards/${encodeURIComponent(it.id)}`).catch(() => null);
    const card = c?.id ? mapTcgdex(c) : mapTcgdex({ ...it, image: it.image?.replace('/es/', '/en/') });
    return lang === 'en' ? card : { ...card, card_name: it.name };
  }));
  return { results: cards, has_more: list.length === PAGE, source: lang === 'en' ? 'tcgdex' : 'tcgdex-es' };
}

// source: la fuente que dio la página 1 ('pokemontcg' | 'tcgdex' | 'tcgdex-es'). Las páginas siguientes
// la respetan para que no se mezclen ni se repitan cartas entre fuentes.
async function searchPokemon(query, page, source = '') {
  const { name, number } = parseQuery(query);
  const run = async (parts, retries = 1) => {
    const q = encodeURIComponent(parts.filter(Boolean).join(' '));
    const out = await getJSON(`https://api.pokemontcg.io/v2/cards?q=${q}&page=${page}&pageSize=${PAGE}` +
      `&orderBy=-set.releaseDate&select=${PKM_FIELDS}`, { retries });
    return { results: (out.data || []).map(mapPokemon), has_more: page * PAGE < (out.totalCount || 0), source: 'pokemontcg' };
  };
  const clean = s => s.replace(/["*\\]/g, '');
  const words = clean(name).split(' ');
  const byName = retries => run([name && `name:"${clean(name)}*"`, number && `number:${number}`], retries);
  // "Charizard Obsidian Flames": la primera palabra es el nombre y el resto la expansión
  const bySet = retries => run([`name:"${words[0]}*"`, `set.name:"${words.slice(1).join(' ')}*"`, number && `number:${number}`], retries);

  if (source === 'tcgdex') return searchTcgdex({ name, number }, page);
  if (source === 'tcgdex-es') return searchTcgdex({ name, number }, page, 'es');
  if (source === 'pokemontcg') {
    const r = await byName(3);
    return r.results.length || words.length < 2 ? r : bySet(3);
  }
  try {
    let r = await byName(1);
    if (!r.results.length && words.length > 1) r = await bySet(1);
    if (r.results.length) return r;
  } catch (err) {
    console.warn('pokemontcg.io no disponible, usando TCGdex:', err.message);
  }
  // Respaldo (o sin resultados): TCGdex en inglés y, si tampoco hay, por nombre en español
  const en = await searchTcgdex({ name, number }, page);
  if (en.results.length || page > 1) return en;
  return searchTcgdex({ name, number }, page, 'es');
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
