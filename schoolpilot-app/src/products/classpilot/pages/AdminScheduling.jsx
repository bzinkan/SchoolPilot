import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarDays, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import SchoolCalendarMonth from "../components/SchoolCalendarMonth";
import ScheduleProfiles from "../components/ScheduleProfiles";

const KEY = ["classpilot-school-scheduling"];
const API = "/classpilot/admin/scheduling";
const weekdays = [[1, "Monday"], [2, "Tuesday"], [3, "Wednesday"], [4, "Thursday"], [5, "Friday"], [6, "Saturday"], [0, "Sunday"]];
const selectClass = "h-10 w-full rounded-md border bg-background px-3 text-sm";
const message = (error) => error?.response?.data?.error || error?.message || "The schedule could not be saved.";
const newId = () => crypto.randomUUID();

function SchedulingEditor({ initial, onDirtyChange }) {
  const [config, setConfig] = useState(initial.config);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [overrideDate, setOverrideDate] = useState("");
  const [previewMonth, setPreviewMonth] = useState("");
  const [calendarMonth, setCalendarMonth] = useState(() => initial.schoolLocalToday.slice(0, 7));
  const [calendarDirty, setCalendarDirty] = useState(false);
  const dirty = JSON.stringify(config) !== JSON.stringify(initial.config);
  useEffect(() => { onDirtyChange(dirty || calendarDirty); }, [dirty, calendarDirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return undefined;
    const beforeUnload = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  const update = (change) => { setConfig((current) => ({ ...current, ...change })); setPreview(null); setError(""); };
  const editProfile = (id, change) => update({ profiles: config.profiles.map((p) => p.id === id ? { ...p, ...change } : p) });
  const editOverride = (date, change) => {
    const value = { ...config.dateOverrides[date], ...change };
    if (value.instructional !== true) delete value.meetingWeekday;
    update({ dateOverrides: { ...config.dateOverrides, [date]: Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) } });
  };
  const previewMutation = useMutation({
    mutationFn: () => apiRequest("POST", `${API}/preview`, { config }),
    onSuccess: (result) => { setPreview(result); setPreviewMonth(result.fromDate.slice(0, 7)); setError(""); },
    onError: (err) => setError(message(err)),
  });
  const save = useMutation({
    mutationFn: () => apiRequest("PUT", API, { config, expectedRevision: preview.revision, previewToken: preview.previewToken }),
    onSuccess: async () => { setPreview(null); await queryClient.invalidateQueries({ queryKey: KEY }); await queryClient.invalidateQueries({ queryKey: ["classpilot-admin-classes"] }); await queryClient.invalidateQueries({ queryKey: ["classpilot-schedule-profiles"] }); },
    onError: (err) => { setError(message(err)); setPreview(null); },
  });
  const busy = save.isPending || previewMutation.isPending;
  return (
    <fieldset className="min-w-0 space-y-6" disabled={busy} data-testid="classpilot-scheduling-panel">
      <Card>
        <CardHeader><CardTitle>A/B days and school year</CardTitle><CardDescription>A/B advances on instructional days. Closing a day recomputes future class days; explicit date overrides stay in place. Each class can meet once per day.</CardDescription></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[["yearStart", "School year starts"], ["yearEnd", "School year ends"], ["cycleAnchorDate", "A/B anchor date"]].map(([field, label]) => <div key={field} className="space-y-2"><Label htmlFor={`schedule-${field}`}>{label}</Label><Input id={`schedule-${field}`} type="date" value={config[field] || ""} onChange={(e) => update({ [field]: e.target.value || null })} disabled={busy} /></div>)}
          <div className="space-y-2"><Label htmlFor="anchor-day">Anchor day</Label><select id="anchor-day" className={selectClass} value={config.cycleAnchorDay} onChange={(e) => update({ cycleAnchorDay: e.target.value })} disabled={busy}><option>A</option><option>B</option></select><p className="text-xs text-muted-foreground">Leave the anchor empty when every class follows weekdays.</p></div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Periods</CardTitle><CardDescription>Assign these periods to classes. Each bell profile supplies their times.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {config.periods.map((period) => <div key={period.id} className="flex gap-2"><Input aria-label="Period name" value={period.name} onChange={(e) => update({ periods: config.periods.map((p) => p.id === period.id ? { ...p, name: e.target.value } : p) })} disabled={busy} /><Button variant="ghost" aria-label={`Remove ${period.name || "period"}`} onClick={() => update({ periods: config.periods.filter((p) => p.id !== period.id), profiles: config.profiles.map((p) => ({ ...p, periods: Object.fromEntries(Object.entries(p.periods).filter(([id]) => id !== period.id)) })) })} disabled={busy}><Trash2 className="h-4 w-4" /></Button></div>)}
          <Button variant="outline" disabled={busy || config.periods.length >= 30} onClick={() => update({ periods: [...config.periods, { id: newId(), name: `Period ${config.periods.length + 1}` }] })}><Plus className="mr-2 h-4 w-4" />Add period</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Bell profiles</CardTitle><CardDescription>Use Regular and Early Release profiles to adjust every class assigned to a period.</CardDescription></CardHeader>
        <CardContent className="space-y-5">
          {config.profiles.map((profile) => <div key={profile.id} className="space-y-3 rounded-lg border p-4">
            <div className="flex gap-2"><Input aria-label="Bell profile name" value={profile.name} onChange={(e) => editProfile(profile.id, { name: e.target.value })} disabled={busy} /><Button variant="ghost" aria-label={`Remove ${profile.name || "profile"}`} onClick={() => update({ profiles: config.profiles.filter((p) => p.id !== profile.id), defaultProfileId: config.defaultProfileId === profile.id ? null : config.defaultProfileId, weekdayProfiles: Object.fromEntries(Object.entries(config.weekdayProfiles).filter(([, id]) => id !== profile.id)), dateOverrides: Object.fromEntries(Object.entries(config.dateOverrides).map(([date, value]) => [date, value.profileId === profile.id ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "profileId")) : value])) })} disabled={busy}><Trash2 className="h-4 w-4" /></Button></div>
            {config.periods.map((period) => <div key={period.id} className="grid items-center gap-2 sm:grid-cols-3"><span className="text-sm font-medium">{period.name}</span>{["startTime", "endTime"].map((field) => <Input key={field} aria-label={`${profile.name} ${period.name} ${field === "startTime" ? "start" : "end"}`} type="time" value={profile.periods[period.id]?.[field] || ""} onChange={(e) => editProfile(profile.id, { periods: { ...profile.periods, [period.id]: { startTime: "", endTime: "", ...profile.periods[period.id], [field]: e.target.value } } })} disabled={busy} />)}</div>)}
          </div>)}
          <Button variant="outline" disabled={busy || !config.periods.length || config.profiles.length >= 30} onClick={() => { const id = newId(); update({ profiles: [...config.profiles, { id, name: config.profiles.length ? "Early Release" : "Regular", periods: Object.fromEntries(config.periods.map((p) => [p.id, { startTime: "08:00", endTime: "08:45" }])) }], defaultProfileId: config.defaultProfileId || id }); }}><Plus className="mr-2 h-4 w-4" />Add bell profile</Button>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-2"><Label htmlFor="default-bell-profile">Default profile</Label><select id="default-bell-profile" className={selectClass} value={config.defaultProfileId || ""} onChange={(e) => update({ defaultProfileId: e.target.value || null })} disabled={busy}><option value="">No default</option>{config.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
            {weekdays.map(([day, label]) => <div key={day} className="space-y-2"><Label htmlFor={`profile-day-${day}`}>{label}</Label><select id={`profile-day-${day}`} className={selectClass} value={config.weekdayProfiles[day] || ""} onChange={(e) => update({ weekdayProfiles: e.target.value ? { ...config.weekdayProfiles, [day]: e.target.value } : Object.fromEntries(Object.entries(config.weekdayProfiles).filter(([key]) => key !== String(day))) })} disabled={busy}><option value="">Use default</option>{config.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>)}
          </div>
        </CardContent>
      </Card>
      <SchoolCalendarMonth month={calendarMonth} onMonthChange={setCalendarMonth} onDirtyChange={setCalendarDirty} />
      <Card>
        <CardHeader><CardTitle>One-date overrides and makeup days</CardTitle><CardDescription>Open an instructional makeup date, including a weekend, and choose which weekday's classes and bells it follows. These ClassPilot overrides remain in place when holidays shift the A/B rotation.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2"><Input aria-label="Override date" type="date" value={overrideDate} onChange={(e) => setOverrideDate(e.target.value)} /><Button variant="outline" disabled={!overrideDate || busy} onClick={() => { update({ dateOverrides: { ...config.dateOverrides, [overrideDate]: config.dateOverrides[overrideDate] || {} } }); setOverrideDate(""); }}>Add date</Button></div>
          {Object.entries(config.dateOverrides).sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => (
            <div key={date} className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center justify-between"><span className="text-sm font-medium">{date}</span><Button variant="ghost" aria-label={`Remove override for ${date}`} onClick={() => update({ dateOverrides: Object.fromEntries(Object.entries(config.dateOverrides).filter(([key]) => key !== date)) })}><Trash2 className="h-4 w-4" /></Button></div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-sm"><span>Instructional status</span><select aria-label={`${date} instructional status`} className={selectClass} value={value.instructional === undefined ? "" : String(value.instructional)} onChange={(e) => editOverride(date, { instructional: e.target.value === "" ? undefined : e.target.value === "true" })}><option value="">Follow school calendar</option><option value="true">Instructional makeup day</option><option value="false">Closed for ClassPilot</option></select></label>
                <label className="space-y-1 text-sm"><span>Meetings and weekday bells follow</span><select aria-label={`${date} meeting weekday`} className={selectClass} disabled={value.instructional !== true} value={value.meetingWeekday ?? ""} onChange={(e) => editOverride(date, { meetingWeekday: e.target.value === "" ? undefined : Number(e.target.value) })}><option value="">Date's actual weekday</option>{weekdays.map(([day, label]) => <option key={day} value={day}>{label}</option>)}</select></label>
                <label className="space-y-1 text-sm"><span>A/B day</span><select aria-label={`${date} A/B day`} className={selectClass} value={value.cycleDay || ""} onChange={(e) => editOverride(date, { cycleDay: e.target.value || undefined })}><option value="">Generated A/B day</option><option>A</option><option>B</option></select></label>
                <label className="space-y-1 text-sm"><span>Bell profile</span><select aria-label={`${date} bell profile`} className={selectClass} value={value.profileId || ""} onChange={(e) => editOverride(date, { profileId: e.target.value || undefined })}><option value="">Default for meeting weekday</option>{config.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="flex flex-wrap items-center gap-3"><Button onClick={() => previewMutation.mutate()} disabled={busy || calendarDirty}>{previewMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CalendarDays className="mr-2 h-4 w-4" />}Preview changes</Button>{preview ? <Button disabled={busy || calendarDirty || preview.blockers.length > 0} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save reviewed schedule"}</Button> : null}<p className="text-sm text-muted-foreground">{calendarDirty ? "Save or discard the calendar month draft before reviewing bell and A/B changes." : "Existing live sessions keep their frozen times and roster."}</p></div>
      {preview ? <Card><CardHeader><CardTitle>Schedule preview</CardTitle><CardDescription>{preview.changedOccurrences} future class occurrences change. Times use {preview.schoolTimezone}. The first 150 changes are listed.</CardDescription></CardHeader><CardContent className="space-y-4">
        {preview.blockers.map((blocker, i) => <p key={i} role="alert" className="text-sm text-destructive">{blocker.date ? `${blocker.date}: ` : ""}{blocker.message}</p>)}
        <Label htmlFor="schedule-preview-month">Preview month</Label><Input id="schedule-preview-month" type="month" value={previewMonth} onChange={(e) => setPreviewMonth(e.target.value)} />
        <div className="max-h-72 overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Date</th><th className="p-2">Day</th><th className="p-2">Bell profile</th></tr></thead><tbody>{preview.days.filter((day) => day.date.startsWith(previewMonth)).map((day) => <tr key={day.date} className="border-t"><td className="p-2">{day.date}{day.overridden ? " · override" : ""}</td><td className="p-2">{day.instructional ? `${day.cycleDay || "Instructional"}${config.dateOverrides[day.date]?.meetingWeekday !== undefined ? ` · ${weekdays.find(([value]) => value === day.meetingWeekday)?.[1]} meetings` : ""}` : "Closed"}</td><td className="p-2">{day.instructional ? config.profiles.find((p) => p.id === day.profileId)?.name || "Custom class times" : "—"}</td></tr>)}</tbody></table></div>
        <div className="max-h-72 overflow-auto">{preview.changes.map((change) => <p key={`${change.date}-${change.classId}`} className="border-t py-2 text-sm">{change.date} · {change.className}: {change.before ? `${change.before.startTime}–${change.before.endTime}` : "No class"} → {change.after ? `${change.after.startTime}–${change.after.endTime}` : "No class"}</p>)}</div>
      </CardContent></Card> : null}
    </fieldset>
  );
}

export default function AdminScheduling() {
  const [advancedDirty, setAdvancedDirty] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const query = useQuery({ queryKey: KEY, queryFn: () => apiRequest("GET", API) });
  if (query.isLoading) return <p className="flex items-center gap-2" role="status"><Loader2 className="h-4 w-4 animate-spin" />Loading school schedules…</p>;
  if (query.error) return <p role="alert" className="text-destructive">{message(query.error)}</p>;
  return query.data ? <div className="space-y-6"><ScheduleProfiles blockedByAdvancedDraft={advancedDirty} onBusyChange={setProfileBusy} /><fieldset disabled={profileBusy} className="min-w-0 space-y-4" aria-label="Advanced bells and calendar"><div><h2 className="text-xl font-semibold">Advanced bells and calendar</h2><p className="text-sm text-muted-foreground">Manage the school year, A/B rotation, bell periods and individual calendar exceptions.</p></div><SchedulingEditor key={query.data.revision} initial={query.data} onDirtyChange={setAdvancedDirty} /></fieldset></div> : null;
}
