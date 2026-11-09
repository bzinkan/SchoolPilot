const paths = {
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  kiosk: <><rect x="3" y="3" width="18" height="13" rx="2" /><path d="M8 21h8m-4-5v5" /></>,
  rules: <path d="M9 6h12M9 12h12M9 18h12M3 5l1 1 2-2M3 11l1 1 2-2M3 17l1 1 2-2" />,
  report: <path d="M4 20h17M7 16v-4m5 4V6m5 10V9" />,
  car: <path d="M3 16v-5l3-5h12l3 5v5M3 11h18M5 16v3m14-3v3M6 14h1m10 0h1" />,
  shield: <path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3zM8 12l3 3 5-6" />,
  bell: <path d="M5 16h14l-2-3V9a5 5 0 0 0-10 0v4l-2 3zm5 4h4" />,
  arrow: <path d="M5 12h14m-5-5l5 5-5 5" />,
  check: <path d="M5 12l4 4L19 6" />,
  school: <path d="M3 9l9-6 9 6v12H3V9zm7 12v-7h4v7M7 11h.01M17 11h.01" />,
  search: <><circle cx="10" cy="10" r="6" /><path d="M15 15l5 5" /></>,
  bus: <><rect x="4" y="3" width="16" height="16" rx="3" /><path d="M4 11h16M8 19v2m8-2v2M8 15h.01M16 15h.01" /></>,
  walk: <><circle cx="13" cy="4" r="2" /><path d="M8 12l3-5 4 5h4M11 7l-1 8-4 6m4-6 5 2 1 4" /></>,
};

export default function ProductAboutIcon({ name }) {
  return (
    <svg className="pa-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}

export function ProductAboutPlane() {
  return (
    <svg viewBox="0 0 30 30" aria-hidden="true" focusable="false">
      <path d="M5 8l21 7-21 7 5-7z" fill="#fff" />
      <path d="M10 15h16L5 22z" fill="#f3b51b" />
    </svg>
  );
}
