import { useState, useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { Card } from "../../../components/ui/card";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Monitor, ExternalLink, AlertTriangle, Lock, Unlock, Layers, Maximize2, X, List, RotateCcw } from "lucide-react";
import { Checkbox } from "../../../components/ui/checkbox";
import { useToast } from "../../../hooks/use-toast";
import { apiRequest } from "../../../lib/queryClient";
import VideoPortal from "./VideoPortal";
import {
  deriveScreenshotDisplay,
  deriveStudentMonitoringDisplay,
  deriveUnavailablePreview,
  formatAbsoluteObservedAt,
  lastObservedDomain,
} from "../lib/studentMonitoringDisplay";
import { commandDeliveryFeedback } from "../lib/commandDeliveryTruth";

const EMPTY_LIST = Object.freeze([]);

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
  liveStream,
  onStartLiveView,
  onStopLiveView,
  liveViewPending = false,
  onAllowDomain,
  teachingSessionId,
  onManageTabs,
  controlDisabled = false,
  disabledReason = "",
  supervisionLabel = "",
  onReturnToClass,
  returnToClassPending = false,
  recentHeartbeats = EMPTY_LIST,
  screenshotData = null,
  flightPaths = EMPTY_LIST,
  monitoringDisplay,
  freshnessNowMs,
  onCommandResult,
}) {
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();
  const tileVideoSlotRef = useRef(null);
  const videoElementRef = useRef(null);
  const lastAutoExpandedStreamRef = useRef(null);
  const effectiveMonitoringDisplay = monitoringDisplay
    || deriveStudentMonitoringDisplay(student, freshnessNowMs);
  const currentTelemetry = effectiveMonitoringDisplay.telemetryCurrent;
  const screenshotDisplay = deriveScreenshotDisplay(screenshotData, freshnessNowMs);
  const displayStatus = effectiveMonitoringDisplay.status;
  const unavailablePreview = deriveUnavailablePreview(effectiveMonitoringDisplay);
  const observedDomain = lastObservedDomain(student);
  const absoluteLastObservedAt = formatAbsoluteObservedAt(effectiveMonitoringDisplay.observedAtMs);

  // Create video element once and attach stream
  useEffect(() => {
    if (!videoElementRef.current) {
      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.style.width = '100%';
      video.style.height = 'auto';
      video.className = 'rounded-md';
      videoElementRef.current = video;
    }

    // Attach stream to video element
    if (videoElementRef.current) {
      videoElementRef.current.srcObject = liveStream || null;
    }

    // Mount video into tile slot when stream exists and the enlarged view is closed.
    if (liveStream && !expanded && tileVideoSlotRef.current && videoElementRef.current) {
      if (!tileVideoSlotRef.current.contains(videoElementRef.current)) {
        tileVideoSlotRef.current.appendChild(videoElementRef.current);
      }
    } else if (!liveStream && videoElementRef.current) {
      // Close portal if expanded
      if (expanded) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setExpanded(false);
      }

      // Remove video element from DOM when stream stops (check both locations)
      const portalSlot = document.querySelector('#portal-video-slot');
      if (portalSlot && portalSlot.contains(videoElementRef.current)) {
        portalSlot.removeChild(videoElementRef.current);
      }
      if (tileVideoSlotRef.current && tileVideoSlotRef.current.contains(videoElementRef.current)) {
        tileVideoSlotRef.current.removeChild(videoElementRef.current);
      }
    }
  }, [liveStream, expanded]);

  useEffect(() => {
    if (!liveStream) {
      lastAutoExpandedStreamRef.current = null;
      return undefined;
    }
    if (lastAutoExpandedStreamRef.current === liveStream) {
      return undefined;
    }
    lastAutoExpandedStreamRef.current = liveStream;

    const timeout = window.setTimeout(() => {
      setExpanded(true);
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [liveStream]);

  useEffect(() => {
    if (!expanded || !liveStream || !videoElementRef.current) return undefined;

    const timeout = window.setTimeout(() => {
      const portalSlot = document.querySelector('#portal-video-slot');
      if (portalSlot && videoElementRef.current && !portalSlot.contains(videoElementRef.current)) {
        portalSlot.appendChild(videoElementRef.current);
      }
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [expanded, liveStream]);

  // Get unique recent domains (last 5)
  const recentDomains = recentHeartbeats
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

  // Expand video to portal
  const handleExpand = (e) => {
    e?.stopPropagation();
    setExpanded(true);
    // Move video to portal after next render
    queueMicrotask(() => {
      const portalSlot = document.querySelector('#portal-video-slot');
      if (portalSlot && videoElementRef.current && !portalSlot.contains(videoElementRef.current)) {
        portalSlot.appendChild(videoElementRef.current);
      }
    });
  };

  // Collapse video back to tile
  const handleCollapse = () => {
    const tileSlot = tileVideoSlotRef.current;
    if (tileSlot && videoElementRef.current && !tileSlot.contains(videoElementRef.current)) {
      tileSlot.appendChild(videoElementRef.current);
    }
    setExpanded(false);
  };

  const isBlocked = currentTelemetry && isBlockedDomain(student.activeTabUrl, blockedDomains);
  const classroomNoiseSuppressed = Boolean(student.classroomNoiseSuppressed || isAbsent || student.suppressionReason);
  const effectiveIsOffTask = currentTelemetry && isOffTask && !classroomNoiseSuppressed;

  // Unblock mutation for flight path
  const unblockForClassMutation = useMutation({
    mutationFn: async () => {
      if (!teachingSessionId) {
        throw new Error("Start a class session before sending commands.");
      }
      return await apiRequest("POST", "/commands", {
        teachingSessionId,
        targetScope: "students",
        targetStudentIds: [student.studentId],
        commandType: "unlock-screen",
        commandPayload: {},
      });
    },
    onSuccess: (data) => {
      const result = onCommandResult?.(data, 'unlock-screen') || data;
      toast(result.deliveryFeedback || commandDeliveryFeedback(result, 'unlock-screen'));
    },
  });

  // Lock to current screen mutation
  const lockToCurrentScreenMutation = useMutation({
    mutationFn: async () => {
      if (!student.activeTabUrl) {
        throw new Error("No active tab to lock to");
      }
      if (!currentTelemetry) {
        throw new Error("The current page is unavailable while the monitoring signal is lost.");
      }
      if (!teachingSessionId) {
        throw new Error("Start a class session before sending commands.");
      }
      return await apiRequest("POST", "/commands", {
        teachingSessionId,
        targetScope: "students",
        targetStudentIds: [student.studentId],
        commandType: "lock-screen",
        commandPayload: { url: student.activeTabUrl },
      });
    },
    onSuccess: (data) => {
      const result = onCommandResult?.(data, 'lock-screen') || data;
      toast(result.deliveryFeedback || commandDeliveryFeedback(result, 'lock-screen'));
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to lock screen",
        description: error.message || "An error occurred",
      });
    },
  });

  // Unlock screen mutation
  const unlockScreenMutation = useMutation({
    mutationFn: async () => {
      if (!teachingSessionId) {
        throw new Error("Start a class session before sending commands.");
      }
      return await apiRequest("POST", "/commands", {
        teachingSessionId,
        targetScope: "students",
        targetStudentIds: [student.studentId],
        commandType: "unlock-screen",
        commandPayload: {},
      });
    },
    onSuccess: (data) => {
      const result = onCommandResult?.(data, 'unlock-screen') || data;
      toast(result.deliveryFeedback || commandDeliveryFeedback(result, 'unlock-screen'));
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to save screen unlock",
        description: error.message || "An error occurred",
      });
    },
  });


  const getStatusLabel = (status) => {
    if (isAbsent) return 'Absent';
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
    if (controlDisabled) {
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
      case 'offline':
        return 'border border-border/40';
      default:
        return 'border border-border';
    }
  };

  const getShadowStyle = (status) => {
    if (controlDisabled) {
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
    if (controlDisabled) return 'opacity-90';
    if (isAbsent) return 'opacity-50';
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
      className={`${getBorderStyle(displayStatus)} ${getShadowStyle(displayStatus)} ${getOpacity(displayStatus)} ${controlDisabled ? 'bg-slate-50/80 dark:bg-slate-950/40' : 'hover-elevate cursor-pointer'} transition-all duration-200 overflow-hidden`}
      onClick={onClick}
    >
      <div className="p-4 space-y-3">
        {/* Header Zone - Avatar + Student Name + Status */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            {onToggleSelect && (
              <Checkbox
                checked={isSelected}
                disabled={controlDisabled}
                onCheckedChange={onToggleSelect}
                onClick={(e) => e.stopPropagation()}
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
              <div className="flex items-center gap-2">
                <span className={`text-xs font-medium ${
                  displayStatus === 'online'
                    ? 'text-green-600 dark:text-green-400'
                    : displayStatus === 'idle' || displayStatus === 'signal_lost'
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-muted-foreground'
                }`}>
                  {getStatusLabel(displayStatus)}
                </span>
                {student.classroomState?.revision != null && student.enforcementHealth && (
                  <span
                    className={`text-[10px] font-medium ${
                      student.enforcementHealth === 'synced'
                        ? 'text-green-600 dark:text-green-400'
                        : student.enforcementHealth === 'failed'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-amber-600 dark:text-amber-400'
                    }`}
                    title="Device-reported classroom-control synchronization status. This is not proof against tampering."
                  >
                    Controls: {student.enforcementHealth}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={controlDisabled || (!currentTelemetry && !student.screenLocked) || lockToCurrentScreenMutation.isPending || unlockScreenMutation.isPending}
              onClick={(e) => {
                e.stopPropagation();
                if (controlDisabled) return;
                if (student.screenLocked) {
                  unlockScreenMutation.mutate();
                } else {
                  lockToCurrentScreenMutation.mutate();
                }
              }}
              title={controlDisabled
                ? disabledReason || "Student is currently in supervision"
                : student.screenLocked
                  ? "Save an unlock restriction"
                  : currentTelemetry
                    ? "Save a lock restriction for the current screen"
                    : "Current screen unavailable while monitoring signal is lost"}
              data-testid={`button-lock-toggle-${student.studentId}`}
            >
              {student.screenLocked ? (
                <Lock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              ) : (
                <Unlock className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        {controlDisabled && (
          <div className="rounded-md border border-slate-300 bg-white/80 p-3 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200">
            <div className="flex items-center gap-2 font-semibold">
              <Lock className="h-3.5 w-3.5" />
              <span>{supervisionLabel || "In supervision"}</span>
            </div>
            <p className="mt-1 leading-snug text-slate-500 dark:text-slate-400">
              {disabledReason || "This student is currently claimed by another supervision session."}
            </p>
          </div>
        )}

        {/* Alert Badges */}
        {(effectiveIsOffTask || isBlocked || isBlockedByFlightPath || student.flightPathActive || (currentTelemetry && student.aiClassification?.safetyAlert) || classroomNoiseSuppressed) && (
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
                      className="ml-1.5 hover:bg-red-200 dark:hover:bg-red-800 rounded-full p-0.5"
                      onClick={(e) => {
                        e.stopPropagation();
                        try {
                          const domain = new URL(student.activeTabUrl).hostname.toLowerCase().replace(/^www\./, '');
                          onAllowDomain(domain);
                        } catch { /* ignore invalid URL */ }
                      }}
                      title="Allow this domain for this session"
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
            {isBlockedByFlightPath && (
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
                    unblockForClassMutation.mutate();
                  }}
                  data-testid={`button-unblock-${student.studentId}`}
                >
                  Unblock for class
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Preview Zone - Live View, Screenshot Thumbnail, or Website Preview Card */}
        {controlDisabled ? (
          <div className="flex aspect-video items-center justify-center rounded-lg border border-slate-200 bg-slate-100/80 text-center dark:border-slate-800 dark:bg-slate-900/80">
            <div className="px-4">
              <Lock className="mx-auto mb-2 h-6 w-6 text-slate-400" />
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Controls locked</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Return the student to class to monitor again.</p>
            </div>
          </div>
        ) : liveStream ? (
          <div className="aspect-video rounded-lg bg-black relative overflow-hidden">
            <div
              ref={tileVideoSlotRef}
              id={`tile-video-slot-${student.studentId}`}
              className="w-full h-full rounded-lg overflow-hidden"
              data-testid={`video-live-${student.studentId}`}
            />
          </div>
        ) : !currentTelemetry ? (
          <div
            className={`flex aspect-video items-center justify-center rounded-lg border text-center ${unavailablePreview.warning ? 'border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/20' : 'border-border bg-muted/30'}`}
            data-testid={`preview-unavailable-${student.studentId}`}
          >
            <div className="px-4">
              <Monitor className={`mx-auto mb-2 h-6 w-6 ${unavailablePreview.warning ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`} />
              <p className="text-sm font-semibold text-foreground">Preview unavailable</p>
              <p className="mt-1 text-xs text-muted-foreground">{unavailablePreview.reason}</p>
              {unavailablePreview.showLastObservation && (
                <>
                  <p className="mt-2 text-[11px] text-muted-foreground">Last observed at {absoluteLastObservedAt}</p>
                  {observedDomain && (
                    <p className="mt-1 truncate text-[11px] text-muted-foreground">
                      Last observed site: {observedDomain}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        ) : screenshotDisplay.fresh ? (
          // Screenshot thumbnail when available
          // Uses tab metadata from the screenshot (not current heartbeat) so overlay matches the image
          <div className="aspect-video rounded-lg bg-muted/40 relative overflow-hidden">
            <img
              src={screenshotData.screenshot}
              alt={`${student.studentName || 'Student'}'s screen`}
              className="w-full h-full object-cover"
              data-testid={`screenshot-${student.studentId}`}
            />
            {/* Overlay with tab info from when screenshot was taken */}
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2">
              <div className="flex items-center gap-1.5">
                {screenshotData.tabFavicon && (
                  <img
                    src={screenshotData.tabFavicon}
                    alt=""
                    className="w-3 h-3 flex-shrink-0 rounded"
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
          {controlDisabled && onReturnToClass && (
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
          {onManageTabs && !controlDisabled && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                onManageTabs();
              }}
              title="Manage this student's open tabs"
              data-testid={`button-manage-tabs-${student.studentId}`}
            >
              <List className="h-3.5 w-3.5 mr-1" />
              Tabs
            </Button>
          )}
          {onStartLiveView && onStopLiveView && !controlDisabled && (
            <Button
              variant={liveStream ? "default" : "outline"}
              size="sm"
              className="h-7 px-3 text-xs"
              disabled={liveViewPending}
              onClick={(e) => {
                e.stopPropagation();
                if (liveStream) {
                  onStopLiveView();
                } else {
                  onStartLiveView();
                }
              }}
              title={liveViewPending ? "Waiting for live view to connect" : liveStream ? "Stop live view" : "Start live view"}
              data-testid={`button-live-view-${student.studentId}`}
            >
              <Monitor className="h-3.5 w-3.5 mr-1" />
              {liveViewPending ? "Connecting" : liveStream ? "Stop" : "View"}
            </Button>
          )}
          {liveStream && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                handleExpand();
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

      {/* Video Portal for enlarged view */}
      {expanded && liveStream && (
        <VideoPortal
          studentName={student.studentName || student.deviceName || "Unknown student"}
          onClose={handleCollapse}
          onStopLiveView={onStopLiveView}
        />
      )}
    </Card>
  );
}

export default StudentTile;
