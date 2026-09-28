/** The one list of My Desk areas, shared by the tab bar and the ClassPilot sidebar card. */
export function myDeskTabList(seatingEnabled) {
  return [
    { key: 'notes', path: '/classpilot/my-desk', label: 'Notes' },
    { key: 'discipline', path: '/classpilot/discipline-records', label: 'Discipline logs' },
    { key: 'student-information', path: '/classpilot/my-desk/student-information', label: 'Student information' },
    ...(seatingEnabled ? [{ key: 'seating', path: '/classpilot/my-desk/seating', label: 'Seating' }] : []),
  ];
}

/** Sub-pages keep their tab highlighted; "Private notes by student" belongs to Notes. */
export function activeMyDeskTab(pathname) {
  if (pathname.startsWith('/classpilot/discipline-records')) return 'discipline';
  if (pathname.startsWith('/classpilot/my-desk/student-information')) return 'student-information';
  if (pathname.startsWith('/classpilot/my-desk/seating')) return 'seating';
  if (pathname === '/classpilot/my-desk' || pathname.startsWith('/classpilot/my-desk/notes')) return 'notes';
  return '';
}
