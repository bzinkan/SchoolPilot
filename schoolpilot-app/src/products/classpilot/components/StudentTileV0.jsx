// V0-inspired dark theme StudentTile — experimental design
// Uses same props/logic as original StudentTile, just different visual style
// To test: set USE_V0_TILE=true in Dashboard.jsx

import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card } from "../../../components/ui/card";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Monitor, ExternalLink, AlertTriangle, Lock, Unlock, Video, Layers, Maximize2, Globe, Clock, MoreHorizontal, ShieldAlert, Circle } from "lucide-react";
import { Checkbox } from "../../../components/ui/checkbox";
import { useToast } from "../../../hooks/use-toast";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import VideoPortal from "./VideoPortal";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";

function isBlockedDomain(url, blockedDomains) {
  if (!url || blockedDomains.length === 0) return false;
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    return blockedDomains.some(blocked => {
      const blockedLower = blocked.toLowerCase().trim();
      return (
        hostname === blockedLower ||
        hostname.endsWith('.' + blockedLower) ||
        hostname.includes('.' + blockedLower + '.') ||
        hostname.startsWith(blockedLower + '.') ||
        hostname.includes(blockedLower)
      );
    });
  } catch {
    return false;
  }
}

function StudentTileV0({ student, onClick, blockedDomains = [], isOffTask = false, isAbsent = false, isSelected = false, onToggleSelect, liveStream, onStartLiveView, onStopLiveView, onBlockRefetches }) {
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();
  const tileVideoSlotRef = useRef(null);
  const videoElementRef = useRef(null);

  // === All existing data fetching & mutations (unchanged) ===

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
    if (videoElementRef.current) {
      videoElementRef.current.srcObject = liveStream || null;
    }
    if (liveStream && tileVideoSlotRef.current && videoElementRef.current) {
      if (!tileVideoSlotRef.current.contains(videoElementRef.current)) {
        tileVideoSlotRef.current.appendChild(videoElementRef.current);
      }
    } else if (!liveStream && videoElementRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (expanded) setExpanded(false);
      const portalSlot = document.querySelector('#portal-video-slot');
      if (portalSlot && portalSlot.contains(videoElementRef.current)) {
        portalSlot.removeChild(videoElementRef.current);
      }
      if (tileVideoSlotRef.current && tileVideoSlotRef.current.contains(videoElementRef.current)) {
        tileVideoSlotRef.current.removeChild(videoElementRef.current);
      }
    }
  }, [liveStream, expanded]);

  const { data: recentHeartbeats = [] } = useQuery({
    queryKey: ['/api/heartbeats', student.primaryDeviceId],
    queryFn: () => apiRequest('GET', `/heartbeats/${student.primaryDeviceId}`),
    select: (data) => Array.isArray(data) ? data : data?.heartbeats ?? [],
    refetchInterval: 30000,
  });

  const { data: flightPaths = [] } = useQuery({
    queryKey: ['/api/flight-paths'],
    queryFn: () => apiRequest('GET', '/flight-paths'),
    select: (data) => Array.isArray(data) ? data : data?.flightPaths ?? [],
  });

  const { data: screenshotData } = useQuery({
    queryKey: ['/api/device/screenshot', student.primaryDeviceId],
    queryFn: () => apiRequest('GET', `/device/screenshot/${student.primaryDeviceId}`),
    enabled: !!student.primaryDeviceId && student.status !== 'offline' && !liveStream,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 15000,
    gcTime: 60000,
  });

  const recentDomains = recentHeartbeats
    .slice(0, 10)
    .reduce((acc, hb) => {
      try {
        const urlObj = new URL(hb.activeTabUrl);
        const domain = urlObj.hostname;
        if (!acc.some(item => new URL(item.url).hostname === domain)) {
          acc.push({ url: hb.activeTabUrl, favicon: hb.favicon, title: hb.activeTabTitle });
        }
      } catch { /* intentionally empty */ }
      return acc;
    }, [])
    .slice(0, 5);

  const activeFlightPath = flightPaths.find((fp) => fp.flightPathName === student.activeFlightPathName);
  const isBlockedByFlightPath = student.flightPathActive && activeFlightPath && student.activeTabUrl &&
    isBlockedDomain(student.activeTabUrl, activeFlightPath.blockedDomains || []);

  const handleExpand = (e) => {
    e?.stopPropagation();
    setExpanded(true);
    queueMicrotask(() => {
      const portalSlot = document.querySelector('#portal-video-slot');
      if (portalSlot && videoElementRef.current && !portalSlot.contains(videoElementRef.current)) {
        portalSlot.appendChild(videoElementRef.current);
      }
    });
  };

  const handleCollapse = () => {
    const tileSlot = tileVideoSlotRef.current;
    if (tileSlot && videoElementRef.current && !tileSlot.contains(videoElementRef.current)) {
      tileSlot.appendChild(videoElementRef.current);
    }
    setExpanded(false);
  };

  const isBlocked = isBlockedDomain(student.activeTabUrl, blockedDomains);

  const unblockForClassMutation = useMutation({
    mutationFn: async () => {
      if (!student.primaryDeviceId) throw new Error("Student does not have a primary device assigned.");
      return await apiRequest("POST", "/remote/unlock-screen", { targetDeviceIds: [student.primaryDeviceId] });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({ title: "Unblocked for class", description: `${student.studentName} can now access this website` });
    },
  });

  const lockToCurrentScreenMutation = useMutation({
    mutationFn: async () => {
      if (!student.activeTabUrl) throw new Error("No active tab to lock to");
      if (!student.primaryDeviceId) throw new Error("Student does not have a primary device assigned.");
      return await apiRequest("POST", "/remote/lock-screen", { url: student.activeTabUrl, targetDeviceIds: [student.primaryDeviceId] });
    },
    onMutate: async () => {
      onBlockRefetches?.();
      await queryClient.cancelQueries({ queryKey: ['/api/students-aggregated'] });
      const previousStudents = queryClient.getQueryData(['/api/students-aggregated']);
      queryClient.setQueryData(['/api/students-aggregated'], (old) =>
        old?.map(s => s.primaryDeviceId === student.primaryDeviceId ? { ...s, screenLocked: true } : s)
      );
      return { previousStudents };
    },
    onSuccess: () => { toast({ title: "Screen locked", description: `${student.studentName} is now locked to their current screen` }); },
    onError: (error, _, context) => {
      if (context?.previousStudents) queryClient.setQueryData(['/api/students-aggregated'], context.previousStudents);
      toast({ variant: "destructive", title: "Failed to lock screen", description: error.message || "An error occurred" });
    },
  });

  const unlockScreenMutation = useMutation({
    mutationFn: async () => {
      if (!student.primaryDeviceId) throw new Error("Student does not have a primary device assigned.");
      return await apiRequest("POST", "/remote/unlock-screen", { targetDeviceIds: [student.primaryDeviceId] });
    },
    onMutate: async () => {
      onBlockRefetches?.();
      await queryClient.cancelQueries({ queryKey: ['/api/students-aggregated'] });
      const previousStudents = queryClient.getQueryData(['/api/students-aggregated']);
      queryClient.setQueryData(['/api/students-aggregated'], (old) =>
        old?.map(s => s.primaryDeviceId === student.primaryDeviceId ? { ...s, screenLocked: false } : s)
      );
      return { previousStudents };
    },
    onSuccess: () => { toast({ title: "Screen unlocked", description: `${student.studentName} can now browse freely` }); },
    onError: (_, __, context) => {
      if (context?.previousStudents) queryClient.setQueryData(['/api/students-aggregated'], context.previousStudents);
    },
  });

  // === V0 Dark Theme Visual Style ===

  const hasAlert = isOffTask || isBlocked || isBlockedByFlightPath || student.aiClassification?.safetyAlert;

  const getStatusConfig = (status) => {
    if (isAbsent) return { color: 'bg-blue-500', label: 'Absent', textColor: 'text-blue-400' };
    switch (status) {
      case 'online': return { color: 'bg-emerald-500', label: 'Active', textColor: 'text-emerald-400' };
      case 'idle': return { color: 'bg-amber-500', label: 'Idle', textColor: 'text-amber-400' };
      default: return { color: 'bg-zinc-500', label: 'Offline', textColor: 'text-zinc-500' };
    }
  };

  const statusConfig = getStatusConfig(student.status);

  return (
    <Card
      data-testid={`card-student-${student.primaryDeviceId}`}
      className={`
        group relative overflow-hidden bg-zinc-950 border-zinc-800/50
        hover:border-zinc-700 transition-all duration-300 cursor-pointer
        ${hasAlert ? 'border-red-500/50 hover:border-red-500/70' : ''}
        ${isAbsent ? 'opacity-50' : ''}
      `}
      onClick={onClick}
    >
      {/* Alert Strip */}
      {hasAlert && (
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-red-500 via-red-400 to-red-500 z-10" />
      )}

      {/* Screenshot / Live View Area */}
      <div className="relative aspect-video bg-zinc-900">
        {liveStream ? (
          <div
            ref={tileVideoSlotRef}
            id={`tile-video-slot-${student.primaryDeviceId}`}
            className="w-full h-full overflow-hidden"
            data-testid={`video-live-${student.primaryDeviceId}`}
          />
        ) : screenshotData?.screenshot ? (
          <img
            src={screenshotData.screenshot}
            alt={`${student.studentName || 'Student'}'s screen`}
            className="w-full h-full object-cover"
            data-testid={`screenshot-${student.primaryDeviceId}`}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-zinc-600">
            <Globe className="h-8 w-8 mb-2" />
            <span className="text-xs">{student.status === 'offline' ? 'Offline' : 'No screen data'}</span>
          </div>
        )}

        {/* Live indicator */}
        {liveStream && (
          <div className="absolute top-3 left-3 flex items-center gap-1.5 px-2 py-1 bg-red-500 rounded text-[10px] font-semibold text-white uppercase tracking-wide z-10">
            <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
            Live
          </div>
        )}

        {/* Alert badges overlay */}
        {hasAlert && (
          <div className="absolute top-3 right-3 flex flex-col gap-1.5 z-10">
            {student.aiClassification?.safetyAlert && (
              <Badge className="bg-red-600/90 hover:bg-red-600 text-white border-0 text-[10px] font-semibold px-2 py-0.5 animate-pulse">
                <AlertTriangle className="h-3 w-3 mr-1" />
                {student.aiClassification.safetyAlert}
              </Badge>
            )}
            {isBlockedByFlightPath && (
              <Badge className="bg-red-500/90 hover:bg-red-500 text-white border-0 text-[10px] font-semibold px-2 py-0.5">
                <ShieldAlert className="h-3 w-3 mr-1" />
                Blocked by {student.activeFlightPathName}
              </Badge>
            )}
            {isOffTask && !isBlockedByFlightPath && (
              <Badge className="bg-red-500/90 hover:bg-red-500 text-white border-0 text-[10px] font-semibold px-2 py-0.5">
                <AlertTriangle className="h-3 w-3 mr-1" />
                Off-Task
              </Badge>
            )}
            {isBlocked && !isOffTask && !isBlockedByFlightPath && (
              <Badge className="bg-orange-500/90 hover:bg-orange-500 text-white border-0 text-[10px] font-semibold px-2 py-0.5">
                <ShieldAlert className="h-3 w-3 mr-1" />
                Blocked
              </Badge>
            )}
            {student.flightPathActive && student.activeFlightPathName && !isBlockedByFlightPath && (
              <Badge className="bg-blue-500/90 hover:bg-blue-500 text-white border-0 text-[10px] font-semibold px-2 py-0.5">
                <Layers className="h-3 w-3 mr-1" />
                {student.activeFlightPathName}
              </Badge>
            )}
          </div>
        )}

        {/* Hover Actions Overlay */}
        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3 z-20">
          {onToggleSelect && (
            <Checkbox
              checked={isSelected}
              onCheckedChange={onToggleSelect}
              onClick={(e) => e.stopPropagation()}
              className="absolute top-3 left-3 border-white/50 data-[state=checked]:bg-blue-500"
              data-testid={`checkbox-select-student-${student.primaryDeviceId}`}
            />
          )}
          {onStartLiveView && onStopLiveView && (
            <Button
              size="sm"
              variant="secondary"
              className="h-8 bg-white/10 hover:bg-white/20 text-white border-0 backdrop-blur-sm"
              onClick={(e) => {
                e.stopPropagation();
                liveStream ? onStopLiveView() : onStartLiveView();
              }}
              data-testid={`button-live-view-${student.primaryDeviceId ?? "unknown-device"}`}
            >
              <Video className="h-4 w-4 mr-1.5" />
              {liveStream ? 'Stop' : 'View Live'}
            </Button>
          )}
          {liveStream && (
            <Button
              size="sm"
              variant="secondary"
              className="h-8 bg-white/10 hover:bg-white/20 text-white border-0 backdrop-blur-sm"
              onClick={(e) => { e.stopPropagation(); handleExpand(e); }}
              data-testid={`button-expand-${student.primaryDeviceId ?? "unknown-device"}`}
            >
              <Maximize2 className="h-4 w-4 mr-1.5" />
              Expand
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="secondary"
                className="h-8 w-8 p-0 bg-white/10 hover:bg-white/20 text-white border-0 backdrop-blur-sm"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={(e) => {
                e.stopPropagation();
                if (student.screenLocked) unlockScreenMutation.mutate();
                else lockToCurrentScreenMutation.mutate();
              }}>
                {student.screenLocked ? (
                  <><Unlock className="h-4 w-4 mr-2" /> Unlock Screen</>
                ) : (
                  <><Lock className="h-4 w-4 mr-2" /> Lock Screen</>
                )}
              </DropdownMenuItem>
              {isBlockedByFlightPath && (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); unblockForClassMutation.mutate(); }}>
                  Unblock for class
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Info Footer */}
      <div className="p-3 space-y-3">
        {/* Student Name + Status */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="relative flex-shrink-0">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium ${
                student.status === 'online'
                  ? 'bg-emerald-900/40 text-emerald-300'
                  : student.status === 'idle'
                  ? 'bg-amber-900/40 text-amber-300'
                  : 'bg-zinc-800 text-zinc-400'
              }`}>
                {student.studentName?.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || '?'}
              </div>
              <div className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-zinc-950 ${statusConfig.color} ${
                student.status === 'online' ? 'animate-pulse' : ''
              }`} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-100 truncate" data-testid={`text-student-name-${student.primaryDeviceId}`}>
                {student.studentName || <span className="text-zinc-500 italic">{student.deviceName || 'Unknown'}</span>}
              </p>
              <p className={`text-[10px] ${statusConfig.textColor} font-medium uppercase tracking-wide`}>
                {statusConfig.label}
              </p>
            </div>
          </div>

          {/* Lock indicator */}
          {student.screenLocked && (
            <Lock className="h-3.5 w-3.5 text-amber-400 flex-shrink-0" />
          )}
        </div>

        {/* Current Tab */}
        {(screenshotData?.tabTitle || student.activeTabTitle) && (
          <div className="flex items-center gap-2 px-2.5 py-2 bg-zinc-900/50 rounded-lg border border-zinc-800/50">
            {(screenshotData?.tabFavicon || student.favicon) ? (
              <img
                src={screenshotData?.tabFavicon || student.favicon}
                alt=""
                className="w-4 h-4 rounded-sm flex-shrink-0"
                onError={(e) => { e.target.style.display = 'none'; }}
              />
            ) : (
              <Globe className="w-4 h-4 text-zinc-500 flex-shrink-0" />
            )}
            <span className="text-xs text-zinc-400 truncate flex-1" data-testid={`text-tab-title-${student.primaryDeviceId}`}>
              {screenshotData?.tabTitle || student.activeTabTitle || 'No active tab'}
            </span>
            <ExternalLink className="h-3 w-3 text-zinc-600 flex-shrink-0" />
          </div>
        )}

        {/* Recent History */}
        {recentDomains.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-zinc-600 uppercase tracking-widest font-medium">Recent</span>
            <div className="flex-1 h-px bg-zinc-800/50" />
            <div className="flex items-center gap-1">
              {recentDomains.map((domain, idx) => (
                <div
                  key={idx}
                  className="w-5 h-5 rounded bg-zinc-800/50 flex items-center justify-center hover:bg-zinc-700/50 transition-colors"
                  title={domain.title || domain.url}
                >
                  {domain.favicon ? (
                    <img src={domain.favicon} alt="" className="w-3 h-3 rounded-sm" onError={(e) => { e.target.style.display = 'none'; }} />
                  ) : (
                    <Globe className="w-3 h-3 text-zinc-600" />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Video Portal */}
      {expanded && liveStream && (
        <VideoPortal
          studentName={student.studentName || student.deviceName || student.primaryDeviceId || "Unknown student"}
          onClose={handleCollapse}
        />
      )}
    </Card>
  );
}

export default StudentTileV0;
