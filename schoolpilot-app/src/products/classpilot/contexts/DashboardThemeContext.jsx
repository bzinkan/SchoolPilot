import { createContext, useContext } from 'react';

// The resolved dashboard theme preset (see shared/themes/presets.js) for the
// console subtree, or null for Default. Provided once at the dashboard root so
// tile ornaments can read it without a prop threading through StudentTile.
export const DashboardThemeContext = createContext(null);

export function useActiveDashboardTheme() {
  return useContext(DashboardThemeContext);
}
