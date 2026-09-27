export function schoolSettingsFixture(recipient = null, schoolId = 'school-a') {
  return { schoolId, schoolName: 'Cedar Grove School', schoolTimezone: 'America/New_York', sections: {
    retention: { version: 'retention-1', retentionHours: '720' },
    classroom: { version: 'classroom-1', maxTabsPerStudent: null, allowedDomains: ['wikipedia.org'] },
    monitoring: { version: 'monitoring-1', enableTrackingHours: true, trackingStartTime: '08:00', trackingEndTime: '15:00', trackingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], afterHoursMode: 'off' },
    signIn: { version: 'signIn-1', sharedChromebookSignInEnabled: false },
    email: { version: 'email-1', centralEmailRecipientUserId: recipient },
    blockedWebsites: { policyRevision: 1, blockedDomains: ['games.example'] },
    rosterGrades: { version: 'grades-1', gradeLevels: ['6', '7', '8'] },
  } };
}
