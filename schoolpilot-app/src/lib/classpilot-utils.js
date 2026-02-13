/**
 * Shared utility functions ported from ClassPilot (shared/utils.ts).
 * TypeScript types stripped; logic preserved identically.
 */

/**
 * Check if the current time is within tracking hours and days, using the school's timezone.
 * This ensures consistent enforcement across client and server regardless of where they're hosted.
 *
 * @param {boolean|null|undefined} enableTrackingHours - Whether tracking hours feature is enabled
 * @param {string|null|undefined} trackingStartTime - Start time in HH:MM format (e.g., "08:00")
 * @param {string|null|undefined} trackingEndTime - End time in HH:MM format (e.g., "15:00")
 * @param {string|null|undefined} schoolTimezone - School timezone in IANA format (e.g., "America/New_York")
 * @param {string[]|null|undefined} trackingDays - Array of day names when tracking is active
 * @returns {boolean} true if currently within tracking hours AND days (or if feature disabled)
 */
export function isWithinTrackingHours(
  enableTrackingHours,
  trackingStartTime,
  trackingEndTime,
  schoolTimezone,
  trackingDays
) {
  // If tracking hours not enabled, always allow tracking
  if (!enableTrackingHours) {
    return true;
  }

  // Defaults
  const startTime = trackingStartTime || "00:00";
  const endTime = trackingEndTime || "23:59";
  const timezone = schoolTimezone || "America/New_York";
  const activeDays = trackingDays || ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

  try {
    const now = new Date();

    // Get current day of week in school's timezone
    const schoolDayName = now.toLocaleString("en-US", {
      timeZone: timezone,
      weekday: 'long'
    });

    // Check if current day is in the list of tracking days
    if (!activeDays.includes(schoolDayName)) {
      return false;
    }

    // Get current time in school's timezone
    const schoolTimeString = now.toLocaleString("en-US", {
      timeZone: timezone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    });

    // Extract HH:MM from the formatted string
    const currentTime = schoolTimeString.split(', ')[1] || schoolTimeString;

    // Compare times as strings (HH:MM format)
    return currentTime >= startTime && currentTime <= endTime;
  } catch (error) {
    console.error("Error checking tracking hours:", error);
    // On error, default to allowing tracking (fail open for usability)
    return true;
  }
}

/**
 * Calculate time spent on each URL from heartbeat data.
 * Groups consecutive heartbeats for the same URL and calculates duration.
 *
 * @param {Array} heartbeats - Array of heartbeat records (will be sorted by timestamp)
 * @param {number} heartbeatIntervalSeconds - Expected interval between heartbeats (default: 10)
 * @returns {Array} Array of URL sessions with duration information
 */
export function calculateURLSessions(heartbeats, heartbeatIntervalSeconds = 10) {
  if (heartbeats.length === 0) return [];

  // Sort by timestamp (oldest first)
  const sorted = [...heartbeats].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const sessions = [];
  let currentSession = null;

  for (let i = 0; i < sorted.length; i++) {
    const heartbeat = sorted[i];
    const currentTime = new Date(heartbeat.timestamp);
    const currentUrl = heartbeat.activeTabUrl ?? "unknown";

    if (!currentSession || currentSession.url !== currentUrl) {
      // Start new session
      if (currentSession) {
        sessions.push(currentSession);
      }

      currentSession = {
        url: currentUrl,
        title: heartbeat.activeTabTitle ?? "Unknown",
        favicon: heartbeat.favicon || undefined,
        startTime: currentTime,
        endTime: currentTime,
        durationSeconds: heartbeatIntervalSeconds, // Initial duration
        heartbeatCount: 1,
      };
    } else {
      // Continue existing session
      currentSession.endTime = currentTime;
      currentSession.heartbeatCount++;

      // Update title/favicon to most recent
      currentSession.title = heartbeat.activeTabTitle;
      if (heartbeat.favicon) {
        currentSession.favicon = heartbeat.favicon;
      }

      // Calculate duration: time span + one interval for the final heartbeat
      const timeSpanSeconds = Math.floor(
        (currentTime.getTime() - currentSession.startTime.getTime()) / 1000
      );
      currentSession.durationSeconds = timeSpanSeconds + heartbeatIntervalSeconds;
    }
  }

  // Add the last session
  if (currentSession) {
    sessions.push(currentSession);
  }

  return sessions;
}

/**
 * Format duration in seconds to human-readable format
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted string like "5m 30s" or "1h 15m"
 */
export function formatDuration(seconds) {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 && hours === 0) parts.push(`${secs}s`); // Only show seconds if less than 1 hour

  return parts.join(' ');
}

/**
 * Check if a URL is on the allowed domains list (flexible matching)
 * @param {string|null|undefined} url - The URL to check
 * @param {string[]} allowedDomains - Array of allowed domain strings
 * @returns {boolean} true if URL is allowed, false otherwise
 */
export function isUrlAllowed(url, allowedDomains) {
  if (!url) return false;
  if (!allowedDomains || allowedDomains.length === 0) return true; // No restrictions = all allowed

  try {
    const hostname = new URL(url).hostname.toLowerCase();

    // Check if URL is on any allowed domain (flexible matching)
    return allowedDomains.some(allowed => {
      const allowedLower = allowed.toLowerCase().trim();

      // Flexible domain matching: check if the allowed domain appears in the hostname
      // This allows ixl.com to match: ixl.com, www.ixl.com, signin.ixl.com, etc.
      return (
        hostname === allowedLower ||                        // Exact match: ixl.com
        hostname.endsWith('.' + allowedLower) ||            // Subdomain: www.ixl.com
        hostname.includes('.' + allowedLower + '.') ||      // Middle segment: sub.ixl.com.au
        hostname.startsWith(allowedLower + '.') ||          // Starts with: ixl.com.au
        hostname.includes(allowedLower)                     // Contains anywhere (most flexible)
      );
    });
  } catch {
    return false;
  }
}

/**
 * Check if a session is off-task based on camera usage and allowed domains
 * @param {string|null|undefined} url - The URL being visited
 * @param {boolean} cameraActive - Whether camera is active
 * @param {string[]} allowedDomains - Array of allowed domain strings
 * @returns {boolean} true if off-task, false otherwise
 */
export function isSessionOffTask(url, cameraActive, allowedDomains) {
  // Camera active = always off-task
  if (cameraActive) return true;

  // No allowed domains configured = nothing is off-task
  if (!allowedDomains || allowedDomains.length === 0) return false;

  // Not on allowed domain = off-task
  return !isUrlAllowed(url, allowedDomains);
}

/**
 * Group heartbeats by device and calculate URL sessions per device.
 * @param {Array} heartbeats - Array of heartbeat records
 * @returns {Map} Map of deviceId to array of URL sessions
 */
export function groupSessionsByDevice(heartbeats) {
  const deviceHeartbeats = new Map();

  // Group heartbeats by device
  for (const heartbeat of heartbeats) {
    if (!deviceHeartbeats.has(heartbeat.deviceId)) {
      deviceHeartbeats.set(heartbeat.deviceId, []);
    }
    deviceHeartbeats.get(heartbeat.deviceId).push(heartbeat);
  }

  // Calculate sessions for each device
  const deviceSessions = new Map();
  Array.from(deviceHeartbeats.entries()).forEach(([deviceId, beats]) => {
    deviceSessions.set(deviceId, calculateURLSessions(beats));
  });

  return deviceSessions;
}

/**
 * Determine whether tracking is allowed based on school hours and after-hours mode.
 * Fails closed when tracking hours are enabled but schedule values are missing.
 * @param {Object} settings - Tracking schedule settings
 * @returns {boolean}
 */
export function isTrackingAllowedNow(settings) {
  if (!settings.enableTrackingHours) {
    return true;
  }

  const hasSchedule =
    Boolean(settings.trackingStartTime)
    && Boolean(settings.trackingEndTime)
    && Boolean(settings.schoolTimezone)
    && Array.isArray(settings.trackingDays)
    && settings.trackingDays.length > 0;

  if (!hasSchedule) {
    return settings.afterHoursMode !== "off";
  }

  const within = isWithinTrackingHours(
    settings.enableTrackingHours,
    settings.trackingStartTime,
    settings.trackingEndTime,
    settings.schoolTimezone,
    settings.trackingDays
  );

  if (within) {
    return true;
  }

  return settings.afterHoursMode !== "off";
}

/**
 * Check if tracking is allowed based on Super Admin configured school hours.
 * This is the school-level tracking window configured by Super Admin.
 * @param {Object} school - School configuration with tracking hours
 * @returns {boolean} true if currently within tracking window (or if 24/7 enabled)
 */
export function isSchoolTrackingAllowed(school) {
  // If 24/7 monitoring is enabled, always allow tracking
  if (school.is24HourEnabled) {
    return true;
  }

  const timezone = school.schoolTimezone || "America/New_York";
  const startHour = school.trackingStartHour ?? 7; // Default 7 AM
  const endHour = school.trackingEndHour ?? 17; // Default 5 PM

  try {
    const now = new Date();

    // Get current hour in school's timezone
    const schoolHour = parseInt(
      now.toLocaleString("en-US", {
        timeZone: timezone,
        hour12: false,
        hour: '2-digit'
      }),
      10
    );

    // Check if current hour is within the tracking window
    return schoolHour >= startHour && schoolHour < endHour;
  } catch (error) {
    console.error("Error checking school tracking hours:", error);
    // On error, default to allowing tracking (fail open for usability)
    return true;
  }
}
