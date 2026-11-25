// Lector de archivos TDF (Tournament Data File) que genera TOM, el programa oficial de torneos de
// Play! Pokémon. Extrae solo lo necesario: datos del evento, jugadores (ID y nombre), rondas,
// emparejamientos, resultados y clasificación final. Nunca conserva fechas de nacimiento.
//
// Resultados (atributo outcome de <match>): 1 = gana jugador 1 · 2 = gana jugador 2 · 3 = empate
// · 4 = doble derrota · 5 = bye · 0 = pendiente. Rondas: type="3" suizo, type="1" eliminación (top cut).

const CATEGORY = { 0: 'Júnior', 1: 'Sénior', 2: 'Máster' };

const decode = s => String(s ?? '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&').trim();

const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, k, v]) => [k, decode(v)]));
const text = (xml, name) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml); return m ? decode(m[1]) : ''; };
const blocks = (xml, name) => [...xml.matchAll(new RegExp(`<${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${name}>)`, 'g'))]
  .map(([, a, body = '']) => ({ attrs: attrs(a), body }));
const section = (xml, name) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml); return m ? m[1] : ''; };

const OUTCOME = { 1: 'p1', 2: 'p2', 3: 'tie', 4: 'dl' };
const pid = v => (/^\d{1,12}$/.test(v || '') ? v : null);

// "11/21/2026" + "11/21/2026 17:19:44" → "2026-11-21T17:19"
function isoLocal(date, time) {
  const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(date || '');
  if (!d) return null;
  const t = /\s(\d{1,2}):(\d{2})/.exec(time || '');
  const p = n => String(n).padStart(2, '0');
  return `${d[3]}-${p(d[1])}-${p(d[2])}T${t ? `${p(t[1])}:${t[2]}` : '00:00'}`;
}

export class TdfError extends Error {}

export function parseTdf(xml) {
  if (typeof xml !== 'string' || !/<tournament\b/.test(xml)) throw new TdfError('El archivo no es un TDF de TOM válido.');
  const root = attrs(/<tournament\b([^>]*)>/.exec(xml)[1]);
  if (root.gametype && root.gametype !== 'TRADING_CARD_GAME') throw new TdfError('Solo se pueden importar torneos del Juego de Cartas (JCC).');

  const data = section(xml, 'data');
  const organizer = attrs(/<organizer\b([^>]*)\/?>/.exec(data)?.[1] || '');
  const tdfId = text(data, 'id');
  const name = text(data, 'name');
  if (!tdfId || !name) throw new TdfError('Al TDF le falta el nombre o el ID del torneo.');

  // Primer <players> = lista general con nombres (los de cada pod solo traen el ID)
  const players = {};
  for (const p of blocks(section(xml, 'players'), 'player')) {
    const id = pid(p.attrs.userid);
    if (id) players[id] = { first: text(p.body, 'firstname'), last: text(p.body, 'lastname') };
  }

  const standingsXml = section(xml, 'standings');
  const categories = blocks(section(xml, 'pods'), 'pod').map(pod => {
    const category = Number(pod.attrs.category);
    const members = blocks(section(pod.body, 'subgroups'), 'player').map(p => pid(p.attrs.userid)).filter(Boolean);
    const rounds = blocks(section(pod.body, 'rounds'), 'round').map(r => ({
      number: Number(r.attrs.number),
      topcut: r.attrs.type === '1',
      matches: blocks(section(r.body, 'matches'), 'match').map(m => {
        const p1 = pid(attrs(/<player1\b([^>]*)/.exec(m.body)?.[1] || '').userid);
        const p2 = pid(attrs(/<player2\b([^>]*)/.exec(m.body)?.[1] || '').userid);
        const bye = m.attrs.outcome === '5' || !p2;
        return { table_no: Number(text(m.body, 'tablenumber')) || 0, player1_id: p1, player2_id: bye ? null : p2,
                 result: bye ? 'p1' : OUTCOME[m.attrs.outcome] || null };
      }).filter(m => m.player1_id),
      pairtime: text(r.body, 'pairtime'),
    })).filter(r => r.number > 0).sort((a, b) => a.number - b.number);
    const finished = blocks(standingsXml, 'pod').find(s => s.attrs.category === String(category) && s.attrs.type === 'finished');
    const standings = finished ? blocks(finished.body, 'player').map(p => ({ id: pid(p.attrs.id), place: Number(p.attrs.place) }))
      .filter(s => s.id && s.place).sort((a, b) => a.place - b.place) : [];
    return { category, label: CATEGORY[category] || `Categoría ${category}`, members, rounds, standings };
  }).filter(c => c.members.length || c.rounds.length);

  if (!categories.length) throw new TdfError('El TDF no tiene jugadores ni rondas.');
  const allMatches = categories.flatMap(c => c.rounds.flatMap(r => r.matches));
  const finished = categories.some(c => c.standings.length) && allMatches.every(m => m.result);
  const firstPair = categories.flatMap(c => c.rounds).map(r => r.pairtime).find(Boolean);

  // Solo se conservan los jugadores que aparecen en algún pod
  const used = new Set(categories.flatMap(c => [...c.members, ...c.rounds.flatMap(r => r.matches.flatMap(m => [m.player1_id, m.player2_id]))]).filter(Boolean));
  for (const id of Object.keys(players)) if (!used.has(id)) delete players[id];
  for (const id of used) players[id] ??= { first: '', last: '' };

  return {
    tdf_id: tdfId.slice(0, 40),
    name: name.slice(0, 80),
    location: [text(data, 'city'), text(data, 'state')].filter(Boolean).join(', ').slice(0, 80),
    starts_at: isoLocal(text(data, 'startdate'), firstPair) || new Date().toISOString().slice(0, 16),
    status: finished ? 'finished' : 'running',
    current_round: Math.max(0, ...categories.flatMap(c => c.rounds.map(r => r.number))),
    data: {
      mode: root.mode || '', organizer: { popid: pid(organizer.popid), name: organizer.name || '' },
      players: Object.fromEntries(Object.entries(players).map(([id, p]) => [id, { first: p.first.slice(0, 40), last: p.last.slice(0, 60) }])),
      categories: categories.map(({ rounds, ...c }) => ({ ...c, rounds: rounds.map(({ pairtime, ...r }) => r) })),
    },
  };
}

// Nombre público de alguien sin cuenta en la app: nombre + inicial del apellido ("Raul Alexis V.")
export function shortName(p) {
  const cap = s => s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  const first = cap(p?.first || '').trim();
  const initial = (p?.last || '').trim().charAt(0).toUpperCase();
  return [first, initial && `${initial}.`].filter(Boolean).join(' ') || 'Jugador';
}

export const CATEGORY_LABEL = CATEGORY;
