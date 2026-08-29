import { memo, useEffect, useRef } from "react";
import { Card } from "../../../components/ui/card";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Monitor, ExternalLink, AlertTriangle, Lock, Unlock, Layers, Maximize2, X, List, RotateCcw, EyeOff } from "lucide-react";
import { Checkbox } from "../../../components/ui/checkbox";
import {
  deriveScreenshotDisplay,
  deriveScreenshotPreviewMode,
  deriveStudentMonitoringDisplay,
  deriveUnavailablePreview,
  isClassBoundScreenshot,
} from "../lib/studentMonitoringDisplay";
import LastSeenTime from "./LastSeenTime";
import {
  studentSupportsCapability,
  studentTileFlightPathReleaseCommand,
  studentTileScreenToggleCommand,
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
  onClick,
  blockedDomains = [],
  isOffTask = false,
  isAbsent = false,
  isSelected = false,
  onToggleSelect,
  signOutOnlySelectionAvailable = false,
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
  actionsDisabled = false,
  actionsDisabledReason = "",
  nonSignOutCommandsBlocked = false,
  monitoringSuppressed = false,
  monitoringSuppressedReason = "",
  supervisionLabel = "",
  onReturnToClass,
  returnToClassPending = false,
  recentHeartbeats = EMPTY_LIST,
  screenshotData = null,
  flightPaths = EMPTY_LIST,
  monitoringDisplay,
  freshnessNowMs,
  screenshotObservationStatus = 'legacy',
  screenshotAuthorizationDenied = false,
  screenshotRefreshUnavailable = false,
}) {
  const videoElementRef = useRef(null);
  const effectiveMonitoringDisplay = monitoringSuppressed
    ? SUPPRESSED_MONITORING_DISPLAY
    : monitoringDisplay || deriveStudentMonitoringDisplay(student, freshnessNowMs);
  const currentTelemetry = effectiveMonitoringDisplay.telemetryCurrent;
  const monitoringActionsDisabled = !currentTelemetry;
  const interactionsDisabled = actionsDisabled
    || monitoringSuppressed
    || monitoringActionsDisabled
    || nonSignOutCommandsBlocked;
  const selectionDisabled = actionsDisabled
    || monitoringSuppressed
    || ((monitoringActionsDisabled || nonSignOutCommandsBlocked) && !signOutOnlySelectionAvailable);
  const screenshotDisplay = deriveScreenshotDisplay(
    monitoringSuppressed ? null : screenshotData,
    freshnessNowMs,
  );
  const displayStatus = effectiveMonitoringDisplay.status;
  const screenshotIsClassBound = isClassBoundScreenshot(screenshotData);
  const observationAuthorizationRevoked = !screenshotIsClassBound && (
    screenshotObservationStatus === 'pending'
    || screenshotObservationStatus === 'denied'
    || screenshotObservationStatus === 'paused_unobserved'
  );
  const screenshotAuthorizationRevoked = monitoringSuppressed
    || ['signed_out', 'delegated'].includes(effectiveMonitoringDisplay.kind)
    || screenshotAuthorizationDenied
    || observationAuthorizationRevoked;
  const liveStreamAuthorizationRevoked = monitoringSuppressed
    || ['signed_out', 'delegated'].includes(effectiveMonitoringDisplay.kind)
    || screenshotAuthorizationDenied
    || screenshotObservationStatus === 'pending'
    || screenshotObservationStatus === 'denied'
    || screenshotObservationStatus === 'paused_unobserved';
  let effectiveScreenshotObservationStatus = screenshotObservationStatus;
  if (screenshotAuthorizationDenied) {
    effectiveScreenshotObservationStatus = 'denied';
  } else if (!screenshotDisplay.available && screenshotRefreshUnavailable) {
    effectiveScreenshotObservationStatus = 'error';
  } else if (screenshotIsClassBound) {
    effectiveScreenshotObservationStatus = 'legacy';
  }
  const screenshotPreviewMode = deriveScreenshotPreviewMode({
    screenshotData,
    nowMs: freshnessNowMs,
    authorizationRevoked: screenshotAuthorizationRevoked,
  });
  const screenshotCapturedLabel = screenshotDisplay.observedAtMs === null
    ? null
    : SCREENSHOT_TIME_FORMATTER.format(new Date(screenshotDisplay.observedAtMs));
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
    || (monitoringActionsDisabled
      ? 'Student actions are disabled while monitoring updates'
      : "Student actions are unavailable in this view");
  const safetyUnlockAvailable = !actionsDisabled
    && !monitoringSuppressed
    && !nonSignOutCommandsBlocked
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

  // Check if current URL is blocked by active flight path
  const activeFlightPath = flightPaths.find((fp) => fp.flightPathName === student.activeFlightPathName);
  const isBlockedByFlightPath = currentTelemetry && student.flightPathActive && activeFlightPath && student.activeTabUrl &&
    isBlockedDomain(student.activeTabUrl, activeFlightPath.blockedDomains || []);

  const isBlocked = currentTelemetry && isBlockedDomain(student.activeTabUrl, blockedDomains);
  const effectiveIsAbsent = !monitoringSuppressed && isAbsent;
  const classroomNoiseSuppressed = !monitoringSuppressed
    && Boolean(student.classroomNoiseSuppressed || effectiveIsAbsent || student.suppressionReason);
  const effectiveIsOffTask = currentTelemetry && isOffTask && !classroomNoiseSuppressed;

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
      className={`${getBorderStyle(displayStatus)} ${getShadowStyle(displayStatus)} ${getOpacity(displayStatus)} ${monitoringSuppressed ? 'bg-slate-50/80 dark:bg-slate-950/40' : 'hover-elevate cursor-pointer'} transition-all duration-200 overflow-hidden`}
      onClick={monitoringSuppressed ? undefined : onClick}
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

        {/* Alert Badges */}
        {!monitoringSuppressed && (effectiveIsOffTask || isBlocked || isBlockedByFlightPath || student.flightPathActive || (currentTelemetry && student.aiClassification?.safetyAlert) || classroomNoiseSuppressed) && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
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
                </Badge>
              )}
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
        ) : screenshotPreviewMode ? (
          // A same-context preview between 75 and 120 seconds old is visibly
          // dimmed and timestamped so it is never presented as live.
          <div
            className={`aspect-video rounded-lg bg-muted/40 relative overflow-hidden ${screenshotPreviewMode === 'retained' ? 'ring-1 ring-inset ring-amber-400/50' : ''}`}
            data-testid={screenshotPreviewMode === 'retained'
              ? `screenshot-retained-${student.studentId}`
              : `screenshot-current-${student.studentId}`}
          >
            <img
              src={screenshotData.screenshot}
              alt={`${student.studentName || 'Student'}'s screen`}
              className={`w-full h-full object-cover ${screenshotPreviewMode === 'retained' ? 'opacity-55' : ''}`}
              loading="lazy"
              decoding="async"
              data-testid={`screenshot-${student.studentId}`}
            />
            {screenshotPreviewMode === 'retained' ? (
              <div className="absolute left-2 top-2 rounded-md bg-amber-400 px-2 py-1 text-[11px] font-semibold text-slate-950 shadow" data-testid={`screenshot-updating-${student.studentId}`}>
                Updating…{screenshotCapturedLabel ? ` · Captured ${screenshotCapturedLabel}` : ''}
              </div>
            ) : null}
            {!currentTelemetry ? (
              <div
                className={`absolute right-2 rounded-md bg-amber-400 px-2 py-1 text-[11px] font-semibold text-slate-950 shadow ${screenshotPreviewMode === 'retained' ? 'top-10' : 'top-2'}`}
                data-testid={`screenshot-monitoring-warning-${student.studentId}`}
              >
                {unavailablePreview.reason}
              </div>
            ) : null}
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2">
              <div className="flex items-center gap-1.5">
                {screenshotData.tabFavicon && (
                  <img
                    src={screenshotData.tabFavicon}
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
                  {screenshotData.tabTitle || 'No active tab'}
                </span>
              </div>
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
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-border/40 bg-muted/30 overflow-hidden" data-testid={`screenshot-stale-${student.studentId}`}>
            <div className="flex aspect-video items-center justify-center bg-muted/20 text-center">
              <div className="px-4">
                <Monitor className="mx-auto mb-2 h-6 w-6 text-muted-foreground/60" />
                <p className="text-sm font-semibold text-foreground">Screenshot unavailable or stale</p>
                <p className="mt-1 text-xs text-muted-foreground">Current website telemetry remains available below.</p>
              </div>
            </div>
            <div className="flex items-center gap-2 px-3 py-2 bg-muted/60 border-t border-border/30">
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
            <div className="p-3 min-h-[60px]">
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Current site</p>
              <p className="font-medium text-sm leading-snug line-clamp-2" data-testid={`text-tab-title-${student.studentId}`}>
                {student.activeTabTitle || <span className="text-muted-foreground italic">No active tab</span>}
              </p>
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
  'onClick',
  'onToggleSelect',
  'onStartLiveView',
  'onStopLiveView',
  'onExpandLiveView',
  'onAllowDomain',
  'onManageTabs',
  'onCommand',
  'onReturnToClass',
]);

function freshnessProjection(props) {
  const monitoring = props.monitoringDisplay
    || deriveStudentMonitoringDisplay(props.student, props.freshnessNowMs);
  const screenshot = deriveScreenshotDisplay(props.screenshotData, props.freshnessNowMs);
  return `${monitoring.kind}:${monitoring.status}:${monitoring.telemetryCurrent}:${screenshot.fresh}:${screenshot.retained}`;
}

function studentTilePropsEqual(previous, next) {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if (CALLBACK_PROPS.has(key) || key === 'freshnessNowMs' || key === 'monitoringDisplay') continue;
    if (!Object.is(previous[key], next[key])) return false;
  }
  return freshnessProjection(previous) === freshnessProjection(next);
}

export default memo(StudentTile, studentTilePropsEqual);
