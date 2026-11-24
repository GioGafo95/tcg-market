// Prueba rápida de punta a punta contra un ambiente (local o QA).
// Uso:  node scripts/smoke-test.mjs http://localhost:3000
// Crea un usuario de prueba temporal, publica una carta con foto, la edita y al final la borra.
const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
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

  const u = `smoke_${Date.now().toString(36)}`;
  await call('/api/auth/register', { method: 'POST', expect: 201,
    body: { username: u, email: `${u}@example.test`, password: 'smoketest123', contact: 'prueba' } });
  ok(`registro de ${u}`);
  await call('/api/auth/register', { method: 'POST', expect: 409,
    body: { username: u, email: `${u}@example.test`, password: 'smoketest123' } });
  ok('usuario duplicado rechazado');

  await call('/api/listings', { method: 'POST', expect: 400, body: { game: 'pokemon', card_name: 'X', price: 1 } });
  ok('carta sin foto rechazada');

  const lookup = await call('/api/lookup?game=yugioh&q=Dark%20Magician');
  const ref = lookup.status === 200 ? lookup.data.results[0] : null;
  ok(ref ? `búsqueda: ${ref.card_name} ${ref.card_code} ~ $${ref.market_price}` : `búsqueda externa no disponible (${lookup.status}), sigo sin referencia`);

  const created = await call('/api/listings', { method: 'POST', expect: 201, body: {
    game: 'yugioh', card_name: ref?.card_name || 'Dark Magician', set_name: ref?.set_name, card_code: ref?.card_code,
    rarity: ref?.rarity, ref_id: ref?.ref_id || '', price: 12.5, quantity: 1, new_photos: [JPEG, JPEG],
  } });
  const l = created.data.listing;
  ok(`carta publicada id=${l.id}, fotos=${l.photos.length}, precio mercado=${l.market_price}, imagen oficial=${l.image_url || '—'}`);

  const photo = await call(l.photos[0].url);
  if (![200, 302].includes(photo.status)) throw new Error(`foto → ${photo.status}`);
  ok(`foto accesible (${photo.status}${photo.status === 302 ? ' → S3 firmado' : ''})`);

  const list = await call('/api/listings?game=yugioh', { expect: 200 });
  if (!list.data.listings.some(x => String(x.id) === String(l.id))) throw new Error('la carta no aparece en el catálogo');
  ok(`aparece en el catálogo (${list.data.listings.length} cartas Yu-Gi-Oh!)`);

  const upd = await call(`/api/listings/${l.id}`, { method: 'PUT', expect: 200,
    body: { ...l, price: 10, keep_photos: [l.photos[0].id], new_photos: [] } });
  ok(`editada: precio=${upd.data.listing.price}, fotos=${upd.data.listing.photos.length}`);
  await call(`/api/listings/${l.id}`, { method: 'PUT', expect: 400, body: { ...l, keep_photos: [], new_photos: [] } });
  ok('quitar todas las fotos rechazado');

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
  await call('/api/auth/logout', { method: 'POST', expect: 200 });
  const me = await call('/api/auth/me', { expect: 200 });
  if (me.data.user) throw new Error('la sesión sigue activa tras cerrar sesión');
  ok('sesión cerrada');
  console.log(`\nTodo OK. (Queda el usuario de prueba "${u}" sin cartas.)`);
};

run().catch(err => { console.error('\n✘ FALLÓ:', err.message); process.exit(1); });
