// Fondo decorativo: dorsos de cartas difuminados sobre el morado para que la página no se sienta vacía.
// Son diseños originales inspirados en los colores de cada juego (no reproducen los dorsos oficiales ni sus logotipos).

const BACKS = {
  // Azul con remolino de energía (estilo Pokémon)
  swirl: `
    <rect width="126" height="176" rx="9" fill="#1d4fa3"/>
    <rect x="6" y="6" width="114" height="164" rx="6" fill="#2a6fd6"/>
    <g fill="none" stroke-linecap="round">
      <path d="M63 40c26 0 44 20 44 48s-18 48-44 48-44-20-44-48" stroke="#7cc3ff" stroke-width="10" opacity=".55"/>
      <path d="M63 58c16 0 26 13 26 30s-10 30-26 30-26-13-26-30" stroke="#ffd54a" stroke-width="7" opacity=".8"/>
      <path d="M20 30c30 10 56 4 86-10M20 160c30-10 56-4 86 10" stroke="#9fd3ff" stroke-width="4" opacity=".45"/>
    </g>
    <circle cx="63" cy="88" r="9" fill="#ffd54a"/>`,
  // Café y naranja con vórtice ovalado oscuro (estilo Yu-Gi-Oh!)
  vortex: `
    <rect width="126" height="176" rx="6" fill="#4a2a12"/>
    <rect x="7" y="7" width="112" height="162" rx="4" fill="#a8521c"/>
    <ellipse cx="63" cy="88" rx="44" ry="62" fill="#2a1508"/>
    <g fill="none" stroke="#e08a3a" stroke-width="3" opacity=".75">
      <ellipse cx="63" cy="88" rx="36" ry="52"/><ellipse cx="63" cy="88" rx="26" ry="38"/><ellipse cx="63" cy="88" rx="15" ry="22"/>
    </g>
    <circle cx="63" cy="88" r="6" fill="#ffb15c"/>`,
  // Marrón con gema central y ornamentos (estilo Magic)
  gem: `
    <rect width="126" height="176" rx="8" fill="#2b1a10"/>
    <rect x="7" y="7" width="112" height="162" rx="5" fill="#6b4426"/>
    <rect x="16" y="16" width="94" height="144" rx="40" fill="#3d2615"/>
    <ellipse cx="63" cy="88" rx="30" ry="44" fill="#4b3a8c"/>
    <ellipse cx="63" cy="88" rx="18" ry="28" fill="#8d7ce0" opacity=".85"/>
    <path d="M63 18l6 10-6 10-6-10zM63 138l6 10-6 10-6-10z" fill="#d9a65c"/>`,
  // Rojo y crema con rosa de los vientos (estilo One Piece)
  compass: `
    <rect width="126" height="176" rx="8" fill="#9e1b1b"/>
    <rect x="7" y="7" width="112" height="162" rx="5" fill="#d8322b"/>
    <circle cx="63" cy="88" r="40" fill="#f3e6c8"/>
    <circle cx="63" cy="88" r="40" fill="none" stroke="#7a1414" stroke-width="4" stroke-dasharray="6 5"/>
    <path d="M63 50l8 38-8 38-8-38zM25 88l38-8 38 8-38 8z" fill="#7a1414"/>
    <circle cx="63" cy="88" r="5" fill="#f3e6c8"/>`,
};

// Posición (% de la pantalla), giro, escala y tipo de cada carta
const LAYOUT = [
  [4, 14, -18, 1.1, 'swirl'], [86, 8, 14, 1, 'vortex'], [70, 44, -8, .9, 'gem'], [10, 58, 10, 1.05, 'compass'],
  [46, 76, -14, .95, 'vortex'], [90, 70, 20, 1.1, 'swirl'], [28, 32, 6, .8, 'gem'], [58, 12, 24, .85, 'compass'],
  [2, 88, -6, .9, 'gem'], [76, 92, -20, .95, 'compass'],
];

export function mountCardBackground() {
  if (document.querySelector('.bg-cards')) return;
  const el = document.createElement('div');
  el.className = 'bg-cards';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = LAYOUT.map(([x, y, r, s, type], i) => `
    <svg class="bg-card c${i}" viewBox="0 0 126 176" style="left:${x}%;top:${y}%;--r:${r}deg;--s:${s}">${BACKS[type]}</svg>`).join('');
  document.body.prepend(el);
}
