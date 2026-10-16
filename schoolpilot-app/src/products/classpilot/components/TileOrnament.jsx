import { useActiveDashboardTheme } from '../contexts/DashboardThemeContext';

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
    default:
      return null;
  }
}
