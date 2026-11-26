// Prueba rápida de punta a punta contra un ambiente (local o QA).
// Uso:  node scripts/smoke-test.mjs http://localhost:3000 [--readonly]
// Completo: crea un usuario de prueba temporal, publica una carta con foto, la edita y al final la borra.
// --readonly: solo comprueba que el ambiente responde (no crea datos); lo usa el despliegue automático.
const BASE = (process.argv.slice(2).find(a => !a.startsWith('--')) || 'http://localhost:3000').replace(/\/$/, '');
const READONLY = process.argv.includes('--readonly');
let cookie = '';

async function call(path, { method = 'GET', body, expect } = {}) {
  const res = await fetch(BASE + path, {
    method, redirect: 'manual',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set?.startsWith('session=')) cookie = set.split(';')[0];
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (expect && res.status !== expect) throw new Error(`${method} ${path} → ${res.status} (esperaba ${expect}): ${text.slice(0, 300)}`);
  return { status: res.status, data, headers: res.headers };
}

const ok = (msg) => console.log(`  ✔ ${msg}`);

// JPEG mínimo válido de 1x1 píxel
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

const run = async () => {
  console.log(`Probando ${BASE}`);
  const h = await call('/healthz', { expect: 200 }); ok(`salud: ${JSON.stringify(h.data)}`);
  await call('/', { expect: 200 }); ok('página principal');
  if (READONLY) {
    const s = await call('/api/stats', { expect: 200 }); ok(`estadísticas: ${JSON.stringify(s.data)}`);
    const c = await call('/api/listings', { expect: 200 }); ok(`catálogo: ${c.data.listings.length} cartas`);
    const sets = await call('/api/listings/sets', { expect: 200 }); ok(`expansiones con cartas: ${sets.data.sets.length}`);
    await call('/api/auth/me', { expect: 200 }); ok('sesión (anónima)');
    await call('/api/listings/mine', { expect: 401 }); ok('rutas privadas protegidas');
    await call('/api/admin/overview', { expect: 401 }); ok('administración protegida');
    const tl = await call('/api/tournaments', { expect: 200 }); ok(`torneos: ${tl.data.tournaments.length}`);
    await call('/api/tournaments/me', { expect: 401 }); ok('panel de torneos protegido');
    console.log('\nTodo OK (solo lectura).');
    return;
  }

  const u = `smoke_${Date.now().toString(36)}`;
  const profile = { first_name: 'Prueba', last_name: 'Automática Pérez', location: 'Ciudad de Prueba', contact: '+52 55 1234 5678' };
  await call('/api/auth/register', { method: 'POST', expect: 400,
    body: { username: u, email: `${u}@example.test`, password: 'smoketest123', ...profile, last_name: '' } });
  ok('registro sin apellidos rechazado');
  await call('/api/auth/register', { method: 'POST', expect: 400,
    body: { username: u, email: `${u}@example.test`, password: 'smoketest123', ...profile, location: '', contact: 'insta' } });
  ok('registro sin zona ni teléfono rechazado');
  const reg = await call('/api/auth/register', { method: 'POST', expect: 201,
    body: { username: u, email: `${u}@example.test`, password: 'smoketest123', ...profile } });
  const ru = reg.data.user;
  if (ru.contact !== '+525512345678') throw new Error(`teléfono no normalizado: ${ru.contact}`);
  if (ru.first_name !== 'Prueba' || ru.last_name !== 'Automática Pérez' || ru.display_name !== 'Prueba Automática Pérez')
    throw new Error(`nombre mal guardado: ${JSON.stringify(ru)}`);
  ok(`registro de ${u}: ${ru.first_name} | ${ru.last_name} | tel ${ru.contact}`);
  await call('/api/auth/me', { method: 'PUT', expect: 400, body: { ...profile, contact: '' } });
  ok('perfil sin teléfono rechazado');
  await call('/api/auth/register', { method: 'POST', expect: 409,
    body: { username: u, email: `${u}@example.test`, password: 'smoketest123', ...profile } });
  ok('usuario duplicado rechazado');
  if (ru.is_admin) throw new Error('una cuenta nueva no debe ser administradora');
  await call('/api/admin/overview', { expect: 403 });
  ok('panel de administración cerrado para usuarios normales');

  // Fotos obligatorias solo si la carta vale más de US$2.50 (aquí, por el precio del vendedor en MXN)
  await call('/api/listings', { method: 'POST', expect: 400, body: { game: 'pokemon', card_name: 'X', price: 500 } });
  ok('carta de $500 MXN sin foto rechazada');
  const cheap = await call('/api/listings', { method: 'POST', expect: 201, body: { game: 'pokemon', card_name: 'Carta común de prueba', price: 10 } });
  if (cheap.data.listing.photos.length !== 0) throw new Error('la carta barata no debería tener fotos');
  await call(`/api/listings/${cheap.data.listing.id}`, { method: 'PUT', expect: 400, body: { ...cheap.data.listing, price: 500, keep_photos: [], new_photos: [] } });
  await call(`/api/listings/${cheap.data.listing.id}`, { method: 'DELETE', expect: 200 });
  ok('carta de $10 MXN sin foto aceptada; subirle el precio a $500 sin foto, rechazado');

  // Accesorios: categoría obligatoria, juego "any" (universal), no se mezclan con el catálogo de cartas
  await call('/api/listings', { method: 'POST', expect: 400, body: { kind: 'accessory', card_name: 'Micas', game: 'any', price: 20 } });
  const acc = await call('/api/listings', { method: 'POST', expect: 201, body: {
    kind: 'accessory', category: 'sleeves', card_name: `Micas de prueba ${u}`, set_name: 'Dragon Shield', game: 'any', condition: 'NEW', price: 20, quantity: 3 } });
  const a = acc.data.listing;
  if (a.kind !== 'accessory' || a.category !== 'sleeves' || a.game !== 'any') throw new Error(`accesorio mal guardado: ${JSON.stringify(a)}`);
  const accList = await call('/api/listings?kind=accessory&game=pokemon&category=sleeves', { expect: 200 });
  if (!accList.data.listings.some(x => String(x.id) === String(a.id))) throw new Error('el accesorio universal no aparece al filtrar por Pokémon');
  const cardsOnly = await call('/api/listings', { expect: 200 });
  if (cardsOnly.data.listings.some(x => String(x.id) === String(a.id))) throw new Error('un accesorio apareció en el catálogo de cartas');
  await call(`/api/listings/${a.id}`, { method: 'PUT', expect: 200, body: { ...a, price: 25, keep_photos: [], new_photos: [] } });
  await call(`/api/listings/${a.id}`, { method: 'DELETE', expect: 200 });
  ok('accesorio publicado, filtrado (universal incluido en Pokémon), editado y borrado; no aparece entre las cartas');

  const lookup = await call('/api/lookup?game=yugioh&q=Dark%20Magician');
  const ref = lookup.status === 200 ? lookup.data.results[0] : null;
  ok(ref ? `búsqueda: ${ref.card_name} ${ref.card_code} ~ $${ref.market_price}` : `búsqueda externa no disponible (${lookup.status}), sigo sin referencia`);

  const created = await call('/api/listings', { method: 'POST', expect: 201, body: {
    game: 'yugioh', card_name: ref?.card_name || 'Dark Magician', set_name: ref?.set_name, card_code: ref?.card_code,
    rarity: ref?.rarity, ref_id: ref?.ref_id || '', price: 12.5, quantity: 1, new_photos: [JPEG, JPEG],
  } });
  const l = created.data.listing;
  ok(`carta publicada id=${l.id}, fotos=${l.photos.length}, imagen oficial=${l.image_url || '—'}`);
  if (l.market_price_usd) {
    if (!l.market_price_mxn || !l.fx) throw new Error('falta la conversión del precio de mercado a MXN');
    ok(`precio de mercado: US$${l.market_price_usd} → $${l.market_price_mxn} MXN (tipo de cambio ${l.fx.rate}, ${l.fx.source})`);
  }

  const photo = await call(l.photos[0].url);
  if (![200, 302].includes(photo.status)) throw new Error(`foto → ${photo.status}`);
  ok(`foto accesible (${photo.status}${photo.status === 302 ? ' → S3 firmado' : ''})`);

  const list = await call('/api/listings?game=yugioh', { expect: 200 });
  if (!list.data.listings.some(x => String(x.id) === String(l.id))) throw new Error('la carta no aparece en el catálogo');
  ok(`aparece en el catálogo (${list.data.listings.length} cartas Yu-Gi-Oh!)`);

  const upd = await call(`/api/listings/${l.id}`, { method: 'PUT', expect: 200,
    body: { ...l, price: 10, keep_photos: [l.photos[0].id], new_photos: [] } });
  ok(`editada: precio=${upd.data.listing.price}, fotos=${upd.data.listing.photos.length}`);
  await call(`/api/listings/${l.id}`, { method: 'PUT', expect: 400, body: { ...l, price: 500, keep_photos: [], new_photos: [] } });
  ok('quitar todas las fotos de una carta de más de US$2.50 rechazado');

  await call(`/api/listings/${l.id}/status`, { method: 'PATCH', expect: 200, body: { status: 'sold' } });
  ok('marcada como vendida');
  const mine = await call('/api/listings/mine', { expect: 200 });
  ok(`mis cartas: ${mine.data.listings.length}`);
  const prof = await call(`/api/users/${u}`, { expect: 200 });
  ok(`perfil público (${prof.data.listings.length} disponibles)`);
  const stats = await call('/api/stats', { expect: 200 });
  ok(`estadísticas: ${JSON.stringify(stats.data)}`);

  await call(`/api/listings/${l.id}`, { method: 'DELETE', expect: 200 });
  ok('carta borrada (y sus fotos)');

  // ---------- Torneos: ID de jugador, inscripción, ronda, resultado y racha ----------
  const pid = () => String(Date.now()).slice(-7) + Math.floor(Math.random() * 90 + 10);
  const tour = await call('/api/tournaments', { method: 'POST', expect: 201,
    body: { name: `Torneo de prueba ${u}`, location: 'Ciudad de Prueba', starts_at: '2030-01-01T18:00', rounds: '2' } });
  const t = tour.data.tournament;
  ok(`torneo creado id=${t.id}`);
  await call(`/api/tournaments/${t.id}/join`, { method: 'POST', expect: 400 });
  ok('inscripción sin ID de jugador rechazada');
  await call('/api/auth/me/pokemon-id', { method: 'PUT', expect: 400, body: { pokemon_id: '12ab' } });
  const myPid = pid();
  const linked = await call('/api/auth/me/pokemon-id', { method: 'PUT', expect: 200, body: { pokemon_id: myPid } });
  if (linked.data.user.pokemon_id !== myPid) throw new Error('el ID de jugador no se guardó');
  ok(`ID de jugador vinculado (${myPid}); ID inválido rechazado`);
  await call(`/api/tournaments/${t.id}/join`, { method: 'POST', expect: 200 });
  const host = cookie;

  // Segundo jugador (rival)
  cookie = '';
  const u2 = `${u}_b`;
  await call('/api/auth/register', { method: 'POST', expect: 201,
    body: { username: u2, email: `${u2}@example.test`, password: 'smoketest123', ...profile } });
  await call('/api/auth/me/pokemon-id', { method: 'PUT', expect: 409, body: { pokemon_id: myPid } });
  ok('ID de jugador duplicado rechazado');
  const rivalPid = pid();
  await call('/api/auth/me/pokemon-id', { method: 'PUT', expect: 200, body: { pokemon_id: rivalPid } });
  await call(`/api/tournaments/${t.id}/join`, { method: 'POST', expect: 200 });
  await call(`/api/tournaments/${t.id}/rounds`, { method: 'POST', expect: 403 });
  const rival = cookie;
  ok(`${u2} inscrito; no organizador no puede generar rondas`);

  cookie = host;
  await call(`/api/tournaments/${t.id}/rounds`, { method: 'POST', expect: 201 });
  const r1 = (await call(`/api/tournaments/${t.id}`, { expect: 200 })).data;
  const m = r1.rounds[0].matches[0];
  if (!r1.me.match?.opponent || r1.me.match.opponent.username !== u2) throw new Error(`rival incorrecto: ${JSON.stringify(r1.me)}`);
  if (!r1.players.every(p => p.pokemon_id)) throw new Error('el organizador debería ver los ID de jugador');
  ok(`ronda 1: mesa ${m.table_no}, rival ${r1.me.match.opponent.username}`);
  await call(`/api/tournaments/${t.id}/rounds`, { method: 'POST', expect: 400 });
  ok('siguiente ronda sin resultados rechazada');
  const iWin = m.player1.username === u ? 'p1' : 'p2';
  await call(`/api/tournaments/${t.id}/matches/1/${m.table_no}`, { method: 'PUT', expect: 200, body: { result: iWin } });
  const meT = (await call('/api/tournaments/me', { expect: 200 })).data;
  if (meT.overall.wins !== 1 || meT.overall.current?.type !== 'W') throw new Error(`racha incorrecta: ${JSON.stringify(meT.overall)}`);
  ok(`resultado capturado; récord ${meT.overall.wins}-${meT.overall.losses}-${meT.overall.ties}, racha ${meT.overall.current.count}V`);

  cookie = rival;
  const pub = (await call(`/api/tournaments/${t.id}`, { expect: 200 })).data;
  if (pub.players.some(p => 'pokemon_id' in p)) throw new Error('un jugador no debería ver los ID de los demás');
  if (pub.me.losses !== 1 || pub.me.current?.type !== 'L') throw new Error(`récord del rival incorrecto: ${JSON.stringify(pub.me)}`);
  ok('el rival ve su derrota y no ve los ID de jugador');
  await call('/api/auth/logout', { method: 'POST', expect: 200 });

  cookie = host;
  await call(`/api/tournaments/${t.id}/finish`, { method: 'POST', expect: 200 });
  const list2 = await call('/api/tournaments', { expect: 200 });
  if (list2.data.tournaments.find(x => String(x.id) === String(t.id))?.status !== 'finished') throw new Error('el torneo no quedó terminado');
  ok('torneo finalizado');

  // ---------- Importar un TDF de TOM (datos ficticios): ronda 1 terminada, ronda 2 emparejada ----------
  const ghost = '7' + String(Date.now()).slice(-6);
  const pl = (id, f, l) => `<player userid="${id}"><firstname>${f}</firstname><lastname>${l}</lastname><birthdate>01/01/2000</birthdate></player>`;
  const mt = (o, a, b, n) => `<match outcome="${o}"><player1 userid="${a}"/>${b ? `<player2 userid="${b}"/>` : ''}<tablenumber>${n}</tablenumber></match>`;
  const tdf = `<?xml version="1.0" encoding="UTF-8"?>
<tournament type="3" stage="5" version="1.86" gametype="TRADING_CARD_GAME" mode="TCG1DAY">
  <data><name>Copa TDF ${u}</name><id>T-${u}</id><city>Ciudad de Prueba</city><state>Prueba</state>
    <organizer popid="9999999" name="organizador de prueba"/><startdate>01/02/2030</startdate></data>
  <players>${pl(myPid, 'PRUEBA', 'UNO')}${pl(rivalPid, 'PRUEBA', 'DOS')}${pl(ghost, 'SIN', 'CUENTA')}</players>
  <pods><pod category="2" stage="1">
    <subgroups><subgroup number="1"><players><player userid="${myPid}"/><player userid="${rivalPid}"/><player userid="${ghost}"/></players></subgroup></subgroups>
    <rounds>
      <round number="1" type="3" stage="6"><matches>${mt(1, myPid, rivalPid, 1)}${mt(5, ghost, null, 2)}</matches></round>
      <round number="2" type="3" stage="6"><matches>${mt(0, ghost, myPid, 1)}${mt(5, rivalPid, null, 2)}</matches></round>
    </rounds>
  </pod></pods>
  <standings><pod category="2" type="finished"></pod></standings>
</tournament>`;
  await call('/api/tournaments/import-tdf', { method: 'POST', expect: 400, body: { tdf: '<nada/>' } });
  const imp = await call('/api/tournaments/import-tdf', { method: 'POST', expect: 201, body: { tdf } });
  const again = await call('/api/tournaments/import-tdf', { method: 'POST', expect: 200, body: { tdf } });
  if (!again.data.updated || String(again.data.tournament.id) !== String(imp.data.tournament.id)) throw new Error('re-importar debería actualizar');
  ok(`TDF importado id=${imp.data.tournament.id}; re-importar actualiza; archivo inválido rechazado`);
  const meTdf = (await call('/api/tournaments/me', { expect: 200 })).data;
  const live = meTdf.active.find(a => String(a.tournament.id) === String(imp.data.tournament.id));
  if (!live || live.round !== 2 || live.table_no !== 1 || live.opponent?.display_name !== 'Sin C.')
    throw new Error(`partida en curso del TDF incorrecta: ${JSON.stringify(live)}`);
  if (!meTdf.history.some(h => h.source === 'tdf' && h.wins === 1)) throw new Error('el TDF no aparece en el historial');
  ok(`TDF en vivo: ronda ${live.round}, mesa ${live.table_no} contra ${live.opponent.display_name}; aparece en el historial`);
  cookie = '';
  const anon = JSON.stringify((await call(`/api/tournaments/${imp.data.tournament.id}`, { expect: 200 })).data);
  if ([myPid, rivalPid, ghost].some(x => anon.includes(x)) || anon.includes('01/01/2000') || anon.includes('birth')) throw new Error('el detalle público expone IDs o fechas de nacimiento');
  ok('el detalle público no expone IDs de jugador ni fechas de nacimiento');
  cookie = host;
  await call(`/api/tournaments/${imp.data.tournament.id}`, { method: 'DELETE', expect: 200 });
  ok('torneo importado quitado');
  await call('/api/auth/logout', { method: 'POST', expect: 200 });
  const me = await call('/api/auth/me', { expect: 200 });
  if (me.data.user) throw new Error('la sesión sigue activa tras cerrar sesión');
  ok('sesión cerrada');
  console.log(`\nTodo OK. (Quedan los usuarios de prueba "${u}" y "${u2}" sin cartas, y un torneo de prueba terminado.)`);
};

run().catch(err => { console.error('\n✘ FALLÓ:', err.message); process.exit(1); });
