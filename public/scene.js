// Escena ilustrada de la portada: atardecer de fantasía con castillo, montañas,
// luna, nubes, luciérnagas, un dragón que cruza el cielo y, tras él, un caballero calavera a caballo. Todo en SVG, sin imágenes externas.

const rand = (seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647)(42);

const stars = Array.from({ length: 46 }, () => {
  const x = Math.round(rand() * 1440), y = Math.round(rand() * 230), r = (rand() * 1.6 + .6).toFixed(1);
  return `<circle class="twinkle" cx="${x}" cy="${y}" r="${r}" style="animation-delay:${(rand() * 4).toFixed(2)}s"/>`;
}).join('');

const fireflies = Array.from({ length: 14 }, () => {
  const x = Math.round(rand() * 1440), y = Math.round(380 + rand() * 120);
  return `<circle class="firefly" cx="${x}" cy="${y}" r="2.6" style="animation-delay:${(rand() * 6).toFixed(2)}s;animation-duration:${(5 + rand() * 5).toFixed(1)}s"/>`;
}).join('');

const cloud = (x, y, s, cls) => `
  <g class="${cls}"><g transform="translate(${x} ${y}) scale(${s})">
    <ellipse cx="0" cy="0" rx="70" ry="26"/><circle cx="-28" cy="-14" r="26"/><circle cx="12" cy="-24" r="34"/><circle cx="44" cy="-8" r="24"/>
  </g></g>`;

const pine = (x, y, s) => `
  <g transform="translate(${x} ${y}) scale(${s})">
    <rect x="-3" y="-6" width="6" height="12" fill="#2a1747"/>
    <path d="M0 -70 L18 -38 H10 L24 -14 H14 L28 8 H-28 L-14 -14 H-24 L-10 -38 H-18 Z"/>
  </g>`;

const lancet = (x, y, w, h) => {
  const r = w / 2;
  return `<path d="M${x - r} ${y} v${-h} C${x - r} ${y - h - r * 1.1} ${x} ${y - h - r * 1.6} ${x} ${y - h - r * 1.8} C${x} ${y - h - r * 1.6} ${x + r} ${y - h - r * 1.1} ${x + r} ${y - h} v${h}z"/>`;
};
// Pináculo: aguja fina con un pequeño remate
const pinnacle = (x, y, h, w = 6) => `<path d="M${x - w} ${y} L${x} ${y - h} L${x + w} ${y} Z"/><circle cx="${x}" cy="${y - h}" r="1.6"/>`;

// Castillo gótico: catedral central con aguja altísima y rosetón, torres laterales con chapiteles,
// arbotantes, pináculos, ventanas de lanceta encendidas y estandartes
const castle = `
  <g transform="translate(1170 330) scale(.95)">
    <g fill="#2b1852">
      <!-- muralla baja con contrafuertes -->
      <rect x="-128" y="-34" width="256" height="54"/>
      <path d="M-128 -34 ${Array.from({ length: 16 }, (_, i) => `L${-128 + i * 16 + 8} -46 L${-128 + i * 16 + 16} -34`).join(' ')} Z"/>
      <!-- torres laterales -->
      <rect x="-114" y="-104" width="44" height="124"/>
      <rect x="70" y="-116" width="44" height="136"/>
      <!-- nave central -->
      <rect x="-46" y="-150" width="92" height="170"/>
      <!-- arbotantes -->
      <path d="M-70 -64 Q-58 -112 -46 -120 L-46 -108 Q-56 -100 -62 -64 Z"/>
      <path d="M70 -70 Q58 -118 46 -128 L46 -116 Q56 -106 62 -70 Z"/>
      <!-- contrafuertes de la nave -->
      <path d="M-54 20 V-120 L-46 -132 V20 Z M54 20 V-120 L46 -132 V20 Z"/>
    </g>
    <!-- chapiteles y agujas -->
    <g fill="#3d2470">
      <path d="M-46 -150 L0 -292 L46 -150 Z"/>
      <path d="M-118 -104 L-92 -210 L-66 -104 Z"/>
      <path d="M66 -116 L92 -230 L118 -116 Z"/>
      ${pinnacle(-46, -150, 34)}${pinnacle(46, -150, 34)}
      ${pinnacle(-114, -104, 24, 5)}${pinnacle(-70, -104, 24, 5)}
      ${pinnacle(70, -116, 24, 5)}${pinnacle(114, -116, 24, 5)}
      ${pinnacle(-54, -120, 22, 4)}${pinnacle(54, -120, 22, 4)}
      ${Array.from({ length: 7 }, (_, i) => pinnacle(-120 + i * 40, -46, 14, 4)).join('')}
    </g>
    <!-- luz de luna en un lado de las agujas -->
    <g fill="#7a4fc0" opacity=".45">
      <path d="M0 -292 L46 -150 H14 Z"/><path d="M-92 -210 L-66 -104 H-82 Z"/><path d="M92 -230 L118 -116 H102 Z"/>
    </g>
    <!-- crochets (ganchos) en la aguja central -->
    <g stroke="#3d2470" stroke-width="2" stroke-linecap="round">
      ${Array.from({ length: 5 }, (_, i) => { const y = -170 - i * 24, dx = 46 * (292 + y) / 142; return `<line x1="${-dx}" y1="${y}" x2="${-dx - 6}" y2="${y - 4}"/><line x1="${dx}" y1="${y}" x2="${dx + 6}" y2="${y - 4}"/>`; }).join('')}
    </g>
    <g stroke="#1e1238" stroke-width="2.5">
      <line x1="0" y1="-292" x2="0" y2="-316"/><line x1="-92" y1="-210" x2="-92" y2="-230"/><line x1="92" y1="-230" x2="92" y2="-250"/>
      <line x1="-7" y1="-306" x2="7" y2="-306"/>
    </g>
    <g fill="#b3264a" class="flags">
      <path class="flag" d="M-92 -230 l18 4 l-6 4 l6 4 l-18 2z"/><path class="flag" d="M92 -250 l18 4 l-6 4 l6 4 l-18 2z"/>
    </g>
    <!-- vidrieras y ventanas encendidas -->
    <g fill="#ffd166" class="windows">
      <circle cx="0" cy="-104" r="18"/>
      ${lancet(-28, -40, 9, 26)}${lancet(28, -40, 9, 26)}
      ${lancet(-14, -134, 6, 10)}${lancet(14, -134, 6, 10)}
      ${lancet(-92, -60, 12, 22)}${lancet(92, -70, 12, 24)}
      ${lancet(-92, -150, 7, 12)}${lancet(92, -164, 7, 12)}
      ${lancet(-110, -4, 6, 10)}${lancet(110, -4, 6, 10)}
    </g>
    <!-- tracería del rosetón -->
    <g stroke="#2b1852" stroke-width="2" fill="none">
      <circle cx="0" cy="-104" r="7"/>
      ${Array.from({ length: 8 }, (_, i) => { const a = i * Math.PI / 4; return `<line x1="${(7 * Math.cos(a)).toFixed(1)}" y1="${(-104 + 7 * Math.sin(a)).toFixed(1)}" x2="${(18 * Math.cos(a)).toFixed(1)}" y2="${(-104 + 18 * Math.sin(a)).toFixed(1)}"/>`; }).join('')}
      <line x1="-28" y1="-50" x2="-28" y2="-40"/><line x1="28" y1="-50" x2="28" y2="-40"/>
    </g>
    <!-- portal apuntado -->
    <path d="M-18 20 v-30 C-18 -32 -6 -42 0 -46 C6 -42 18 -32 18 -10 v30z" fill="#170d2e"/>
    <path d="M-18 20 v-30 C-18 -32 -6 -42 0 -46 C6 -42 18 -32 18 -10 v30" fill="none" stroke="#4a2c80" stroke-width="2.5"/>
  </g>`;

// Espada recta: hoja, guarda, empuñadura y pomo (apunta hacia arriba desde 0,0)
const sword = (len = 62) => `
  <path d="M-3 0 V${-len} L0 ${-len - 8} L3 ${-len} V0 Z" fill="#cfd3e6"/><path d="M0 ${-len - 8} L3 ${-len} V0 H0 Z" fill="#9aa0bd"/>
  <rect x="-12" y="-2" width="24" height="5" rx="2" fill="#8a5a2b"/><rect x="-2.5" y="3" width="5" height="12" fill="#5a3a1e"/>
  <circle cy="17" r="3.6" fill="#ffd166"/>`;

// Calavera caricaturesca con ojos que brillan
const skull = `
  <path d="M-12 2 C-14 -12 -6 -18 0 -18 C6 -18 14 -12 12 2 C12 6 9 7 8 8 V12 H-8 V8 C-9 7 -12 6 -12 2 Z" fill="#f1e6cf"/>
  <path d="M12 2 C12 6 9 7 8 8 V12 H3 V6 C8 4 10 -4 8 -14 C13 -10 13 -4 12 2 Z" fill="#d6c7a6"/>
  <ellipse cx="-5" cy="-3" rx="4" ry="4.4" fill="#1a0f2e"/><ellipse cx="5" cy="-3" rx="4" ry="4.4" fill="#1a0f2e"/>
  <g class="skull-eyes" fill="#ff4f6d"><circle cx="-5" cy="-2.6" r="1.6"/><circle cx="5" cy="-2.6" r="1.6"/></g>
  <path d="M0 2 L-2 6 H2 Z" fill="#1a0f2e"/>
  <path d="M-4 9 V12 M0 9 V12 M4 9 V12" stroke="#1a0f2e" stroke-width="1.2"/>`;

// Escudo heráldico con calavera y dos espadas cruzadas detrás
const crest = (x, y, s = 1, cls = '') => `
  <g transform="translate(${x} ${y}) scale(${s})"><g class="crest ${cls}">
    <g transform="rotate(-38) translate(0 46)">${sword(96)}</g>
    <g transform="rotate(38) translate(0 46)">${sword(96)}</g>
    <path d="M-26 -30 H26 V-2 C26 18 12 30 0 38 C-12 30 -26 18 -26 -2 Z" fill="#2c1857" stroke="#ffd166" stroke-width="3"/>
    <path d="M0 -30 H26 V-2 C26 18 12 30 0 38 Z" fill="#3d2470"/>
    <g transform="translate(0 2) scale(1.05)">${skull}</g>
  </g></g>`;

// Pata del caballo: muslo y caña con casco; gira desde la cadera para el galope
const leg = (x, y, cls, fill) => `
  <g transform="translate(${x} ${y})"><g class="leg ${cls}">
    <path d="M-5 0 L5 0 L4 16 L3 30 H-3 L-4 16 Z" fill="${fill}"/><rect x="-4.5" y="28" width="9" height="5" rx="1.5" fill="#120a24"/>
  </g></g>`;

// Caballero calavera con armadura, escudo y espada, cabalgando hacia la derecha (origen: cascos)
const knight = `
  <g class="knight">
    <!-- capa ondeando detrás -->
    <path class="cape" d="M-6 -92 C-26 -90 -44 -82 -62 -70 C-52 -66 -50 -60 -58 -52 C-40 -56 -24 -62 -10 -66 Z" fill="#9b2245"/>
    <!-- patas del lado lejano (más oscuras) -->
    ${leg(-30, -36, 'back-far', '#1c1036')}${leg(22, -36, 'front-far', '#1c1036')}
    <!-- caballo: cuerpo, cola, cuello y cabeza -->
    <path class="tail" d="M-44 -50 C-58 -50 -66 -40 -68 -24 C-60 -32 -54 -36 -46 -40 Z" fill="#1a0f2e"/>
    <path d="M-46 -52 C-46 -64 -30 -66 -8 -64 C10 -63 24 -64 32 -58 L40 -80 C42 -90 50 -95 57 -92 L75 -76 C78 -72 76 -66 71 -66 L58 -70 L50 -54 C46 -40 36 -34 20 -34 L-30 -34 C-42 -34 -46 -42 -46 -52 Z" fill="#2a1650"/>
    <path d="M48 -91 L50 -102 L55 -92 Z M52 -92 L56 -101 L58 -91 Z" fill="#2a1650"/>
    <path class="tail" d="M38 -80 C40 -92 48 -96 54 -94 L46 -84 L40 -64 L34 -60 Z" fill="#1a0f2e"/>
    <circle cx="55" cy="-86" r="2.2" fill="#ff4f6d" class="skull-eyes"/>
    <!-- armadura del caballo (testera) y gualdrapa -->
    <path d="M60 -87 L75 -75 L71 -70 L58 -80 Z" fill="#9aa0bd"/>
    <path d="M-40 -60 C-20 -64 10 -64 30 -58 L26 -36 C10 -30 -20 -30 -38 -36 Z" fill="#9b2245"/>
    <path d="M-38 -38 C-20 -32 10 -32 26 -38" fill="none" stroke="#ffd166" stroke-width="2.5"/>
    <path d="M-30 -36 l4 6 l4 -6 M-14 -34 l4 6 l4 -6 M2 -34 l4 6 l4 -6 M18 -36 l4 6 l4 -6" fill="#ffd166"/>
    <!-- patas del lado cercano -->
    ${leg(-34, -38, 'back', '#2a1650')}${leg(18, -38, 'front', '#2a1650')}
    <!-- jinete: pierna, peto, brazo y casco -->
    <path d="M-6 -62 L6 -62 L12 -44 L6 -42 Z" fill="#9aa0bd"/>
    <path d="M-16 -64 C-18 -78 -16 -90 -6 -94 C4 -94 10 -86 8 -64 Z" fill="#cfd3e6"/>
    <path d="M-2 -94 C4 -94 10 -86 8 -64 H-2 Z" fill="#9aa0bd"/>
    <path d="M-16 -76 H8" stroke="#6f7594" stroke-width="2"/>
    <g transform="translate(-3 -106) scale(.78)">${skull}</g>
    <path d="M-14 -110 C-14 -124 8 -126 10 -112 L10 -108 H-14 Z" fill="#9aa0bd"/>
    <path d="M-2 -124 C-10 -136 -24 -134 -30 -126 C-20 -128 -12 -126 -6 -120 Z" fill="#ff4f6d"/>
    <!-- brazo con la espada en alto -->
    <g transform="translate(2 -86)"><g class="sword-arm">
      <path d="M0 -4 L18 -12 L20 -6 L2 4 Z" fill="#cfd3e6"/>
      <g transform="translate(19 -9) rotate(28)">${sword(46)}</g>
    </g></g>
    <!-- escudo -->
    <g transform="translate(-18 -74) scale(.42)">
      <path d="M-26 -30 H26 V-2 C26 18 12 30 0 38 C-12 30 -26 18 -26 -2 Z" fill="#3a2168" stroke="#ffd166" stroke-width="5"/>
      <g transform="translate(0 2) scale(1.1)">${skull}</g>
    </g>
  </g>`;

// Dragón caricaturesco en silueta, mirando a la derecha
const dragon = `
  <g class="dragon">
    <g class="dragon-body" fill="#2a1650">
      <path class="wing wing-back" d="M52 22 C40 -6 22 -22 6 -26 C18 -10 22 2 20 14 Z" opacity=".75"/>
      <path d="M-58 30 C-44 22 -30 34 -14 30 C6 24 26 18 50 20 C70 22 84 18 96 10 L104 4 L110 8 L106 2 L116 4 C124 6 128 12 126 18 C120 22 110 22 102 26 C92 34 76 40 54 40 C30 40 8 42 -14 38 C-30 36 -44 40 -58 30 Z"/>
      <path d="M-58 30 L-74 22 L-66 34 Z"/>
      <path d="M40 38 l-4 12 l8 -2z M70 36 l-2 12 l8 -3z"/>
      <path class="wing" d="M62 22 C56 -12 36 -40 10 -52 C24 -34 26 -16 22 -2 C34 -10 44 -6 46 6 C50 0 58 6 62 22 Z"/>
    </g>
    <circle cx="114" cy="12" r="2.2" fill="#ffd166"/>
  </g>`;

export function sceneSVG() {
  return `
  <svg class="scene-svg" viewBox="0 0 1440 520" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1c1245"/><stop offset=".22" stop-color="#3f2580"/>
        <stop offset=".4" stop-color="#9a4ea8"/><stop offset=".54" stop-color="#ff8a9a"/><stop offset=".66" stop-color="#ffc48a"/><stop offset="1" stop-color="#ffd9a0"/>
      </linearGradient>
      <radialGradient id="moonGlow"><stop offset="0" stop-color="#fff2c9" stop-opacity=".55"/><stop offset="1" stop-color="#fff2c9" stop-opacity="0"/></radialGradient>
      <linearGradient id="far" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9a6ad0"/><stop offset="1" stop-color="#6b3fa6"/></linearGradient>
      <linearGradient id="mid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#58338f"/><stop offset="1" stop-color="#3a2170"/></linearGradient>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>

    <rect width="1440" height="520" fill="url(#sky)"/>
    <g fill="#fff">${stars}</g>

    <circle cx="1010" cy="96" r="170" fill="url(#moonGlow)"/>
    <circle cx="1010" cy="96" r="54" fill="#fff4d6"/>
    <g fill="#f3e2b8"><circle cx="992" cy="84" r="10"/><circle cx="1026" cy="112" r="7"/><circle cx="1022" cy="76" r="5"/></g>

    <g fill="#ffd6e6" opacity=".45">${cloud(180, 120, 1, 'drift slow')}${cloud(860, 80, .8, 'drift')}${cloud(1320, 220, .7, 'drift slow')}</g>

    <g class="dragon-path">${dragon}</g>

    <path fill="url(#far)" opacity=".9" d="M0 330 L120 250 L210 300 L330 200 L450 290 L560 230 L680 300 L800 210 L930 290 L1040 240 L1160 310 L1280 220 L1440 300 V520 H0Z"/>
    <g fill="#f4e6ff" opacity=".55">
      <path d="M330 200 L352 222 L340 220 L330 230 L320 220 L308 222Z"/><path d="M800 210 L822 232 L808 230 L800 238 L790 230 L778 232Z"/><path d="M1280 220 L1300 240 L1288 238 L1280 246 L1270 238 L1260 240Z"/>
    </g>

    <g fill="#ffe0ec" opacity=".35">${cloud(560, 290, .9, 'drift')}${cloud(1080, 320, 1.1, 'drift slow')}</g>

    <path fill="url(#mid)" d="M0 380 C120 340 220 330 300 320 C380 330 460 360 560 360 C700 360 780 320 900 330 C1020 340 1120 380 1240 370 C1320 364 1390 350 1440 350 V520 H0Z"/>
    <g filter="url(#glow)">${castle}</g>
    <g fill="#2f1b5c">${pine(520, 372, .7)}${pine(560, 378, .55)}${pine(980, 352, .75)}${pine(1030, 360, .6)}${pine(1110, 372, .7)}${pine(1390, 362, .65)}${pine(120, 372, .65)}${pine(300, 360, .8)}${pine(340, 366, .6)}</g>

    <path fill="#2a1852" d="M0 440 C160 410 300 420 460 432 C640 446 760 410 940 414 C1100 418 1260 446 1440 430 V520 H0Z"/>
    <g class="knight-path">${knight}</g>
    <g fill="#24144a">${pine(40, 452, .9)}${pine(90, 460, .7)}${pine(1380, 448, .95)}${pine(1330, 458, .7)}${pine(760, 428, .6)}</g>
    <path fill="#1e1440" d="M0 480 C240 462 480 470 720 476 C960 482 1200 466 1440 474 V520 H0Z"/>

    <g fill="#ffe27a" filter="url(#glow)">${fireflies}</g>
  </svg>`;
}

// Emblema suelto (escudo con calavera y espadas cruzadas) para la sección de torneos
export const emblemSVG = (cls = '') =>
  `<svg class="emblem ${cls}" viewBox="-62 -66 124 132" aria-hidden="true">${crest(0, 0, 1, 'bob')}</svg>`;
