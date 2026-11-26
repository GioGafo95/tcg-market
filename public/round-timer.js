// Reloj de la ronda de un torneo: cuenta regresiva sincronizada con el servidor, controles del organizador
// y avisos (sonido, vibración y notificación del sistema) a los 5 minutos y al terminar el tiempo.
//
// Los avisos funcionan con la página abierta (aunque esté en otra pestaña). El sonido necesita que la persona
// toque "Activar avisos" una vez, porque los navegadores no dejan sonar audio sin una interacción.

let tick = null, poll = null, state = null;
const pad = n => String(Math.floor(n)).padStart(2, '0');
export const fmtClock = secs => {
  const s = Math.max(0, Math.ceil(secs));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}` : `${pad(s / 60)}:${pad(s % 60)}`;
};

// ---------- Sonido (sin archivos: tonos generados con Web Audio) ----------
let audio = null;
function ctx() {
  if (!audio) { const C = window.AudioContext || window.webkitAudioContext; if (C) audio = new C(); }
  return audio;
}
function beep(freq = 880, ms = 250, when = 0, vol = 0.25) {
  const a = ctx(); if (!a) return;
  const o = a.createOscillator(), g = a.createGain();
  o.type = 'square'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, a.currentTime + when);
  g.gain.exponentialRampToValueAtTime(vol, a.currentTime + when + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + when + ms / 1000);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + when); o.stop(a.currentTime + when + ms / 1000 + 0.05);
}
const chime = () => { beep(660, 180, 0); beep(880, 260, 0.22); };
const alarm = () => { for (let i = 0; i < 3; i++) { beep(988, 220, i * 0.9); beep(784, 220, i * 0.9 + 0.28); beep(988, 380, i * 0.9 + 0.56); } };

export const alertsEnabled = () => localStorage.getItem('roundAlerts') === '1';
export async function enableAlerts() {
  localStorage.setItem('roundAlerts', '1');
  try { await ctx()?.resume(); } catch { /* sin audio */ }
  chime();
  if ('Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch { /* el navegador no lo permite */ }
  }
}
export function disableAlerts() { localStorage.setItem('roundAlerts', '0'); }

function notify(title, body) {
  if (!alertsEnabled()) return;
  try { navigator.vibrate?.([400, 200, 400, 200, 800]); } catch { /* sin vibración */ }
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: '/img/icon-macai.png', tag: 'round-timer', renotify: true }); } catch { /* algunos navegadores solo lo permiten desde un service worker */ }
  }
}

// ---------- Estado y cuenta regresiva ----------
function remainingNow() {
  if (!state) return 0;
  const t = state.timer;
  if (t.status === 'running') return Math.max(0, (Date.parse(t.ends_at) - (Date.now() + state.offset)) / 1000);
  return t.remaining;
}
function statusNow() {
  const t = state?.timer;
  if (!t) return 'idle';
  if (t.status === 'running' && remainingNow() <= 0) return 'ended';
  return t.status;
}
const firedKey = type => `timer:${state.id}:${state.timer.round}:${type}`;
function fire(type, fn) { if (sessionStorage.getItem(firedKey(type))) return; sessionStorage.setItem(firedKey(type), '1'); fn(); }

const RULE_END = {
  yugioh: 'Fin de la ronda (KONAMI): la partida termina en este momento. Si no hay ganador del match, es doble derrota.',
  pokemon: 'Se acabó el tiempo (Play! Pokémon): el jugador en turno termina su turno y se juegan 3 turnos adicionales (+3).',
};

function render() {
  if (!state) return;
  const rem = remainingNow(), st = statusNow();
  const pct = state.timer.duration ? Math.max(0, Math.min(100, rem / state.timer.duration * 100)) : 0;
  document.querySelectorAll('[data-round-clock]').forEach(el => {
    el.querySelector('.rc-time').textContent = st === 'idle' ? fmtClock(state.timer.duration) : fmtClock(rem);
    el.querySelector('.rc-state').textContent = { idle: 'Sin iniciar', running: 'En curso', paused: 'En pausa', ended: '¡Tiempo!' }[st];
    el.querySelector('.rc-bar i').style.width = `${pct}%`;
    el.dataset.state = st;
    el.classList.toggle('warn', st === 'running' && rem <= 300);
  });
  document.querySelectorAll('[data-timer-host]').forEach(el => { el.dataset.state = st; });
  if (st === 'running' && rem <= 300 && rem > 0) fire('5min', () => { if (alertsEnabled()) chime(); notify(`Quedan 5 minutos · ronda ${state.timer.round}`, state.name); });
  if (st === 'ended') fire('end', () => {
    if (alertsEnabled()) alarm();
    notify(`⏰ ¡Se acabó el tiempo de la ronda ${state.timer.round}!`, `${state.name} · ${RULE_END[state.game]}`);
    showEndOverlay();
  });
}

function showEndOverlay() {
  document.querySelector('.time-up')?.remove();
  const el = document.createElement('div');
  el.className = 'time-up'; el.setAttribute('role', 'alertdialog');
  el.innerHTML = `<div class="tu-card"><div class="tu-icon">⏰</div><h2>¡Se acabó el tiempo!</h2>
    <p><b>Ronda ${state.timer.round}</b> · ${state.name}</p><p class="tu-rule">${RULE_END[state.game]}</p>
    <button type="button" class="btn primary">Entendido</button></div>`;
  el.querySelector('button').addEventListener('click', () => el.remove());
  document.body.appendChild(el);
}

async function refresh() {
  if (!state) return;
  try {
    const r = await fetch(`/api/tournaments/${state.id}/timer`, { credentials: 'same-origin', cache: 'no-store' }).then(x => x.json());
    if (!r.timer) return;
    const changedRound = r.current_round !== state.round;
    state.timer = r.timer;
    state.offset = Date.parse(r.server_now) - Date.now();
    if (changedRound && state.onRoundChange) state.onRoundChange();
    render();
  } catch { /* sin conexión: se sigue contando con lo último que se supo */ }
}

export function stopRoundTimer() { clearInterval(tick); clearInterval(poll); tick = poll = null; state = null; }

// Arranca la cuenta en todos los relojes [data-round-clock] de la página
export function startRoundTimer({ id, timer, serverNow, game, name, round, onRoundChange }) {
  stopRoundTimer();
  if (!timer) return;
  state = { id, timer, offset: Date.parse(serverNow) - Date.now(), game, name, round, onRoundChange };
  // Al abrir la página con el tiempo ya terminado no se repite la alarma
  if (statusNow() === 'ended') sessionStorage.setItem(firedKey('end'), '1');
  if (statusNow() !== 'idle' && remainingNow() <= 300) sessionStorage.setItem(firedKey('5min'), '1');
  render();
  tick = setInterval(render, 250);
  poll = setInterval(refresh, 15000);
}
// Tras recargar la página el audio vuelve a estar bloqueado: el primer toque lo desbloquea
document.addEventListener('pointerdown', () => { if (alertsEnabled() && audio?.state !== 'running') ctx()?.resume().catch(() => {}); });
document.addEventListener('visibilitychange',() => { if (document.visibilityState === 'visible') refresh(); });
window.addEventListener('hashchange', stopRoundTimer);

// Aplica la respuesta de un control del organizador sin esperar al siguiente sondeo
export function applyTimer(r) {
  if (!state || !r?.timer) return;
  state.timer = r.timer; state.offset = Date.parse(r.server_now) - Date.now();
  sessionStorage.removeItem(firedKey('end')); sessionStorage.removeItem(firedKey('5min'));
  if (statusNow() !== 'idle' && remainingNow() <= 300) sessionStorage.setItem(firedKey('5min'), '1');
  render();
}

// HTML del reloj (se puede poner varias veces en la página)
export function clockHTML({ big = false } = {}) {
  return `<div class="round-clock ${big ? 'big' : ''}" data-round-clock data-state="idle">
    <div class="rc-state">Sin iniciar</div><div class="rc-time">--:--</div><div class="rc-bar"><i></i></div></div>`;
}
