import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { Card } from "../../../components/ui/card";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Monitor, ExternalLink, AlertTriangle, Lock, Unlock, Layers, Maximize2, X, List, RotateCcw, EyeOff, UserRound } from "lucide-react";
import { Checkbox } from "../../../components/ui/checkbox";
import {
  deriveScreenshotDisplay,
  deriveScreenshotHealthDisplay,
  deriveScreenshotPreviewMode,
  deriveStudentMonitoringDisplay,
  deriveUnavailablePreview,
  isExactBoundScreenshot,
  screenshotStaleThresholdMs,
} from "../lib/studentMonitoringDisplay";
import LastSeenTime, { ExpiryCountdown } from "./LastSeenTime";
import { useDecodedScreenshot } from "../hooks/useDecodedScreenshot";
import { deriveTileTabFavicons } from "../lib/tileTabFavicons";
import { normalizedTileControlRevision } from "../lib/tileBatchPolling";
import "./studentTileFrame.css";
import {
  activeTemporaryAllows,
  deriveTabLimitChip,
  studentSupportsCapability,
  studentTileFlightPathReleaseCommand,
  studentTileScreenToggleCommand,
  studentTileTempUnblockCommand,
} from "../lib/dashboardCommandContext";

const EMPTY_LIST = Object.freeze([]);
const SCREENSHOT_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});
const SUPPRESSED_MONITORING_DISPLAY = Object.freeze({
  kind: 'delegated',
  status: 'suppressed',
  label: '',
  telemetryCurrent: false,
  observedAtMs: null,
  nextBoundaryAtMs: null,
});

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function isBlockedDomain(url, blockedDomains) {
  if (!url || blockedDomains.length === 0) return false;

  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    return blockedDomains.some(blocked => {
      const blockedLower = blocked.toLowerCase().trim();

      // Flexible domain matching: check if the blocked domain appears in the hostname
      // This allows ixl.com to match: ixl.com, www.ixl.com, signin.ixl.com, etc.
      return (
        hostname === blockedLower ||                        // Exact match
        hostname.endsWith('.' + blockedLower) ||            // Subdomain
        hostname.includes('.' + blockedLower + '.') ||      // Middle segment
        hostname.startsWith(blockedLower + '.') ||          // Starts with
        hostname.includes(blockedLower)                     // Contains anywhere (most flexible)
      );
    });
  } catch {
    return false;
  }
}

function StudentTile({
  student,
  onOpenDetails,
  blockedDomains = [],
  isOffTask = false,
  isAbsent = false,
  isSelected = false,
  onToggleSelect,
  signOutOnlySelectionAvailable = false,
  persistentRestrictionSelectionAvailable = false,
  liveStream,
  onStartLiveView,
  onStopLiveView,
  onExpandLiveView,
  liveViewPending = false,
  onAllowDomain,
  onManageTabs,
  onCommand,
  commandPending = false,
  commandError = "",
  canLockScreen = true,
  canRemoveFlightPath = true,
  canTempUnblock = false,
  actionsDisabled = false,
  actionsDisabledReason = "",
  nonSignOutCommandsBlocked = false,
  restrictionSelectionActive = false,
  monitoringSuppressed = false,
  monitoringSuppressedReason = "",
  supervisionLabel = "",
  onReturnToClass,
  returnToClassPending = false,
  recentHeartbeats = EMPTY_LIST,
  screenshotData = null,
  onOpenScreenshot,
  flightPaths = EMPTY_LIST,
  monitoringDisplay,
  freshnessNowMs,
  screenshotObservationStatus = 'legacy',
  screenshotAuthorizationDenied = false,
  screenshotRefreshUnavailable = false,
  screenshotUpdating = false,
  screenshotCaptureCadence: negotiatedCaptureCadence = 'background',
  observationActive = false,
}) {
  const videoElementRef = useRef(null);
  const screenshotButtonRef = useRef(null);
  // A wall that actively observes repaints about every 5 seconds, so a preview
  // reads as behind long before the 75-second background threshold. The caller
  // opts in per tile; an unknown observation state keeps the default window.
  const screenshotCaptureCadence = observationActive ? 'active_view' : negotiatedCaptureCadence;
  const effectiveMonitoringDisplay = monitoringSuppressed
    ? SUPPRESSED_MONITORING_DISPLAY
    : monitoringDisplay || deriveStudentMonitoringDisplay(student, freshnessNowMs);
  const currentTelemetry = effectiveMonitoringDisplay.telemetryCurrent;
  const monitoringActionsDisabled = !currentTelemetry;
  const interactionsDisabled = actionsDisabled
    || monitoringSuppressed
    || monitoringActionsDisabled
    || nonSignOutCommandsBlocked
    || restrictionSelectionActive;
  const selectionDisabled = actionsDisabled
    || monitoringSuppressed
    || (
      (monitoringActionsDisabled || nonSignOutCommandsBlocked)
      && !signOutOnlySelectionAvailable
      && !persistentRestrictionSelectionAvailable
    );
  const staleThresholdMs = screenshotStaleThresholdMs(screenshotCaptureCadence);
  const screenshotDisplay = deriveScreenshotDisplay(
    monitoringSuppressed ? null : screenshotData,
    freshnessNowMs,
    { staleThresholdMs },
  );
  const displayStatus = effectiveMonitoringDisplay.status;
  // A pixel stamped with an exact generation is self-authorizing: the server
  // only retains it under the authority that captured it. An unstamped legacy
  // frame carries no such proof, so it keeps every observation-lease gate.
  const screenshotIsExactlyBound = isExactBoundScreenshot(screenshotData);
  const observationAuthorizationRevoked = !screenshotIsExactlyBound && (
    screenshotObservationStatus === 'pending'
    || screenshotObservationStatus === 'denied'
    || screenshotObservationStatus === 'ineligible'
    || screenshotObservationStatus === 'paused_unobserved'
  );
  const screenshotAuthorizationRevoked = monitoringSuppressed
    || ['signed_out', 'delegated'].includes(effectiveMonitoringDisplay.kind)
    || screenshotAuthorizationDenied
    || screenshotObservationStatus === 'ineligible'
    || observationAuthorizationRevoked;
  const liveStreamAuthorizationRevoked = monitoringSuppressed
    || ['signed_out', 'delegated'].includes(effectiveMonitoringDisplay.kind)
    || screenshotAuthorizationDenied
    || screenshotObservationStatus === 'pending'
    || screenshotObservationStatus === 'denied'
    || screenshotObservationStatus === 'ineligible'
    || screenshotObservationStatus === 'paused_unobserved';
  let effectiveScreenshotObservationStatus = screenshotObservationStatus;
  if (screenshotAuthorizationDenied) {
    effectiveScreenshotObservationStatus = 'denied';
  } else if (!screenshotDisplay.available && screenshotRefreshUnavailable) {
    effectiveScreenshotObservationStatus = 'error';
  } else if (screenshotIsExactlyBound) {
    effectiveScreenshotObservationStatus = 'legacy';
  }
  const screenshotPreviewMode = deriveScreenshotPreviewMode({
    screenshotData,
    nowMs: freshnessNowMs,
    authorizationRevoked: screenshotAuthorizationRevoked,
    staleThresholdMs,
  });
  // Pixel identity: student, exact realtime binding, classroom revision and the
  // frame's own binding stamp. Any change fails closed — a frame decoded under
  // a prior binding is dropped, never carried across the swap.
  const screenshotPrivacyKey = [
    student.studentId,
    student.realtimeBinding || '',
    normalizedTileControlRevision(student),
    screenshotData?.bindingVersion || '',
  ].join('\n');
  // Double buffer: the frame on screen is replaced only once its successor has
  // fully decoded, so a 5-second wall never blanks or tears between captures.
  const {
    frame: screenshotFrame,
    previousFrame: previousScreenshotFrame,
    releasePreviousFrame,
    expired: screenshotFrameExpired,
  } = useDecodedScreenshot(
    screenshotPreviewMode ? screenshotData : null,
    screenshotPrivacyKey,
    { crossfade: true },
  );
  // Retention is enforced by the frame itself, on the real clock. Once the hook
  // has expired it there is nothing left to paint, so the preview surface gives
  // way to the unavailable card instead of holding a frozen frame behind an
  // amber "Updating…" badge for as long as `freshnessNowMs` stays behind.
  const displayableScreenshotPreviewMode = screenshotFrameExpired
    ? null
    : screenshotPreviewMode;
  const decodedScreenshotData = screenshotFrame?.screenshotData ?? null;
  const decodedScreenshotDisplay = deriveScreenshotDisplay(decodedScreenshotData, freshnessNowMs, {
    staleThresholdMs,
  });
  const paintedFreshUntilMs = decodedScreenshotDisplay.available
    ? decodedScreenshotDisplay.freshUntilMs
    : null;
  const paintedRetainedUntilMs = decodedScreenshotDisplay.available
    ? decodedScreenshotDisplay.retainedUntilMs
    : null;
  useLayoutEffect(() => {
    const studentId = student.studentId;
    PAINTED_FRAME_BOUNDS.set(studentId, {
      freshUntilMs: paintedFreshUntilMs,
      retainedUntilMs: paintedRetainedUntilMs,
    });
    return () => {
      PAINTED_FRAME_BOUNDS.delete(studentId);
    };
  }, [student.studentId, paintedFreshUntilMs, paintedRetainedUntilMs]);
  // Age cues describe the pixels actually on screen. A replacement that is
  // still decoding — or that failed to decode — can never make older pixels
  // look current.
  const decodedPreviewMode = deriveScreenshotPreviewMode({
    screenshotData: decodedScreenshotData,
    nowMs: freshnessNowMs,
    authorizationRevoked: screenshotAuthorizationRevoked,
    staleThresholdMs,
  });
  const screenshotHealth = monitoringSuppressed
    ? null
    : deriveScreenshotHealthDisplay(student, {
        nowMs: freshnessNowMs,
        cadence: screenshotCaptureCadence,
        screenshotDisplay,
        monitoringDisplay: effectiveMonitoringDisplay,
      });
  const screenshotHealthToneClass = screenshotHealth?.tone === 'warn'
    ? 'bg-amber-400/90 text-slate-950'
    : screenshotHealth?.tone === 'ok'
      ? 'bg-emerald-500/85 text-white'
      : 'bg-white/15 text-white/80';
  // A visible preview already proves capture is working, so nothing is badged
  // over the picture unless something needs attention. The placeholder cards
  // below keep the full label because they have no picture to speak for them.
  const screenshotHealthOverlay = screenshotHealth?.tone === 'warn' ? screenshotHealth : null;
  const screenshotInteractionAvailable = Boolean(
    !monitoringSuppressed
    && displayableScreenshotPreviewMode
    && onOpenScreenshot,
  );
  const screenshotCapturedLabel = decodedScreenshotDisplay.observedAtMs === null
    ? null
    : SCREENSHOT_TIME_FORMATTER.format(new Date(decodedScreenshotDisplay.observedAtMs));
  const unavailablePreview = deriveUnavailablePreview(effectiveMonitoringDisplay);
  const hasLastObservation = Number.isFinite(effectiveMonitoringDisplay.observedAtMs)
    && effectiveMonitoringDisplay.observedAtMs > 0;
  const neverObserved = effectiveMonitoringDisplay.kind === 'signed_out' && !hasLastObservation;
  const supportsScreenOnlyUnlock = studentSupportsCapability(student, 'screenOnlyUnlockV1');
  const unlockLabel = supportsScreenOnlyUnlock
    ? "Clear this student's waypoint (screen only)"
    : "Extension update required for screen-only unlock";
  const activeLiveStream = interactionsDisabled || liveStreamAuthorizationRevoked
    ? null
    : liveStream;
  const unavailableActionReason = actionsDisabledReason
    || (restrictionSelectionActive
      ? 'Clear the signed-out restriction selection before using individual student actions'
      : monitoringActionsDisabled
        ? 'Student actions are disabled while monitoring updates'
        : "Student actions are unavailable in this view");
  const safetyUnlockAvailable = !actionsDisabled
    && !monitoringSuppressed
    && !nonSignOutCommandsBlocked
    && !restrictionSelectionActive
    && monitoringActionsDisabled
    && student.screenLocked
    && supportsScreenOnlyUnlock
    && canLockScreen
    && Boolean(onCommand);

  // The dashboard owns negotiation and the enlarged portal. This tile only
  // renders a preview of the one active stream.
  useEffect(() => {
    const video = videoElementRef.current;
    if (!video) return undefined;
    video.srcObject = activeLiveStream || null;
    return () => {
      if (video.srcObject === activeLiveStream) video.srcObject = null;
    };
  }, [activeLiveStream]);

  // Get unique recent domains (last 5)
  const recentDomains = (monitoringSuppressed ? EMPTY_LIST : recentHeartbeats)
    .slice(0, 10)
    .reduce((acc, hb) => {
      try {
        const urlObj = new URL(hb.activeTabUrl);
        const domain = urlObj.hostname;

        // Only add if we don't already have this domain
        if (!acc.some(item => new URL(item.url).hostname === domain)) {
          acc.push({
            url: hb.activeTabUrl,
            favicon: hb.favicon,
            title: hb.activeTabTitle
          });
        }
      } catch {
        // intentionally empty
      }
      return acc;
    }, [])
    .slice(0, 5);

  // Open-tab favicon strip. Hidden whenever telemetry is not current so a
  // stale snapshot can never be mistaken for what the student has open now.
  const tabFavicons = monitoringSuppressed || !currentTelemetry ? null : deriveTileTabFavicons(student);

  // Check if current URL is blocked by active flight path
  const activeFlightPath = flightPaths.find((fp) => fp.flightPathName === student.activeFlightPathName);
  const isBlockedByFlightPath = currentTelemetry && student.flightPathActive && activeFlightPath && student.activeTabUrl &&
    isBlockedDomain(student.activeTabUrl, activeFlightPath.blockedDomains || []);

  const isBlocked = currentTelemetry && isBlockedDomain(student.activeTabUrl, blockedDomains);
  const effectiveIsAbsent = !monitoringSuppressed && isAbsent;
  const classroomNoiseSuppressed = !monitoringSuppressed
    && Boolean(student.classroomNoiseSuppressed || effectiveIsAbsent || student.suppressionReason);
  const effectiveIsOffTask = currentTelemetry && isOffTask && !classroomNoiseSuppressed;
  const tabLimitChip = currentTelemetry ? deriveTabLimitChip(student) : null;
  const temporaryAllows = currentTelemetry ? activeTemporaryAllows(student, freshnessNowMs) : EMPTY_LIST;

  const getStatusLabel = (status) => {
    if (effectiveIsAbsent) return 'Absent';
    if (effectiveMonitoringDisplay.label) return effectiveMonitoringDisplay.label;
    switch (status) {
      case 'online':
        return 'Online';
      case 'idle':
        return 'Idle';
      case 'offline':
        return 'Offline';
      default:
        return 'Unknown';
    }
  };

  const getBorderStyle = (status) => {
    if (monitoringSuppressed) {
      return 'border-2 border-slate-300 border-dashed dark:border-slate-700';
    }

    if (effectiveIsOffTask) {
      return 'border-2 border-red-500';
    }

    if (isBlocked) {
      return 'border-2 border-destructive';
    }

    switch (status) {
      case 'online':
        return 'border-2 border-green-500/30';
      case 'idle':
        return 'border-2 border-amber-500/30';
      case 'reconnecting':
      case 'updates_unavailable':
      case 'signal_lost':
        return 'border border-amber-500/50';
      case 'offline':
        return 'border border-border/40';
      default:
        return 'border border-border';
    }
  };

  const getShadowStyle = (status) => {
    if (monitoringSuppressed) {
      return 'shadow-sm';
    }

    if (effectiveIsOffTask) {
      return 'shadow-lg shadow-red-100 dark:shadow-red-950/30';
    }

    if (isBlocked) {
      return 'shadow-lg shadow-destructive/10';
    }

    switch (status) {
      case 'online':
        return 'shadow-lg shadow-green-100 dark:shadow-green-950/30';
      case 'idle':
        return 'shadow-lg shadow-amber-100 dark:shadow-amber-950/30';
      case 'offline':
        return 'shadow-md';
      default:
        return 'shadow-md';
    }
  };

  const getOpacity = (status) => {
    if (monitoringSuppressed) return 'opacity-90';
    if (effectiveIsAbsent) return 'opacity-50';
    switch (status) {
      case 'online':
        return 'opacity-100';
      case 'idle':
        return 'opacity-95';
      case 'offline':
        return 'opacity-75';
      default:
        return 'opacity-75';
    }
  };

  return (
    <Card
      data-testid={`card-student-${student.studentId}`}
      className={`${getBorderStyle(displayStatus)} ${getShadowStyle(displayStatus)} ${getOpacity(displayStatus)} ${monitoringSuppressed ? 'bg-slate-50/80 dark:bg-slate-950/40' : screenshotInteractionAvailable ? 'hover-elevate cursor-pointer' : ''} transition-all duration-200 overflow-hidden`}
      onClick={screenshotInteractionAvailable
        ? (event) => {
            const target = event.target;
            if (
              target instanceof Element
              && target.closest('button, a, input, select, textarea, [role="button"], [role="checkbox"]')
            ) {
              return;
            }
            onOpenScreenshot(screenshotButtonRef.current);
          }
        : undefined}
    >
      <div className="p-4 space-y-3">
        {/* Header Zone - Avatar + Student Name + Available Status */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            {onToggleSelect && !monitoringSuppressed && (
              <Checkbox
                checked={isSelected}
                disabled={selectionDisabled}
                onCheckedChange={onToggleSelect}
                onClick={(e) => e.stopPropagation()}
                title={selectionDisabled
                  ? unavailableActionReason
                  : persistentRestrictionSelectionAvailable
                    ? "Select for restrictions that will apply after sign-in"
                    : signOutOnlySelectionAvailable
                      ? "Select for Student Sign Out only"
                      : "Select this student"}
                data-testid={`checkbox-select-student-${student.studentId}`}
              />
            )}
            {/* Avatar with status indicator */}
            <div className="relative flex-shrink-0">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold ${
                displayStatus === 'online'
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                  : displayStatus === 'idle'
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                  : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
              }`}>
                {student.studentName
                  ? student.studentName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
                  : '?'}
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-sm" data-testid={`text-student-name-${student.studentId}`}>
                {student.studentName || (
                  <span className="text-muted-foreground italic">
                    {student.deviceName || 'Unknown'}
                  </span>
                )}
              </h3>
              {(currentTelemetry || effectiveIsAbsent) && (
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium ${
                    displayStatus === 'online'
                      ? 'text-green-600 dark:text-green-400'
                      : displayStatus === 'idle' || displayStatus === 'signal_lost' || displayStatus === 'reconnecting' || displayStatus === 'updates_unavailable'
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-muted-foreground'
                  }`}>
                    {getStatusLabel(displayStatus)}
                  </span>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {!monitoringSuppressed ? <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={(!safetyUnlockAvailable && interactionsDisabled) || !canLockScreen || !onCommand || (student.screenLocked && !supportsScreenOnlyUnlock) || (!currentTelemetry && !student.screenLocked) || commandPending}
              onClick={(e) => {
                e.stopPropagation();
                if (interactionsDisabled && !safetyUnlockAvailable) return;
                const command = studentTileScreenToggleCommand(student);
                if (command) onCommand?.(command);
              }}
              title={safetyUnlockAvailable
                ? unlockLabel
                : interactionsDisabled
                  ? unavailableActionReason
                  : student.screenLocked
                  ? unlockLabel
                  : currentTelemetry
                    ? "Set a waypoint at this student's current screen"
                    : "Current screen unavailable while monitoring signal is lost"}
              data-testid={`button-lock-toggle-${student.studentId}`}
            >
              {student.screenLocked ? (
                <Lock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              ) : (
                <Unlock className="h-4 w-4" />
              )}
            </Button> : null}
          </div>
        </div>

        {monitoringSuppressed && (
          <div className="rounded-md border border-slate-300 bg-white/80 p-3 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200">
            <div className="flex items-center gap-2 font-semibold">
              <Lock className="h-3.5 w-3.5" />
              <span>{supervisionLabel || "In supervision"}</span>
            </div>
            <p className="mt-1 leading-snug text-slate-500 dark:text-slate-400">
              {monitoringSuppressedReason || "This student is currently claimed by another supervision session."}
            </p>
          </div>
        )}

        {commandError && !interactionsDisabled ? (
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200" role="alert">
            {commandError}
          </div>
        ) : null}

        {/* Alert Badges. The row keeps a reserved height whether or not it has
            badges, so a badge appearing or clearing never reflows the tile —
            or, through the grid row, every tile beside it. */}
        {!monitoringSuppressed && (
          <div className="flex flex-col gap-2" data-testid={`badge-row-${student.studentId}`}>
            <div className="flex min-h-[22px] flex-wrap gap-1.5">
              {currentTelemetry && student.aiClassification?.safetyAlert && (
                <Badge variant="outline" className="text-xs px-2 py-0.5 bg-red-100 text-red-900 border-red-400 animate-pulse dark:bg-red-950 dark:text-red-400 dark:border-red-800" data-testid={`badge-safety-${student.studentId}`}>
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Safety Alert: {student.aiClassification.safetyAlert}
                </Badge>
              )}
              {classroomNoiseSuppressed && (
                <Badge variant="outline" className="text-xs px-2 py-0.5 bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-700" data-testid={`badge-context-${student.studentId}`}>
                  {student.suppressionReason || "Classroom noise suppressed"}
                </Badge>
              )}
              {student.flightPathActive && student.activeFlightPathName && !isBlockedByFlightPath && (
                <Badge variant="outline" className="text-xs px-2 py-0.5 bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-800" data-testid={`badge-scene-${student.studentId}`}>
                  <Layers className="h-3 w-3 mr-1" />
                  {student.activeFlightPathName}
                </Badge>
              )}
              {isBlockedByFlightPath && (
                <Badge variant="outline" className="text-xs px-2 py-0.5 bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400 dark:border-red-800" data-testid={`badge-blocked-by-scene-${student.studentId}`}>
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Blocked by {student.activeFlightPathName}
                  <button
                    type="button"
                    className="ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold enabled:hover:bg-red-200 disabled:cursor-not-allowed disabled:opacity-50 dark:enabled:hover:bg-red-800"
                    disabled={interactionsDisabled || !canTempUnblock || !onCommand || commandPending}
                    title={interactionsDisabled ? unavailableActionReason : "Allow this site for 10 minutes"}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (interactionsDisabled) return;
                      const domain = hostnameOf(student.activeTabUrl);
                      const command = studentTileTempUnblockCommand(student, domain);
                      if (command) onCommand?.(command);
                    }}
                    data-testid={`button-allow-temporarily-${student.studentId}`}
                  >
                    Allow 10 min
                  </button>
                </Badge>
              )}
              {effectiveIsOffTask && !isBlockedByFlightPath && (
                <Badge variant="outline" className="text-xs px-2 py-0.5 bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400 dark:border-red-800" data-testid={`badge-offtask-${student.studentId}`}>
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Off-Task
                  {onAllowDomain && (
                    <button
                      className="ml-1.5 rounded-full p-0.5 enabled:hover:bg-red-200 disabled:cursor-not-allowed disabled:opacity-50 dark:enabled:hover:bg-red-800"
                      disabled={interactionsDisabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (interactionsDisabled) return;
                        try {
                          const domain = new URL(student.activeTabUrl).hostname.toLowerCase().replace(/^www\./, '');
                          onAllowDomain(domain);
                        } catch { /* ignore invalid URL */ }
                      }}
                      title={interactionsDisabled ? unavailableActionReason : "Allow this domain for this session"}
                      data-testid={`button-allow-domain-${student.studentId}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </Badge>
              )}
              {isBlocked && !effectiveIsOffTask && !isBlockedByFlightPath && (
                <Badge variant="outline" className="text-xs px-2 py-0.5 bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400 dark:border-red-800" data-testid={`badge-blocked-${student.studentId}`}>
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Blocked Domain
                  <button
                    type="button"
                    className="ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold enabled:hover:bg-red-200 disabled:cursor-not-allowed disabled:opacity-50 dark:enabled:hover:bg-red-800"
                    disabled={interactionsDisabled || !canTempUnblock || !onCommand || commandPending}
                    title={interactionsDisabled ? unavailableActionReason : "Allow this site for 10 minutes"}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (interactionsDisabled) return;
                      const domain = hostnameOf(student.activeTabUrl);
                      const command = studentTileTempUnblockCommand(student, domain);
                      if (command) onCommand?.(command);
                    }}
                    data-testid={`button-allow-temporarily-${student.studentId}`}
                  >
                    Allow 10 min
                  </button>
                </Badge>
              )}
              {tabLimitChip && (
                <Badge
                  variant="outline"
                  className={`text-xs px-2 py-0.5 ${tabLimitChip.over
                    ? 'bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800'
                    : 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-700'}`}
                  title={tabLimitChip.over
                    ? `Over the ${tabLimitChip.tabLimit}-tab limit`
                    : `Tab limit: ${tabLimitChip.tabLimit}`}
                  data-testid={`badge-tab-limit-${student.studentId}`}
                >
                  <List className="h-3 w-3 mr-1" />
                  {tabLimitChip.openTabCount} / {tabLimitChip.tabLimit} tabs
                </Badge>
              )}
              {temporaryAllows.map((allow) => (
                <Badge
                  key={allow.domain}
                  variant="outline"
                  className="text-xs px-2 py-0.5 bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800"
                  title={`${allow.domain} is temporarily allowed for this student`}
                  data-testid={`badge-temp-allow-${student.studentId}`}
                >
                  <Unlock className="h-3 w-3 mr-1" />
                  {allow.domain} allowed
                  <ExpiryCountdown expiresAtMs={allow.expiresAtMs} className="ml-1 font-normal opacity-80" />
                </Badge>
              ))}
            </div>
            {isBlockedByFlightPath && canRemoveFlightPath && (
              <div className="flex gap-2">
                <p className="text-xs text-muted-foreground truncate flex-1">
                  {student.activeTabUrl}
                </p>
                <Button
                  size="sm"
                  variant="default"
                  className="h-7 px-3 text-xs bg-blue-600 hover:bg-blue-700 text-white"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (interactionsDisabled) return;
                    const command = studentTileFlightPathReleaseCommand(student);
                    if (command) onCommand?.(command);
                  }}
                  disabled={interactionsDisabled || !onCommand || commandPending}
                  title={interactionsDisabled ? unavailableActionReason : "Remove this student's active Flight Path"}
                  data-testid={`button-unblock-${student.studentId}`}
                >
                  Remove Flight Path
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Preview Zone - Live View, Screenshot Thumbnail, or Website Preview Card */}
        {monitoringSuppressed ? (
          <div className="flex aspect-video items-center justify-center rounded-lg border border-slate-200 bg-slate-100/80 text-center dark:border-slate-800 dark:bg-slate-900/80">
            <div className="px-4">
              <Lock className="mx-auto mb-2 h-6 w-6 text-slate-400" />
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Controls locked</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Return the student to class to monitor again.</p>
            </div>
          </div>
        ) : activeLiveStream ? (
          <div className="aspect-video rounded-lg bg-black relative overflow-hidden">
            <video
              ref={videoElementRef}
              autoPlay
              muted
              playsInline
              className="h-full w-full rounded-lg object-contain"
              data-testid={`video-live-${student.studentId}`}
            />
          </div>
        ) : displayableScreenshotPreviewMode ? (
          // A same-context preview between 75 and 120 seconds old is visibly
          // dimmed and timestamped so it is never presented as live.
          <button
            ref={screenshotButtonRef}
            type="button"
            className={`classpilot-frame-letterbox block aspect-video w-full rounded-lg relative overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${decodedPreviewMode === 'retained' ? 'ring-1 ring-inset ring-amber-400/50' : ''}`}
            data-testid={displayableScreenshotPreviewMode === 'retained'
              ? `screenshot-retained-${student.studentId}`
              : `screenshot-current-${student.studentId}`}
            aria-label={`Open large screen preview for ${student.studentName || 'student'}`}
            title="Open large automatically refreshed screenshot"
            disabled={!onOpenScreenshot}
            onClick={(event) => {
              event.stopPropagation();
              onOpenScreenshot?.(event.currentTarget);
            }}
          >
            {decodedPreviewMode ? (
              <div className={`absolute inset-0 ${decodedPreviewMode === 'retained' ? 'opacity-55' : ''}`}>
                {/* The outgoing frame stays beneath the incoming one for the
                    length of the fade, so a swap never exposes the letterbox. */}
                {previousScreenshotFrame ? (
                  <img
                    key={previousScreenshotFrame.sequence}
                    src={previousScreenshotFrame.src}
                    alt=""
                    aria-hidden="true"
                    className="absolute inset-0 h-full w-full object-contain"
                    data-testid={`screenshot-previous-${student.studentId}`}
                  />
                ) : null}
                <img
                  key={screenshotFrame.sequence}
                  src={screenshotFrame.src}
                  alt={`Latest screen preview for ${student.studentName || 'student'}`}
                  className="classpilot-frame-in absolute inset-0 h-full w-full object-contain"
                  decoding="async"
                  onAnimationEnd={releasePreviousFrame}
                  data-testid={`screenshot-${student.studentId}`}
                />
              </div>
            ) : null}
            {decodedPreviewMode === 'retained' ? (
              <div className="absolute left-2 top-2 rounded-md bg-amber-400 px-2 py-1 text-[11px] font-semibold text-slate-950 shadow" data-testid={`screenshot-updating-${student.studentId}`}>
                Updating…{screenshotCapturedLabel ? ` · Captured ${screenshotCapturedLabel}` : ''}
              </div>
            ) : null}
            {!currentTelemetry ? (
              <div
                className={`absolute right-2 rounded-md bg-amber-400 px-2 py-1 text-[11px] font-semibold text-slate-950 shadow ${decodedPreviewMode === 'retained' ? 'top-10' : 'top-2'}`}
                data-testid={`screenshot-monitoring-warning-${student.studentId}`}
              >
                {unavailablePreview.reason}
              </div>
            ) : null}
            {decodedScreenshotData ? (
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2">
                <div className="flex items-center gap-1.5">
                  {decodedScreenshotData.tabFavicon && (
                    <img
                      src={decodedScreenshotData.tabFavicon}
                      alt=""
                      className="w-3 h-3 flex-shrink-0 rounded"
                      loading="lazy"
                      decoding="async"
                      onError={(e) => {
                        e.target.style.display = 'none';
                      }}
                    />
                  )}
                  <span className="text-xs text-white/90 truncate font-medium">
                    {decodedScreenshotData.tabTitle || 'No active tab'}
                  </span>
                  {screenshotHealthOverlay ? (
                    <span
                      className={`ml-auto flex-shrink-0 rounded px-1 py-px text-[10px] font-medium ${screenshotHealthToneClass}`}
                      data-testid={`screenshot-health-${student.studentId}`}
                    >
                      {screenshotHealthOverlay.label}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </button>
        ) : screenshotUpdating ? (
          <div className="flex aspect-video items-center justify-center rounded-lg border border-sky-200 bg-sky-50/70 text-center dark:border-sky-900 dark:bg-sky-950/20" data-testid={`screenshot-updating-authority-${student.studentId}`}>
            <div className="px-4">
              <Monitor className="mx-auto mb-2 h-6 w-6 text-sky-600 dark:text-sky-400" />
              <p className="text-sm font-semibold text-foreground">Updating preview</p>
              <p className="mt-1 text-xs text-muted-foreground">The student remains connected while a preview for the new classroom state arrives.</p>
            </div>
          </div>
        ) : !currentTelemetry ? (
          <div
            className={`flex aspect-video items-center justify-center rounded-lg border text-center ${unavailablePreview.warning ? 'border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/20' : 'border-border bg-muted/30'}`}
            data-testid={`preview-unavailable-${student.studentId}`}
          >
            <div className="px-4">
              <Monitor className={`mx-auto mb-2 h-6 w-6 ${unavailablePreview.warning ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`} />
              <p
                className="text-sm font-semibold text-foreground"
                data-testid={`text-unavailable-status-${student.studentId}`}
              >
                {unavailablePreview.reason}
              </p>
              {unavailablePreview.showLastObservation && hasLastObservation && (
                <LastSeenTime
                  observedAt={effectiveMonitoringDisplay.observedAtMs}
                  className="mt-2 block text-[11px] text-muted-foreground"
                />
              )}
              {neverObserved && (
                <span className="mt-2 block text-[11px] text-muted-foreground">
                  Never observed
                </span>
              )}
            </div>
          </div>
        ) : effectiveScreenshotObservationStatus === 'pending' ? (
          <div className="flex aspect-video items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-center dark:border-slate-800 dark:bg-slate-950/40" data-testid={`screenshot-observation-pending-${student.studentId}`}>
            <div className="px-4">
              <Monitor className="mx-auto mb-2 h-6 w-6 text-slate-500" />
              <p className="text-sm font-semibold text-foreground">Authorizing screen preview…</p>
              <p className="mt-1 text-xs text-muted-foreground">Monitoring activity remains available while this view is verified.</p>
            </div>
          </div>
        ) : effectiveScreenshotObservationStatus === 'denied' ? (
          <div className="flex aspect-video items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-center dark:border-slate-800 dark:bg-slate-950/40" data-testid={`screenshot-observation-denied-${student.studentId}`}>
            <div className="px-4">
              <EyeOff className="mx-auto mb-2 h-6 w-6 text-slate-500" />
              <p className="text-sm font-semibold text-foreground">Screen preview unavailable</p>
              <p className="mt-1 text-xs text-muted-foreground">Screen observation is not authorized in this view.</p>
            </div>
          </div>
        ) : effectiveScreenshotObservationStatus === 'paused_unobserved' ? (
          <div className="flex aspect-video items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-center dark:border-slate-800 dark:bg-slate-950/40" data-testid={`screenshot-paused-${student.studentId}`}>
            <div className="px-4">
              <EyeOff className="mx-auto mb-2 h-6 w-6 text-slate-500" />
              <p className="text-sm font-semibold text-foreground">Screenshots paused</p>
              <p className="mt-1 text-xs text-muted-foreground">This class view is not actively observed. Website activity remains available.</p>
            </div>
          </div>
        ) : effectiveScreenshotObservationStatus === 'error' ? (
          <div className="flex aspect-video items-center justify-center rounded-lg border border-amber-200 bg-amber-50/70 text-center dark:border-amber-900 dark:bg-amber-950/20" data-testid={`screenshot-observation-error-${student.studentId}`}>
            <div className="px-4">
              <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-amber-600 dark:text-amber-400" />
              <p className="text-sm font-semibold text-foreground">Screenshot observation unavailable</p>
              <p className="mt-1 text-xs text-muted-foreground">Activity reporting continues from heartbeat telemetry.</p>
              {screenshotHealth ? (
                <p className="mt-2 text-[11px] font-medium text-amber-700 dark:text-amber-300" data-testid={`screenshot-health-${student.studentId}`}>
                  {screenshotHealth.label}
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          // Every preview branch occupies the same aspect-video box, so a tile
          // never changes height as it moves between live, stale and error
          // states — the site read-out is stacked inside the box, not below it.
          <div className="flex aspect-video flex-col overflow-hidden rounded-lg border border-border/40 bg-muted/30" data-testid={`screenshot-stale-${student.studentId}`}>
            <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/20 text-center">
              <div className="px-4">
                <Monitor className="mx-auto mb-2 h-6 w-6 text-muted-foreground/60" />
                <p className="text-sm font-semibold text-foreground">Screenshot unavailable or stale</p>
                <p className="mt-1 text-xs text-muted-foreground">Current website telemetry remains available below.</p>
                {screenshotHealth ? (
                  <p
                    className={`mt-2 text-[11px] font-medium ${screenshotHealth.tone === 'warn' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`}
                    data-testid={`screenshot-health-${student.studentId}`}
                  >
                    {screenshotHealth.label}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="flex flex-shrink-0 items-center gap-2 px-3 py-1.5 bg-muted/60 border-t border-border/30">
              {student.favicon ? (
                <img
                  src={student.favicon}
                  alt=""
                  className="w-4 h-4 flex-shrink-0 rounded"
                  onError={(e) => {
                    e.target.style.display = 'none';
                  }}
                />
              ) : (
                <div className="w-4 h-4 rounded bg-muted-foreground/20 flex items-center justify-center">
                  <ExternalLink className="w-2.5 h-2.5 text-muted-foreground/50" />
                </div>
              )}
              <span className="text-xs text-muted-foreground truncate flex-1 font-mono" data-testid={`text-tab-url-${student.studentId}`}>
                {student.activeTabUrl ? (() => { try { return new URL(student.activeTabUrl).hostname; } catch { return student.activeTabUrl; } })() : 'No tab'}
              </span>
            </div>
            <div className="flex-shrink-0 border-t border-border/20 bg-muted/40 px-3 py-1.5">
              <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Current site</p>
              <p className="font-medium text-sm leading-snug line-clamp-2" data-testid={`text-tab-title-${student.studentId}`}>
                {student.activeTabTitle || <span className="text-muted-foreground italic">No active tab</span>}
              </p>
            </div>
          </div>
        )}

        {/* Open Tab Favicons */}
        {tabFavicons && tabFavicons.tabs.length > 0 && (
          <div className="flex items-center gap-1.5 px-1 py-1.5 border-t border-border/20" data-testid={`tab-favicons-${student.studentId}`}>
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Open</span>
            <div className="flex items-center gap-1 flex-1 overflow-x-auto">
              {tabFavicons.tabs.map((tab, index) => (
                <span
                  key={tab.key}
                  className={`flex-shrink-0 w-5 h-5 rounded bg-muted/50 flex items-center justify-center border ${tab.active ? 'border-primary/70 ring-1 ring-primary/60' : 'border-border/20'}`}
                  title={`${tab.title} · ${tab.hostname}`}
                  data-testid={`tab-favicon-${student.studentId}-${index}`}
                >
                  {tab.favicon ? (
                    <img
                      src={tab.favicon}
                      alt=""
                      className="w-3.5 h-3.5 rounded"
                      referrerPolicy="no-referrer"
                      loading="lazy"
                      decoding="async"
                      onError={(e) => {
                        e.target.style.display = 'none';
                      }}
                    />
                  ) : (
                    <div className="w-2 h-2 rounded-full bg-muted-foreground/30" />
                  )}
                </span>
              ))}
              {tabFavicons.overflow > 0 && (
                <button
                  type="button"
                  className="flex-shrink-0 h-5 rounded border border-border/20 bg-muted/50 px-1.5 text-[10px] font-medium text-muted-foreground enabled:hover:bg-muted disabled:cursor-default"
                  title={onManageTabs && !interactionsDisabled
                    ? `${tabFavicons.totalCount} open tabs · View this student's open tabs`
                    : `${tabFavicons.totalCount} open tabs`}
                  disabled={!onManageTabs || interactionsDisabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    onManageTabs?.();
                  }}
                  data-testid={`button-tab-favicons-more-${student.studentId}`}
                >
                  +{tabFavicons.overflow}{tabFavicons.truncated ? '…' : ''}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Mini History Icons */}
        {recentDomains.length > 0 && (
          <div className="flex items-center gap-1.5 px-1 py-1.5 border-t border-border/20">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Recent</span>
            <div className="flex items-center gap-1 flex-1 overflow-x-auto">
              {recentDomains.map((domain, idx) => (
                <div
                  key={idx}
                  className="flex-shrink-0 w-5 h-5 rounded bg-muted/50 flex items-center justify-center border border-border/20"
                  title={domain.title}
                >
                  {domain.favicon ? (
                    <img
                      src={domain.favicon}
                      alt=""
                      className="w-3.5 h-3.5 rounded"
                      loading="lazy"
                      decoding="async"
                      onError={(e) => {
                        e.target.style.display = 'none';
                      }}
                    />
                  ) : (
                    <div className="w-2 h-2 rounded-full bg-muted-foreground/30" />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer Zone - Actions Only */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/20">
          {onOpenDetails && !monitoringSuppressed && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={(event) => {
                event.stopPropagation();
                onOpenDetails(event.currentTarget);
              }}
              title={`Open details and activity for ${student.studentName || 'student'}`}
              aria-label={`Open details and activity for ${student.studentName || 'student'}`}
              data-testid={`button-student-details-${student.studentId}`}
            >
              <UserRound className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              Details
            </Button>
          )}
          {monitoringSuppressed && onReturnToClass && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs border-amber-300 bg-amber-50 text-slate-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100"
              disabled={returnToClassPending}
              onClick={(e) => {
                e.stopPropagation();
                onReturnToClass();
              }}
              title="Release this student from supervision and return them to your active class"
              data-testid={`button-return-to-class-${student.studentId}`}
            >
              <RotateCcw className="h-3.5 w-3.5 mr-1" />
              Return to Class
            </Button>
          )}
          {onManageTabs && !interactionsDisabled && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                onManageTabs();
              }}
              title="View this student's open tabs"
              data-testid={`button-manage-tabs-${student.studentId}`}
            >
              <List className="h-3.5 w-3.5 mr-1" />
              View Tabs
            </Button>
          )}
          {onStartLiveView && onStopLiveView && !interactionsDisabled && (
            <Button
              variant={activeLiveStream ? "default" : "outline"}
              size="sm"
              className="h-7 px-3 text-xs"
              disabled={liveViewPending}
              onClick={(e) => {
                e.stopPropagation();
                if (activeLiveStream) {
                  onStopLiveView();
                } else {
                  onStartLiveView();
                }
              }}
              title={liveViewPending ? "Waiting for live view to connect" : activeLiveStream ? "Stop live view" : "Start live view"}
              data-testid={`button-live-view-${student.studentId}`}
            >
              <Monitor className="h-3.5 w-3.5 mr-1" />
              {liveViewPending ? "Connecting" : activeLiveStream ? "Stop" : "View"}
            </Button>
          )}
          {activeLiveStream && onExpandLiveView && !interactionsDisabled && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                onExpandLiveView();
              }}
              title="Expand to full screen with zoom and screenshot controls"
              data-testid={`button-expand-${student.studentId}`}
            >
              <Maximize2 className="h-3.5 w-3.5 mr-1" />
              Expand
            </Button>
          )}
        </div>
      </div>

    </Card>
  );
}

const CALLBACK_PROPS = new Set([
  'onOpenDetails',
  'onToggleSelect',
  'onStartLiveView',
  'onStopLiveView',
  'onExpandLiveView',
  'onAllowDomain',
  'onManageTabs',
  'onOpenScreenshot',
  'onCommand',
  'onReturnToClass',
]);

// A tile paints the DECODED frame, which can lag or diverge from the props
// frame (a decode still in flight, or a decode that failed). The comparator
// sees only props, so each mounted tile publishes the display bounds — instants
// only, never pixels — of the frame it actually painted. Projecting those
// forward is what turns a tile over when ITS frame ages, instead of holding the
// last painted DOM, amber "Updating…" badge included, for as long as the props
// frame's own projection happens to sit still.
const PAINTED_FRAME_BOUNDS = new Map();

function paintedFrameProjection(props, nowMs) {
  const bounds = PAINTED_FRAME_BOUNDS.get(props.student?.studentId);
  if (!bounds) return 'none';
  const fresh = bounds.freshUntilMs !== null && nowMs < bounds.freshUntilMs;
  const retained = bounds.retainedUntilMs !== null && nowMs < bounds.retainedUntilMs;
  return `${fresh}:${retained}`;
}

function freshnessProjection(props) {
  const nowMs = Number.isFinite(props.freshnessNowMs) ? props.freshnessNowMs : Date.now();
  const monitoring = props.monitoringDisplay
    || deriveStudentMonitoringDisplay(props.student, props.freshnessNowMs);
  // An observed wall ages previews at the active-view boundary. Project that
  // boundary too, or memo would hold a tile past the point its amber cue is due.
  const screenshot = props.observationActive
    ? deriveScreenshotDisplay(props.screenshotData, props.freshnessNowMs, {
      staleThresholdMs: screenshotStaleThresholdMs('active_view'),
    })
    : deriveScreenshotDisplay(props.screenshotData, props.freshnessNowMs, {
      staleThresholdMs: screenshotStaleThresholdMs(props.screenshotCaptureCadence),
    });
  return `${monitoring.kind}:${monitoring.status}:${monitoring.telemetryCurrent}:${screenshot.fresh}:${screenshot.retained}:${paintedFrameProjection(props, nowMs)}`;
}

function studentTilePropsEqual(previous, next) {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if (CALLBACK_PROPS.has(key)) {
      // Callback identities change as dashboard state is projected into each
      // tile, but callback availability is authorization/UI state. A function
      // becoming undefined must remove its action immediately.
      if (Boolean(previous[key]) !== Boolean(next[key])) return false;
      continue;
    }
    if (key === 'freshnessNowMs' || key === 'monitoringDisplay') continue;
    if (!Object.is(previous[key], next[key])) return false;
  }
  return freshnessProjection(previous) === freshnessProjection(next);
}

export default memo(StudentTile, studentTilePropsEqual);
