// Escena ilustrada de la portada: atardecer de fantasía con castillo, montañas,
// luna, nubes, luciérnagas y un dragón que cruza el cielo. Todo en SVG, sin imágenes externas.

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

// Castillo de cuento: torre central, dos torres laterales, almenas, ventanas encendidas y banderas
const castle = `
  <g transform="translate(1250 330) scale(.95)">
    <g fill="#3b2272">
      <rect x="-40" y="-120" width="80" height="140" rx="4"/>
      <path d="M-40 -120 v-12 h12 v12 h10 v-12 h12 v12 h12 v-12 h12 v12 h10 v-12 h12 v12z"/>
      <rect x="-110" y="-70" width="46" height="90" rx="4"/>
      <rect x="64" y="-80" width="46" height="100" rx="4"/>
      <rect x="-64" y="-40" width="128" height="60"/>
      <path d="M-64 -40 v-10 h12 v10 h12 v-10 h12 v10 h12 v-10 h12 v10 h12 v-10 h12 v10 h12 v-10 h12 v10 h12 v-10 h8 v10z"/>
    </g>
    <g fill="#ff7eb6">
      <path d="M-50 -132 L0 -200 L50 -132 Z"/>
      <path d="M-118 -70 L-87 -122 L-56 -70 Z"/>
      <path d="M56 -80 L87 -136 L118 -80 Z"/>
    </g>
    <g fill="#e0619a" opacity=".55">
      <path d="M0 -200 L50 -132 H10 Z"/><path d="M-87 -122 L-56 -70 H-80 Z"/><path d="M87 -136 L118 -80 H94 Z"/>
    </g>
    <g stroke="#2a1747" stroke-width="2.5">
      <line x1="0" y1="-200" x2="0" y2="-226"/><line x1="-87" y1="-122" x2="-87" y2="-142"/><line x1="87" y1="-136" x2="87" y2="-156"/>
    </g>
    <g fill="#ffd166" class="flags">
      <path class="flag" d="M0 -226 l22 6 l-22 6z"/><path class="flag" d="M-87 -142 l16 5 l-16 5z"/><path class="flag" d="M87 -156 l16 5 l-16 5z"/>
    </g>
    <g fill="#ffd166" class="windows">
      <path d="M-10 -86 a10 10 0 0 1 20 0 v20 h-20z"/>
      <rect x="-96" y="-44" width="16" height="20" rx="8"/><rect x="78" y="-52" width="16" height="20" rx="8"/>
      <rect x="-30" y="-24" width="10" height="14" rx="5"/><rect x="20" y="-24" width="10" height="14" rx="5"/>
    </g>
    <path d="M-16 20 v-26 a16 16 0 0 1 32 0 v26z" fill="#22133f"/>
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
    <g fill="#24144a">${pine(40, 452, .9)}${pine(90, 460, .7)}${pine(1380, 448, .95)}${pine(1330, 458, .7)}${pine(760, 428, .6)}</g>
    <path fill="#1e1440" d="M0 480 C240 462 480 470 720 476 C960 482 1200 466 1440 474 V520 H0Z"/>

    <g fill="#ffe27a" filter="url(#glow)">${fireflies}</g>
  </svg>`;
}
