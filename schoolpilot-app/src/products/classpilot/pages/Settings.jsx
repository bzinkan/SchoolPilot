import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { useToast } from "../../../hooks/use-toast";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import { ArrowLeft, Download, Shield, Clock, AlertCircle, Layers, Plus, Pencil, Trash2, Star, Users, BookOpen, Eye, Copy, RefreshCw, KeyRound } from "lucide-react";
import { ThemeToggle } from "../../../components/ThemeToggle";

// Helper function to normalize domain names
function normalizeDomain(domain) {
  let normalized = domain.trim().toLowerCase();

  // Remove protocol if present
  normalized = normalized.replace(/^https?:\/\//i, '');

  // Remove www. prefix
  normalized = normalized.replace(/^www\./i, '');

  // Remove paths, query params, and hash
  normalized = normalized.split('/')[0].split('?')[0].split('#')[0];

  // Remove port if present
  normalized = normalized.split(':')[0];

  return normalized;
}

function buildManagedPolicy(enrollmentKeySettings) {
  const serverUrl = typeof window !== "undefined" ? window.location.origin : "https://school-pilot.net";
  const policy = {
    serverUrl,
  };

  if (enrollmentKeySettings?.schoolSlug) {
    policy.schoolSlug = enrollmentKeySettings.schoolSlug;
  } else if (enrollmentKeySettings?.schoolId) {
    policy.schoolId = enrollmentKeySettings.schoolId;
  } else {
    policy.schoolSlug = "your-school-slug";
  }

  policy.enrollmentKey = enrollmentKeySettings?.key || "generate-a-setup-key-first";
  return JSON.stringify(policy, null, 2);
}

const settingsSchema = z.object({
  schoolName: z.string().min(1, "School name is required"),
  retentionDays: z.string().min(1, "Retention period is required"),
  maxTabsPerStudent: z.string().optional(),
  blockedDomains: z.string(),
  allowedDomains: z.string(),
  ipAllowlist: z.string(),
  aiSafetyEmailsEnabled: z.boolean().optional(),
  autoBlockUnsafeUrls: z.boolean().optional(),
  sharedChromebookSignInEnabled: z.boolean().optional(),
  sharedChromebookPinLoginEnabled: z.boolean().optional(),
});

export default function Settings() {
  const navigate = useNavigate();
  const { toast } = useToast();

  // Flight Paths management state
  const [showSceneDialog, setShowSceneDialog] = useState(false);
  const [editingScene, setEditingScene] = useState(null);
  const [flightPathName, setSceneName] = useState("");
  const [sceneDescription, setSceneDescription] = useState("");
  const [sceneAllowedDomains, setSceneAllowedDomains] = useState("");
  const [deleteSceneId, setDeleteSceneId] = useState(null);
  const [showClassroomDialog, setShowClassroomDialog] = useState(false);
  const [selectedCourseId, setSelectedCourseId] = useState("");
  const [selectedResourceIds, setSelectedResourceIds] = useState(new Set());
  const [classroomFlightPathName, setClassroomFlightPathName] = useState("");


  const { data: settings, isLoading } = useQuery({
    queryKey: ['/api/settings'],
    queryFn: () => apiRequest('GET', '/settings'),
  });

  const { data: scenes = [], isLoading: scenesLoading } = useQuery({
    queryKey: ['/api/flight-paths'],
    queryFn: () => apiRequest('GET', '/flight-paths'),
    select: (data) => Array.isArray(data) ? data : (data?.flightPaths ?? data?.scenes ?? []),
  });

  const { data: parentDigestSettings } = useQuery({
    queryKey: ["/api/classpilot/parent-digests/settings"],
    queryFn: () => apiRequest("GET", "/classpilot/parent-digests/settings"),
    select: (data) => data?.settings ?? {},
  });

  const { data: enrollmentKeySettings, isLoading: enrollmentKeyLoading } = useQuery({
    queryKey: ["/api/classpilot/enrollment-key"],
    queryFn: () => apiRequest("GET", "/classpilot/enrollment-key"),
  });

  const { data: classroomCourses = [], isLoading: classroomCoursesLoading } = useQuery({
    queryKey: ["/api/classroom/courses"],
    queryFn: () => apiRequest("GET", "/classroom/courses"),
    select: (data) => data?.courses ?? [],
    enabled: showClassroomDialog,
  });

  const { data: classroomResources = [], isLoading: classroomResourcesLoading } = useQuery({
    queryKey: ["/api/classroom/resources", selectedCourseId],
    queryFn: () => apiRequest("GET", `/classroom/courses/${selectedCourseId}/resources`),
    select: (data) => data?.resources ?? [],
    enabled: showClassroomDialog && !!selectedCourseId,
  });

  const form = useForm({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      schoolName: settings?.schoolName || "",
      retentionDays: settings?.retentionHours ? String(Math.round(parseInt(settings.retentionHours) / 24)) : "30",
      maxTabsPerStudent: settings?.maxTabsPerStudent || "",
      blockedDomains: settings?.blockedDomains?.join(", ") || "",
      allowedDomains: settings?.allowedDomains?.join(", ") || "",
      ipAllowlist: settings?.ipAllowlist?.join(", ") || "",
      aiSafetyEmailsEnabled: settings?.aiSafetyEmailsEnabled !== false,
      autoBlockUnsafeUrls: settings?.autoBlockUnsafeUrls !== false,
      sharedChromebookSignInEnabled: settings?.sharedChromebookSignInEnabled === true,
      sharedChromebookPinLoginEnabled: settings?.sharedChromebookPinLoginEnabled === true,
    },
  });

  // Update form when settings load
  useEffect(() => {
    if (settings) {
      form.reset({
        schoolName: settings.schoolName,
        retentionDays: settings.retentionHours ? String(Math.round(parseInt(settings.retentionHours) / 24)) : "30",
        maxTabsPerStudent: settings.maxTabsPerStudent || "",
        blockedDomains: settings.blockedDomains?.join(", ") || "",
        allowedDomains: settings.allowedDomains?.join(", ") || "",
        ipAllowlist: settings.ipAllowlist?.join(", ") || "",
        aiSafetyEmailsEnabled: settings.aiSafetyEmailsEnabled !== false,
        autoBlockUnsafeUrls: settings.autoBlockUnsafeUrls !== false,
        sharedChromebookSignInEnabled: settings.sharedChromebookSignInEnabled === true,
        sharedChromebookPinLoginEnabled: settings.sharedChromebookPinLoginEnabled === true,
      });
    }
  }, [settings, form]);

  const updateSettingsMutation = useMutation({
    mutationFn: async (data) => {
      // Convert days to hours for storage
      const retentionHours = String(parseInt(data.retentionDays) * 24);

      const payload = {
        ...data,
        retentionHours,
        maxTabsPerStudent: data.maxTabsPerStudent || null,
        blockedDomains: data.blockedDomains
          .split(",")
          .map((d) => normalizeDomain(d))
          .filter(Boolean),
        allowedDomains: data.allowedDomains
          .split(",")
          .map((d) => normalizeDomain(d))
          .filter(Boolean),
        ipAllowlist: data.ipAllowlist
          .split(",")
          .map((ip) => ip.trim())
          .filter(Boolean),
        aiSafetyEmailsEnabled: data.aiSafetyEmailsEnabled !== false,
        autoBlockUnsafeUrls: data.autoBlockUnsafeUrls !== false,
        sharedChromebookSignInEnabled: data.sharedChromebookSignInEnabled === true,
        sharedChromebookPinLoginEnabled: data.sharedChromebookPinLoginEnabled === true,
      };
      return await apiRequest("POST", "/settings", payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
      toast({
        title: "Settings saved",
        description: "Your settings have been updated successfully",
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to save settings",
        description: error.message,
      });
    },
  });

  const rotateEnrollmentKeyMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/classpilot/enrollment-key/rotate"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/classpilot/enrollment-key"] });
      toast({
        title: "Setup key ready",
        description: "The managed extension policy has been updated with the new key.",
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to generate setup key",
        description: error.message,
      });
    },
  });

  // Scenes mutations
  const createSceneMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("POST", "/flight-paths", {
        flightPathName,
        description: sceneDescription || undefined,
        allowedDomains: sceneAllowedDomains.split(",").map(d => normalizeDomain(d)).filter(Boolean),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/flight-paths'] });
      toast({ title: "Flight path created", description: `"${flightPathName}" has been created successfully` });
      setShowSceneDialog(false);
      resetSceneForm();
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Failed to create flight path", description: error.message });
    },
  });

  const updateSceneMutation = useMutation({
    mutationFn: async () => {
      if (!editingScene) throw new Error("No scene to update");
      return await apiRequest("PATCH", `/flight-paths/${editingScene.id}`, {
        flightPathName,
        description: sceneDescription || undefined,
        allowedDomains: sceneAllowedDomains.split(",").map(d => normalizeDomain(d)).filter(Boolean),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/flight-paths'] });
      toast({ title: "Flight path updated", description: `"${flightPathName}" has been updated successfully` });
      setShowSceneDialog(false);
      resetSceneForm();
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Failed to update flight path", description: error.message });
    },
  });

  const deleteSceneMutation = useMutation({
    mutationFn: async (flightPathId) => {
      return await apiRequest("DELETE", `/flight-paths/${flightPathId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/flight-paths'] });
      toast({ title: "Flight path deleted", description: "The flight path has been deleted successfully" });
      setDeleteSceneId(null);
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Failed to delete flight path", description: error.message });
    },
  });

  const classroomFlightPathMutation = useMutation({
    mutationFn: async () => {
      const selectedResources = classroomResources.filter((resource) => selectedResourceIds.has(resource.id));
      return apiRequest("POST", "/flight-paths/from-classroom", {
        courseId: selectedCourseId,
        selectedResourceIds: [...selectedResourceIds],
        resources: selectedResources,
        name: classroomFlightPathName || "Classroom Flight Path",
        description: "Created from Google Classroom resources",
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/flight-paths"] });
      toast({ title: "Flight path created", description: `${data.extracted?.allowedDomains?.length || 0} allowed entries extracted` });
      setShowClassroomDialog(false);
      setSelectedCourseId("");
      setSelectedResourceIds(new Set());
      setClassroomFlightPathName("");
    },
    onError: (error) => toast({ variant: "destructive", title: "Classroom import failed", description: error.message }),
  });

  const parentDigestMutation = useMutation({
    mutationFn: (payload) => apiRequest("PATCH", "/classpilot/parent-digests/settings", {
      parentTransparencyEnabled: !!payload.parentTransparencyEnabled,
      parentDigestIncludesSafety: !!payload.parentDigestIncludesSafety,
      parentDigestIncludesPassDismissal: payload.parentDigestIncludesPassDismissal !== false,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/classpilot/parent-digests/settings"] });
      toast({ title: "Parent digest settings saved" });
    },
    onError: (error) => toast({ variant: "destructive", title: "Digest settings failed", description: error.message }),
  });

  const resetSceneForm = () => {
    setSceneName("");
    setSceneDescription("");
    setSceneAllowedDomains("");
    setEditingScene(null);
  };

  const handleCreateScene = () => {
    resetSceneForm();
    setShowSceneDialog(true);
  };

  const handleEditScene = (scene) => {
    setEditingScene(scene);
    setSceneName(scene.flightPathName);
    setSceneDescription(scene.description || "");
    setSceneAllowedDomains(scene.allowedDomains?.join(", ") || "");
    setShowSceneDialog(true);
  };

  const handleSaveScene = () => {
    if (!flightPathName.trim()) {
      toast({ variant: "destructive", title: "Flight path name required", description: "Please enter a name for the flight path" });
      return;
    }
    if (editingScene) {
      updateSceneMutation.mutate();
    } else {
      createSceneMutation.mutate();
    }
  };

  const handleDeleteScene = (flightPathId) => {
    setDeleteSceneId(flightPathId);
  };

  const confirmDeleteScene = () => {
    if (deleteSceneId) {
      deleteSceneMutation.mutate(deleteSceneId);
    }
  };

  const onSubmit = (data) => {
    updateSettingsMutation.mutate(data);
  };

  const sharedSignInEnabled = form.watch("sharedChromebookSignInEnabled");
  const pinLoginEnabled = form.watch("sharedChromebookPinLoginEnabled");
  const managedPolicy = buildManagedPolicy(enrollmentKeySettings);
  const setupKey = enrollmentKeySettings?.key || "";

  const copyText = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: label });
    } catch {
      toast({
        variant: "destructive",
        title: "Copy failed",
        description: "Select the text and copy it manually.",
      });
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="h-8 w-8 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-sm text-muted-foreground">Loading settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-background">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => navigate("/classpilot")}
                data-testid="button-back"
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div>
                <h1 className="text-xl font-semibold">Settings</h1>
                <p className="text-xs text-muted-foreground">Manage your classroom monitoring settings</p>
              </div>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-6 py-8 space-y-8">
        {/* General Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              General Settings
            </CardTitle>
            <CardDescription>
              Configure your school information and security settings
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="schoolName">School Name</Label>
                <Input
                  id="schoolName"
                  data-testid="input-school-name"
                  {...form.register("schoolName")}
                  placeholder="Enter your school name"
                />
                {form.formState.errors.schoolName && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.schoolName.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="retentionDays">Data Retention (days)</Label>
                <Input
                  id="retentionDays"
                  data-testid="input-retention-days"
                  type="number"
                  {...form.register("retentionDays")}
                  placeholder="30"
                />
                {form.formState.errors.retentionDays && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.retentionDays.message}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Student activity data will be automatically deleted after this period
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="maxTabsPerStudent">Maximum Tabs Per Student</Label>
                <Input
                  id="maxTabsPerStudent"
                  data-testid="input-max-tabs"
                  type="number"
                  {...form.register("maxTabsPerStudent")}
                  placeholder="Leave empty for unlimited"
                />
                {form.formState.errors.maxTabsPerStudent && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.maxTabsPerStudent.message}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Limit the number of tabs students can have open. Leave empty for unlimited tabs.
                </p>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">School-Wide Blocked Content</p>
                <div className="flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">Sexual Content</span>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">Violent Content</span>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">Drug-Related Content</span>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">Self-Harm Content</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  AI automatically blocks unsafe content. If AI is blocking a domain you want to allow, add it to the Allowed Domains field below.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="allowedDomains">Allowed Domains (comma-separated)</Label>
                <Input
                  id="allowedDomains"
                  data-testid="input-allowed-domains"
                  {...form.register("allowedDomains")}
                  placeholder="youtube.com, wikipedia.org"
                />
                <p className="text-xs text-muted-foreground">
                  Domains listed here will never be blocked by AI. Use this to allow sites that AI may flag as unsafe.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="blockedDomains">Blocked Websites (comma-separated)</Label>
                <Input
                  id="blockedDomains"
                  data-testid="input-blocked-domains"
                  {...form.register("blockedDomains")}
                  placeholder="lens.google.com, chat.openai.com, quillbot.com"
                />
                <p className="text-xs text-muted-foreground">
                  Students will be blocked from accessing these domains. Use this to block AI tools, cheating sites, etc.
                </p>
              </div>

              <div className="flex items-center space-x-3">
                <input
                  type="checkbox"
                  id="aiSafetyEmailsEnabled"
                  className="h-4 w-4 rounded border-gray-300"
                  {...form.register("aiSafetyEmailsEnabled")}
                />
                <Label htmlFor="aiSafetyEmailsEnabled">
                  AI Safety Alert Emails
                </Label>
              </div>
              <p className="text-xs text-muted-foreground -mt-4 ml-7">
                Send email notifications to school admins when dangerous content (self-harm, violence, sexual) is detected.
              </p>

              <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                Attendance, hall pass, and dismissal context reduces classroom off-task noise in the dashboard. Critical student safety monitoring remains active and is still logged and routed to staff.
              </div>

              <div className="rounded-md border p-4 space-y-3">
                <div>
                  <p className="text-sm font-medium flex items-center gap-2">
                    <KeyRound className="h-4 w-4" />
                    Shared Chromebook Sign-In
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Enable manual sign-in when the extension cannot detect a Chrome profile email. IT only needs to apply one managed policy to the student Chromebook OU.
                  </p>
                </div>
                <div className="flex items-center space-x-3">
                  <input
                    type="checkbox"
                    id="sharedChromebookSignInEnabled"
                    className="h-4 w-4 rounded border-gray-300"
                    {...form.register("sharedChromebookSignInEnabled")}
                  />
                  <Label htmlFor="sharedChromebookSignInEnabled">
                    Enable Email + Student ID fallback
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground ml-7">
                  Students enter their school email and Student ID Number from the SchoolPilot roster.
                </p>
                <div className="flex items-center space-x-3">
                  <input
                    type="checkbox"
                    id="sharedChromebookPinLoginEnabled"
                    className="h-4 w-4 rounded border-gray-300"
                    {...form.register("sharedChromebookPinLoginEnabled")}
                  />
                  <Label htmlFor="sharedChromebookPinLoginEnabled">
                    Enable Name + PIN login
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground ml-7">
                  Optional. Students choose their grade, pick their name, and enter their 4-digit PIN.
                </p>

                <div className="rounded-md border bg-muted/30 p-3 space-y-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm font-medium">Shared Chromebook setup key</p>
                      <p className="text-xs text-muted-foreground">
                        Generate once, then copy the policy below into Google Admin for the ClassPilot extension.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => rotateEnrollmentKeyMutation.mutate()}
                      disabled={rotateEnrollmentKeyMutation.isPending || enrollmentKeyLoading}
                    >
                      <RefreshCw className={`h-4 w-4 mr-2 ${rotateEnrollmentKeyMutation.isPending ? "animate-spin" : ""}`} />
                      {setupKey ? "Rotate Key" : "Generate Key"}
                    </Button>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="shared-chromebook-setup-key">Setup key</Label>
                    <div className="flex gap-2">
                      <Input
                        id="shared-chromebook-setup-key"
                        readOnly
                        value={setupKey || "No setup key generated yet"}
                        className="font-mono text-xs"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => setupKey && copyText(setupKey, "Setup key copied")}
                        disabled={!setupKey}
                        aria-label="Copy setup key"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <Label htmlFor="shared-chromebook-policy">Google Admin managed policy</Label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setupKey && copyText(managedPolicy, "Managed policy copied")}
                        disabled={!setupKey}
                      >
                        <Copy className="h-4 w-4 mr-2" />
                        Copy
                      </Button>
                    </div>
                    <pre
                      id="shared-chromebook-policy"
                      className="max-h-56 overflow-auto rounded-md border bg-background p-3 text-xs"
                    >
{managedPolicy}
                    </pre>
                    <p className="text-xs text-muted-foreground">
                      Apply this once to the student Chromebook organizational unit. Do not add grade, class, or Chromebook-specific fields; students choose their grade during PIN sign-in.
                    </p>
                  </div>

                  <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                    <div className="rounded-md border bg-background p-2">
                      Email + ID: {sharedSignInEnabled ? "enabled after saving settings" : "off"}
                    </div>
                    <div className="rounded-md border bg-background p-2">
                      Name + PIN: {pinLoginEnabled ? "enabled after saving settings" : "off"}
                    </div>
                  </div>
                </div>
              </div>

              <Button
                type="submit"
                data-testid="button-save-settings"
                disabled={updateSettingsMutation.isPending}
              >
                {updateSettingsMutation.isPending ? "Saving..." : "Save Settings"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Flight Path Management */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="h-5 w-5" />
                Flight Path Management
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowClassroomDialog(true)}
                  data-testid="button-import-classroom-flight-path"
                >
                  <BookOpen className="h-4 w-4 mr-2" />
                  From Classroom
                </Button>
                <Button
                  size="sm"
                  onClick={handleCreateScene}
                  data-testid="button-create-scene"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Create Flight Path
                </Button>
              </div>
            </CardTitle>
            <CardDescription>
              Create browsing environments with allowed/blocked websites for different activities
            </CardDescription>
          </CardHeader>
          <CardContent>
            {scenesLoading ? (
              <div className="text-center py-8">
                <div className="h-6 w-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
                <p className="text-sm text-muted-foreground">Loading flight paths...</p>
              </div>
            ) : scenes.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Layers className="h-12 w-12 mx-auto mb-3 opacity-20" />
                <p className="text-sm">No flight paths created yet</p>
                <p className="text-xs mt-1">Create a flight path to get started</p>
              </div>
            ) : (
              <div className="space-y-3">
                {scenes.map((scene) => (
                  <div
                    key={scene.id}
                    className="border rounded-lg p-4 space-y-2 hover-elevate"
                    data-testid={`scene-card-${scene.id}`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <h4 className="font-medium">{scene.flightPathName}</h4>
                          {scene.isDefault && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary">
                              <Star className="h-3 w-3 mr-1" />
                              Default
                            </span>
                          )}
                        </div>
                        {scene.description && (
                          <p className="text-sm text-muted-foreground mt-1">{scene.description}</p>
                        )}
                        <div className="mt-2 space-y-1 text-xs">
                          {scene.allowedDomains && scene.allowedDomains.length > 0 && (
                            <div className="flex items-start gap-2">
                              <span className="text-green-600 dark:text-green-400 font-medium shrink-0">Allowed:</span>
                              <span className="text-muted-foreground">{scene.allowedDomains.join(", ")}</span>
                            </div>
                          )}
                          {scene.blockedDomains && scene.blockedDomains.length > 0 && (
                            <div className="flex items-start gap-2">
                              <span className="text-red-600 dark:text-red-400 font-medium shrink-0">Blocked:</span>
                              <span className="text-muted-foreground">{scene.blockedDomains.join(", ")}</span>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 ml-4">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleEditScene(scene)}
                          data-testid={`button-edit-scene-${scene.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleDeleteScene(scene.id)}
                          data-testid={`button-delete-scene-${scene.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Parent Transparency */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5" />
              Parent Transparency Digest
            </CardTitle>
            <CardDescription>
              Weekly opt-in summaries for approved GoPilot parent-child links
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-start gap-3 rounded-md border p-3">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={!!parentDigestSettings?.parentTransparencyEnabled}
                onChange={(event) => parentDigestMutation.mutate({
                  ...parentDigestSettings,
                  parentTransparencyEnabled: event.target.checked,
                })}
              />
              <span>
                <span className="block text-sm font-medium">Enable weekly parent digests</span>
                <span className="text-xs text-muted-foreground">Uses approved GoPilot parent links only.</span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-md border p-3">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={parentDigestSettings?.parentDigestIncludesPassDismissal !== false}
                onChange={(event) => parentDigestMutation.mutate({
                  ...parentDigestSettings,
                  parentDigestIncludesPassDismissal: event.target.checked,
                })}
              />
              <span>
                <span className="block text-sm font-medium">Include pass and dismissal summary</span>
                <span className="text-xs text-muted-foreground">Shows counts and high-level school day context.</span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-md border p-3">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={!!parentDigestSettings?.parentDigestIncludesSafety}
                onChange={(event) => parentDigestMutation.mutate({
                  ...parentDigestSettings,
                  parentDigestIncludesSafety: event.target.checked,
                })}
              />
              <span>
                <span className="block text-sm font-medium">Include staff-approved safety notes</span>
                <span className="text-xs text-muted-foreground">No screenshots, raw browsing timelines, or raw email content are included.</span>
              </span>
            </label>
          </CardContent>
        </Card>

        {/* Privacy Notice */}
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertCircle className="h-5 w-5 text-primary" />
              Privacy & Compliance
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              This system is designed to be FERPA and COPPA compliant. All monitoring is visible to students through the Chrome extension.
            </p>
            <p>
              Data collected: Tab titles, URLs, and timestamps only. No keystrokes, microphone, or camera access.
            </p>
            <p>
              Screen sharing requires explicit student consent via button click and shows a visible indicator.
            </p>
          </CardContent>
        </Card>
      </main>

      {/* Flight Path Create/Edit Dialog */}
      <Dialog open={showSceneDialog} onOpenChange={setShowSceneDialog}>
        <DialogContent data-testid="dialog-scene-form">
          <DialogHeader>
            <DialogTitle>{editingScene ? "Edit Flight Path" : "Create New Flight Path"}</DialogTitle>
            <DialogDescription>
              {editingScene ? "Update the flight path configuration" : "Lock students into specific allowed domains for focused learning"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="scene-name">Flight Path Name *</Label>
              <Input
                id="scene-name"
                value={flightPathName}
                onChange={(e) => setSceneName(e.target.value)}
                placeholder="e.g., Research Time, Math Practice, Reading"
                data-testid="input-scene-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="scene-description">Description</Label>
              <Input
                id="scene-description"
                value={sceneDescription}
                onChange={(e) => setSceneDescription(e.target.value)}
                placeholder="Optional description of this flight path"
                data-testid="input-scene-description"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="scene-allowed">Allowed Domains</Label>
              <Input
                id="scene-allowed"
                value={sceneAllowedDomains}
                onChange={(e) => setSceneAllowedDomains(e.target.value)}
                placeholder="classroom.google.com, docs.google.com, khanacademy.org"
                data-testid="input-scene-allowed-domains"
              />
              <div className="text-xs text-muted-foreground space-y-1">
                <p>Comma-separated domains. Use specific subdomains for best control.</p>
                <p className="font-medium text-primary">Google Services Examples:</p>
                <ul className="ml-3 space-y-0.5">
                  <li>• <code className="text-xs bg-muted px-1 rounded">classroom.google.com</code> - Google Classroom only</li>
                  <li>• <code className="text-xs bg-muted px-1 rounded">docs.google.com</code> - Forms, Docs, Sheets, Slides</li>
                  <li>• <code className="text-xs bg-muted px-1 rounded">drive.google.com</code> - Google Drive only</li>
                </ul>
                <p className="text-amber-600 dark:text-amber-500 pt-1 flex items-start gap-1">
                  <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                  <span>Using just <code className="text-xs bg-muted px-1 rounded">google.com</code> allows ALL Google services (YouTube, Gmail, etc.)</span>
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowSceneDialog(false)}
              data-testid="button-cancel-scene"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSaveScene}
              disabled={createSceneMutation.isPending || updateSceneMutation.isPending}
              data-testid="button-save-scene"
            >
              {createSceneMutation.isPending || updateSceneMutation.isPending ? "Saving..." : (editingScene ? "Update Flight Path" : "Create Flight Path")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Classroom Flight Path Dialog */}
      <Dialog open={showClassroomDialog} onOpenChange={setShowClassroomDialog}>
        <DialogContent className="max-w-3xl" data-testid="dialog-classroom-flight-path">
          <DialogHeader>
            <DialogTitle>Create Flight Path From Classroom</DialogTitle>
            <DialogDescription>
              Select Classroom resources and create a Flight Path from their linked websites.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 md:grid-cols-[240px_1fr]">
            <div className="space-y-2">
              <Label>Course</Label>
              <div className="max-h-80 overflow-auto rounded-md border">
                {classroomCoursesLoading ? (
                  <p className="p-3 text-sm text-muted-foreground">Loading courses...</p>
                ) : classroomCourses.length === 0 ? (
                  <p className="p-3 text-sm text-muted-foreground">No Classroom courses found.</p>
                ) : classroomCourses.map((course) => (
                  <button
                    key={course.id}
                    type="button"
                    className={`block w-full border-b px-3 py-2 text-left text-sm hover:bg-muted ${selectedCourseId === course.id ? "bg-muted font-medium" : ""}`}
                    onClick={() => {
                      setSelectedCourseId(course.id);
                      setSelectedResourceIds(new Set());
                      setClassroomFlightPathName(course.name ? `${course.name} Flight Path` : "Classroom Flight Path");
                    }}
                  >
                    {course.name || course.courseName || course.id}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="classroom-flight-path-name">Flight Path Name</Label>
                <Input
                  id="classroom-flight-path-name"
                  value={classroomFlightPathName}
                  onChange={(event) => setClassroomFlightPathName(event.target.value)}
                  placeholder="Classroom Flight Path"
                />
              </div>
              <div className="max-h-80 overflow-auto rounded-md border">
                {!selectedCourseId ? (
                  <p className="p-3 text-sm text-muted-foreground">Select a course to load assignments and materials.</p>
                ) : classroomResourcesLoading ? (
                  <p className="p-3 text-sm text-muted-foreground">Loading resources...</p>
                ) : classroomResources.length === 0 ? (
                  <p className="p-3 text-sm text-muted-foreground">No linked coursework or materials found.</p>
                ) : classroomResources.map((resource) => {
                  const checked = selectedResourceIds.has(resource.id);
                  return (
                    <label key={`${resource.resourceType}-${resource.id}`} className="flex cursor-pointer items-start gap-3 border-b p-3 text-sm hover:bg-muted/50">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4"
                        checked={checked}
                        onChange={(event) => {
                          setSelectedResourceIds((prev) => {
                            const next = new Set(prev);
                            if (event.target.checked) next.add(resource.id);
                            else next.delete(resource.id);
                            return next;
                          });
                        }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{resource.title}</span>
                        <span className="text-xs text-muted-foreground">{resource.resourceType} · {resource.links?.length || 0} link(s)</span>
                        <span className="mt-1 block truncate text-xs text-muted-foreground">
                          {(resource.links || []).map((link) => link.url).join(", ")}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowClassroomDialog(false)}>Cancel</Button>
            <Button
              onClick={() => classroomFlightPathMutation.mutate()}
              disabled={!selectedCourseId || selectedResourceIds.size === 0 || classroomFlightPathMutation.isPending}
            >
              {classroomFlightPathMutation.isPending ? "Creating..." : "Create Flight Path"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Flight Path Confirmation Dialog */}
      <Dialog open={deleteSceneId !== null} onOpenChange={(open) => !open && setDeleteSceneId(null)}>
        <DialogContent data-testid="dialog-delete-scene">
          <DialogHeader>
            <DialogTitle>Delete Flight Path</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this flight path? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteSceneId(null)}
              data-testid="button-cancel-delete-scene"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDeleteScene}
              disabled={deleteSceneMutation.isPending}
              data-testid="button-confirm-delete-scene"
            >
              {deleteSceneMutation.isPending ? "Deleting..." : "Delete Flight Path"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
