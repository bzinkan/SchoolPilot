import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { useToast } from "../../../hooks/use-toast";

const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export default function MonitoringHoursSettings({ settings }) {
  const { toast } = useToast();
  const [value, setValue] = useState(() => ({
    enableTrackingHours: settings?.enableTrackingHours === true,
    trackingStartTime: settings?.trackingStartTime || "08:00",
    trackingEndTime: settings?.trackingEndTime || "15:00",
    schoolTimezone: settings?.schoolTimezone || "America/New_York",
    trackingDays: settings?.trackingDays || days.slice(0, 5),
    afterHoursMode: settings?.afterHoursMode || "off",
  }));
  const update = (field, next) => setValue(previous => ({ ...previous, [field]: next }));
  const save = useMutation({
    mutationFn: () => apiRequest("POST", "/settings", {
      enableTrackingHours: value.enableTrackingHours, trackingStartTime: value.trackingStartTime,
      trackingEndTime: value.trackingEndTime, trackingDays: value.trackingDays, afterHoursMode: value.afterHoursMode,
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/settings"] }); toast({ title: "Monitoring hours saved" }); },
    onError: error => toast({ variant: "destructive", title: "Monitoring hours could not be saved", description: error.response?.data?.error || error.message }),
  });
  return <section className="space-y-4 rounded-md border p-4" aria-label="Monitoring hours">
    <h3 className="font-medium">Monitoring hours</h3>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.enableTrackingHours} onChange={e => update("enableTrackingHours", e.target.checked)} />Use configured tracking hours</label>
    <div className="grid gap-3 sm:grid-cols-3"><label className="text-sm">Start<Input type="time" value={value.trackingStartTime} onChange={e => update("trackingStartTime", e.target.value)} /></label><label className="text-sm">End<Input type="time" value={value.trackingEndTime} onChange={e => update("trackingEndTime", e.target.value)} /></label><label className="text-sm">School timezone<Input value={value.schoolTimezone} readOnly aria-describedby="monitoring-timezone-note" /></label></div>
    <p id="monitoring-timezone-note" className="text-xs text-muted-foreground">The school profile timezone also controls class schedules. Update it through school administration.</p>
    <fieldset className="flex flex-wrap gap-3"><legend className="mb-2 text-sm">Tracking days</legend>{days.map(day => <label key={day} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={value.trackingDays.includes(day)} onChange={e => update("trackingDays", e.target.checked ? [...value.trackingDays, day] : value.trackingDays.filter(item => item !== day))} />{day.slice(0, 3)}</label>)}</fieldset>
    <label className="block text-sm">After hours<select className="ml-3 rounded-md border bg-background p-2" value={value.afterHoursMode} onChange={e => update("afterHoursMode", e.target.value)}><option value="off">Off</option><option value="limited">Safety only</option><option value="full">Full monitoring</option></select></label>
    <p className="text-xs text-muted-foreground">Safety only requires configured tracking hours and an updated extension. It checks minimal page data for safety alerts without browsing history, screenshots, teacher presence, Live View, or classroom commands.</p>
    <Button type="button" variant="outline" disabled={save.isPending || (value.afterHoursMode === "limited" && !value.enableTrackingHours)} onClick={() => save.mutate()}>Save monitoring hours</Button>
  </section>;
}
