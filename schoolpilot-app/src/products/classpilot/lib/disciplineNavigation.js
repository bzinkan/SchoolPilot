// This allowlisted marker controls navigation only. Access and school scope
// continue to come from the server's capabilities, never from a URL parameter.
export function disciplineParent(search) {
  return new URLSearchParams(search).get('entry') === 'admin'
    ? { path: '/classpilot/admin', label: 'Admin Panel' }
    : { path: '/classpilot/my-desk', label: 'My Desk' };
}

/** Carry the origin onto a code-owned internal route; never accept a return URL. */
export function withDisciplineEntry(path, search) {
  return new URLSearchParams(search).get('entry') === 'admin'
    ? `${path}${path.includes('?') ? '&' : '?'}entry=admin`
    : path;
}
