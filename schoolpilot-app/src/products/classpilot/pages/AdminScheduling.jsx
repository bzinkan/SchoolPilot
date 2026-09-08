import { createElement, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Bell, CalendarDays, Clock3, Files, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import SchoolCalendarMonth from "../components/SchoolCalendarMonth";
import ScheduleProfiles from "../components/ScheduleProfiles";

const KEY = ["classpilot-school-scheduling"];
const API = "/classpilot/admin/scheduling";
const weekdays = [[1, "Monday"], [2, "Tuesday"], [3, "Wednesday"], [4, "Thursday"], [5, "Friday"], [6, "Saturday"], [0, "Sunday"]];
const selectClass = "h-10 w-full rounded-md border bg-background px-3 text-sm";
const message = (error) => error?.response?.data?.error || error?.message || "The schedule could not be saved.";
const newId = () => crypto.randomUUID();
const sections = [
  { value: "profiles", label: "Schedule profiles", description: "Early release & testing days", icon: Files },
  { value: "bells", label: "Bells & rotation", description: "Periods, bell times & A/B days", icon: Bell },
  { value: "calendar", label: "Calendar & exceptions", description: "Closures & makeup dates", icon: CalendarDays },
];
const panelClass = "mt-0 space-y-5 data-[state=inactive]:hidden";

function SchedulingEditor({ initial, onDirtyChange, section, disabled }) {
  const [config, setConfig] = useState(initial.config);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [overrideDate, setOverrideDate] = useState("");
  const [previewMonth, setPreviewMonth] = useState("");
  const [calendarMonth, setCalendarMonth] = useState(() => initial.schoolLocalToday.slice(0, 7));
  const [calendarDirty, setCalendarDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const dirty = JSON.stringify(config) !== JSON.stringify(initial.config);
  useEffect(() => { onDirtyChange(dirty || calendarDirty); }, [dirty, calendarDirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return undefined;
    const beforeUnload = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  const update = (change) => { setConfig((current) => ({ ...current, ...change })); setPreview(null); setError(""); setNotice(""); };
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
  const discard = () => { setConfig(initial.config); setPreview(null); setError(""); setNotice("Bell, rotation and date-override draft discarded."); };
  return (
    <fieldset className={`min-w-0 space-y-5 ${section === "profiles" ? "hidden" : ""}`} disabled={busy || disabled} data-testid="classpilot-scheduling-panel">
      <TabsContent value="bells" forceMount className={panelClass}>
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">Bells & rotation</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">Set the everyday timetable here, then assign a period and meeting days to each class in Classes.</p>
      </div>
      <Card>
        <CardHeader><CardTitle>1. Define periods</CardTitle><CardDescription>A period is a shared slot, such as Period 1 or Homeroom. Add the names here; set their times below.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {config.periods.map((period) => <div key={period.id} className="flex gap-2"><Input aria-label="Period name" value={period.name} onChange={(e) => update({ periods: config.periods.map((p) => p.id === period.id ? { ...p, name: e.target.value } : p) })} disabled={busy} /><Button variant="ghost" aria-label={`Remove ${period.name || "period"}`} onClick={() => update({ periods: config.periods.filter((p) => p.id !== period.id), profiles: config.profiles.map((p) => ({ ...p, periods: Object.fromEntries(Object.entries(p.periods).filter(([id]) => id !== period.id)) })) })} disabled={busy}><Trash2 className="h-4 w-4" /></Button></div>)}
          <Button variant="outline" disabled={busy || config.periods.length >= 30} onClick={() => update({ periods: [...config.periods, { id: newId(), name: `Period ${config.periods.length + 1}` }] })}><Plus className="mr-2 h-4 w-4" />Add period</Button>
          {!config.periods.length && <p className="text-sm text-muted-foreground">Start with a period to unlock bell profiles. Classes with their own fixed times can keep using those times.</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>2. Set bell times</CardTitle><CardDescription>A bell profile gives each period a start and end time. Regular and Early Release can use the same periods with different times.</CardDescription></CardHeader>
        <CardContent className="space-y-5">
          {config.profiles.map((profile) => <div key={profile.id} className="space-y-3 rounded-lg border p-4">
            <div className="flex gap-2"><Input aria-label="Bell profile name" value={profile.name} onChange={(e) => editProfile(profile.id, { name: e.target.value })} disabled={busy} /><Button variant="ghost" aria-label={`Remove ${profile.name || "profile"}`} onClick={() => update({ profiles: config.profiles.filter((p) => p.id !== profile.id), defaultProfileId: config.defaultProfileId === profile.id ? null : config.defaultProfileId, weekdayProfiles: Object.fromEntries(Object.entries(config.weekdayProfiles).filter(([, id]) => id !== profile.id)), dateOverrides: Object.fromEntries(Object.entries(config.dateOverrides).map(([date, value]) => [date, value.profileId === profile.id ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "profileId")) : value])) })} disabled={busy}><Trash2 className="h-4 w-4" /></Button></div>
            <div className="hidden grid-cols-3 gap-2 text-xs text-muted-foreground sm:grid"><span>Period</span><span>Starts</span><span>Ends</span></div>
            {config.periods.map((period) => <div key={period.id} className="grid items-center gap-2 sm:grid-cols-3"><span className="text-sm font-medium">{period.name}</span>{["startTime", "endTime"].map((field) => <label key={field}><span className="mb-1 block text-xs text-muted-foreground sm:sr-only">{field === "startTime" ? "Starts" : "Ends"}</span><Input aria-label={`${profile.name} ${period.name} ${field === "startTime" ? "start" : "end"}`} type="time" value={profile.periods[period.id]?.[field] || ""} onChange={(e) => editProfile(profile.id, { periods: { ...profile.periods, [period.id]: { startTime: "", endTime: "", ...profile.periods[period.id], [field]: e.target.value } } })} disabled={busy} /></label>)}</div>)}
          </div>)}
          <Button variant="outline" disabled={busy || !config.periods.length || config.profiles.length >= 30} onClick={() => { const id = newId(); update({ profiles: [...config.profiles, { id, name: config.profiles.length ? "Early Release" : "Regular", periods: Object.fromEntries(config.periods.map((p) => [p.id, { startTime: "08:00", endTime: "08:45" }])) }], defaultProfileId: config.defaultProfileId || id }); }}><Plus className="mr-2 h-4 w-4" />Add bell profile</Button>
          {!config.periods.length && <p className="text-sm text-muted-foreground">Add a period above before creating a bell profile.</p>}
          {config.profiles.length > 0 && <div className="space-y-4 border-t pt-5">
            <div><h3 className="text-sm font-semibold">3. Choose when the bells apply</h3><p className="mt-1 text-sm text-muted-foreground">The default supplies times for classes assigned to periods. Use weekday exceptions for a regular weekly variation.</p></div>
          <div className="max-w-sm">
            <div className="space-y-2"><Label htmlFor="default-bell-profile">Default profile</Label><select id="default-bell-profile" className={selectClass} value={config.defaultProfileId || ""} onChange={(e) => update({ defaultProfileId: e.target.value || null })} disabled={busy}><option value="">No default</option>{config.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
          </div>
          <details className="rounded-md border p-3" open={Object.keys(config.weekdayProfiles).length > 0 ? true : undefined}>
            <summary className="cursor-pointer text-sm font-medium">Weekday bell exceptions <span className="font-normal text-muted-foreground">(optional)</span></summary>
            <p className="mt-2 text-xs text-muted-foreground">For example, use Early Release every Wednesday. Selecting weekend bells does not open a weekend for classes; add a makeup date in Calendar & exceptions.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{weekdays.map(([day, label]) => <div key={day} className="space-y-2"><Label htmlFor={`profile-day-${day}`}>{label}</Label><select id={`profile-day-${day}`} className={selectClass} value={config.weekdayProfiles[day] || ""} onChange={(e) => update({ weekdayProfiles: e.target.value ? { ...config.weekdayProfiles, [day]: e.target.value } : Object.fromEntries(Object.entries(config.weekdayProfiles).filter(([key]) => key !== String(day))) })} disabled={busy}><option value="">Use default</option>{config.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>)}</div>
          </details>
          </div>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>School year & A/B rotation</CardTitle><CardDescription>For classes that alternate A and B days, choose a known A or B date as the anchor. Leave the anchor empty if all classes follow weekdays.</CardDescription></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[["yearStart", "School year starts"], ["yearEnd", "School year ends"], ["cycleAnchorDate", "A/B anchor date"]].map(([field, label]) => <div key={field} className="space-y-2"><Label htmlFor={`schedule-${field}`}>{label}</Label><Input id={`schedule-${field}`} type="date" value={config[field] || ""} onChange={(e) => update({ [field]: e.target.value || null })} disabled={busy} /></div>)}
          <div className="space-y-2"><Label htmlFor="anchor-day">Anchor day</Label><select id="anchor-day" className={selectClass} value={config.cycleAnchorDay} onChange={(e) => update({ cycleAnchorDay: e.target.value })} disabled={busy}><option>A</option><option>B</option></select></div>
          <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2 xl:col-span-4">A/B advances only on instructional days. A closure shifts the rotation; explicit date overrides stay in place. School-year dates bound the A/B rotation. Set each class’s first and last dates in Classes.</p>
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground">{dirty || calendarDirty || busy || disabled ? "Save or discard your draft before opening Classes to assign periods and enable automatic scheduling." : <>Next, <Link className="font-medium text-primary underline underline-offset-4" to="/classpilot/admin/classes">assign periods to classes</Link> and enable automatic scheduling for the classes that should start at the bell.</>}</p>
      </TabsContent>
      <TabsContent value="calendar" forceMount className={panelClass}>
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">Calendar & exceptions</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">Mark school closures in the calendar. Use a date override for a makeup day, a specific A/B day or different bells.</p>
      </div>
      <p className="rounded-md border-l-2 border-primary bg-primary/5 px-4 py-3 text-sm">Calendar months have their own preview and save. Save or discard a month draft before reviewing bell, rotation or date-override changes.</p>
      <SchoolCalendarMonth month={calendarMonth} onMonthChange={setCalendarMonth} onDirtyChange={setCalendarDirty} />
      <Card>
        <CardHeader><CardTitle>Date overrides & makeup days</CardTitle><CardDescription>For example, open a Saturday and have it follow Monday’s classes and bells. Overrides apply to ClassPilot on the selected date and stay in place when closures shift the A/B rotation.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex max-w-md gap-2"><Input aria-label="Override date" type="date" value={overrideDate} onChange={(e) => setOverrideDate(e.target.value)} /><Button variant="outline" disabled={!overrideDate || busy} onClick={() => { update({ dateOverrides: { ...config.dateOverrides, [overrideDate]: config.dateOverrides[overrideDate] || {} } }); setOverrideDate(""); }}>Add date</Button></div>
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
      </TabsContent>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
      <div className="space-y-3 rounded-lg border border-input bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-semibold">{dirty ? "Unsaved schedule changes" : "Review school schedule"}</p><p className="mt-1 text-xs text-muted-foreground">Includes bells, A/B rotation and date overrides from both sections.</p></div>{dirty && <Button variant="ghost" size="sm" onClick={discard} disabled={busy}>Discard schedule draft</Button>}</div>
        <div className="flex flex-wrap items-center gap-3"><Button onClick={() => previewMutation.mutate()} disabled={busy || calendarDirty}>{previewMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CalendarDays className="mr-2 h-4 w-4" />}Preview changes</Button>{preview ? <Button disabled={busy || calendarDirty || preview.blockers.length > 0} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save reviewed schedule"}</Button> : null}</div>
        <p className="text-xs text-muted-foreground">{calendarDirty ? "Save or discard the calendar month draft before reviewing bell and A/B changes." : "Preview first, then save. Classes already in progress keep their times and roster."}</p>
      </div>
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
  const [section, setSection] = useState("profiles");
  const [advancedDirty, setAdvancedDirty] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileWorkspace, setProfileWorkspace] = useState(false);
  const query = useQuery({ queryKey: KEY, queryFn: () => apiRequest("GET", API) });
  if (query.isLoading) return <p className="flex items-center gap-2" role="status"><Loader2 className="h-4 w-4 animate-spin" />Loading school schedules…</p>;
  if (query.error) return <p role="alert" className="text-destructive">{message(query.error)}</p>;
  return query.data ? <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-5">
      <div><h2 className="text-2xl font-semibold">School scheduling</h2><p className="mt-1 max-w-2xl text-sm text-muted-foreground">Choose a task below. Everyday bells, special schedules and calendar dates each have their own place.</p></div>
      {query.data.schoolTimezone && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Clock3 className="h-4 w-4" />{query.data.schoolTimezone}</p>}
    </div>
    <Tabs value={section} onValueChange={setSection} orientation="vertical" className={profileWorkspace && section === 'profiles' ? 'space-y-5' : 'grid items-start gap-6 lg:grid-cols-[240px_minmax(0,1fr)]'}>
      <div hidden={profileWorkspace && section === 'profiles'} inert={(profileWorkspace && section === 'profiles') || undefined} className="space-y-5 lg:sticky lg:top-5">
        <TabsList aria-label="Scheduling tasks" className="flex h-auto w-full flex-col items-stretch gap-1 rounded-lg border bg-card p-2">
          {sections.map(({ value, label, description, icon }) => <TabsTrigger key={value} value={value} aria-label={label} className="justify-start gap-3 whitespace-normal px-3 py-3 text-left data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none">{createElement(icon, { className: "h-5 w-5 shrink-0", "aria-hidden": true })}<span><span className="block">{label}</span><span className="mt-1 block text-xs font-normal text-muted-foreground">{description}</span></span></TabsTrigger>)}
        </TabsList>
        {advancedDirty && <p role="status" className="px-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300">You have an unsaved bell, rotation, date-override or calendar draft. It stays here when you switch sections.</p>}
        <div className="hidden space-y-2 px-2 text-sm lg:block"><h3 className="font-medium">Swapping two classes?</h3><p className="text-xs leading-relaxed text-muted-foreground">Schedule Changes handles a one-day exchange of class times and teacher approvals.</p>{advancedDirty || profileBusy ? <p className="text-xs text-muted-foreground">Finish or discard your draft before opening Schedule Changes.</p> : <Link to="/classpilot/admin/classes/schedule-changes" className="inline-flex items-center gap-1 text-xs font-medium text-primary underline underline-offset-4">Open Schedule Changes<ArrowRight className="h-3 w-3" /></Link>}</div>
      </div>
      <div className="min-w-0">
        <TabsContent value="profiles" forceMount className={panelClass}><ScheduleProfiles blockedByAdvancedDraft={advancedDirty} onBusyChange={setProfileBusy} onWorkspaceChange={setProfileWorkspace} /></TabsContent>
        <SchedulingEditor key={query.data.revision} initial={query.data} onDirtyChange={setAdvancedDirty} section={section} disabled={profileBusy} />
      </div>
    </Tabs>
  </div> : null;
}
