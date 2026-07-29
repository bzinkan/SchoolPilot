export const SITE_ORIGIN = 'https://school-pilot.net';

export const PUBLIC_PAGE_METADATA = Object.freeze({
  '/': {
    title: 'Schoolpilot | Student Safety and School Operations',
    description:
      'Schoolpilot brings Chromebook classroom management, digital hall passes, and student dismissal into one platform for K-12 schools.',
  },
  '/products/classpilot': {
    title: 'ClassPilot | Chromebook Classroom Management',
    description:
      'ClassPilot helps K-12 educators supervise Chromebooks, guide student browsing, and respond to online safety concerns.',
  },
  '/products/passpilot': {
    title: 'PassPilot | Digital Hall Passes for K-12 Schools',
    description:
      'PassPilot gives K-12 schools a simple digital hall pass workflow with real-time visibility for teachers and administrators.',
  },
  '/products/gopilot': {
    title: 'GoPilot | Student Dismissal Management',
    description:
      'GoPilot helps K-12 schools coordinate student dismissal, pickups, buses, and family notifications from one connected workflow.',
  },
  '/get-started': {
    title: 'Get Started with Schoolpilot',
    description:
      'Tell Schoolpilot about your school and the student safety or operations tools your team needs.',
  },
  '/security': {
    title: 'Security at Schoolpilot',
    description:
      'Review Schoolpilot security practices, data safeguards, and resources for K-12 technology and procurement teams.',
  },
  '/privacy': {
    title: 'Privacy Policy | Schoolpilot',
    description:
      'Read the Schoolpilot privacy policy, including how school and student information is protected and handled.',
  },
  '/terms': {
    title: 'Terms of Service | Schoolpilot',
    description: 'Read the terms that govern use of Schoolpilot services.',
  },
  '/ai-transparency': {
    title: 'AI Transparency | Schoolpilot',
    description:
      'Learn how Schoolpilot uses artificial intelligence, human oversight, and privacy safeguards in its K-12 products.',
  },
  '/subprocessors': {
    title: 'Subprocessors | Schoolpilot',
    description:
      'Review the service providers Schoolpilot uses to operate and support its K-12 platform.',
  },
  '/delete-account': {
    title: 'Account and Data Deletion | Schoolpilot',
    description:
      'Learn how to request deletion of a Schoolpilot account and associated data.',
  },
});

export function normalizePathname(pathname) {
  if (!pathname || pathname === '/') return '/';
  return pathname.replace(/\/+$/, '') || '/';
}

export function getPublicPageMetadata(pathname) {
  return PUBLIC_PAGE_METADATA[normalizePathname(pathname)] ?? null;
}
