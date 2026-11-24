// Consulta de bases de datos públicas de cartas y precios de mercado.
//  - Pokémon:   api.pokemontcg.io  (precio "market" de TCGplayer, USD); si falla, api.tcgdex.net
//  - Yu-Gi-Oh!: db.ygoprodeck.com  (precio de TCGplayer por edición/set, USD)
// Collectr no ofrece una API pública, por eso se usa TCGplayer como referencia de mercado.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REF_DIR = 'uploads/ref';
mkdirSync(REF_DIR, { recursive: true });

const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

async function getJSON(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.data;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } });
  if (res.status === 400 || res.status === 404) return { data: [] }; // ygoprodeck responde 400 cuando no hay resultados
  if (!res.ok) throw new Error(`Error ${res.status} al consultar ${new URL(url).host}`);
  const data = await res.json();
  cache.set(url, { t: Date.now(), data });
  return data;
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
  rarity: c.rarity || '',
  image_url: c.image ? `${c.image}/high.png` : '',
  image_small: c.image ? `${c.image}/low.webp` : '',
  market_price: tcgdexPrice(c),
  market_source: 'TCGplayer',
});

async function searchTcgdex(name) {
  const list = await getJSON(`${TCGDEX}/cards?name=${encodeURIComponent(name)}&pagination:itemsPerPage=12`);
  const ids = (Array.isArray(list) ? list : []).filter(c => c.image).map(c => c.id);
  const cards = await Promise.all(ids.map(id => getJSON(`${TCGDEX}/cards/${encodeURIComponent(id)}`).catch(() => null)));
  return cards.filter(Boolean).map(mapTcgdex);
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

export async function searchCards(game, name) {
  name = name.trim();
  if (name.length < 2) return [];
  if (game === 'pokemon') {
    try {
      const q = encodeURIComponent(`name:"${name.replace(/"/g, '')}*"`);
      const { data = [] } = await getJSON(
        `https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=18&orderBy=-set.releaseDate&select=${PKM_FIELDS}`);
      return data.map(mapPokemon);
    } catch (err) {
      console.warn('pokemontcg.io no disponible, usando TCGdex:', err.message);
      return searchTcgdex(name);
    }
  }
  const { data = [] } = await getJSON(
    `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(name)}&num=8&offset=0`);
  const out = [];
  for (const c of data) {
    const sets = c.card_sets?.length ? c.card_sets : [null];
    for (const s of sets.slice(0, 6)) out.push(mapYugioh(c, s));
  }
  return out.slice(0, 24);
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
  const name = `${game}-${createHash('sha1').update(url).digest('hex').slice(0, 20)}${ext}`;
  const path = join(REF_DIR, name);
  if (!existsSync(path)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.startsWith('image/')) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) return '';
    writeFileSync(path, buf);
  }
  return `/${REF_DIR}/${name}`;
}
