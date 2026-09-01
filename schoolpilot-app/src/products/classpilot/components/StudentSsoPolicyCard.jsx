import { createElement, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Route,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { Switch } from "../../../components/ui/switch";
import { useToast } from "../../../hooks/use-toast";
import { apiRequest, queryClient } from "../../../lib/queryClient";

const QUERY_KEY = ["/api/classpilot/admin/sso-policy"];
const BUILT_IN_IDS = new Set(["clever", "google"]);

function clonePolicy(policy) {
  return {
    schemaVersion: 1,
    enabled: policy?.enabled === true,
    defaultProfileId: policy?.defaultProfileId || null,
    attemptTtlSeconds: 300,
    profiles: Array.isArray(policy?.profiles)
      ? policy.profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          startUrl: profile.startUrl,
          hostRules: Array.isArray(profile.hostRules)
            ? profile.hostRules.map((rule) => ({ ...rule }))
            : [],
        }))
      : [],
  };
}

function policyError(error, fallback = "Student sign-in policy could not be loaded.") {
  const issues = error?.response?.data?.issues;
  if (Array.isArray(issues) && issues[0]?.message) return issues[0].message;
  return error?.response?.data?.error || error?.message || fallback;
}

function ReadinessStep({ label, state, detail, icon }) {
  const stateClasses = state === "ready"
    ? "border-emerald-300 bg-emerald-50/80 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-100"
    : state === "warning"
      ? "border-amber-300 bg-amber-50/80 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
      : "border-slate-300 bg-white/80 text-slate-800 dark:border-slate-700 dark:bg-slate-950/50 dark:text-slate-200";
  return (
    <div className={`min-w-0 rounded-lg border p-3 ${stateClasses}`}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em]">
        {createElement(icon, { className: "h-4 w-4 shrink-0", "aria-hidden": true })}
        {label}
      </div>
      <p className="mt-2 text-sm leading-snug">{detail}</p>
    </div>
  );
}

function ReadinessStrip({ response }) {
  const readiness = response.extensionReadiness || {};
  const recent = readiness.recentlyActiveBindings || 0;
  const ready = readiness.readyBindings || 0;
  const observed = readiness.observedBindings || 0;
  const policyDetail = response.policyValid === false
    ? "Stored policy is invalid and is being treated as off. Save to repair it."
    : response.policy?.enabled
      ? `Policy revision ${response.revision} enables temporary sign-in.`
      : `Policy revision ${response.revision} is saved but turned off.`;
  const gateActive = response.operatorGateActive === true;
  let deviceDetail = "No current student binding has checked in during the five-minute evidence window.";
  let deviceState = "neutral";
  if (recent > 0 && ready === recent) {
    deviceDetail = `${ready} of ${recent} recent bindings reported and negotiated the required capability.`;
    deviceState = "ready";
  } else if (recent > 0) {
    deviceDetail = `${ready} of ${recent} recent bindings are ready; ${observed} supplied capability evidence.`;
    deviceState = "warning";
  }

  return (
    <div className="grid gap-3 md:grid-cols-3" aria-label="Sign-in policy preflight">
      <ReadinessStep
        label="Policy"
        state={response.policyValid === false ? "warning" : "ready"}
        detail={policyDetail}
        icon={Route}
      />
      <ReadinessStep
        label="Server rollout"
        state={gateActive ? "ready" : "warning"}
        detail={gateActive
          ? "The exact-school operator gate is on."
          : "The operator gate is off; this policy remains operationally inert."}
        icon={ShieldCheck}
      />
      <ReadinessStep
        label="Chromebook evidence"
        state={deviceState}
        detail={deviceDetail}
        icon={KeyRound}
      />
    </div>
  );
}

function HostRuleEditor({ profileId, rule, ruleIndex, onChange, onRemove, removable, locked }) {
  const fieldId = `sso-host-${profileId}-${ruleIndex}`;
  return (
    <div className="grid gap-3 rounded-md border bg-background p-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
      <div className="space-y-1.5">
        <Label htmlFor={fieldId}>Approved authentication host</Label>
        <Input
          id={fieldId}
          value={rule.hostname}
          onChange={(event) => onChange({ ...rule, hostname: event.target.value })}
          placeholder="login.example.edu"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          readOnly={locked}
          aria-readonly={locked}
        />
      </div>
      <div className="flex min-h-10 items-center gap-2">
        <Switch
          id={`${fieldId}-subdomains`}
          checked={rule.includeSubdomains === true}
          onCheckedChange={(checked) => onChange({ ...rule, includeSubdomains: checked })}
          disabled={locked}
        />
        <Label htmlFor={`${fieldId}-subdomains`} className="whitespace-nowrap text-xs font-normal">
          Include subdomains
        </Label>
      </div>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={onRemove}
        disabled={!removable}
        aria-label={`Remove ${rule.hostname || "host rule"}`}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

function ProviderEditor({ profile, isDefault, onChange, onRemove }) {
  const builtIn = BUILT_IN_IDS.has(profile.id);
  const clever = profile.id === "clever";
  const editableRules = !builtIn;
  const updateRule = (ruleIndex, rule) => {
    const hostRules = profile.hostRules.map((current, index) => index === ruleIndex ? rule : current);
    onChange({ ...profile, hostRules });
  };
  const removeRule = (ruleIndex) => {
    onChange({ ...profile, hostRules: profile.hostRules.filter((_, index) => index !== ruleIndex) });
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-950/30" aria-labelledby={`provider-${profile.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h4 id={`provider-${profile.id}`} className="font-semibold">{profile.name || "Unnamed provider"}</h4>
            {builtIn ? <Badge variant="secondary">Built in</Badge> : <Badge variant="outline">Custom</Badge>}
            {isDefault ? <Badge className="bg-amber-400 text-slate-950 hover:bg-amber-400">Starts first</Badge> : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {builtIn
              ? clever
                ? "Clever supports its subdomains and exact Google Accounts for district sign-in."
                : "Google uses exact accounts.google.com only."
              : "Custom rules must name only the identity-provider hosts needed during authentication."}
          </p>
        </div>
        {!builtIn ? (
          <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
            <Trash2 className="mr-2 h-4 w-4" /> Remove provider
          </Button>
        ) : null}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {!builtIn ? (
          <div className="space-y-1.5">
            <Label htmlFor={`provider-name-${profile.id}`}>Provider name</Label>
            <Input
              id={`provider-name-${profile.id}`}
              value={profile.name}
              onChange={(event) => onChange({ ...profile, name: event.target.value })}
              placeholder="District Okta"
            />
          </div>
        ) : null}
        <div className={`space-y-1.5 ${builtIn ? "sm:col-span-2" : ""}`}>
          <Label htmlFor={`provider-url-${profile.id}`}>Start URL</Label>
          <Input
            id={`provider-url-${profile.id}`}
            value={profile.startUrl}
            onChange={(event) => onChange({ ...profile, startUrl: event.target.value })}
            readOnly={builtIn && !clever}
            aria-readonly={builtIn && !clever}
            placeholder="https://login.example.edu/start"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            {clever
              ? "Use your district Clever launch URL. HTTPS query parameters are supported."
              : builtIn
                ? "The Google start URL is fixed to the approved authentication host."
                : "The URL must be HTTPS and match one of this provider’s host rules."}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label>Host rules</Label>
          {editableRules ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onChange({
                ...profile,
                hostRules: [...profile.hostRules, { hostname: "", includeSubdomains: false }],
              })}
              disabled={profile.hostRules.length >= 12}
            >
              <Plus className="mr-2 h-4 w-4" /> Add host
            </Button>
          ) : null}
        </div>
        {profile.hostRules.map((rule, ruleIndex) => (
          <HostRuleEditor
            key={`${profile.id}-${ruleIndex}`}
            profileId={profile.id}
            rule={rule}
            ruleIndex={ruleIndex}
            onChange={(nextRule) => updateRule(ruleIndex, nextRule)}
            onRemove={() => removeRule(ruleIndex)}
            removable={editableRules && profile.hostRules.length > 1}
            locked={!editableRules}
          />
        ))}
      </div>
    </section>
  );
}

function PolicyEditor({ response, refetch }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState(() => clonePolicy(response.policy));
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(null);
  const [serverError, setServerError] = useState("");

  const updateDraft = (updater) => {
    setDraft((current) => typeof updater === "function" ? updater(current) : updater);
    setDirty(true);
    setConflict(null);
    setServerError("");
  };

  const mutation = useMutation({
    mutationFn: () => apiRequest("PATCH", "/classpilot/admin/sso-policy", {
      expectedRevision: response.revision,
      policy: draft,
    }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(QUERY_KEY, saved);
      setDraft(clonePolicy(saved.policy));
      setDirty(false);
      setConflict(null);
      setServerError("");
      toast({
        title: "Student sign-in policy saved",
        description: saved.operatorGateActive
          ? "The server rollout is active; Chromebook readiness is reported separately."
          : "The policy is saved and remains inactive until the school rollout gate is enabled.",
      });
    },
    onError: (error) => {
      if (error?.response?.status === 409) {
        setConflict(error.response.data?.current || true);
        return;
      }
      setServerError(policyError(error, "Policy was not saved."));
    },
  });

  const replaceProfile = (profileIndex, profile) => updateDraft((current) => ({
    ...current,
    profiles: current.profiles.map((item, index) => index === profileIndex ? profile : item),
  }));
  const removeProfile = (profileIndex) => updateDraft((current) => {
    const removed = current.profiles[profileIndex];
    const profiles = current.profiles.filter((_, index) => index !== profileIndex);
    const defaultProfileId = current.defaultProfileId === removed?.id
      ? profiles[0]?.id || null
      : current.defaultProfileId;
    return { ...current, profiles, defaultProfileId };
  });
  const addCustomProvider = () => updateDraft((current) => {
    const suffix = Date.now().toString(36);
    const profile = {
      id: `custom-${suffix}`,
      name: "Custom provider",
      startUrl: "",
      hostRules: [{ hostname: "", includeSubdomains: false }],
    };
    return {
      ...current,
      defaultProfileId: current.defaultProfileId || profile.id,
      profiles: [...current.profiles, profile],
    };
  });
  const loadLatest = async () => {
    if (conflict && conflict !== true) {
      queryClient.setQueryData(QUERY_KEY, conflict);
      setDraft(clonePolicy(conflict.policy));
      setDirty(false);
      setConflict(null);
      return;
    }
    await refetch();
    setConflict(null);
  };

  return (
    <div className="space-y-6">
      <ReadinessStrip response={response} />

      <div className="flex flex-col gap-4 rounded-xl border-2 border-slate-800 bg-slate-950 p-4 text-white sm:flex-row sm:items-center sm:justify-between dark:border-slate-600">
        <div>
          <Label htmlFor="waypoint-student-sign-in" className="text-sm font-semibold text-white">
            Allow approved sign-in during Waypoints and Flight Paths
          </Label>
          <p id="waypoint-student-sign-in-description" className="mt-1 max-w-2xl text-sm text-slate-300">
            Students may temporarily visit only the identity-provider hosts below. Reaching a provider never counts as reaching the assigned destination.
          </p>
        </div>
        <Switch
          id="waypoint-student-sign-in"
          checked={draft.enabled}
          onCheckedChange={(enabled) => updateDraft({ ...draft, enabled })}
          aria-describedby="waypoint-student-sign-in-description"
          data-testid="switch-waypoint-student-sign-in"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_230px] sm:items-end">
        <div>
          <Label htmlFor="sso-default-provider" className="font-semibold">First stop for a signed-out student</Label>
          <p className="mt-1 text-sm text-muted-foreground">
            Cold or deferred restrictions open this provider before the teacher’s destination.
          </p>
        </div>
        <Select
          value={draft.defaultProfileId || undefined}
          onValueChange={(defaultProfileId) => updateDraft({ ...draft, defaultProfileId })}
          disabled={draft.profiles.length === 0}
        >
          <SelectTrigger id="sso-default-provider" data-testid="select-sso-default-provider">
            <SelectValue placeholder="Choose a provider" />
          </SelectTrigger>
          <SelectContent>
            {draft.profiles.map((profile) => (
              <SelectItem key={profile.id} value={profile.id}>{profile.name || profile.id}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">Approved identity providers</h3>
            <p className="text-sm text-muted-foreground">Exact hosts are safest. Include subdomains only when the provider requires them.</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addCustomProvider} disabled={draft.profiles.length >= 12}>
            <Plus className="mr-2 h-4 w-4" /> Add custom provider
          </Button>
        </div>
        {draft.profiles.map((profile, profileIndex) => (
          <ProviderEditor
            key={profile.id}
            profile={profile}
            isDefault={draft.defaultProfileId === profile.id}
            onChange={(nextProfile) => replaceProfile(profileIndex, nextProfile)}
            onRemove={() => removeProfile(profileIndex)}
          />
        ))}
      </div>

      {response.conflicts?.length ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100" role="alert" data-testid="sso-policy-block-conflicts">
          <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" /> Block-policy conflict</p>
          <p className="mt-1">One or more authentication hosts also match the school blocked-domain list. Blocks stay authoritative, so sign-in may fail until the conflict is resolved.</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {response.conflicts.map((conflict) => (
              <li key={`${conflict.profileId}-${conflict.hostname}-${conflict.blockedDomain}`}>
                {conflict.hostname} conflicts with {conflict.blockedDomain}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-lg border bg-muted/35 p-4 text-sm">
          <p className="flex items-center gap-2 font-medium"><CheckCircle2 className="h-4 w-4 text-emerald-600" /> School block check is clear</p>
          <p className="mt-1 text-muted-foreground">Attention, school blocks, and teacher block lists remain authoritative over this sign-in policy.</p>
        </div>
      )}

      {serverError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          {serverError}
        </div>
      ) : null}
      {conflict ? (
        <div className="flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100" role="alert" data-testid="sso-policy-revision-conflict">
          <p>Another administrator saved this policy. Load the latest revision before saving again.</p>
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={loadLatest}>
            <RefreshCw className="mr-2 h-4 w-4" /> Load latest policy
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-3 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          Evidence reflects exact active student bindings observed in the last {response.extensionReadiness?.observationWindowSeconds || 300} seconds—not every device in the fleet.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" asChild>
            <a href="/classpilot/admin/it-readiness">IT Readiness <ExternalLink className="ml-2 h-4 w-4" /></a>
          </Button>
          <Button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={!dirty || mutation.isPending || draft.profiles.length === 0 || !draft.defaultProfileId}
            data-testid="button-save-sso-policy"
          >
            {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save sign-in policy
          </Button>
        </div>
      </div>
    </div>
  );
}

export function StudentSsoPolicyCard({ canManage }) {
  const settingsQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => apiRequest("GET", "/classpilot/admin/sso-policy"),
    enabled: canManage === true,
  });

  const response = settingsQuery.data;
  const editorKey = useMemo(
    () => response ? `${response.revision}-${response.policyValid !== false}` : "loading",
    [response]
  );

  if (!canManage) return null;

  return (
    <Card
      id="student-sign-in-during-waypoints"
      role="region"
      aria-labelledby="student-sign-in-during-waypoints-title"
      className="overflow-hidden border-slate-300 dark:border-slate-700"
      data-testid="card-student-sso-policy"
    >
      <CardHeader className="relative overflow-hidden border-b border-slate-700 bg-slate-900 text-white">
        <div className="absolute inset-y-0 right-0 w-36 -skew-x-12 bg-amber-400/10" aria-hidden="true" />
        <CardTitle id="student-sign-in-during-waypoints-title" className="relative flex items-center gap-2 text-base">
          <KeyRound className="h-5 w-5 text-amber-300" /> Student Sign-In During Waypoints
        </CardTitle>
        <CardDescription className="relative max-w-2xl text-slate-300">
          Give restricted students a narrow, school-approved route through Clever, Google, or another identity provider—without opening general browsing.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6">
        {settingsQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading student sign-in policy…
          </div>
        ) : settingsQuery.error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
            {policyError(settingsQuery.error)}
            <Button type="button" variant="link" className="ml-2 h-auto p-0 text-destructive" onClick={() => settingsQuery.refetch()}>
              Try again
            </Button>
          </div>
        ) : response ? (
          <PolicyEditor key={editorKey} response={response} refetch={settingsQuery.refetch} />
        ) : null}
      </CardContent>
    </Card>
  );
}
