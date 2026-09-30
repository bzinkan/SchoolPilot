import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../../../lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { Button } from "../../../../components/ui/button";
import { Input } from "../../../../components/ui/input";
import { Label } from "../../../../components/ui/label";
import { Switch } from "../../../../components/ui/switch";
import { Skeleton } from "../../../../components/ui/skeleton";
import { toast } from "../../../../hooks/use-toast";

// PassPilot issuance rules. Backend-first: nothing is shown as saved until a
// fresh GET after the write returns the saved values.
const RULES_PATH = "/passpilot/admin/rules";
const DESTINATION_LABELS = {
  bathroom: "Bathroom",
  nurse: "Nurse",
  office: "Office",
  counselor: "Counselor",
  other_classroom: "Other classroom",
};

function rulesErrorMessage(error, fallback = "Try again.") {
  const data = error?.response?.data;
  if (data?.error && data?.code) return `${data.error} (${data.code})`;
  return data?.error || error?.message || fallback;
}

function studentName(student) {
  if (!student) return "Student no longer on the roster";
  const name = `${student.lastName}, ${student.firstName}`;
  return student.status === "active" ? name : `${name} (inactive)`;
}

/** Empty means "no limit"; otherwise a whole number from 0 through 50. */
function parseLimit(value) {
  if (value.trim() === "") return { valid: true, value: null };
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 50
    ? { valid: true, value: number }
    : { valid: false, value: null };
}

function formatLimit(value) {
  return value === null || value === undefined ? "" : String(value);
}

function downloadJson(fileName, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function StudentPicker({ id, label, value, onChange }) {
  const [term, setTerm] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(term.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [term]);
  const results = useQuery({
    queryKey: ["passpilot-rules-student-search", search],
    queryFn: () => apiRequest("GET", "/students", undefined, { params: { search } }),
    enabled: search.length >= 2,
    staleTime: 30_000,
  });
  const students = (results.data?.students ?? []).slice(0, 25);
  const placeholder = search.length < 2
    ? "Type at least 2 characters"
    : results.isFetching
      ? "Searching…"
      : `${students.length} ${students.length === 1 ? "match" : "matches"}`;

  return (
    <div className="space-y-1">
      <Label htmlFor={`${id}-search`}>{label}</Label>
      <Input
        id={`${id}-search`}
        data-testid={`input-${id}-search`}
        placeholder="Search by name or ID"
        value={term}
        onChange={(event) => {
          setTerm(event.target.value);
          onChange("");
        }}
      />
      <select
        id={id}
        aria-label={label}
        data-testid={`select-${id}`}
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{placeholder}</option>
        {students.map((student) => (
          <option key={student.id} value={student.id}>
            {student.lastName}, {student.firstName}
            {student.studentIdNumber ? ` (${student.studentIdNumber})` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

function DestinationRow({ destination, policy, busy, onSave, onRemove }) {
  const label = DESTINATION_LABELS[destination] ?? destination;
  // The parent keys this row by the saved values, so local edits reset
  // whenever the server copy changes.
  const [enabled, setEnabled] = useState(policy?.enabled ?? true);
  const [capacity, setCapacity] = useState(policy ? String(policy.maxConcurrent) : "");
  const parsed = Number(capacity);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 500;

  return (
    <div className="flex flex-wrap items-end gap-3 border-b py-3 last:border-b-0" data-testid={`row-capacity-${destination}`}>
      <div className="w-40 space-y-1">
        <Label htmlFor={`capacity-${destination}`}>{label}</Label>
        <Input
          id={`capacity-${destination}`}
          data-testid={`input-capacity-${destination}`}
          type="number"
          min={1}
          max={500}
          placeholder="No limit"
          value={capacity}
          onChange={(event) => setCapacity(event.target.value)}
        />
      </div>
      <div className="flex items-center gap-2 pb-2">
        <Switch
          id={`capacity-enabled-${destination}`}
          data-testid={`switch-capacity-${destination}`}
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={`Enforce ${label} capacity`}
        />
        <Label htmlFor={`capacity-enabled-${destination}`} className="text-sm font-normal">Enforce</Label>
      </div>
      <Button
        type="button"
        size="sm"
        data-testid={`button-save-capacity-${destination}`}
        disabled={!valid || busy}
        onClick={() => onSave(destination, { maxConcurrent: parsed, enabled })}
      >
        Save
      </Button>
      {policy ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid={`button-remove-capacity-${destination}`}
          disabled={busy}
          onClick={() => onRemove(destination)}
        >
          Remove
        </Button>
      ) : null}
    </div>
  );
}

function DefaultLimits({ limits, busy, onSave, onRemove }) {
  // Keyed by the saved values in the parent, like DestinationRow.
  const [daily, setDaily] = useState(formatLimit(limits?.dailyLimit));
  const [period, setPeriod] = useState(formatLimit(limits?.periodLimit));
  const [enabled, setEnabled] = useState(limits?.enabled ?? true);
  const dailyLimit = parseLimit(daily);
  const periodLimit = parseLimit(period);
  const valid = dailyLimit.valid && periodLimit.valid && (dailyLimit.value !== null || periodLimit.value !== null);

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="w-36 space-y-1">
        <Label htmlFor="rules-daily-limit">Passes per day</Label>
        <Input id="rules-daily-limit" data-testid="input-daily-limit" type="number" min={0} max={50}
          placeholder="No limit" value={daily} onChange={(event) => setDaily(event.target.value)} />
      </div>
      <div className="w-36 space-y-1">
        <Label htmlFor="rules-period-limit">Passes per period</Label>
        <Input id="rules-period-limit" data-testid="input-period-limit" type="number" min={0} max={50}
          placeholder="No limit" value={period} onChange={(event) => setPeriod(event.target.value)} />
      </div>
      <div className="flex items-center gap-2 pb-2">
        <Switch id="rules-default-enabled" data-testid="switch-default-limits" checked={enabled}
          onCheckedChange={setEnabled} aria-label="Enforce the school limits" />
        <Label htmlFor="rules-default-enabled" className="text-sm font-normal">Enforce</Label>
      </div>
      <Button type="button" size="sm" data-testid="button-save-default-limits" disabled={!valid || busy}
        onClick={() => onSave({ dailyLimit: dailyLimit.value, periodLimit: periodLimit.value, enabled })}>
        Save
      </Button>
      {limits ? (
        <Button type="button" size="sm" variant="ghost" data-testid="button-remove-default-limits" disabled={busy} onClick={onRemove}>
          Remove
        </Button>
      ) : null}
    </div>
  );
}

export default function RulesTab({ rulesQueryKey }) {
  const rulesQuery = useQuery({
    queryKey: rulesQueryKey,
    queryFn: () => apiRequest("GET", RULES_PATH),
    retry: false,
  });
  const writing = useRef(false);
  const [busy, setBusy] = useState(false);
  const [unverified, setUnverified] = useState(false);
  const [limitStudentId, setLimitStudentId] = useState("");
  const [limitDaily, setLimitDaily] = useState("");
  const [limitPeriod, setLimitPeriod] = useState("");
  const [studentA, setStudentA] = useState("");
  const [studentB, setStudentB] = useState("");
  const [note, setNote] = useState("");

  // One write at a time; each is confirmed by a fresh GET before success shows.
  const save = async (method, path, body, isSaved) => {
    if (writing.current) return false;
    writing.current = true;
    setBusy(true);
    try {
      await apiRequest(method, `${RULES_PATH}${path}`, body);
      const refreshed = await rulesQuery.refetch();
      if (refreshed.error || !refreshed.data || !isSaved(refreshed.data)) {
        setUnverified(true);
        toast({
          title: "Saved rules could not be verified",
          description: "Reload the rules and check them before relying on this change.",
          variant: "destructive",
        });
        return false;
      }
      setUnverified(false);
      toast({ title: "Rules saved" });
      return true;
    } catch (error) {
      toast({ title: "Rules were not saved", description: rulesErrorMessage(error), variant: "destructive" });
      await rulesQuery.refetch();
      return false;
    } finally {
      writing.current = false;
      setBusy(false);
    }
  };

  if (rulesQuery.isLoading) {
    return (
      <div className="mt-4 space-y-4" aria-live="polite">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-64 w-full" />
        <span className="sr-only">Loading pass rules</span>
      </div>
    );
  }
  if (rulesQuery.isError || !rulesQuery.data) {
    return (
      <Card className="mt-4 border-destructive/40">
        <CardContent className="p-8 text-center">
          <h3 className="font-semibold">Pass rules couldn’t be loaded</h3>
          <p className="mt-2 text-sm text-muted-foreground">Try again. No rules were changed.</p>
          <Button type="button" variant="outline" className="mt-4" onClick={() => rulesQuery.refetch()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  const rules = rulesQuery.data;
  const policies = new Map((rules.destinationPolicies ?? []).map((policy) => [policy.destination, policy]));
  const periodLimitSet = rules.defaultLimits?.periodLimit != null
    || (rules.studentLimits ?? []).some((limit) => limit.periodLimit != null);
  const studentDaily = parseLimit(limitDaily);
  const studentPeriod = parseLimit(limitPeriod);
  const studentLimitValid = !!limitStudentId && studentDaily.valid && studentPeriod.valid
    && (studentDaily.value !== null || studentPeriod.value !== null);
  const encounterValid = !!studentA && !!studentB && studentA !== studentB && note.length <= 500;

  const saveDestination = (destination, value) => save("PUT", `/destinations/${destination}`, value,
    (data) => data.destinationPolicies.some((policy) => policy.destination === destination
      && policy.maxConcurrent === value.maxConcurrent && policy.enabled === value.enabled));
  const removeDestination = (destination) => save("DELETE", `/destinations/${destination}`, undefined,
    (data) => !data.destinationPolicies.some((policy) => policy.destination === destination));
  const saveDefault = (value) => save("PUT", "/limits/default", value,
    (data) => data.defaultLimits?.dailyLimit === value.dailyLimit
      && data.defaultLimits?.periodLimit === value.periodLimit && data.defaultLimits?.enabled === value.enabled);
  const removeDefault = () => save("DELETE", "/limits/default", undefined, (data) => data.defaultLimits === null);
  const addStudentLimit = async () => {
    const value = { dailyLimit: studentDaily.value, periodLimit: studentPeriod.value, enabled: true };
    const saved = await save("PUT", `/limits/students/${encodeURIComponent(limitStudentId)}`, value,
      (data) => data.studentLimits.some((limit) => limit.studentId === limitStudentId
        && limit.dailyLimit === value.dailyLimit && limit.periodLimit === value.periodLimit));
    if (saved) {
      setLimitStudentId("");
      setLimitDaily("");
      setLimitPeriod("");
    }
  };
  const removeStudentLimit = (studentId) => save("DELETE", `/limits/students/${encodeURIComponent(studentId)}`, undefined,
    (data) => !data.studentLimits.some((limit) => limit.studentId === studentId));
  const addEncounter = async () => {
    const pair = [studentA, studentB];
    const saved = await save("POST", "/encounters", { studentIdA: studentA, studentIdB: studentB, ...(note.trim() ? { reasonNote: note.trim() } : {}) },
      (data) => data.encounterRestrictions.some((restriction) =>
        pair.includes(restriction.studentAId) && pair.includes(restriction.studentBId)));
    if (saved) {
      setStudentA("");
      setStudentB("");
      setNote("");
    }
  };
  const toggleEncounter = (id, enabled) => save("PATCH", `/encounters/${encodeURIComponent(id)}`, { enabled },
    (data) => data.encounterRestrictions.some((restriction) => restriction.id === id && restriction.enabled === enabled));
  const removeEncounter = (id) => save("DELETE", `/encounters/${encodeURIComponent(id)}`, undefined,
    (data) => !data.encounterRestrictions.some((restriction) => restriction.id === id));
  const exportRecords = async (studentId) => {
    try {
      const records = await apiRequest("GET", `${RULES_PATH}/students/${encodeURIComponent(studentId)}/records`);
      downloadJson(`PassPilot_rule_records_${studentId}.json`, records);
    } catch (error) {
      toast({ title: "Records were not exported", description: rulesErrorMessage(error), variant: "destructive" });
    }
  };

  return (
    <div className="mt-4 space-y-4" data-testid="passpilot-rules">
      {unverified ? (
        <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm" data-testid="alert-rules-unverified">
          The last change could not be confirmed.{" "}
          <Button type="button" variant="link" className="h-auto p-0" onClick={() => rulesQuery.refetch()}>Reload rules</Button>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Destination capacity</CardTitle>
          <p className="text-sm text-muted-foreground">
            The most students who can be out to a destination at once. Passes still out from an earlier day do not count.
          </p>
        </CardHeader>
        <CardContent>
          {(rules.destinations ?? []).map((destination) => {
            const policy = policies.get(destination);
            return (
              <DestinationRow key={`${destination}:${policy?.maxConcurrent ?? ""}:${policy?.enabled ?? ""}`}
                destination={destination} policy={policy} busy={busy} onSave={saveDestination} onRemove={removeDestination} />
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pass limits</CardTitle>
          <p className="text-sm text-muted-foreground">
            School-wide limits apply to every student. A student limit replaces the school value it sets. Leave a field empty for no limit.
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          <DefaultLimits
            key={`${rules.defaultLimits?.dailyLimit ?? ""}:${rules.defaultLimits?.periodLimit ?? ""}:${rules.defaultLimits?.enabled ?? ""}`}
            limits={rules.defaultLimits} busy={busy} onSave={saveDefault} onRemove={removeDefault} />
          {periodLimitSet && rules.periodEnforcement !== "bell_schedule" ? (
            <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="alert-period-enforcement">
              {rules.periodEnforcement === "unavailable"
                ? "Period limits are saved but not enforced: this school has no bell schedule, scheduled class sessions or scheduled kiosk blocks to define a period."
                : "This school has no bell schedule, so period limits apply only while a scheduled class session or kiosk block is in progress."}
            </div>
          ) : null}

          <div className="space-y-3 border-t pt-4">
            <h4 className="text-sm font-semibold">Student limits</h4>
            <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr_auto] md:items-end">
              <StudentPicker id="student-limit-student" label="Student" value={limitStudentId} onChange={setLimitStudentId} />
              <div className="space-y-1">
                <Label htmlFor="student-daily-limit">Per day</Label>
                <Input id="student-daily-limit" data-testid="input-student-daily-limit" type="number" min={0} max={50}
                  placeholder="School value" value={limitDaily} onChange={(event) => setLimitDaily(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="student-period-limit">Per period</Label>
                <Input id="student-period-limit" data-testid="input-student-period-limit" type="number" min={0} max={50}
                  placeholder="School value" value={limitPeriod} onChange={(event) => setLimitPeriod(event.target.value)} />
              </div>
              <Button type="button" data-testid="button-add-student-limit" disabled={!studentLimitValid || busy} onClick={addStudentLimit}>
                Save student limit
              </Button>
            </div>
            {(rules.studentLimits ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No student limits.</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {rules.studentLimits.map((limit) => (
                  <li key={limit.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm" data-testid={`row-student-limit-${limit.studentId}`}>
                    <span>
                      <span className="font-medium">{studentName(limit.student)}</span>
                      {" · "}{limit.dailyLimit ?? "school"} per day · {limit.periodLimit ?? "school"} per period
                      {limit.enabled ? "" : " · not enforced"}
                    </span>
                    <span className="flex gap-2">
                      <Button type="button" size="sm" variant="outline" data-testid={`button-export-records-${limit.studentId}`}
                        onClick={() => exportRecords(limit.studentId)}>
                        Export records
                      </Button>
                      <Button type="button" size="sm" variant="ghost" data-testid={`button-remove-student-limit-${limit.studentId}`}
                        disabled={busy} onClick={() => removeStudentLimit(limit.studentId)}>
                        Remove
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Encounter restrictions</CardTitle>
          <p className="text-sm text-muted-foreground">
            Two students in a restriction cannot be out at the same time. Teachers, office staff and students see only that a pass
            isn&apos;t available right now; they are never told a restriction exists or who it involves.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <StudentPicker id="encounter-student-a" label="First student" value={studentA} onChange={setStudentA} />
            <StudentPicker id="encounter-student-b" label="Second student" value={studentB} onChange={setStudentB} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="encounter-note">Private note for administrators (optional)</Label>
            <Input id="encounter-note" data-testid="input-encounter-note" maxLength={500} value={note}
              onChange={(event) => setNote(event.target.value)} />
          </div>
          <Button type="button" data-testid="button-add-encounter" disabled={!encounterValid || busy} onClick={addEncounter}>
            Add restriction
          </Button>
          {(rules.encounterRestrictions ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No encounter restrictions.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {rules.encounterRestrictions.map((restriction) => {
                const byId = new Map((restriction.students ?? []).map((student) => [student.id, student]));
                return (
                  <li key={restriction.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm" data-testid={`row-encounter-${restriction.id}`}>
                    <span>
                      <span className="font-medium">{studentName(byId.get(restriction.studentAId))}</span>
                      {" and "}
                      <span className="font-medium">{studentName(byId.get(restriction.studentBId))}</span>
                      {restriction.reasonNote ? <span className="block text-muted-foreground">{restriction.reasonNote}</span> : null}
                    </span>
                    <span className="flex items-center gap-2">
                      <Switch data-testid={`switch-encounter-enabled-${restriction.id}`} checked={restriction.enabled} disabled={busy}
                        onCheckedChange={(enabled) => toggleEncounter(restriction.id, enabled)} aria-label="Enforce this restriction" />
                      <Button type="button" size="sm" variant="ghost" data-testid={`button-remove-encounter-${restriction.id}`}
                        disabled={busy} onClick={() => removeEncounter(restriction.id)}>
                        Remove
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Pass denial records are kept for {rules.denialRetentionDays ?? 400} days. Limits and restrictions stay until an administrator removes them.
      </p>
    </div>
  );
}
