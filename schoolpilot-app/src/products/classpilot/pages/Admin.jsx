import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { useToast } from "../../../hooks/use-toast";
import { Trash2, UserPlus, Users, ArrowLeft, AlertTriangle, Clock, Settings as SettingsIcon, Key, FileText, ChevronLeft, ChevronRight, BarChart3, LogOut, Upload, Search, Plus, Building2, Loader2, AlertCircle, RefreshCw, ClipboardCheck, ShieldAlert, CalendarDays } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Checkbox } from "../../../components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../../components/ui/tabs";
import { Badge } from "../../../components/ui/badge";
import { useClassPilotAuth } from "../../../hooks/useClassPilotAuth";
import { ThemeToggle } from "../../../components/ThemeToggle";
import GoogleRosterConnectorPanel from "../../../shared/components/GoogleRosterConnectorPanel";
import {
  continueCalendarHistoryNavigation,
  disableCalendarHistoryGuard,
  updateCalendarHistoryGuard,
} from "../calendarHistoryGuard";
import SchoolCalendarMonth from "../components/SchoolCalendarMonth";
import StaffAccessTransitionDialog from "../../../shared/components/StaffAccessTransitionDialog";

const ADMIN_TAB_VALUES = new Set(["staff", "calendar", "audit"]);
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

function currentMonthInTimeZone(timeZone) {
  const formatMonth = (zone) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}`;
  };
  try {
    return formatMonth(timeZone);
  } catch {
    return formatMonth("America/New_York");
  }
}

const createStaffSchema = z.object({
  name: z.string().optional(),
  email: z.string().email("Invalid email address"),
  role: z.enum(["teacher", "school_admin"]),
  password: z.string().optional(),
});

const staffEmailSchema = z.string().email();
const CLASSPILOT_TEACHABLE_ROLES = new Set(["teacher", "admin", "school_admin"]);

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function losesClassPilotTeachability(currentRole, nextRole) {
  return CLASSPILOT_TEACHABLE_ROLES.has(currentRole)
    && !CLASSPILOT_TEACHABLE_ROLES.has(nextRole);
}

function classPilotStaffRoleLabel(role) {
  if (role === "school_admin" || role === "admin") return "School Admin";
  if (role === "office_staff") return "Office Staff";
  return "Teacher";
}

function normalizeStaffRecord(record) {
  const user = record?.user || {};
  const role = record?.role === "admin" ? "school_admin" : record?.role;
  return {
    id: record?.id || record?.membershipId || record?.userId,
    membershipId: record?.membershipId || record?.id,
    userId: record?.userId || user.id,
    role,
    gopilotRole: record?.gopilotRole ?? null,
    effectiveRole: record?.effectiveRole
      || String(record?.gopilotRole || "").trim()
      || record?.role,
    status: record?.status || "active",
    email: record?.email || user.email || "",
    displayName: record?.displayName
      || user.displayName
      || [record?.firstName || user.firstName, record?.lastName || user.lastName].filter(Boolean).join(" ")
      || null,
    user,
  };
}

function staffIdentityLabel(staff) {
  const name = staff?.displayName || staff?.email || "Staff member";
  return staff?.email && staff.email !== name ? `${name} — ${staff.email}` : name;
}

function getApiErrorDetails(error) {
  const data = error?.response?.data || {};
  return {
    code: data.code || null,
    message: data.error || data.message || error?.message || "The request could not be completed.",
    data,
  };
}

function workspaceImportIssueText(issue) {
  if (typeof issue === "string") return issue;
  if (!issue || typeof issue !== "object") return "Unknown import issue";
  return [issue.email, issue.code, issue.error || issue.message]
    .filter(Boolean)
    .join(" — ") || "Unknown import issue";
}

export default function Admin() {
  const navigate = useNavigate();
  const { currentUser, school, isLoading } = useClassPilotAuth();
  const isAdmin = currentUser?.isSuperAdmin || currentUser?.role === "admin" || currentUser?.role === "school_admin";

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="container mx-auto max-w-3xl p-6">
        <Card>
          <CardHeader>
            <CardTitle>Access denied</CardTitle>
            <CardDescription>ClassPilot admin tools are available to school admins only.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => navigate("/classpilot")}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <AdminPanel currentUser={currentUser} schoolTimezone={school?.timezone || "America/New_York"} />;
}

function AdminPanel({ currentUser, schoolTimezone }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();

  const [staffTransitionRequest, setStaffTransitionRequest] = useState(null);
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [staffToEdit, setStaffToEdit] = useState(null);
  const [selectedRole, setSelectedRole] = useState("teacher");
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [staffToResetPassword, setStaffToResetPassword] = useState(null);
  const [newPassword, setNewPassword] = useState("");
  const [calendarDirty, setCalendarDirty] = useState(false);
  const [calendarDraftEpoch, setCalendarDraftEpoch] = useState(0);
  const [pendingAdminNavigation, setPendingAdminNavigation] = useState(null);
  const historyGuardOwnerRef = useRef(Symbol("school-calendar-history-guard"));
  const [auditPage, setAuditPage] = useState(0);
  const [auditActionFilter, setAuditActionFilter] = useState("");
  const [addStaffDialogOpen, setAddStaffDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [wsImportDialogOpen, setWsImportDialogOpen] = useState(false);
  const [wsImportOU, setWsImportOU] = useState("");
  const [wsImportRole, setWsImportRole] = useState("teacher");
  const [wsExcludedEmails, setWsExcludedEmails] = useState(new Set());
  const [wsImportResult, setWsImportResult] = useState(null);
  const [staffSearchQuery, setStaffSearchQuery] = useState("");
  const [staffStatusFilter, setStaffStatusFilter] = useState("active");
  const [staffPage, setStaffPage] = useState(0);
  const [identityConflict, setIdentityConflict] = useState(null);
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState([]);
  const [importError, setImportError] = useState("");
  const [importResult, setImportResult] = useState(null);
  const STAFF_PER_PAGE = 10;
  const requestedTab = searchParams.get("tab");
  const activeTab = ADMIN_TAB_VALUES.has(requestedTab) ? requestedTab : "staff";
  const requestedMonth = searchParams.get("month");
  const calendarMonth = MONTH_PATTERN.test(requestedMonth || "")
    ? requestedMonth
    : currentMonthInTimeZone(schoolTimezone);

  useEffect(() => {
    if (activeTab !== "calendar" || MONTH_PATTERN.test(requestedMonth || "")) return;
    const next = new URLSearchParams(searchParams);
    next.set("tab", "calendar");
    next.set("month", calendarMonth);
    setSearchParams(next, { replace: true });
  }, [activeTab, calendarMonth, requestedMonth, searchParams, setSearchParams]);

  useLayoutEffect(() => {
    const owner = historyGuardOwnerRef.current;
    updateCalendarHistoryGuard({
      owner,
      enabled: activeTab === "calendar" && calendarDirty,
      currentEntry: {
        index: window.history.state?.idx,
        state: window.history.state,
        href: window.location.href,
      },
      onBlocked: setPendingAdminNavigation,
      onRestored: () => setPendingAdminNavigation((pending) => (
        pending?.kind === "history" ? { ...pending, restored: true } : pending
      )),
    });
    return () => disableCalendarHistoryGuard(owner);
  }, [activeTab, calendarDirty, calendarMonth]);

  const commitTabChange = (tab) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", tab);
    if (tab === "calendar") next.set("month", calendarMonth);
    setSearchParams(next);
  };

  const requestTabChange = (tab) => {
    if (tab === activeTab) return;
    if (activeTab === "calendar" && calendarDirty) {
      setPendingAdminNavigation({ kind: "tab", value: tab });
      return;
    }
    commitTabChange(tab);
  };

  const requestRouteChange = (path) => {
    if (activeTab === "calendar" && calendarDirty) {
      setPendingAdminNavigation({ kind: "route", value: path });
      return;
    }
    navigate(path);
  };

  const updateCalendarMonth = (month) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", "calendar");
    next.set("month", month);
    setSearchParams(next);
  };

  const confirmAdminNavigation = () => {
    const pending = pendingAdminNavigation;
    setPendingAdminNavigation(null);
    if (!pending) return;
    setCalendarDirty(false);
    setCalendarDraftEpoch((epoch) => epoch + 1);
    if (pending.kind === "history") {
      if (pending.delta === null) {
        disableCalendarHistoryGuard(historyGuardOwnerRef.current);
        navigate(pending.targetPath);
      } else {
        continueCalendarHistoryNavigation(pending);
      }
      return;
    }
    if (pending.kind === "tab") commitTabChange(pending.value);
    else {
      disableCalendarHistoryGuard(historyGuardOwnerRef.current);
      navigate(pending.value);
    }
  };

  const form = useForm({
    resolver: zodResolver(createStaffSchema),
    defaultValues: {
      name: "",
      email: "",
      role: "teacher",
      password: "",
    },
  });
  const watchedRole = form.watch("role");

  const { data: staffData, isLoading } = useQuery({
    queryKey: ["/api/users/staff", "all"],
    queryFn: () => apiRequest("GET", "/users/staff?status=all"),
    select: (data) => ({
      users: (data?.staff ?? data?.users ?? []).map(normalizeStaffRecord),
    }),
  });

  const { data: _settings } = useQuery({
    queryKey: ["/api/settings"],
    queryFn: () => apiRequest("GET", "/settings"),
  });

  const { data: activeSessions = [] } = useQuery({
    queryKey: ["/api/sessions/all"],
    queryFn: () => apiRequest("GET", "/sessions/all"),
    select: (data) => Array.isArray(data) ? data : data?.sessions ?? [],
    refetchInterval: 10000, // Poll every 10 seconds
  });

  const { data: allGroups = [] } = useQuery({
    queryKey: ["/api/teacher/groups"],
    queryFn: () => apiRequest("GET", "/teacher/groups"),
    select: (data) => Array.isArray(data) ? data : data?.groups ?? [],
  });

  // Audit logs query
  const { data: auditLogsData, isLoading: auditLogsLoading } = useQuery({
    queryKey: ["/api/admin/audit-logs", auditPage, auditActionFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", "20");
      params.set("offset", String(auditPage * 20));
      if (auditActionFilter) params.set("action", auditActionFilter);
      return apiRequest("GET", `/admin/audit-logs?${params.toString()}`);
    },
    enabled: activeTab === "audit",
  });

  const getFriendlyErrorMessage = (error) => {
    if (!error) return "";
    const message = error instanceof Error ? error.message : String(error);
    const jsonMatch = message.match(/\{.*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.error) {
          return parsed.error;
        }
      } catch {
        return message;
      }
    }
    return message;
  };

  const createStaffMutation = useMutation({
    mutationFn: async (data) => {
      const payload = {
        email: normalizeEmail(data.email),
        role: data.role === "school_admin" ? "admin" : data.role,
        displayName: data.name?.trim() ? data.name.trim() : undefined,
        password: data.password?.trim() ? data.password : undefined,
        ...(data.confirmDistinctPerson ? { confirmDistinctPerson: true } : {}),
      };
      return await apiRequest("POST", "/users/staff", payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users/staff"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/teachers"] });
      form.reset();
      setAddStaffDialogOpen(false);
      setIdentityConflict(null);
      setStaffStatusFilter("active");
      toast({
        title: "Staff member added",
        description: "The staff account has been created successfully.",
      });
    },
    onError: (error, variables) => {
      const details = getApiErrorDetails(error);
      if (details.code === "POSSIBLE_DUPLICATE_STAFF" || details.code === "STAFF_REACTIVATION_REQUIRED") {
        setIdentityConflict({
          ...details.data,
          code: details.code,
          pendingStaff: variables,
        });
        setAddStaffDialogOpen(false);
        return;
      }
      toast({
        variant: "destructive",
        title: "Failed to add staff",
        description: details.message,
      });
    },
  });

  const bulkImportMutation = useMutation({
    mutationFn: async (users) => {
      const results = { success: 0, failed: 0, errors: [] };
      for (const user of users) {
        try {
          await apiRequest("POST", "/users/staff", {
            email: user.email,
            role: user.role === "admin" ? "admin" : "teacher",
            displayName: user.name || undefined,
          });
          results.success++;
        } catch (error) {
          const details = getApiErrorDetails(error);
          results.failed++;
          results.errors.push({ email: user.email, code: details.code, message: details.message });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      queryClient.invalidateQueries({ queryKey: ["/api/users/staff"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/teachers"] });
      setImportResult(results);
      if (results.failed === 0) {
        setImportDialogOpen(false);
        setImportFile(null);
        setImportPreview([]);
        setImportError("");
        setImportResult(null);
      } else {
        setImportFile(null);
        setImportPreview([]);
      }
      toast({
        title: "Import complete",
        description: `Successfully imported ${results.success} staff members.${results.failed > 0 ? ` ${results.failed} failed.` : ""}`,
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Import failed",
        description: error.message || "An error occurred during import",
      });
    },
  });

  // Google Workspace staff import queries
  const { data: wsUsersData, isLoading: wsUsersLoading, error: wsUsersError, refetch: wsUsersRefetch } = useQuery({
    queryKey: ["/api/directory/users"],
    queryFn: () => apiRequest("GET", "/directory/users"),
    enabled: wsImportDialogOpen,
  });
  const { data: wsOUData, isLoading: wsOULoading, refetch: wsOURefetch } = useQuery({
    queryKey: ["/api/directory/orgunits"],
    queryFn: () => apiRequest("GET", "/directory/orgunits"),
    enabled: wsImportDialogOpen,
  });

  const wsUsers = wsUsersData?.users || [];
  const wsOUs = wsOUData?.orgUnits || [];
  const wsFilteredUsers = wsImportOU && wsImportOU !== "__all__"
    ? wsUsers.filter(u => u.orgUnitPath === wsImportOU && !u.suspended)
    : wsUsers.filter(u => !u.suspended);

  const wsErrorCode = (() => {
    if (!wsUsersError) return null;
    // With axios, the server response is in error.response.data; error.message is generic
    const serverMsg = wsUsersError.response?.data?.error || wsUsersError.response?.data?.message || "";
    const code = wsUsersError.response?.data?.code;
    if (code === "GOOGLE_CONNECTOR_REQUIRED" || serverMsg.includes("GOOGLE_CONNECTOR_REQUIRED")) return "GOOGLE_CONNECTOR_REQUIRED";
    const msg = serverMsg || wsUsersError.message || "";
    try { const m = msg.match(/\{.*\}/); if (m) return JSON.parse(m[0]).code || null; } catch { /* ignore */ }
    if (msg.includes("NO_TOKENS") || msg.includes("Google not connected")) return "NO_TOKENS";
    if (msg.includes("INSUFFICIENT_PERMISSIONS")) return "INSUFFICIENT_PERMISSIONS";
    return "UNKNOWN_ERROR";
  })();

  const wsImportMutation = useMutation({
    mutationFn: (params) => apiRequest("POST", "/directory/import-staff", params),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/users/staff"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/teachers"] });
      setWsImportResult(data);
      toast({
        title: "Staff import complete",
        description: `Imported ${data.imported || 0}, updated ${data.updated || 0}, and flagged ${data.skipped || 0} for review.`,
      });
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Staff import failed", description: error.message });
    },
  });

  const parseCSV = (text) => {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];

    const header = lines[0].toLowerCase().split(",").map(h => h.trim());
    const emailIdx = header.findIndex(h => h === "email" || h === "e-mail");
    const nameIdx = header.findIndex(h => h === "name" || h === "full name" || h === "displayname");
    const roleIdx = header.findIndex(h => h === "role" || h === "type");

    if (emailIdx === -1) {
      throw new Error("CSV must have an 'email' column");
    }

    const results = [];
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(",").map(v => v.trim().replace(/^"|"$/g, ""));
      const email = values[emailIdx];
      if (!email || !email.includes("@")) continue;

      const name = nameIdx !== -1 ? values[nameIdx] || "" : "";
      const roleValue = roleIdx !== -1 ? values[roleIdx]?.toLowerCase() || "" : "";
      const role = roleValue.includes("admin") ? "admin" : "teacher";

      results.push({ name, email, role });
    }
    return results;
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportFile(file);
    setImportError("");
    setImportPreview([]);
    setImportResult(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result;
        const parsed = parseCSV(text);
        if (parsed.length === 0) {
          setImportError("No valid staff entries found in CSV");
        } else {
          setImportPreview(parsed);
        }
      } catch (error) {
        setImportError(error.message || "Failed to parse CSV");
      }
    };
    reader.readAsText(file);
  };

  const reactivateStaffMutation = useMutation({
    mutationFn: (membershipId) => apiRequest("POST", `/users/staff/${membershipId}/reactivate`, {}),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/users/staff"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/admin/teachers"] }),
      ]);
      setIdentityConflict(null);
      setStaffStatusFilter("active");
      toast({
        title: "School access restored",
        description: "The existing staff identity was reactivated; no duplicate account was created.",
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Could not reactivate staff",
        description: getApiErrorDetails(error).message,
      });
    },
  });

  const updateStaffMutation = useMutation({
    mutationFn: async (payload) => {
      const emailChanged = normalizeEmail(payload.email) !== normalizeEmail(payload.expectedEmail);
      const profileChanged = payload.role !== payload.expectedRole
        || payload.name?.trim() !== payload.expectedName?.trim();

      if (emailChanged && profileChanged) {
        const separateSaveError = new Error("Save the email correction separately from name or role changes.");
        separateSaveError.code = "STAFF_EDIT_REQUIRES_SEPARATE_SAVES";
        throw separateSaveError;
      }

      if (emailChanged) {
        const emailResult = await apiRequest("PATCH", `/users/staff/${payload.membershipId}/email`, {
          expectedEmail: payload.expectedEmail,
          email: payload.email,
        });
        const confirmedEmail = normalizeEmail(emailResult?.email || emailResult?.user?.email);
        if (!confirmedEmail || confirmedEmail !== normalizeEmail(payload.email)) {
          const confirmationError = new Error("The server did not confirm the requested email address. Refresh the page before trying again.");
          confirmationError.code = "STAFF_EMAIL_CONFIRMATION_MISMATCH";
          throw confirmationError;
        }
        return { operation: "email" };
      }

      if (profileChanged) {
        await apiRequest("PATCH", `/admin/users/${payload.membershipId}`, {
          ...(payload.role !== payload.expectedRole ? { role: payload.role } : {}),
          ...(payload.name?.trim() !== payload.expectedName?.trim()
            ? { name: payload.name?.trim() || undefined }
            : {}),
        });
        return { operation: "profile" };
      }

      return { operation: "none" };
    },
    onSuccess: ({ operation }, payload) => {
      toast({
        title: operation === "email" ? "Email corrected" : "Staff updated",
        description: operation === "email"
          ? "The email was corrected on the existing identity. The staff member should sign in again."
          : "Staff details have been updated successfully.",
      });
      const editingOwnEmail = operation === "email" && payload.userId === currentUser?.id;
      if (!editingOwnEmail) {
        queryClient.invalidateQueries({ queryKey: ["/api/users/staff"] });
        queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
        queryClient.invalidateQueries({ queryKey: ["/api/admin/teachers"] });
      }
      setEditDialogOpen(false);
      setStaffToEdit(null);
    },
    onError: (error) => {
      const details = getApiErrorDetails(error);
      const message = details.message;
      if (message.includes("last school admin")) {
        toast({
          title: "Action blocked",
          description: message,
        });
        return;
      }
      if (details.code === "STAFF_EMAIL_STALE") {
        queryClient.invalidateQueries({ queryKey: ["/api/users/staff"] });
      }
      toast({
        variant: "destructive",
        title: details.code === "STAFF_EMAIL_CENTRAL_REVIEW_REQUIRED"
          ? "Central review required"
          : details.code === "STAFF_EDIT_REQUIRES_SEPARATE_SAVES"
            ? "Use separate saves"
            : "Failed to update staff",
        description: message || "An error occurred",
      });
    },
  });

  const resetPasswordMutation = useMutation({
    mutationFn: async (payload) => {
      return await apiRequest("POST", `/admin/users/${payload.userId}/password`, {
        newPassword: payload.newPassword,
      });
    },
    onSuccess: () => {
      toast({
        title: "Password reset",
        description: "The staff member's password has been reset successfully.",
      });
      setPasswordDialogOpen(false);
      setStaffToResetPassword(null);
      setNewPassword("");
      setStaffSearchQuery("");
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to reset password",
        description: getFriendlyErrorMessage(error) || "An error occurred",
      });
    },
  });

  const cleanupStudentsMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("POST", "/admin/cleanup-students");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/students"] });
      toast({
        title: "Student data cleared",
        description: "All student devices and activity data have been cleared successfully.",
      });
      setCleanupDialogOpen(false);
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to cleanup student data",
        description: error.message || "An error occurred",
      });
    },
  });

  const onSubmit = (data) => {
    createStaffMutation.mutate(data);
  };

  const handleRemoveAccessClick = (staff) => {
    setStaffTransitionRequest({ staff, action: "deactivate" });
  };

  const handleEditClick = (staff) => {
    setStaffToEdit(staff);
    setSelectedRole(staff.role);
    setEditName(staff.displayName || "");
    setEditEmail(staff.email || "");
    setEditDialogOpen(true);
  };

  const handleResetPasswordClick = (staff) => {
    setStaffToResetPassword(staff);
    setNewPassword("");
    setPasswordDialogOpen(true);
  };

  const handleResetPasswordSubmit = () => {
    if (!staffToResetPassword || !newPassword) return;
    resetPasswordMutation.mutate({
      userId: staffToResetPassword.id,
      newPassword,
    });
  };

  const handleEditSubmit = () => {
    if (!staffToEdit) {
      return;
    }
    const roleChanged = selectedRole !== staffToEdit.role;
    const nameChanged = editName.trim() !== (staffToEdit.displayName || "").trim();
    if (roleChanged && nameChanged) {
      toast({
        variant: "destructive",
        title: "Use separate saves",
        description: "Save the name change first, then reopen this editor to change the role.",
      });
      return;
    }
    if (roleChanged && losesClassPilotTeachability(staffToEdit.role, selectedRole)) {
      setEditDialogOpen(false);
      setStaffTransitionRequest({
        staff: staffToEdit,
        action: "change_role",
        newRole: selectedRole,
      });
      setStaffToEdit(null);
      return;
    }
    updateStaffMutation.mutate({
      membershipId: staffToEdit.membershipId,
      userId: staffToEdit.userId,
      role: selectedRole,
      expectedRole: staffToEdit.role,
      name: editName,
      expectedName: staffToEdit.displayName || "",
      email: normalizeEmail(editEmail),
      expectedEmail: staffToEdit.email,
    });
  };

  const handleEditIdentityCandidate = (candidate) => {
    const normalized = normalizeStaffRecord(candidate);
    setIdentityConflict(null);
    handleEditClick(normalized);
  };

  const handleConfirmDistinctPerson = () => {
    if (!identityConflict?.pendingStaff) return;
    createStaffMutation.mutate({
      ...identityConflict.pendingStaff,
      confirmDistinctPerson: true,
    });
  };

  const staff = staffData?.users || [];
  const activeStaff = staff.filter((member) => member.status === "active");
  const formerStaff = staff.filter((member) => member.status === "inactive");
  const editEmailChanged = Boolean(staffToEdit)
    && normalizeEmail(editEmail) !== normalizeEmail(staffToEdit.email);
  const editProfileChanged = Boolean(staffToEdit)
    && (selectedRole !== staffToEdit.role
      || editName.trim() !== (staffToEdit.displayName || "").trim());
  const editRequiresSeparateSaves = editEmailChanged && editProfileChanged;
  const identityConflictCandidates = (identityConflict?.candidates || []).map(normalizeStaffRecord);
  if (identityConflict?.code === "STAFF_REACTIVATION_REQUIRED" && identityConflictCandidates.length === 0) {
    const existing = staff.find((member) => member.membershipId === identityConflict.membershipId);
    if (existing) identityConflictCandidates.push(existing);
  }

  return (
    <div className="container mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-lg bg-primary flex items-center justify-center">
            <Users className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-semibold">Admin Panel</h1>
            <p className="text-muted-foreground">
              {currentUser?.schoolName && <span className="font-medium">{currentUser.schoolName}</span>}
              {currentUser?.schoolName && ' \u2022 '}
              Manage staff, schedules, and school operations
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ThemeToggle />
          <Button
            variant="outline"
            onClick={() => requestRouteChange("/classpilot/admin/attendance")}
          >
            <ClipboardCheck className="h-4 w-4 mr-2" />
            Attendance
          </Button>
          <Button
            variant="outline"
            onClick={() => requestRouteChange("/classpilot/admin/analytics")}
          >
            <BarChart3 className="h-4 w-4 mr-2" />
            Analytics
          </Button>
          {currentUser?.mailpilotEntitled && (
            <Button
              variant="outline"
              onClick={() => requestRouteChange("/classpilot/admin/email-monitoring")}
            >
              <ShieldAlert className="h-4 w-4 mr-2" />
              Email Monitor
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => requestRouteChange("/classpilot")}
            data-testid="button-back-dashboard"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Dashboard
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => requestRouteChange("/login")}
            data-testid="button-logout"
            title="Log out"
          >
            <LogOut className="h-5 w-5" />
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={requestTabChange} className="space-y-4">
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="staff" className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            Staff & Settings
          </TabsTrigger>
          <TabsTrigger value="calendar" className="flex items-center gap-2" data-testid="tab-school-calendar">
            <CalendarDays className="h-4 w-4" />
            School Calendar
          </TabsTrigger>
          <TabsTrigger value="audit" className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Audit Logs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="staff" className="space-y-6">
          {/* Staff Management Card */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Users className="h-5 w-5" />
                    Staff Accounts
                  </CardTitle>
                  <CardDescription>
                    {activeStaff.length} active · {formerStaff.length} former
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setWsImportDialogOpen(true);
                      setWsImportResult(null);
                      setWsImportOU("");
                      setWsImportRole("teacher");
                      setWsExcludedEmails(new Set());
                    }}
                  >
                    <Building2 className="h-4 w-4 mr-2" />
                    Import from Google
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setImportDialogOpen(true)}
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    Import CSV
                  </Button>
                  <Button onClick={() => setAddStaffDialogOpen(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Add Staff
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by name or email..."
                  value={staffSearchQuery}
                  onChange={(e) => {
                    setStaffSearchQuery(e.target.value);
                    setStaffPage(0);
                  }}
                  className="pl-9"
                />
              </div>

              <div className="flex w-fit gap-1 rounded-lg bg-muted p-1" aria-label="Staff status filter">
                <Button
                  type="button"
                  size="sm"
                  variant={staffStatusFilter === "active" ? "default" : "ghost"}
                  onClick={() => {
                    setStaffStatusFilter("active");
                    setStaffPage(0);
                  }}
                  data-testid="filter-active-staff"
                >
                  Active ({activeStaff.length})
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={staffStatusFilter === "inactive" ? "default" : "ghost"}
                  onClick={() => {
                    setStaffStatusFilter("inactive");
                    setStaffPage(0);
                  }}
                  data-testid="filter-former-staff"
                >
                  Former ({formerStaff.length})
                </Button>
              </div>

              {/* Staff List */}
              {isLoading ? (
                <div className="text-center py-8 text-muted-foreground">
                  Loading staff...
                </div>
              ) : staff.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Users className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
                  <p>No staff yet. Add a staff member to get started!</p>
                </div>
              ) : (() => {
                // Helper to extract last name for sorting
                const getLastName = (name) => {
                  if (!name) return "";
                  const parts = name.trim().split(/\s+/);
                  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : parts[0].toLowerCase();
                };

                const filteredStaff = (staffStatusFilter === "active" ? activeStaff : formerStaff)
                  .filter((member) => {
                    const query = staffSearchQuery.toLowerCase();
                    return (
                      member.email?.toLowerCase().includes(query) ||
                      (member.displayName?.toLowerCase().includes(query) ?? false)
                    );
                  })
                  .sort((a, b) => {
                    // Sort by last name, then by email if no name
                    const aLastName = getLastName(a.displayName) || a.email.toLowerCase();
                    const bLastName = getLastName(b.displayName) || b.email.toLowerCase();
                    return aLastName.localeCompare(bLastName);
                  });
                const totalPages = Math.ceil(filteredStaff.length / STAFF_PER_PAGE);
                const paginatedStaff = filteredStaff.slice(
                  staffPage * STAFF_PER_PAGE,
                  (staffPage + 1) * STAFF_PER_PAGE
                );

                return (
                  <div className="space-y-4">
                    {filteredStaff.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground">
                        No staff members match your search.
                      </div>
                    ) : (
                      <>
                        <div className="overflow-x-auto rounded-lg border">
                          <table className="w-full min-w-[680px]">
                            <thead className="bg-muted">
                              <tr>
                                <th className="px-4 py-3 text-left font-medium text-sm">Name</th>
                                <th className="px-4 py-3 text-left font-medium text-sm">Email</th>
                                <th className="px-4 py-3 text-left font-medium text-sm">Role</th>
                                <th className="px-4 py-3 text-right font-medium text-sm">Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {paginatedStaff.map((member) => (
                                <tr
                                  key={member.id}
                                  data-testid={`staff-row-${member.id}`}
                                  className="border-t hover:bg-muted/50"
                                >
                                  <td className="px-4 py-3">
                                    <div>
                                      <span className="font-medium" data-testid={`staff-name-${member.id}`}>
                                        {member.displayName || "\u2014"}
                                      </span>
                                      <p className="mt-1 font-mono text-[11px] text-muted-foreground" data-testid={`staff-membership-id-${member.id}`}>
                                        Membership ID: {member.membershipId}
                                      </p>
                                    </div>
                                  </td>
                                  <td className="px-4 py-3 text-muted-foreground">
                                    {member.email}
                                  </td>
                                  <td className="px-4 py-3">
                                    <div className="flex flex-wrap gap-2">
                                      <Badge variant={member.role === "school_admin" ? "default" : "secondary"}>
                                        {classPilotStaffRoleLabel(member.role)}
                                      </Badge>
                                      {member.status === "inactive" ? <Badge variant="outline">Former staff</Badge> : null}
                                    </div>
                                  </td>
                                  <td className="px-4 py-3">
                                    <div className="flex items-center justify-end gap-1">
                                      {member.status === "active" ? (
                                        <>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            data-testid={`button-edit-${member.id}`}
                                            onClick={() => handleEditClick(member)}
                                            disabled={updateStaffMutation.isPending}
                                          >
                                            Edit
                                          </Button>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            aria-label={`Reset password for ${staffIdentityLabel(member)}`}
                                            data-testid={`button-reset-password-${member.id}`}
                                            onClick={() => handleResetPasswordClick(member)}
                                            disabled={resetPasswordMutation.isPending}
                                          >
                                            <Key className="h-4 w-4" />
                                          </Button>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            aria-label={`Remove school access for ${staffIdentityLabel(member)}`}
                                            data-testid={`button-remove-access-${member.id}`}
                                            onClick={() => handleRemoveAccessClick(member)}
                                          >
                                            <Trash2 className="h-4 w-4 text-destructive" />
                                          </Button>
                                        </>
                                      ) : (
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          data-testid={`button-reactivate-${member.id}`}
                                          onClick={() => reactivateStaffMutation.mutate(member.membershipId)}
                                          disabled={reactivateStaffMutation.isPending}
                                        >
                                          <RefreshCw className="mr-2 h-4 w-4" />
                                          Reactivate
                                        </Button>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        {/* Pagination */}
                        {totalPages > 1 && (
                          <div className="flex items-center justify-between">
                            <div className="text-sm text-muted-foreground">
                              Showing {staffPage * STAFF_PER_PAGE + 1} - {Math.min((staffPage + 1) * STAFF_PER_PAGE, filteredStaff.length)} of {filteredStaff.length}
                            </div>
                            <div className="flex gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={staffPage === 0}
                                onClick={() => setStaffPage(p => p - 1)}
                              >
                                <ChevronLeft className="h-4 w-4" />
                                Previous
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={staffPage >= totalPages - 1}
                                onClick={() => setStaffPage(p => p + 1)}
                              >
                                Next
                                <ChevronRight className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })()}
            </CardContent>
          </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Student Roster Management
          </CardTitle>
          <CardDescription>
            Manage student records and import new students
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-muted p-4 rounded-lg">
            <p className="text-sm mb-2">
              <strong>Student Roster:</strong> Centralized management of all student records.
            </p>
            <ul className="text-sm space-y-1 list-disc list-inside text-muted-foreground">
              <li>Import students via CSV files</li>
              <li>Edit student information (name, email, grade)</li>
              <li>Delete student records</li>
              <li>Filter students by grade level</li>
            </ul>
          </div>
          <Button
            variant="default"
            data-testid="button-manage-students"
            onClick={() => requestRouteChange("/classpilot/students")}
          >
            Manage Students
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SettingsIcon className="h-5 w-5" />
            Class Management
          </CardTitle>
          <CardDescription>
            Create and manage class rosters for teachers
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-muted p-4 rounded-lg">
            <p className="text-sm mb-2">
              <strong>Admin Class Creation:</strong> Create official class rosters for teachers.
            </p>
            <ul className="text-sm space-y-1 list-disc list-inside text-muted-foreground">
              <li>Browse classes by grade level</li>
              <li>Create classes (e.g., "7th Science P3") and assign to teachers</li>
              <li>Assign students to class rosters</li>
              <li>Teachers can then start/end sessions for these classes</li>
            </ul>
          </div>
          <Button
            variant="default"
            data-testid="button-manage-classes"
            onClick={() => requestRouteChange("/classpilot/admin/classes")}
          >
            Manage Classes
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Active Sessions Monitor
          </CardTitle>
          <CardDescription>
            View all ongoing class sessions school-wide
          </CardDescription>
        </CardHeader>
        <CardContent>
          {activeSessions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Clock className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-sm">No active class sessions</p>
            </div>
          ) : (
            <div className="space-y-2">
              {activeSessions.map((session) => {
                const teacher = staff.find(t => t.userId === session.teacherId);
                const group = allGroups.find(g => g.id === session.groupId);
                return (
                  <div
                    key={session.id}
                    className="flex items-center justify-between p-3 rounded-lg border hover-elevate"
                    data-testid={`session-${session.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                      <div>
                        <p className="font-medium">{group?.name || 'Unknown Group'}</p>
                        <p className="text-sm text-muted-foreground">
                          {teacher?.displayName || teacher?.email || 'Unknown Teacher'} {'\u2022'} Started {new Date(session.startTime).toLocaleTimeString()}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5" />
            Coverage
          </CardTitle>
          <CardDescription>
            Monitor online unassigned students and manage temporary coverage
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="default"
            data-testid="button-manage-coverage"
            onClick={() => requestRouteChange("/classpilot/coverage")}
          >
            Open Coverage
          </Button>
        </CardContent>
      </Card>

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            Database Cleanup
          </CardTitle>
          <CardDescription>
            Remove all student devices and monitoring data from the system
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-muted p-4 rounded-lg">
            <p className="text-sm mb-2">
              <strong>Warning:</strong> This will permanently delete:
            </p>
            <ul className="text-sm space-y-1 list-disc list-inside text-muted-foreground">
              <li>All registered student/Chromebook devices</li>
              <li>All heartbeat and activity history</li>
              <li>All URL visit records</li>
            </ul>
            <p className="text-sm mt-3 text-muted-foreground">
              Use this to clean up duplicate entries or start fresh. Extensions will need to re-register after cleanup.
            </p>
          </div>
          <Button
            variant="destructive"
            data-testid="button-cleanup-students"
            onClick={() => setCleanupDialogOpen(true)}
            disabled={cleanupStudentsMutation.isPending}
          >
            {cleanupStudentsMutation.isPending ? "Cleaning up..." : "Clear All Student Data"}
          </Button>
        </CardContent>
      </Card>
        </TabsContent>

        <TabsContent value="calendar" className="space-y-4">
          <SchoolCalendarMonth
            key={`${calendarMonth}:${calendarDraftEpoch}`}
            month={calendarMonth}
            onDirtyChange={setCalendarDirty}
            onMonthChange={updateCalendarMonth}
          />
        </TabsContent>

        <TabsContent value="audit" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Audit Logs
              </CardTitle>
              <CardDescription>
                Track administrative actions and changes for compliance
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <Label htmlFor="action-filter">Filter by Action</Label>
                  <Select
                    value={auditActionFilter}
                    onValueChange={(v) => {
                      setAuditActionFilter(v === "all" ? "" : v);
                      setAuditPage(0);
                    }}
                  >
                    <SelectTrigger id="action-filter">
                      <SelectValue placeholder="All actions" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All actions</SelectItem>
                      <SelectItem value="auth.login">Login</SelectItem>
                      <SelectItem value="auth.logout">Logout</SelectItem>
                      <SelectItem value="settings.update">Settings Update</SelectItem>
                      <SelectItem value="user.create">User Created</SelectItem>
                      <SelectItem value="user.update">User Updated</SelectItem>
                      <SelectItem value="user.delete">User Deleted</SelectItem>
                      <SelectItem value="student.create">Student Created</SelectItem>
                      <SelectItem value="student.update">Student Updated</SelectItem>
                      <SelectItem value="student.delete">Student Deleted</SelectItem>
                      <SelectItem value="session.start">Session Started</SelectItem>
                      <SelectItem value="session.end">Session Ended</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {auditLogsLoading ? (
                <div className="text-center py-8 text-muted-foreground">Loading audit logs...</div>
              ) : auditLogsData?.logs && auditLogsData.logs.length > 0 ? (
                <div className="space-y-4">
                  <div className="border rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-muted">
                        <tr>
                          <th className="px-4 py-2 text-left font-medium">Time</th>
                          <th className="px-4 py-2 text-left font-medium">User</th>
                          <th className="px-4 py-2 text-left font-medium">Action</th>
                          <th className="px-4 py-2 text-left font-medium">Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {auditLogsData.logs.map((log) => (
                          <tr key={log.id} className="border-t">
                            <td className="px-4 py-2 whitespace-nowrap">
                              {new Date(log.createdAt).toLocaleString()}
                            </td>
                            <td className="px-4 py-2">
                              <div>{log.userEmail || log.userId}</div>
                              {log.userRole && (
                                <Badge variant="outline" className="text-xs mt-1">
                                  {log.userRole}
                                </Badge>
                              )}
                            </td>
                            <td className="px-4 py-2">
                              <Badge variant={
                                log.action.startsWith('auth.') ? 'default' :
                                log.action.includes('delete') ? 'destructive' :
                                'secondary'
                              }>
                                {log.action}
                              </Badge>
                            </td>
                            <td className="px-4 py-2 max-w-xs truncate">
                              {log.entityName && <span>{log.entityName}</span>}
                              {log.entityType && !log.entityName && <span className="text-muted-foreground">{log.entityType}</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="text-sm text-muted-foreground">
                      Showing {auditPage * 20 + 1} - {Math.min((auditPage + 1) * 20, auditLogsData.total)} of {auditLogsData.total}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={auditPage === 0}
                        onClick={() => setAuditPage(p => p - 1)}
                      >
                        <ChevronLeft className="h-4 w-4" />
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={(auditPage + 1) * 20 >= auditLogsData.total}
                        onClick={() => setAuditPage(p => p + 1)}
                      >
                        Next
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  No audit logs found. Actions will be recorded as users interact with the system.
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <AlertDialog
        open={Boolean(pendingAdminNavigation)}
        onOpenChange={(open) => {
          if (!open && (pendingAdminNavigation?.kind !== "history" || pendingAdminNavigation.restored)) {
            setPendingAdminNavigation(null);
          }
        }}
      >
        <AlertDialogContent data-testid="dialog-calendar-navigation-guard">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved calendar changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAdminNavigation?.kind === "history"
                ? "Using Back or Forward will discard this month’s draft. Saved dates will not be affected."
                : "Leaving the School Calendar will discard this month’s draft. Saved dates will not be affected."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingAdminNavigation?.kind === "history" && !pendingAdminNavigation.restored}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmAdminNavigation}
              disabled={pendingAdminNavigation?.kind === "history" && !pendingAdminNavigation.restored}
              data-testid="button-discard-calendar-navigation"
            >
              Discard and leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={editDialogOpen}
        onOpenChange={(open) => {
          setEditDialogOpen(open);
          if (!open) {
            setStaffToEdit(null);
            setEditEmail("");
          }
        }}
      >
        <DialogContent data-testid="dialog-edit-staff">
          <DialogHeader>
            <DialogTitle>Edit Staff</DialogTitle>
            <DialogDescription>
              Update details for <strong>{staffIdentityLabel(staffToEdit)}</strong>. Correcting the email keeps the same identity and class assignments.
              {staffToEdit?.membershipId ? (
                <span className="mt-1 block font-mono text-xs">Membership ID: {staffToEdit.membershipId}</span>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Display Name</Label>
              <Input
                id="edit-name"
                data-testid="input-edit-name"
                type="text"
                placeholder="e.g., John Smith"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-email">Email</Label>
              <Input
                id="edit-email"
                data-testid="input-edit-email"
                type="email"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
                autoComplete="email"
              />
              <p className="text-xs text-muted-foreground">
                Use this field for corrections and Workspace address changes. Do not remove and recreate the staff member.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-role">Role</Label>
              <Select
                value={selectedRole}
                onValueChange={(value) => setSelectedRole(value)}
              >
                <SelectTrigger id="edit-role" data-testid="select-edit-role">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="teacher">Teacher</SelectItem>
                  <SelectItem value="school_admin">School Admin</SelectItem>
                  <SelectItem value="office_staff">Office Staff (non-teaching)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {editRequiresSeparateSaves ? (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" data-testid="staff-separate-save-warning">
                Save the email correction by itself first. After the staff member signs in again, reopen this editor to save name or role changes.
              </div>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleEditSubmit}
                disabled={
                  updateStaffMutation.isPending
                  || editRequiresSeparateSaves
                  || !staffEmailSchema.safeParse(normalizeEmail(editEmail)).success
                }
              >
                {updateStaffMutation.isPending
                  ? "Saving..."
                  : editEmailChanged
                    ? "Save email correction"
                    : "Save profile changes"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={passwordDialogOpen}
        onOpenChange={(open) => {
          setPasswordDialogOpen(open);
          if (!open) {
            setStaffToResetPassword(null);
            setNewPassword("");
          }
        }}
      >
        <DialogContent data-testid="dialog-reset-password">
          <DialogHeader>
            <DialogTitle>Reset Password</DialogTitle>
            <DialogDescription>
              Set a new password for <strong>{staffIdentityLabel(staffToResetPassword)}</strong>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-password">New Password</Label>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password (min 10 characters)"
                data-testid="input-new-password"
              />
              <p className="text-xs text-muted-foreground">
                Minimum 10 characters required.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPasswordDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleResetPasswordSubmit}
                disabled={resetPasswordMutation.isPending || newPassword.length < 10}
              >
                {resetPasswordMutation.isPending ? "Resetting..." : "Reset Password"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <StaffAccessTransitionDialog
        open={Boolean(staffTransitionRequest)}
        onOpenChange={(open) => {
          if (!open) setStaffTransitionRequest(null);
        }}
        staff={staffTransitionRequest?.staff}
        allStaff={staff}
        transitionAction={staffTransitionRequest?.action || "deactivate"}
        newRole={staffTransitionRequest?.newRole}
      />

      <AlertDialog open={cleanupDialogOpen} onOpenChange={setCleanupDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear All Student Data</AlertDialogTitle>
            <AlertDialogDescription>
              Are you absolutely sure? This will permanently delete all student devices, activity history, and monitoring data from the database. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-cleanup">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-cleanup"
              onClick={() => cleanupStudentsMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Yes, Clear All Data
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add Staff Dialog */}
      <Dialog
        open={addStaffDialogOpen}
        onOpenChange={(open) => {
          setAddStaffDialogOpen(open);
          if (!open) {
            form.reset();
          }
        }}
      >
        <DialogContent data-testid="dialog-add-staff">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5" />
              Add Staff Member
            </DialogTitle>
            <DialogDescription>
              Add a teacher or school admin to your school. They can sign in with Google or use a temporary password.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="modal-name">Name (Optional)</Label>
              <Input
                id="modal-name"
                data-testid="input-staff-name"
                type="text"
                placeholder="e.g., John Smith"
                {...form.register("name")}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="modal-email">Email *</Label>
              <Input
                id="modal-email"
                data-testid="input-staff-email"
                type="email"
                placeholder="e.g., john.smith@school.edu"
                {...form.register("email")}
              />
              {form.formState.errors.email && (
                <p className="text-sm text-destructive">
                  {form.formState.errors.email.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="modal-role">Role</Label>
              <Select
                value={watchedRole}
                onValueChange={(value) => form.setValue("role", value)}
              >
                <SelectTrigger id="modal-role" data-testid="select-staff-role">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="teacher">Teacher</SelectItem>
                  <SelectItem value="school_admin">School Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="modal-password">Temp Password (Optional)</Label>
              <Input
                id="modal-password"
                data-testid="input-staff-password"
                type="password"
                placeholder="Leave blank for Google-only login"
                {...form.register("password")}
              />
              <p className="text-xs text-muted-foreground">
                If left blank, the user must sign in with Google.
              </p>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddStaffDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                data-testid="button-create-staff"
                disabled={createStaffMutation.isPending}
              >
                {createStaffMutation.isPending ? "Adding..." : "Add Staff"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(identityConflict)}
        onOpenChange={(open) => {
          if (!open && !createStaffMutation.isPending && !reactivateStaffMutation.isPending) {
            setIdentityConflict(null);
          }
        }}
      >
        <DialogContent data-testid="dialog-staff-identity-conflict">
          <DialogHeader>
            <DialogTitle>
              {identityConflict?.code === "STAFF_REACTIVATION_REQUIRED"
                ? "Reactivate the existing staff identity"
                : "Confirm this is a different person"}
            </DialogTitle>
            <DialogDescription>
              {identityConflict?.code === "STAFF_REACTIVATION_REQUIRED"
                ? "This email already belongs to former staff at this school. Reactivate that identity so its existing history and assignments remain connected."
                : "A staff member with the same name already exists under another email. Choose the existing identity when this is an email correction; create another identity only when these are truly different people."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {identityConflictCandidates.map((candidate) => (
              <div key={candidate.membershipId} className="flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">{staffIdentityLabel(candidate)}</p>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    Membership ID: {candidate.membershipId}
                  </p>
                  <div className="mt-1 flex gap-2">
                    <Badge variant="secondary">
                      {candidate.role === "school_admin" ? "School Admin" : "Teacher"}
                    </Badge>
                    <Badge variant={candidate.status === "inactive" ? "outline" : "default"}>
                      {candidate.status === "inactive" ? "Former staff" : "Active"}
                    </Badge>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" onClick={() => handleEditIdentityCandidate(candidate)}>
                    Edit existing email
                  </Button>
                  {candidate.status === "inactive" ? (
                    <Button
                      type="button"
                      onClick={() => reactivateStaffMutation.mutate(candidate.membershipId)}
                      disabled={reactivateStaffMutation.isPending}
                    >
                      Reactivate
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
            {identityConflictCandidates.length === 0 ? (
              <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
                Refresh the staff list to review the existing identity before continuing.
              </p>
            ) : null}
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setIdentityConflict(null);
                setAddStaffDialogOpen(true);
              }}
            >
              Back
            </Button>
            {identityConflict?.code === "POSSIBLE_DUPLICATE_STAFF" ? (
              <Button
                type="button"
                variant="destructive"
                data-testid="button-confirm-distinct-staff"
                onClick={handleConfirmDistinctPerson}
                disabled={createStaffMutation.isPending}
              >
                {createStaffMutation.isPending ? "Creating…" : "This is a different person"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import CSV Dialog */}
      <Dialog
        open={importDialogOpen}
        onOpenChange={(open) => {
          setImportDialogOpen(open);
          if (!open) {
            setImportFile(null);
            setImportPreview([]);
            setImportError("");
            setImportResult(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl" data-testid="dialog-import-staff">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" />
              Import Staff from CSV
            </DialogTitle>
            <DialogDescription>
              Upload a CSV file to bulk import staff members. The file should have columns for email, name (optional), and role (optional).
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* File Upload */}
            <div className="space-y-2">
              <Label htmlFor="csv-file">CSV File</Label>
              <div className="border-2 border-dashed rounded-lg p-6 text-center">
                <input
                  id="csv-file"
                  type="file"
                  accept=".csv"
                  onChange={handleFileChange}
                  className="hidden"
                />
                <label htmlFor="csv-file" className="cursor-pointer">
                  <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {importFile ? importFile.name : "Click to upload or drag and drop"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    CSV file with email, name, and role columns
                  </p>
                </label>
              </div>
            </div>

            {/* CSV Format Help */}
            <div className="bg-muted p-3 rounded-lg">
              <p className="text-sm font-medium mb-1">Expected CSV format:</p>
              <code className="text-xs text-muted-foreground">
                email,name,role<br />
                john@school.edu,John Smith,teacher<br />
                jane@school.edu,Jane Doe,admin
              </code>
            </div>

            {/* Error */}
            {importError && (
              <div className="bg-destructive/10 text-destructive p-3 rounded-lg text-sm">
                {importError}
              </div>
            )}

            {importResult?.failed > 0 ? (
              <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                <p className="font-medium">
                  Imported {importResult.success}; {importResult.failed} require identity review.
                </p>
                <p>
                  No conflicting row was created automatically. Use Add Staff to confirm a genuinely different person, Edit for an email correction, or Former staff to reactivate an existing identity.
                </p>
                <ul className="max-h-36 space-y-1 overflow-auto">
                  {importResult.errors.map((error) => (
                    <li key={`${error.email}-${error.code || error.message}`}>
                      <span className="font-medium">{error.email}</span>: {error.message}
                      {error.code ? <span className="ml-1 font-mono text-xs">({error.code})</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Preview */}
            {importPreview.length > 0 && (
              <div className="space-y-2">
                <Label>Preview ({importPreview.length} staff members)</Label>
                <div className="border rounded-lg max-h-48 overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Name</th>
                        <th className="px-3 py-2 text-left font-medium">Email</th>
                        <th className="px-3 py-2 text-left font-medium">Role</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.slice(0, 10).map((user, idx) => (
                        <tr key={idx} className="border-t">
                          <td className="px-3 py-2">{user.name || "\u2014"}</td>
                          <td className="px-3 py-2">{user.email}</td>
                          <td className="px-3 py-2">
                            <Badge variant={user.role === "admin" ? "default" : "secondary"}>
                              {user.role === "admin" ? "School Admin" : "Teacher"}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                      {importPreview.length > 10 && (
                        <tr className="border-t">
                          <td colSpan={3} className="px-3 py-2 text-center text-muted-foreground">
                            ...and {importPreview.length - 10} more
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setImportDialogOpen(false)}>
              {importResult ? "Close" : "Cancel"}
            </Button>
            {!importResult ? (
              <Button
                onClick={() => bulkImportMutation.mutate(importPreview)}
                disabled={importPreview.length === 0 || bulkImportMutation.isPending}
              >
                {bulkImportMutation.isPending ? "Importing..." : `Import ${importPreview.length} Staff`}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Google Workspace Staff Import Dialog */}
      <Dialog open={wsImportDialogOpen} onOpenChange={(open) => {
        setWsImportDialogOpen(open);
        if (!open) { setWsImportResult(null); setWsImportOU(""); setWsExcludedEmails(new Set()); }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" />
              Import Staff from Google Workspace
            </DialogTitle>
            <DialogDescription>
              Import teachers and staff from your Google Workspace directory
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {wsUsersLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin mr-2" />
                <span className="text-muted-foreground">Loading users from Google Workspace...</span>
              </div>
            ) : wsErrorCode === "NO_TOKENS" || wsErrorCode === "GOOGLE_CONNECTOR_REQUIRED" ? (
              <GoogleRosterConnectorPanel onConnected={() => {
                wsUsersRefetch();
                wsOURefetch();
              }} />
            ) : wsErrorCode === "INSUFFICIENT_PERMISSIONS" ? (
              <div className="text-center py-8 space-y-4">
                <div className="flex items-center justify-center gap-2 text-yellow-600">
                  <AlertCircle className="h-5 w-5" />
                  <span className="font-medium">Admin Access Required</span>
                </div>
                <p className="text-muted-foreground">This feature requires Google Workspace administrator privileges. Make sure you connected a Google Workspace admin account.</p>
              </div>
            ) : wsErrorCode ? (
              <div className="text-center py-8 space-y-4">
                <div className="flex items-center justify-center gap-2 text-red-600">
                  <AlertCircle className="h-5 w-5" />
                  <span className="font-medium">Failed to load users</span>
                </div>
                <p className="text-muted-foreground">{wsUsersError?.response?.data?.error || wsUsersError?.message || "An unexpected error occurred."}</p>
                <Button variant="outline" size="sm" onClick={() => wsUsersRefetch()}>Try Again</Button>
              </div>
            ) : wsImportResult ? (
              <div className="space-y-4">
                <div className="p-4 border rounded-md space-y-3">
                  <p className="font-medium">Import Results:</p>
                  <div className="grid grid-cols-3 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">Imported</p>
                      <p className="text-2xl font-bold text-green-600">{wsImportResult.imported || 0}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Updated</p>
                      <p className="text-2xl font-bold text-blue-600">{wsImportResult.updated || 0}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Skipped / review</p>
                      <p className="text-2xl font-bold text-amber-700">{wsImportResult.skipped || 0}</p>
                    </div>
                  </div>
                  {wsImportResult.errors?.length > 0 && (
                    <div className="mt-3 p-3 bg-destructive/10 rounded-md">
                      <p className="font-medium text-destructive mb-2">
                        Rows requiring review ({wsImportResult.errors.length}):
                      </p>
                      <ul className="max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-sm text-destructive" data-testid="workspace-staff-import-errors">
                        {wsImportResult.errors.map((err, i) => <li key={i}>{workspaceImportIssueText(err)}</li>)}
                      </ul>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Keep this result open until every skipped or failed row has been reviewed. No row is silently overwritten.
                  </p>
                </div>
                <div className="flex justify-end">
                  <Button onClick={() => setWsImportDialogOpen(false)}>Done</Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    Found {wsFilteredUsers.length} user{wsFilteredUsers.length !== 1 ? "s" : ""}
                  </p>
                  <Button variant="outline" size="sm" onClick={() => wsUsersRefetch()}>
                    <RefreshCw className="h-4 w-4 mr-2" /> Refresh
                  </Button>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Filter by Organizational Unit</Label>
                    <Select value={wsImportOU} onValueChange={(v) => { setWsImportOU(v); setWsExcludedEmails(new Set()); }}>
                      <SelectTrigger>
                        <SelectValue placeholder={wsOULoading ? "Loading..." : "All Users"} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__all__">All Users</SelectItem>
                        {wsOUs.map((ou) => (
                          <SelectItem key={ou.orgUnitId} value={ou.orgUnitPath}>{ou.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Import as Role</Label>
                    <Select value={wsImportRole} onValueChange={(v) => setWsImportRole(v)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="teacher">Teacher</SelectItem>
                        <SelectItem value="school_admin">School Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {wsFilteredUsers.length > 0 && (
                  <div className="border rounded-md divide-y max-h-64 overflow-auto">
                    {wsFilteredUsers.map((user) => {
                      const excluded = wsExcludedEmails.has(user.email.toLowerCase());
                      return (
                        <div key={user.id} className="flex items-center gap-3 p-2 text-sm">
                          <Checkbox
                            checked={!excluded}
                            onCheckedChange={(checked) => {
                              setWsExcludedEmails(prev => {
                                const next = new Set(prev);
                                if (checked) next.delete(user.email.toLowerCase());
                                else next.add(user.email.toLowerCase());
                                return next;
                              });
                            }}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate">{user.name}</p>
                            <p className="text-muted-foreground text-xs truncate">{user.email}</p>
                          </div>
                          {user.orgUnitPath && (
                            <span className="text-xs text-muted-foreground">{user.orgUnitPath}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setWsImportDialogOpen(false)}>Cancel</Button>
                  <Button
                    onClick={() => {
                      const excludeArr = wsExcludedEmails.size > 0 ? Array.from(wsExcludedEmails) : undefined;
                      wsImportMutation.mutate({
                        orgUnitPath: wsImportOU && wsImportOU !== "__all__" ? wsImportOU : undefined,
                        role: wsImportRole,
                        excludeEmails: excludeArr,
                      });
                    }}
                    disabled={wsImportMutation.isPending || wsFilteredUsers.length - wsExcludedEmails.size === 0}
                  >
                    {wsImportMutation.isPending ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Importing...</>
                    ) : (
                      <><Users className="h-4 w-4 mr-2" />Import {wsFilteredUsers.length - wsExcludedEmails.size} Staff</>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
