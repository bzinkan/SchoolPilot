import { KIOSK_PLATES, kioskFirstName, kioskPlateLabel } from '../../../shared/themes/kiosk';

// The student's first name inside a theme shape, shown for a few seconds on
// the kiosk's sign-out and return confirmations. One SVG template per preset
// with a single text slot: the name stays real text (read aloud as "Ada,
// carved on a jack-o-lantern"), textLength keeps long names inside the
// shape, and every text band keeps at least 4.5:1 against its own fill.
// Uploaded-image themes get the neutral glass plate.

const BAND = { x: 35, width: 170, rx: 12 };

function Band({ y, height = 40, fill, stroke }) {
  return <rect x={BAND.x} y={y} width={BAND.width} height={height} rx={BAND.rx} fill={fill} stroke={stroke} strokeWidth={stroke ? 2 : 0} />;
}

function Pumpkin() {
  return <g>
    <rect x="109" y="36" width="22" height="30" rx="7" fill="#166534" />
    <ellipse cx="120" cy="138" rx="102" ry="84" fill="#f97316" />
    <ellipse cx="120" cy="138" rx="62" ry="84" fill="none" stroke="#c2410c" strokeWidth="3" opacity="0.6" />
    <ellipse cx="120" cy="138" rx="24" ry="84" fill="none" stroke="#c2410c" strokeWidth="3" opacity="0.6" />
    <path d="M70 108 L92 76 L114 108 Z" fill="#fde68a" stroke="#1c0a00" strokeWidth="4" strokeLinejoin="round" />
    <path d="M126 108 L148 76 L170 108 Z" fill="#fde68a" stroke="#1c0a00" strokeWidth="4" strokeLinejoin="round" />
    <Band y={124} height={54} fill="#1c0a00" />
  </g>;
}
Pumpkin.textY = 151; Pumpkin.textFill = '#fde68a';

function Turkey() {
  const feathers = [[-60, '#b45309'], [-30, '#dc2626'], [0, '#f59e0b'], [30, '#dc2626'], [60, '#b45309']];
  return <g>
    <g transform="translate(120 130)">
      {feathers.map(([angle, fill]) => <ellipse key={angle} cx="0" cy="-78" rx="22" ry="56" fill={fill} transform={`rotate(${angle})`} />)}
    </g>
    <circle cx="120" cy="152" r="74" fill="#78350f" />
    <circle cx="120" cy="84" r="20" fill="#92400e" />
    <path d="M136 84 L156 90 L136 96 Z" fill="#f59e0b" />
    <path d="M128 92 q6 18 -2 26" stroke="#dc2626" strokeWidth="6" fill="none" strokeLinecap="round" />
    <circle cx="113" cy="80" r="3" fill="#1c0a00" />
    <Band y={134} height={44} fill="#431407" />
  </g>;
}
Turkey.textY = 156; Turkey.textFill = '#fef3c7';

function Stocking() {
  return <g>
    <path d="M72 84 h96 v80 q0 10 10 10 h22 q24 0 24 24 v10 q0 22 -22 22 h-96 q-34 0 -34 -34 Z" fill="#b91c1c" />
    <path d="M190 194 q0 18 -18 18 h-60" stroke="#f8fafc" strokeWidth="14" fill="none" strokeLinecap="round" />
    <Band y={38} height={52} fill="#f8fafc" stroke="#cbd5e1" />
  </g>;
}
Stocking.textY = 64; Stocking.textFill = '#7f1d1d';

function Wreath() {
  const candles = [[78, '#7e22ce'], [100, '#7e22ce'], [122, '#f472b6'], [144, '#7e22ce']];
  return <g>
    <circle cx="120" cy="134" r="84" fill="none" stroke="#166534" strokeWidth="30" />
    {[20, 80, 140, 200, 260, 320].map(angle => <circle key={angle} cx={120 + 84 * Math.cos((angle * Math.PI) / 180)} cy={134 + 84 * Math.sin((angle * Math.PI) / 180)} r="6" fill="#dc2626" />)}
    {candles.map(([x, fill]) => <g key={x}>
      <rect x={x} y="22" width="16" height="42" rx="3" fill={fill} />
      <ellipse cx={x + 8} cy="16" rx="5" ry="9" fill="#fbbf24" />
    </g>)}
    <Band y={114} height={40} fill="#0f172a" />
  </g>;
}
Wreath.textY = 134; Wreath.textFill = '#f8fafc';

function HeartShape() {
  return <g>
    <path d="M120 218 C 40 164, 18 112, 40 76 C 60 42, 106 46, 120 82 C 134 46, 180 42, 200 76 C 222 112, 200 164, 120 218 Z" fill="#e11d48" />
    <Band y={102} height={44} fill="#9f1239" />
  </g>;
}
HeartShape.textY = 124; HeartShape.textFill = '#fff1f2';

function Shamrock() {
  return <g>
    <path d="M120 150 q-6 40 -26 70" stroke="#166534" strokeWidth="12" fill="none" strokeLinecap="round" />
    <circle cx="120" cy="82" r="44" fill="#15803d" />
    <circle cx="78" cy="136" r="44" fill="#15803d" />
    <circle cx="162" cy="136" r="44" fill="#15803d" />
    <circle cx="120" cy="120" r="46" fill="#15803d" />
    <Band y={104} height={40} fill="#052e16" />
  </g>;
}
Shamrock.textY = 124; Shamrock.textFill = '#dcfce7';

function Egg() {
  return <g>
    <path d="M120 22 C 70 22, 36 94, 36 148 C 36 198, 74 226, 120 226 C 166 226, 204 198, 204 148 C 204 94, 170 22, 120 22 Z" fill="#c4b5fd" />
    <path d="M44 120 q38 -18 76 0 t76 0" stroke="#a78bfa" strokeWidth="10" fill="none" />
    <path d="M40 176 q40 18 80 0 t80 0" stroke="#f9a8d4" strokeWidth="10" fill="none" />
    <Band y={128} height={44} fill="#312e81" />
  </g>;
}
Egg.textY = 150; Egg.textFill = '#ede9fe';

function Flower() {
  return <g>
    {[0, 60, 120, 180, 240, 300].map(angle => <ellipse key={angle} cx="120" cy="56" rx="30" ry="56" fill="#f9a8d4" transform={`rotate(${angle} 120 130)`} />)}
    <circle cx="120" cy="130" r="70" fill="#fbbf24" />
    <Band y={110} height={40} fill="#78350f" />
  </g>;
}
Flower.textY = 130; Flower.textFill = '#fef3c7';

function SunShape() {
  return <g>
    {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map(angle => <rect key={angle} x="114" y="8" width="12" height="40" rx="6" fill="#fcd34d" transform={`rotate(${angle} 120 130)`} />)}
    <circle cx="120" cy="130" r="82" fill="#fbbf24" />
    <Band y={110} height={40} fill="#78350f" />
  </g>;
}
SunShape.textY = 130; SunShape.textFill = '#fef3c7';

function LeafShape() {
  return <g>
    <path d="M120 16 C 40 60, 20 160, 112 224 C 204 160, 200 60, 120 16 Z" fill="#c2410c" />
    <path d="M118 40 L114 220" stroke="#7c2d12" strokeWidth="5" />
    <path d="M118 90 L72 124 M118 130 L66 168 M118 90 L166 124 M118 130 L170 168" stroke="#7c2d12" strokeWidth="4" />
    <Band y={110} height={44} fill="#431407" />
  </g>;
}
LeafShape.textY = 132; LeafShape.textFill = '#fff7ed';

function Snowflake() {
  return <g>
    {[0, 60, 120].map(angle => <g key={angle} transform={`rotate(${angle} 120 130)`}>
      <path d="M120 22 L120 238" stroke="#bae6fd" strokeWidth="8" strokeLinecap="round" />
      <path d="M100 48 L120 66 L140 48 M100 212 L120 194 L140 212" stroke="#bae6fd" strokeWidth="6" fill="none" strokeLinecap="round" />
    </g>)}
    <circle cx="120" cy="130" r="70" fill="#0c4a6e" stroke="#e0f2fe" strokeWidth="4" />
    <Band y={110} height={40} fill="#082f49" />
  </g>;
}
Snowflake.textY = 130; Snowflake.textFill = '#f0f9ff';

function Glass() {
  return <rect x="20" y="88" width="200" height="76" rx="18" fill="rgba(17, 24, 39, 0.85)" stroke="rgba(255, 255, 255, 0.35)" strokeWidth="2" />;
}
Glass.textY = 126; Glass.textFill = '#f8fafc';

const SHAPES = {
  pumpkin: Pumpkin, turkey: Turkey, stocking: Stocking, wreath: Wreath, heart: HeartShape, shamrock: Shamrock,
  egg: Egg, flower: Flower, sun: SunShape, leaf: LeafShape, snowflake: Snowflake, glass: Glass,
};

export default function KioskNamePlate({ themeId, firstName, className = '' }) {
  const plate = KIOSK_PLATES[themeId];
  const name = kioskFirstName(firstName);
  if (!plate || !name) return null;
  const Shape = SHAPES[plate.shape] ?? Glass;
  const fontSize = name.length <= 6 ? 36 : name.length <= 9 ? 30 : 24;
  const fit = name.length > 7 ? { textLength: BAND.width - 20, lengthAdjust: 'spacingAndGlyphs' } : {};
  return (
    <svg viewBox="0 0 240 240" role="img" aria-label={kioskPlateLabel(themeId, firstName)} data-testid="kiosk-name-plate" data-plate={plate.shape}
      className={`kiosk-plate ${className}`.trim()}>
      <Shape />
      <text x="120" y={Shape.textY} textAnchor="middle" dominantBaseline="central" fontSize={fontSize} fill={Shape.textFill} {...fit}>{name}</text>
    </svg>
  );
}
