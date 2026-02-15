/* eslint-disable react-refresh/only-export-components */
import { Briefcase, Users, School, UserPlus, Bus, Car } from 'lucide-react';

// Google Logo SVG
export const GoogleLogo = ({ className = "w-5 h-5" }) => (
  <svg className={className} viewBox="0 0 24 24">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
  </svg>
);

// Normalize snake_case API data to camelCase for frontend
export const normalizeStudent = (s) => ({
  ...s,
  firstName: s.first_name || s.firstName || '',
  lastName: s.last_name || s.lastName || '',
  dismissalType: s.dismissal_type || s.dismissalType || 'car',
  busRoute: s.bus_route || s.busRoute || '',
  homeroom: s.homeroom_id || s.homeroom || null,
  externalId: s.external_id || s.externalId || '',
});

export const GRADES = ['Pre-K', 'K', '1', '2', '3', '4', '5', '6', '7', '8'];
export const PAGE_SIZE = 30;

export const TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern' },
  { value: 'America/Chicago', label: 'Central' },
  { value: 'America/Denver', label: 'Mountain' },
  { value: 'America/Los_Angeles', label: 'Pacific' },
  { value: 'America/Anchorage', label: 'Alaska' },
  { value: 'Pacific/Honolulu', label: 'Hawaii' },
];

export const tabs = [
  { id: 'staff', label: 'Staff', icon: Briefcase },
  { id: 'roster', label: 'Student Roster', icon: Users },
  { id: 'homerooms', label: 'Create Homerooms', icon: School },
  { id: 'assign', label: 'Assign Students', icon: UserPlus },
  { id: 'bus-assignments', label: 'Bus Assignments', icon: Bus },
  { id: 'dismissal', label: 'Set Dismissal', icon: Car },
  { id: 'car-numbers', label: 'Car Numbers', icon: Car },
];

export function detectGradeFromName(name) {
  if (!name) return '';
  const n = name.toLowerCase().trim();
  if (/pre[\s-]?k|pre[\s-]?kindergarten/i.test(n)) return 'Pre-K';
  if (/^kindergarten$|^kinder$/i.test(n) || /\bkindergarten\b|\bkinder\b/i.test(n)) return 'K';
  const gradeMatch = n.match(/(?:grade|gr\.?)\s*(\d+)/i);
  if (gradeMatch) return gradeMatch[1];
  const ordinalMatch = n.match(/(\d+)(?:st|nd|rd|th)\s*(?:grade)?/i);
  if (ordinalMatch) return ordinalMatch[1];
  const numOnly = n.match(/^(\d+)$/);
  if (numOnly && parseInt(numOnly[1]) <= 12) return numOnly[1];
  return '';
}
