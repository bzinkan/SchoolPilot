import { useActiveDashboardTheme } from '../contexts/DashboardThemeContext';

const HEART = 'M16 29 C8 22 2 17 2 10.5 C2 6 5.5 3 9.5 3 C12.3 3 14.6 4.6 16 7 C17.4 4.6 19.7 3 22.5 3 C26.5 3 30 6 30 10.5 C30 17 24 22 16 29 Z';
const LEAFLET = 'M0 7 C-5.5 2.5 -8 -1 -8 -4.5 C-8 -7.5 -5.5 -9.5 -3 -9.5 C-1.4 -9.5 0 -8.5 0 -7 C0 -8.5 1.4 -9.5 3 -9.5 C5.5 -9.5 8 -7.5 8 -4.5 C8 -1 5.5 2.5 0 7 Z';
const LEAF = 'M16 2 C27 8 30 19 16 30 C2 19 5 8 16 2 Z';

// The small drawing beside the ClassPilot wordmark in the console header, one
// per preloaded theme. Pure presentation: sized by dashboardThemes.css, never
// a hit target, hidden from assistive technology. Nothing without a theme and
// nothing for a teacher's own uploaded background.
export default function HeaderOrnament() {
  const theme = useActiveDashboardTheme();
  const id = theme?.id;
  if (!id || id === 'image') return null;
  const svg = { 'aria-hidden': true, focusable: 'false', className: 'header-ornament', 'data-testid': 'header-ornament', 'data-ornament': id };
  switch (id) {
    case 'halloween':
      return (
        <svg viewBox="0 0 64 64" {...svg}>
          <rect x="29" y="5" width="7" height="13" rx="3" fill="#15803d" />
          <ellipse cx="32" cy="38" rx="27" ry="23" fill="#f97316" />
          <ellipse cx="18" cy="38" rx="11" ry="22" fill="#ea580c" opacity=".55" />
          <ellipse cx="46" cy="38" rx="11" ry="22" fill="#ea580c" opacity=".55" />
          <ellipse cx="32" cy="38" rx="10" ry="23" fill="#fb923c" opacity=".7" />
          <path d="M17 31 L26 36 L17 39 Z" fill="#fef08a" /><path d="M47 31 L38 36 L47 39 Z" fill="#fef08a" /><path d="M32 38 L28.5 44 L35.5 44 Z" fill="#fef08a" />
          <path d="M15 46 Q32 60 49 46 L45 46 L43 51 L39 46 L35 51 L31 46 L27 51 L23 46 L21 50 L19 46 Z" fill="#fef08a" />
        </svg>
      );
    case 'thanksgiving':
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
          <path d="M28.5 41 L35.5 41 L32 48 Z" fill="#f59e0b" /><path d="M33.5 43.5 C39 45 38 53 32.5 51 Z" fill="#dc2626" />
        </svg>
      );
    case 'christmas':
      return (
        <svg viewBox="0 0 48 48" {...svg}>
          <path d="M24 4 L34 18 L14 18 Z" fill="#22c55e" /><path d="M24 12 L37 29 L11 29 Z" fill="#16a34a" /><path d="M24 21 L40 41 L8 41 Z" fill="#15803d" />
          <rect x="21" y="41" width="6" height="5" fill="#78350f" />
          <circle cx="20" cy="24" r="2" fill="#ef4444" /><circle cx="29" cy="31" r="2" fill="#facc15" /><circle cx="17" cy="35" r="2" fill="#3b82f6" /><circle cx="31" cy="21" r="1.6" fill="#f472b6" />
          <path d="M24 1 L25.4 4.6 L29.2 4.8 L26.2 7.2 L27.2 11 L24 8.8 L20.8 11 L21.8 7.2 L18.8 4.8 L22.6 4.6 Z" fill="#fcd34d" />
        </svg>
      );
    case 'advent':
      return (
        <svg viewBox="0 0 40 40" {...svg}>
          <rect x="14" y="14" width="12" height="22" rx="2" fill="#7c3aed" /><rect x="14" y="14" width="12" height="4" fill="#a78bfa" />
          <ellipse cx="20" cy="9" rx="3.5" ry="6" fill="#fbbf24" /><ellipse cx="20" cy="10.5" rx="1.6" ry="3" fill="#fef3c7" />
        </svg>
      );
    case 'valentines':
      return <svg viewBox="0 0 32 32" {...svg}><path d={HEART} fill="#fb7185" /></svg>;
    case 'st-patricks':
      return (
        <svg viewBox="0 0 40 40" {...svg}>
          {[0, 120, 240].map(angle => (
            <path key={angle} d={LEAFLET} fill="#16a34a" stroke="#15803d" strokeWidth="0.8" transform={`translate(20 19) rotate(${angle}) translate(0 -8.5)`} />
          ))}
          <path d="M20 22 Q23 30 19 37" stroke="#15803d" strokeWidth="2.6" fill="none" strokeLinecap="round" />
        </svg>
      );
    case 'easter':
      return (
        <svg viewBox="0 0 32 40" {...svg}>
          <path d="M16 2 C8 2 3 14 3 24 C3 32 9 38 16 38 C23 38 29 32 29 24 C29 14 24 2 16 2 Z" fill="#f9a8d4" />
          <path d="M4 18 Q16 12 28 18" stroke="#fff" strokeWidth="3" fill="none" /><path d="M4 27 Q16 33 28 27" stroke="#fff" strokeWidth="3" fill="none" />
          <circle cx="16" cy="22.5" r="2.2" fill="#a78bfa" />
        </svg>
      );
    case 'spring':
      return (
        <svg viewBox="0 0 40 40" {...svg}>
          {[0, 45, 90, 135, 180, 225, 270, 315].map(angle => (
            <ellipse key={angle} cx="20" cy="9" rx="4.2" ry="8" fill="#f9a8d4" stroke="rgba(0,0,0,.08)" transform={`rotate(${angle} 20 20)`} />
          ))}
          <circle cx="20" cy="20" r="6" fill="#fbbf24" />
        </svg>
      );
    case 'summer':
      return (
        <svg viewBox="0 0 40 40" {...svg}>
          {[0, 45, 90, 135, 180, 225, 270, 315].map(angle => (
            <line key={angle} x1="20" y1="3" x2="20" y2="8" stroke="#f59e0b" strokeWidth="3" strokeLinecap="round" transform={`rotate(${angle} 20 20)`} />
          ))}
          <circle cx="20" cy="20" r="9" fill="#fbbf24" />
        </svg>
      );
    case 'fall':
      return (
        <svg viewBox="0 0 32 32" {...svg}>
          <path d={LEAF} fill="#ea580c" /><path d="M16 6 L16 28 M16 14 L10 10 M16 18 L22 13" stroke="rgba(0,0,0,.25)" strokeWidth="1.5" fill="none" />
        </svg>
      );
    case 'winter':
      return (
        <svg viewBox="0 0 40 40" {...svg}>
          {[0, 60, 120, 180, 240, 300].map(angle => (
            <g key={angle} transform={`rotate(${angle} 20 20)`} stroke="#e0f2fe" strokeWidth="2.4" strokeLinecap="round">
              <line x1="20" y1="20" x2="20" y2="3" /><line x1="20" y1="8" x2="16" y2="5" strokeWidth="2" /><line x1="20" y1="8" x2="24" y2="5" strokeWidth="2" />
            </g>
          ))}
        </svg>
      );
    default:
      return null;
  }
}
