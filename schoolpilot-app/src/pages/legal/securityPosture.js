// Public claims: keep in step with docs/soc2/claim-register.md (scanned by `npm run soc2:check`).
export const SECURITY_PAGES_UPDATED = 'November 9, 2026';

export const POSTURE_STATUS_LABELS = {
  in_place: 'In place',
  partial: 'Partial',
  planned: 'Planned',
};

export const SECURITY_POSTURE = [
  {
    title: 'Student data privacy',
    items: [
      { status: 'in_place', label: 'FERPA', detail: 'Acts as a "school official" under the school\'s direct control' },
      { status: 'in_place', label: 'COPPA', detail: 'Relies on the school consent exception; children never sign up directly' },
      { status: 'in_place', label: 'Student data use policy', detail: 'Schoolpilot prohibits sale, advertising and AI-model training with student data; provider-account limitations are described in AI Transparency' },
      { status: 'in_place', label: 'Data privacy agreements', detail: 'Signs the NDPA and state variants (CA, TX, IL, NY) on request' },
      { status: 'in_place', label: 'Parent rights', detail: 'Access requests answered within 45 days; corrections within 15 business days' },
      { status: 'in_place', label: 'End of contract', detail: 'School-directed data return and destruction follow the executed agreement and a verified operator process' },
    ],
  },
  {
    title: 'Security program',
    items: [
      { status: 'in_place', label: 'Written security program', detail: 'Documented WISP; full copy available under NDA' },
      { status: 'in_place', label: 'Background checks', detail: 'Required before anyone is given production access' },
      { status: 'in_place', label: 'Security training', detail: 'Annual training for everyone with access to student data' },
      { status: 'in_place', label: 'Incident response', detail: 'Schools notified within 72 hours of a breach; full report within 30 days' },
      { status: 'in_place', label: 'Monitoring and audit logs', detail: 'Alerts on failed-login spikes, bulk changes and cross-school access; admin actions logged' },
      { status: 'partial', label: 'Service providers', detail: 'Listed in Privacy; vendor agreement confirmations remain in review. New providers handling student PII require 30 days\' notice, except emergencies' },
    ],
  },
  {
    title: 'Data protection',
    items: [
      { status: 'in_place', label: 'Encryption in transit', detail: 'TLS 1.2+ with HSTS' },
      { status: 'in_place', label: 'Encryption at rest', detail: 'AWS RDS (PostgreSQL) and S3 server-side encryption' },
      { status: 'in_place', label: 'US hosting', detail: 'Primary database and file storage in AWS us-east-1; external provider processing is described in Privacy' },
      { status: 'in_place', label: 'School-by-school separation', detail: 'Enforced in the application and by PostgreSQL row-level security' },
      { status: 'in_place', label: 'Backups and recovery', detail: 'Encrypted automated database backups; annual restore drill required by policy' },
    ],
  },
  {
    title: 'Access and sign-in',
    items: [
      { status: 'in_place', label: 'Role-based access', detail: 'Least-privilege roles for admins, teachers, office staff and parents' },
      { status: 'in_place', label: 'Passwords', detail: 'bcrypt hashing, 10+ character complexity, lockout after 10 failed attempts' },
      { status: 'in_place', label: 'Sessions', detail: 'Secure httpOnly cookies, CSRF protection, 1-hour idle timeout for admins' },
      { status: 'in_place', label: 'Google sign-in', detail: 'Staff sign in with their school Google account' },
      { status: 'in_place', label: 'Staff password controls', detail: 'Schools can disable staff passwords on the web; the GoPilot staff app keeps password access with an active GoPilot license' },
      { status: 'planned', label: 'Microsoft and SAML 2.0 sign-in', detail: 'Microsoft Entra ID and SAML 2.0 single sign-on are on the roadmap' },
      { status: 'planned', label: 'In-app MFA for administrators', detail: 'Deferred and tracked in our SOC 2 remediation register' },
    ],
  },
  {
    title: 'Secure development',
    items: [
      { status: 'in_place', label: 'Static code analysis', detail: 'CodeQL runs on main pushes, pull requests and weekly; error findings block CI, warnings are logged' },
      { status: 'in_place', label: 'Dependency scanning', detail: 'CI audits dependencies; production high/critical findings block unless a scoped, time-limited disposition passes validation' },
      { status: 'in_place', label: 'Secret scanning', detail: 'Gitleaks runs on main pushes and pull requests' },
      { status: 'in_place', label: 'Container scanning', detail: 'Trivy blocks fixable high/critical findings on main pushes, selected pull requests and weekly scans' },
      { status: 'planned', label: 'Penetration test', detail: 'Independent third-party test planned' },
    ],
  },
  {
    title: 'Rostering and interoperability',
    items: [
      { status: 'in_place', label: 'Google Classroom and Directory', detail: 'Class roster and staff sync from Google Workspace' },
      { status: 'in_place', label: 'OneRoster 1.1 and 1.2', detail: 'Bulk CSV roster import from SIS exports' },
      { status: 'partial', label: 'Clever Secure Sync', detail: 'Built; awaiting validation with a Clever district before general availability' },
    ],
  },
  {
    title: 'Certifications and assessments',
    items: [
      { status: 'in_place', label: 'HECVAT Lite', detail: 'Pre-completed security questionnaire, published for review' },
      { status: 'in_place', label: 'Hosting infrastructure', detail: 'AWS publishes SOC reports and ISO certifications for in-scope services; these do not certify Schoolpilot' },
      { status: 'planned', label: 'SOC 2 Type II', detail: 'Working toward SOC 2 Type II readiness' },
      { status: 'planned', label: 'Independent privacy reviews', detail: 'Common Sense Privacy and 1EdTech TrustEd Apps submissions planned' },
    ],
  },
];
