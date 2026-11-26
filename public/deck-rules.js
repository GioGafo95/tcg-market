// Reglas de construcción de decks. Lo usan el navegador (aviso en vivo) y el servidor (al guardar).
// Un deck se guarda aunque no sea legal: las reglas solo informan qué le falta o le sobra.
//
// Carta del deck: { ref_id, name, set_name, card_code, image, category, basic_energy, section, qty, price_usd }
//   Pokémon:   section 'main'; category pokemon | trainer | energy
//   Yu-Gi-Oh!: section main | extra | side; category monster | spell | trap | extra

export const DECK_GAMES = ['pokemon', 'yugioh'];
export const SECTIONS = { pokemon: ['main'], yugioh: ['main', 'extra', 'side'] };
export const SECTION_LABEL = { main: 'Deck principal', extra: 'Extra Deck', side: 'Side Deck' };
export const CATEGORY_LABEL = {
  pokemon: 'Pokémon', trainer: 'Entrenador', energy: 'Energía',
  monster: 'Monstruos', spell: 'Mágicas', trap: 'Trampas', extra: 'Extra Deck', '': 'Otras',
};
export const MAX_ENTRIES = 120;   // cartas distintas por deck
export const MAX_QTY = 60;        // copias de una misma carta (energía básica)

const sum = (cards, f = () => true) => cards.filter(f).reduce((n, c) => n + c.qty, 0);
const nameKey = n => String(n || '').trim().toLowerCase();

export function deckSummary(game, cards) {
  const issues = [];
  const counts = {};
  for (const s of SECTIONS[game] || ['main']) counts[s] = sum(cards, c => (c.section || 'main') === s);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  // Copias por nombre (en Yu-Gi-Oh! cuentan principal + extra + side juntos)
  const byName = new Map();
  for (const c of cards) {
    if (game === 'pokemon' && c.basic_energy) continue;
    byName.set(nameKey(c.name), (byName.get(nameKey(c.name)) || { name: c.name, qty: 0 }));
    byName.get(nameKey(c.name)).qty += c.qty;
  }
  const maxCopies = game === 'pokemon' ? 4 : 3;
  for (const { name, qty } of byName.values()) {
    if (qty > maxCopies) issues.push(`${name}: ${qty} copias (máximo ${maxCopies}).`);
  }

  if (game === 'pokemon') {
    if (counts.main !== 60) issues.push(`El deck debe tener exactamente 60 cartas (lleva ${counts.main}).`);
    const pokemon = sum(cards, c => c.category === 'pokemon');
    if (counts.main && !pokemon && cards.some(c => c.category)) issues.push('No tiene ninguna carta Pokémon.');
  } else {
    if (counts.main < 40) issues.push(`El deck principal necesita al menos 40 cartas (lleva ${counts.main}).`);
    if (counts.main > 60) issues.push(`El deck principal admite máximo 60 cartas (lleva ${counts.main}).`);
    if (counts.extra > 15) issues.push(`El Extra Deck admite máximo 15 cartas (lleva ${counts.extra}).`);
    if (counts.side > 15) issues.push(`El Side Deck admite máximo 15 cartas (lleva ${counts.side}).`);
    const misplaced = cards.filter(c => c.category === 'extra' && c.section === 'main');
    if (misplaced.length) issues.push(`Van en el Extra Deck: ${misplaced.map(c => c.name).join(', ')}.`);
  }

  const priced = cards.filter(c => c.price_usd > 0);
  return {
    total, counts, valid: issues.length === 0, issues,
    value_usd: Math.round(priced.reduce((n, c) => n + c.price_usd * c.qty, 0) * 100) / 100,
    priced_cards: sum(priced), unpriced_cards: total - sum(priced),
    cover: cards.find(c => c.image)?.image || '',
  };
}

// Lista en texto (compatible con el formato de exportar de Pokémon TCG Live: "4 Pikachu ex SVI 57")
export function deckToText(game, cards) {
  const line = c => [c.qty, c.name, c.set_code_short || '', c.card_code || ''].filter(v => v !== '').join(' ');
  const groups = game === 'pokemon'
    ? [['pokemon', 'Pokémon'], ['trainer', 'Trainer'], ['energy', 'Energy'], ['', 'Otras']]
        .map(([k, label]) => [label, cards.filter(c => (c.category || '') === k)])
    : [['main', 'Main'], ['extra', 'Extra'], ['side', 'Side']]
        .map(([k, label]) => [label, cards.filter(c => (c.section || 'main') === k)]);
  return groups.filter(([, list]) => list.length)
    .map(([label, list]) => `${label}: ${sum(list)}\n${list.map(line).join('\n')}`).join('\n\n');
}

// Lee una lista en texto. Acepta encabezados ("Pokémon: 12", "Trainer", "Energy", "Main", "Extra", "Side")
// y líneas "4 Nombre de la carta [SET 123]". Devuelve cartas sin imagen ni precio (se pueden buscar después).
export function parseDeckText(game, text) {
  const cards = [];
  let section = 'main', category = '';
  const HEADERS = {
    'pokémon': ['main', 'pokemon'], pokemon: ['main', 'pokemon'], trainer: ['main', 'trainer'], trainers: ['main', 'trainer'],
    entrenador: ['main', 'trainer'], entrenadores: ['main', 'trainer'], energy: ['main', 'energy'], 'energía': ['main', 'energy'],
    main: ['main', ''], 'main deck': ['main', ''], principal: ['main', ''], extra: ['extra', 'extra'], 'extra deck': ['extra', 'extra'],
    side: ['side', ''], 'side deck': ['side', ''],
  };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const lineText = raw.trim();
    if (!lineText || lineText.startsWith('#') || lineText.startsWith('//')) continue;
    const header = HEADERS[lineText.replace(/[:\s]*\d*$/, '').trim().toLowerCase()];
    if (header) { [section, category] = header; if (game === 'pokemon') section = 'main'; continue; }
    const m = /^(\d{1,2})x?\s+(.+?)(?:\s+([A-Z0-9-]{2,6})\s+([A-Za-z0-9-]{1,8}))?$/.exec(lineText);
    if (!m) continue;
    const name = m[2].trim();
    const isEnergy = category === 'energy' || /\benergy$/i.test(name);
    cards.push({
      ref_id: '', name, set_name: '', card_code: m[4] || '', set_code_short: m[3] || '', image: '',
      category: game === 'pokemon' ? (category || (isEnergy ? 'energy' : '')) : category,
      basic_energy: game === 'pokemon' && isEnergy && /^(basic\s+)?(grass|fire|water|lightning|psychic|fighting|darkness|metal|fairy)\s+energy$/i.test(name),
      section: game === 'pokemon' ? 'main' : section, qty: Math.min(MAX_QTY, Number(m[1])), price_usd: 0,
    });
  }
  return mergeCards(cards);
}

// Junta entradas repetidas (misma carta y misma sección)
export function mergeCards(cards) {
  const out = [];
  for (const c of cards) {
    const k = (c.ref_id || `${nameKey(c.name)}|${c.set_code_short || ''}|${c.card_code || ''}`) + '|' + (c.section || 'main');
    const prev = out.find(x => ((x.ref_id || `${nameKey(x.name)}|${x.set_code_short || ''}|${x.card_code || ''}`) + '|' + (x.section || 'main')) === k);
    if (prev) prev.qty = Math.min(MAX_QTY, prev.qty + c.qty); else out.push({ ...c });
  }
  return out;
}
