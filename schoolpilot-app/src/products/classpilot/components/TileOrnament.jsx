import { useActiveDashboardTheme } from '../contexts/DashboardThemeContext';

const HEART = 'M16 29 C8 22 2 17 2 10.5 C2 6 5.5 3 9.5 3 C12.3 3 14.6 4.6 16 7 C17.4 4.6 19.7 3 22.5 3 C26.5 3 30 6 30 10.5 C30 17 24 22 16 29 Z';
const LEAFLET = 'M0 7 C-5.5 2.5 -8 -1 -8 -4.5 C-8 -7.5 -5.5 -9.5 -3 -9.5 C-1.4 -9.5 0 -8.5 0 -7 C0 -8.5 1.4 -9.5 3 -9.5 C5.5 -9.5 8 -7.5 8 -4.5 C8 -1 5.5 2.5 0 7 Z';
const LEAF = 'M16 2 C27 8 30 19 16 30 C2 19 5 8 16 2 Z';

// Decorative, theme-specific drawing on a student tile. Pure presentation:
// absolutely positioned by dashboardThemes.css, never focusable, never a hit
// target, hidden from assistive technology. Renders nothing without a theme.
export default function TileOrnament() {
  const theme = useActiveDashboardTheme();
  const kind = theme?.ornament;
  if (!kind || kind === 'none') return null;
  const svg = { 'aria-hidden': true, focusable: 'false', className: `tile-ornament tile-ornament-${kind}` };
  switch (kind) {
    case 'cobweb':
      return (
        <svg viewBox="0 0 40 40" {...svg}>
          <path d="M40 0 L0 0 M40 0 L6 10 M40 0 L16 22 M40 0 L30 34 M40 0 L40 40" stroke="currentColor" strokeWidth="1" fill="none" />
          <path d="M40 11 A11 11 0 0 0 29 0 M40 22 A22 22 0 0 0 18 0 M40 33 A33 33 0 0 0 7 0" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      );
    case 'turkey':
      return (
        <svg viewBox="0 0 64 64" {...svg}>
          <g transform="translate(32 30)">
            <ellipse rx="7" ry="17" fill="#b45309" transform="rotate(-62) translate(0 -14)" />
            <ellipse rx="7" ry="17" fill="#dc2626" transform="rotate(-31) translate(0 -16)" />
            <ellipse rx="7" ry="18" fill="#f59e0b" transform="translate(0 -17)" />
            <ellipse rx="7" ry="17" fill="#dc2626" transform="rotate(31) translate(0 -16)" />
            <ellipse rx="7" ry="17" fill="#b45309" transform="rotate(62) translate(0 -14)" />
          </g>
          <circle cx="32" cy="38" r="15" fill="#78350f" />
          <circle cx="26" cy="35" r="3.2" fill="#fff" /><circle cx="38" cy="35" r="3.2" fill="#fff" />
          <circle cx="26.6" cy="35.6" r="1.5" fill="#111" /><circle cx="38.6" cy="35.6" r="1.5" fill="#111" />
          <path d="M28.5 41 L35.5 41 L32 48 Z" fill="#f59e0b" />
          <path d="M33.5 43.5 C39 45 38 53 32.5 51 Z" fill="#dc2626" />
        </svg>
      );
    case 'lights':
      return (
        <span className="tile-ornament tile-ornament-lights" aria-hidden="true">
          <span className="tile-ornament-wire" />
          <span className="tile-ornament-bulbs" />
        </span>
      );
    case 'hearts':
      return (
        <span className="tile-ornament tile-ornament-hearts" aria-hidden="true">
          <svg viewBox="0 0 32 32" className="heart heart-a"><path d={HEART} fill="currentColor" /></svg>
          <svg viewBox="0 0 32 32" className="heart heart-b"><path d={HEART} fill="currentColor" /></svg>
          <svg viewBox="0 0 32 32" className="heart heart-c"><path d={HEART} fill="currentColor" /></svg>
        </span>
      );
    case 'shamrock':
      return (
        <svg viewBox="0 0 40 40" {...svg}>
          {[0, 120, 240].map(angle => (
            <path key={angle} d={LEAFLET} fill="#16a34a" stroke="#15803d" strokeWidth="0.8" transform={`translate(20 19) rotate(${angle}) translate(0 -8.5)`} />
          ))}
          <path d="M20 22 Q23 30 19 37" stroke="#15803d" strokeWidth="2.6" fill="none" strokeLinecap="round" />
        </svg>
      );
    case 'ears':
      return (
        <svg viewBox="0 0 48 34" {...svg}>
          <g transform="rotate(-12 14 34)"><ellipse cx="14" cy="20" rx="7.5" ry="20" fill="#fff" stroke="#e5e7eb" strokeWidth="1" /><ellipse cx="14" cy="22" rx="3.6" ry="14" fill="#fbcfe8" /></g>
          <g transform="rotate(12 34 34)"><ellipse cx="34" cy="20" rx="7.5" ry="20" fill="#fff" stroke="#e5e7eb" strokeWidth="1" /><ellipse cx="34" cy="22" rx="3.6" ry="14" fill="#fbcfe8" /></g>
        </svg>
      );
    case 'daisy':
      return (
        <svg viewBox="0 0 40 40" {...svg}>
          {[0, 45, 90, 135, 180, 225, 270, 315].map(angle => (
            <ellipse key={angle} cx="20" cy="9" rx="4.2" ry="8" fill="#fff" stroke="rgba(0,0,0,.08)" transform={`rotate(${angle} 20 20)`} />
          ))}
          <circle cx="20" cy="20" r="6" fill="#fbbf24" />
        </svg>
      );
    case 'sun':
      return (
        <svg viewBox="0 0 40 40" {...svg}>
          {[0, 45, 90, 135, 180, 225, 270, 315].map(angle => (
            <line key={angle} x1="20" y1="3" x2="20" y2="8" stroke="#f59e0b" strokeWidth="3" strokeLinecap="round" transform={`rotate(${angle} 20 20)`} />
          ))}
          <circle cx="20" cy="20" r="9" fill="#fbbf24" />
        </svg>
      );
    case 'leaf':
      return (
        <span className="tile-ornament tile-ornament-leaf" aria-hidden="true">
          <svg viewBox="0 0 32 32" className="leaf-a"><path d={LEAF} fill="currentColor" /><path d="M16 6 L16 28 M16 14 L10 10 M16 18 L22 13" stroke="rgba(0,0,0,.25)" strokeWidth="1.5" fill="none" /></svg>
          <svg viewBox="0 0 32 32" className="leaf-b"><path d={LEAF} fill="currentColor" /></svg>
        </span>
      );
    case 'snowcap':
      return (
        <span className="tile-ornament tile-ornament-snowcap" aria-hidden="true">
          <svg viewBox="0 0 120 14" preserveAspectRatio="none" style={{ width: '100%', height: '100%', display: 'block' }}>
            <path d="M0 14 L0 9 Q8 2 18 8 Q27 13 36 6 Q46 0 56 7 Q66 13 76 5 Q86 -1 96 6 Q106 12 114 7 L120 9 L120 14 Z" fill="#fff" />
          </svg>
          <svg viewBox="0 0 40 40" className="flake">
            {[0, 60, 120, 180, 240, 300].map(angle => (
              <g key={angle} transform={`rotate(${angle} 20 20)`} stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <line x1="20" y1="20" x2="20" y2="3" /><line x1="20" y1="8" x2="16" y2="5" strokeWidth="2" /><line x1="20" y1="8" x2="24" y2="5" strokeWidth="2" />
              </g>
            ))}
          </svg>
        </span>
      );
    default:
      return null;
  }
}
