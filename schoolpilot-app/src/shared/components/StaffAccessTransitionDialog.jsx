import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useToast } from "../../hooks/use-toast";
import { apiRequest, queryClient } from "../../lib/queryClient";

const TEACHABLE_ROLES = new Set(["teacher", "admin", "school_admin"]);
const ACTIVE_STAFF_ROLES = new Set([...TEACHABLE_ROLES, "office_staff"]);
const ACTIVE_STAFF_DEPENDENCIES = new Set([
  "coverage_assignment",
  "central_email_recipient",
]);

function identityLabel(staff) {
  const name = staff?.displayName
    || [staff?.first_name || staff?.firstName, staff?.last_name || staff?.lastName].filter(Boolean).join(" ")
    || [staff?.user?.firstName, staff?.user?.lastName].filter(Boolean).join(" ")
    || staff?.email
    || staff?.user?.email
    || "Staff member";
  const email = staff?.email || staff?.user?.email;
  return email && email !== name ? `${name} — ${email}` : name;
}

function errorMessage(error) {
  return error?.response?.data?.error || error?.message || "The request could not be completed.";
}

function assignmentImpactUrl(apiBasePath, membershipId, transitionAction, newRole, newGopilotRole) {
  const baseUrl = `${apiBasePath}/${membershipId}/assignment-impact`;
  if (transitionAction !== "change_role") return baseUrl;

  const parameters = ["action=change_role"];
  if (newRole !== undefined) parameters.push(`newRole=${encodeURIComponent(newRole)}`);
  if (newGopilotRole !== undefined) {
    parameters.push(`newGopilotRole=${newGopilotRole === null ? "null" : encodeURIComponent(newGopilotRole)}`);
  }
  return `${baseUrl}?${parameters.join("&")}`;
}

function dependencyKindLabel(kind) {
  const labels = {
    class_primary: "Primary class teacher",
    class_co_teacher: "Class co-teacher",
    passpilot_legacy_class: "PassPilot class",
    gopilot_homeroom_primary: "Primary homeroom teacher",
    gopilot_homeroom_co_teacher: "Homeroom co-teacher",
    coverage_assignment: "Coverage assignment",
    teacher_student_assignment: "Direct student assignment",
    flight_path: "Flight Path owner",
    block_list: "Block List owner",
    student_group: "Student Group owner",
    central_email_recipient: "Central session-summary recipient",
  };
  return labels[kind] || "School assignment";
}

function blockerKindLabel(kind) {
  const labels = {
    active_teaching_session: "Active teaching session",
    active_supervision_context: "Active supervision context",
    active_kiosk_session: "Active kiosk session",
    active_schedule_change: "Active schedule change",
    active_scheduled_conflict: "Active scheduled conflict",
  };
  return labels[kind] || "Active workflow";
}

function staffRoleLabel(role) {
  const labels = {
    teacher: "Teacher",
    office_staff: "Office Staff",
    admin: "Administrator",
    school_admin: "School Administrator",
  };
  return labels[role] || "the selected role";
}

export default function StaffAccessTransitionDialog({
  open,
  onOpenChange,
  staff,
  allStaff,
  apiBasePath = "/users/staff",
  transitionAction = "deactivate",
  newRole,
  newGopilotRole,
  onTransitionComplete,
}) {
  const { toast } = useToast();
  const [decisionOverrides, setDecisionOverrides] = useState({});
  const impactUrl = assignmentImpactUrl(
    apiBasePath,
    staff?.membershipId,
    transitionAction,
    newRole,
    newGopilotRole,
  );

  const impactQuery = useQuery({
    queryKey: ["staff-assignment-impact", apiBasePath, staff?.membershipId, transitionAction, newRole, newGopilotRole],
    queryFn: () => apiRequest("GET", impactUrl),
    enabled: open && Boolean(staff?.membershipId),
  });

  const replacementCandidates = useMemo(() => {
    const byMembershipId = new Map();
    for (const candidate of allStaff || []) {
      const effectiveRole = candidate.effectiveRole
        || String(candidate.gopilotRole || "").trim()
        || candidate.role;
      if (
        (candidate.status || "active") !== "active"
        || !(candidate.membershipId || candidate.id)
        || candidate.userId === staff?.userId
        || (candidate.membershipId || candidate.id) === staff?.membershipId
        || (!ACTIVE_STAFF_ROLES.has(candidate.role) && !ACTIVE_STAFF_ROLES.has(effectiveRole))
      ) {
        continue;
      }
      const membershipId = candidate.membershipId || candidate.id;
      if (!byMembershipId.has(membershipId)) {
        byMembershipId.set(membershipId, { ...candidate, membershipId });
      }
    }
    return Array.from(byMembershipId.values()).sort((a, b) => identityLabel(a).localeCompare(identityLabel(b)));
  }, [allStaff, staff?.membershipId, staff?.userId]);

  const impact = impactQuery.data?.impact;
  const dependencies = impact?.assignments || [];
  const blockers = impact?.blockers || [];
  const decisions = dependencies.map((dependency) => {
    const decisionKey = `${dependency.assignmentType}:${dependency.assignmentId}`;
    const override = decisionOverrides[decisionKey];
    return {
      assignmentType: dependency.assignmentType,
      assignmentId: dependency.assignmentId,
      operation: override?.operation || "",
      replacementMembershipId: override?.replacementMembershipId || "",
    };
  });
  const decisionsComplete = decisions.every((decision) => (
    decision.operation === "remove"
    || (decision.operation === "replace" && Boolean(decision.replacementMembershipId))
  ));
  const roleChangeComplete = transitionAction !== "change_role"
    || newRole !== undefined
    || newGopilotRole !== undefined;
  const transitionTargetLabel = staffRoleLabel(newGopilotRole ?? newRole);

  const transitionMutation = useMutation({
    mutationFn: () => apiRequest("POST", `${apiBasePath}/${staff.membershipId}/transition`, {
      expectedRevision: impact.revision,
      action: transitionAction,
      ...(newRole !== undefined ? { newRole } : {}),
      ...(newGopilotRole !== undefined ? { newGopilotRole } : {}),
      decisions: decisions.map((decision) => ({
        assignmentType: decision.assignmentType,
        assignmentId: decision.assignmentId,
        operation: decision.operation,
        ...(decision.operation === "replace" ? { replacementMembershipId: decision.replacementMembershipId } : {}),
      })),
    }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/users/staff"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/admin/teachers"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/classpilot/admin/classes"] }),
      ]);
      await onTransitionComplete?.(result);
      toast({
        title: transitionAction === "deactivate" ? "School access removed" : "Staff role changed",
        description: transitionAction === "deactivate"
          ? `${identityLabel(staff)} no longer has school access. Live relationships were reassigned or removed exactly as reviewed; history was retained.`
          : `${identityLabel(staff)} now has the selected role. Live assignments were transferred without changing history.`,
      });
      setDecisionOverrides({});
      onOpenChange(false);
    },
    onError: (error) => {
      const code = error?.response?.data?.code;
      if (code === "STAFF_ASSIGNMENT_IMPACT_STALE") {
        impactQuery.refetch();
        setDecisionOverrides({});
      }
      toast({
        variant: "destructive",
        title: code === "STAFF_ASSIGNMENT_IMPACT_STALE"
          ? "Assignments changed"
          : transitionAction === "deactivate"
            ? "Could not remove school access"
            : "Could not change staff role",
        description: code === "STAFF_ASSIGNMENT_IMPACT_STALE"
          ? "The impact review was refreshed. Review every assignment again before continuing."
          : errorMessage(error),
      });
    },
  });

  const changeDecision = (decisionKey, patch) => {
    setDecisionOverrides((previous) => ({
      ...previous,
      [decisionKey]: { ...previous[decisionKey], ...patch },
    }));
  };

  const handleOpenChange = (nextOpen) => {
    if (!nextOpen && !transitionMutation.isPending) setDecisionOverrides({});
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto" data-testid="dialog-staff-transition">
        <DialogHeader>
          <DialogTitle>{transitionAction === "deactivate" ? "Remove school access" : "Change staff role"}</DialogTitle>
          <DialogDescription>
            {transitionAction === "deactivate" ? "Remove school access for " : `Change the role to ${transitionTargetLabel} for `}
            <strong>{identityLabel(staff)}</strong>. Every assignment needs an explicit decision; historical records will be retained.
            {staff?.membershipId ? (
              <span className="mt-1 block font-mono text-xs">Authorized membership ID: {staff.membershipId}</span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {impactQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            Checking live assignments…
          </div>
        ) : impactQuery.isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            {errorMessage(impactQuery.error)}
          </div>
        ) : (
          <div className="space-y-5">
            {blockers.length > 0 ? (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-amber-950">
                <div className="flex items-center gap-2 font-medium">
                  <AlertTriangle className="h-4 w-4" />
                  Resolve these active workflows first
                </div>
                <ul className="mt-2 space-y-1 text-sm">
                  {blockers.map((blocker) => (
                    <li key={`${blocker.blockerType}-${blocker.blockerId}`}>
                      <span>{blockerKindLabel(blocker.blockerType)}: {blocker.label}</span>
                      <span className="ml-1 block font-mono text-[11px] text-amber-800" data-testid={`staff-blocker-ids-${blocker.blockerId}`}>
                        Blocker ID: {blocker.blockerId}
                        {blocker.resourceId ? ` · Resource ID: ${blocker.resourceId}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {dependencies.length === 0 ? (
              <div className="rounded-md border bg-muted/30 p-4 text-sm">
                No live teaching or operational assignments need to be transferred.
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <h3 className="font-medium">Live assignments</h3>
                  <p className="text-sm text-muted-foreground">
                    Choose an action for every assignment. Required ownership must have a replacement; optional relationships may be removed.
                  </p>
                </div>
                {dependencies.map((dependency, dependencyIndex) => {
                  const decisionKey = `${dependency.assignmentType}:${dependency.assignmentId}`;
                  const decision = decisions[dependencyIndex];
                  const eligibleReplacementCandidates = dependency.assignmentType.startsWith("gopilot_")
                    ? replacementCandidates.filter((candidate) => (
                        candidate.effectiveRole
                        || String(candidate.gopilotRole || "").trim()
                        || candidate.role
                      ) === "teacher")
                    : ACTIVE_STAFF_DEPENDENCIES.has(dependency.assignmentType)
                      ? replacementCandidates.filter((candidate) => ACTIVE_STAFF_ROLES.has(candidate.role))
                      : replacementCandidates.filter((candidate) => TEACHABLE_ROLES.has(candidate.role));
                  return (
                    <div
                      key={decisionKey}
                      className="space-y-3 rounded-md border p-4 [contain-intrinsic-size:0_220px] [content-visibility:auto]"
                      data-testid={`staff-dependency-${dependency.assignmentId}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-medium">{dependency.label}</p>
                          <p className="text-xs text-muted-foreground">{dependencyKindLabel(dependency.assignmentType)}</p>
                          <p className="mt-1 font-mono text-[11px] text-muted-foreground" data-testid={`staff-assignment-ids-${dependency.assignmentId}`}>
                            Assignment ID: {dependency.assignmentId} · Resource ID: {dependency.resourceId}
                          </p>
                        </div>
                        <Badge variant={dependency.required ? "default" : "secondary"}>
                          {dependency.required ? "Replacement required" : "Optional"}
                        </Badge>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor={`decision-action-${dependency.assignmentId}`}>Action</Label>
                        <Select
                          value={decision.operation}
                          onValueChange={(operation) => changeDecision(decisionKey, {
                            operation,
                            ...(operation === "remove" ? { replacementMembershipId: "" } : {}),
                          })}
                        >
                          <SelectTrigger id={`decision-action-${dependency.assignmentId}`}>
                            <SelectValue placeholder="Choose an action" />
                          </SelectTrigger>
                          <SelectContent>
                            {dependency.allowedOperations?.includes("remove") ? (
                              <SelectItem value="remove">Remove this relationship</SelectItem>
                            ) : null}
                            {dependency.allowedOperations?.includes("replace") ? (
                              <SelectItem value="replace">Transfer to another staff member</SelectItem>
                            ) : null}
                          </SelectContent>
                        </Select>
                      </div>

                      {decision.operation === "replace" ? (
                        <div className="space-y-2">
                          <Label htmlFor={`replacement-${dependency.assignmentId}`}>Replacement staff member</Label>
                          <Select
                            value={decision.replacementMembershipId}
                            onValueChange={(replacementMembershipId) => changeDecision(decisionKey, { replacementMembershipId })}
                          >
                            <SelectTrigger id={`replacement-${dependency.assignmentId}`} data-testid={`select-replacement-${dependency.assignmentId}`}>
                              <SelectValue placeholder="Choose an active teacher or administrator" />
                            </SelectTrigger>
                            <SelectContent>
                              {eligibleReplacementCandidates.map((candidate) => (
                                <SelectItem key={candidate.membershipId} value={candidate.membershipId}>
                                  {identityLabel(candidate)} · Membership ID: {candidate.membershipId}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {eligibleReplacementCandidates.length === 0 ? (
                            <p className="text-xs text-destructive">Add or reactivate another teachable staff member before continuing.</p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={transitionMutation.isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            data-testid="button-confirm-remove-access"
            onClick={() => transitionMutation.mutate()}
            disabled={
              impactQuery.isLoading
              || impactQuery.isError
              || blockers.length > 0
              || !decisionsComplete
              || !roleChangeComplete
              || transitionMutation.isPending
            }
          >
            {transitionMutation.isPending
              ? transitionAction === "deactivate" ? "Removing access…" : "Changing role…"
              : transitionAction === "deactivate" ? "Transfer assignments and remove access" : "Transfer assignments and change role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
