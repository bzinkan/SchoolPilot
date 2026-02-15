import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useTeachers, useGrades } from "../../../../hooks/use-students";
import { usePassPilotAuth } from "../../../../hooks/usePassPilotAuth";
import { apiRequest, queryClient } from "../../../../lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { Button } from "../../../../components/ui/button";
import { Input } from "../../../../components/ui/input";
import { Label } from "../../../../components/ui/label";
import { Switch } from "../../../../components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../../../components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../../components/ui/tabs";
import { Badge } from "../../../../components/ui/badge";
import { Skeleton } from "../../../../components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "../../../../components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../../components/ui/select";
import { Checkbox } from "../../../../components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../../components/ui/dropdown-menu";
import { Plus, Trash2, Download, RefreshCw, Search, Pencil, Eye, Users, Upload, FileSpreadsheet, Cloud, GraduationCap, ChevronDown } from "lucide-react";
import { toast } from "../../../../hooks/use-toast";

const GRADE_LEVELS = ["K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];

export function SetupView() {
  const [activeTab, setActiveTab] = useState(() => {
    const hash = window.location.hash.replace('#', '');
    const sub = hash.split('/')[1];
    return sub === 'settings' ? 'settings' : 'teachers';
  });

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-semibold">School Setup</h2>
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="teachers">Teachers</TabsTrigger>
          <TabsTrigger value="students">Student Roster</TabsTrigger>
          <TabsTrigger value="classes">Classes</TabsTrigger>
          <TabsTrigger value="assignments">Class Assignments</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="teachers"><TeachersTab /></TabsContent>
        <TabsContent value="students"><StudentRosterTab /></TabsContent>
        <TabsContent value="classes"><ClassesTab /></TabsContent>
        <TabsContent value="assignments"><AssignmentsTab /></TabsContent>
        <TabsContent value="settings"><SettingsTab /></TabsContent>
      </Tabs>
    </div>
  );
}

function TeachersTab() {
  const { data: teachers, isLoading } = useTeachers();
  const [addOpen, setAddOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");

  // Google Workspace teacher import state
  const [gwImportOpen, setGwImportOpen] = useState(false);
  const [gwOrgUnits, setGwOrgUnits] = useState([]);
  const [gwOuLoading, setGwOuLoading] = useState(false);
  const [gwSelectedOUs, setGwSelectedOUs] = useState(new Set());
  const [gwExpandedOU, setGwExpandedOU] = useState(null);
  const [gwUsers, setGwUsers] = useState([]);
  const [gwUsersLoading, setGwUsersLoading] = useState(false);
  const [gwSelectedUsers, setGwSelectedUsers] = useState(new Set());
  const [gwImporting, setGwImporting] = useState(false);
  const [gwResult, setGwResult] = useState(null);

  const addTeacher = useMutation({
    mutationFn: (data) =>
      apiRequest("POST", "/admin/teachers", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teachers"] });
      toast({ title: "Teacher added" });
      setAddOpen(false);
      setEmail("");
      setDisplayName("");
      setPassword("");
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const removeTeacher = useMutation({
    mutationFn: (id) => apiRequest("DELETE", `/admin/teachers/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teachers"] });
      toast({ title: "Teacher removed" });
    },
  });

  const loadGwOrgUnits = async () => {
    setGwOuLoading(true);
    try {
      const res = await fetch("/api/directory/orgunits", { credentials: "include" });
      if (!res.ok) {
        const err = await res.json();
        if (err.code === "NO_TOKENS") {
          toast({ title: "Google not connected", description: "Connect your Google account in Settings first.", variant: "destructive" });
          setGwImportOpen(false);
          return;
        }
        throw new Error(err.error || "Failed to load org units");
      }
      const data = await res.json();
      const ous = data.orgUnits || [];
      setGwOrgUnits(ous);
      if (ous.length <= 1) {
        const ouPath = ous.length === 1 ? ous[0].orgUnitPath : undefined;
        setGwExpandedOU(ouPath || "__all__");
        loadGwUsers(ouPath);
      }
    } catch (err) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setGwOuLoading(false);
    }
  };

  const loadGwUsers = async (orgUnitPath) => {
    setGwUsersLoading(true);
    try {
      const url = orgUnitPath
        ? `/api/directory/users?orgUnitPath=${encodeURIComponent(orgUnitPath)}`
        : "/api/directory/users";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Failed to load users"); }
      const data = await res.json();
      setGwUsers(data.users || []);
      setGwSelectedUsers(new Set((data.users || []).map((u) => u.id)));
    } catch (err) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setGwUsersLoading(false);
    }
  };

  const importGwTeachersFromOUs = async () => {
    setGwImporting(true);
    let totalImported = 0;
    let totalSkipped = 0;
    for (const ouPath of gwSelectedOUs) {
      try {
        const res = await fetch("/api/directory/import-teachers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orgUnitPath: ouPath }),
          credentials: "include",
        });
        if (res.ok) {
          const data = await res.json();
          totalImported += data.imported;
          totalSkipped += data.skipped;
        }
      } catch { /* continue */ }
    }
    queryClient.invalidateQueries({ queryKey: ["teachers"] });
    setGwResult({ imported: totalImported, skipped: totalSkipped });
    toast({ title: `Imported ${totalImported} teachers from ${gwSelectedOUs.size} OU(s)` });
    setGwSelectedOUs(new Set());
    setGwImporting(false);
  };

  const importGwTeachersFromUsers = async () => {
    setGwImporting(true);
    try {
      const res = await fetch("/api/directory/import-teachers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgUnitPath: gwExpandedOU === "__all__" ? undefined : gwExpandedOU,
          userIds: Array.from(gwSelectedUsers),
        }),
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        queryClient.invalidateQueries({ queryKey: ["teachers"] });
        setGwResult({ imported: data.imported, skipped: data.skipped });
        toast({ title: `Imported ${data.imported} teachers` });
      } else {
        const err = await res.json();
        toast({ title: "Import failed", description: err.error, variant: "destructive" });
      }
    } catch (err) {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    } finally {
      setGwImporting(false);
    }
  };

  if (isLoading) return <Skeleton className="h-40 w-full mt-4" />;

  return (
    <div className="space-y-4 mt-4">
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => { setGwImportOpen(true); loadGwOrgUnits(); }}>
          <Cloud className="h-4 w-4 mr-1" />
          Import from Google Workspace
        </Button>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Add Teacher
        </Button>
      </div>

      {(teachers ?? []).length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No teachers added yet. Teachers will sign in with Google after being added.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-2">
          {(teachers ?? []).map((teacher) => (
            <Card key={teacher.id}>
              <CardContent className="py-3 px-4 flex items-center justify-between">
                <div>
                  <span className="font-medium">{teacher.displayName || teacher.email}</span>
                  <span className="text-muted-foreground text-sm ml-2">{teacher.email}</span>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="sm"><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove teacher?</AlertDialogTitle>
                      <AlertDialogDescription>This will remove their access to PassPilot.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => removeTeacher.mutate(teacher.id)}>Remove</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add Teacher Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Teacher</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Email</Label>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teacher@school.edu" />
            </div>
            <div className="space-y-1">
              <Label>Display Name</Label>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ms. Smith" />
            </div>
            <div className="space-y-1">
              <Label>Password (optional — Google OAuth preferred)</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <Button
              className="w-full"
              onClick={() => addTeacher.mutate({ email, displayName, password: password || undefined })}
              disabled={addTeacher.isPending}
            >
              {addTeacher.isPending ? "Adding..." : "Add Teacher"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Google Workspace Teacher Import Dialog */}
      <Dialog open={gwImportOpen} onOpenChange={(open) => {
        setGwImportOpen(open);
        if (!open) {
          setGwOrgUnits([]); setGwSelectedOUs(new Set()); setGwExpandedOU(null);
          setGwUsers([]); setGwSelectedUsers(new Set()); setGwResult(null);
        }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {gwExpandedOU ? (
                <div className="flex items-center gap-2">
                  {gwOrgUnits.length > 1 && (
                    <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => { setGwExpandedOU(null); setGwUsers([]); setGwSelectedUsers(new Set()); }}>
                      &larr; Back
                    </Button>
                  )}
                  <span>{gwExpandedOU === "__all__" ? "Import Teachers from Google Workspace" : `Users in ${gwOrgUnits.find((o) => o.orgUnitPath === gwExpandedOU)?.name || gwExpandedOU}`}</span>
                </div>
              ) : "Import Teachers from Google Workspace"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {(gwOuLoading || gwUsersLoading) && (
              <div className="py-8 text-center">
                <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{gwOuLoading ? "Loading organizational units..." : "Loading users..."}</p>
              </div>
            )}

            {/* OU List */}
            {!gwOuLoading && !gwExpandedOU && !gwUsersLoading && (
              <>
                {gwOrgUnits.length === 0 ? (
                  <div className="py-8 text-center text-muted-foreground">
                    <Cloud className="h-10 w-10 mx-auto mb-3 opacity-50" />
                    <p>No organizational units found.</p>
                    <Button variant="outline" size="sm" className="mt-3" onClick={loadGwOrgUnits}>
                      <RefreshCw className="h-3 w-3 mr-1" /> Retry
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-muted-foreground">{gwOrgUnits.length} organizational unit{gwOrgUnits.length !== 1 ? "s" : ""}</p>
                      <Button variant="outline" size="sm" onClick={() => { setGwExpandedOU("__all__"); loadGwUsers(); }}>
                        View All Users
                      </Button>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => {
                        if (gwSelectedOUs.size === gwOrgUnits.length) setGwSelectedOUs(new Set());
                        else setGwSelectedOUs(new Set(gwOrgUnits.map((o) => o.orgUnitPath)));
                      }}>
                        {gwSelectedOUs.size === gwOrgUnits.length ? "Deselect All" : "Select All"}
                      </Button>
                      {gwSelectedOUs.size > 0 && <span className="text-sm font-medium">{gwSelectedOUs.size} selected</span>}
                    </div>
                    <div className="max-h-72 overflow-y-auto border rounded-lg">
                      {gwOrgUnits.map((ou) => (
                        <div key={ou.orgUnitPath} className={`flex items-center gap-3 p-3 border-b last:border-b-0 hover:bg-muted/20 ${gwSelectedOUs.has(ou.orgUnitPath) ? "bg-blue-50/50" : ""}`}>
                          <Checkbox
                            checked={gwSelectedOUs.has(ou.orgUnitPath)}
                            onCheckedChange={() => {
                              const s = new Set(gwSelectedOUs);
                              if (s.has(ou.orgUnitPath)) s.delete(ou.orgUnitPath); else s.add(ou.orgUnitPath);
                              setGwSelectedOUs(s);
                            }}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{ou.name}</p>
                            <p className="text-xs text-muted-foreground truncate">{ou.orgUnitPath}</p>
                          </div>
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => {
                            setGwExpandedOU(ou.orgUnitPath);
                            loadGwUsers(ou.orgUnitPath);
                          }}>
                            &rarr;
                          </Button>
                        </div>
                      ))}
                    </div>

                    {gwResult && (
                      <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                        <p className="font-medium">Imported {gwResult.imported} teachers, {gwResult.skipped} skipped (already exist)</p>
                      </div>
                    )}

                    <Button
                      className="w-full"
                      onClick={importGwTeachersFromOUs}
                      disabled={gwImporting || gwSelectedOUs.size === 0}
                    >
                      {gwImporting ? "Importing..." : `Import from ${gwSelectedOUs.size} Selected OU${gwSelectedOUs.size !== 1 ? "s" : ""}`}
                    </Button>
                  </>
                )}
              </>
            )}

            {/* User List */}
            {!gwUsersLoading && gwExpandedOU && (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">{gwUsers.length} users</p>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => {
                      if (gwSelectedUsers.size === gwUsers.length) setGwSelectedUsers(new Set());
                      else setGwSelectedUsers(new Set(gwUsers.map((u) => u.id)));
                    }}>
                      {gwSelectedUsers.size === gwUsers.length ? "Deselect All" : "Select All"}
                    </Button>
                    <span className="text-sm">{gwSelectedUsers.size} selected</span>
                  </div>
                </div>
                <div className="max-h-64 overflow-y-auto border rounded-lg">
                  {gwUsers.map((user) => (
                    <div key={user.id} className={`flex items-center gap-3 p-2 border-b last:border-b-0 hover:bg-muted/20 ${gwSelectedUsers.has(user.id) ? "bg-blue-50/50" : ""}`}>
                      <Checkbox checked={gwSelectedUsers.has(user.id)} onCheckedChange={() => {
                        const s = new Set(gwSelectedUsers);
                        if (s.has(user.id)) s.delete(user.id); else s.add(user.id);
                        setGwSelectedUsers(s);
                      }} />
                      <div>
                        <p className="text-sm font-medium">{user.name}</p>
                        <p className="text-xs text-muted-foreground">{user.email}</p>
                      </div>
                    </div>
                  ))}
                </div>

                {gwResult && (
                  <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                    <p className="font-medium">Imported {gwResult.imported} teachers, {gwResult.skipped} skipped (already exist)</p>
                  </div>
                )}

                <Button
                  className="w-full"
                  onClick={importGwTeachersFromUsers}
                  disabled={gwImporting || gwSelectedUsers.size === 0}
                >
                  {gwImporting ? "Importing..." : `Import ${gwSelectedUsers.size} Selected User${gwSelectedUsers.size !== 1 ? "s" : ""} as Teachers`}
                </Button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StudentRosterTab() {
  const { school } = usePassPilotAuth();
  const [filterGrade, setFilterGrade] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [addOpen, setAddOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [addGradesOpen, setAddGradesOpen] = useState(false);
  const [addGradesInput, setAddGradesInput] = useState("");
  const PAGE_SIZE = 30;

  // Import state
  const [csvImportOpen, setCsvImportOpen] = useState(false);
  const [csvFile, setCsvFile] = useState(null);
  const [csvPreview, setCsvPreview] = useState([]);
  const [csvGradeLevel, setCsvGradeLevel] = useState("");
  const [googleDirOpen, setGoogleDirOpen] = useState(false);
  const [googleDirUsers, setGoogleDirUsers] = useState([]);
  const [googleDirSelected, setGoogleDirSelected] = useState(new Set());
  const [googleDirGradeLevel, setGoogleDirGradeLevel] = useState("");
  const [googleDirLoading, setGoogleDirLoading] = useState(false);
  // OU-based import state
  const [orgUnits, setOrgUnits] = useState([]);
  const [ouLoading, setOuLoading] = useState(false);
  const [selectedOUs, setSelectedOUs] = useState(new Set());
  const [expandedOU, setExpandedOU] = useState(null);
  const [ouGradeOverrides, setOuGradeOverrides] = useState({});
  const [classroomOpen, setClassroomOpen] = useState(false);
  const [classroomCourses, setClassroomCourses] = useState([]);
  const [classroomSelectedCourse, setClassroomSelectedCourse] = useState("");
  const [classroomGradeLevel, setClassroomGradeLevel] = useState("");
  const [classroomLoading, setClassroomLoading] = useState(false);
  const [importResult, setImportResult] = useState(null);

  // Add student form state
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [studentEmail, setStudentEmail] = useState("");
  const [studentIdNumber, setStudentIdNumber] = useState("");
  const [gradeLevel, setGradeLevel] = useState("");

  // Bulk add state
  const [bulkNames, setBulkNames] = useState("");
  const [bulkGradeLevel, setBulkGradeLevel] = useState("");

  // Multi-select state
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkGradeOpen, setBulkGradeOpen] = useState(false);
  const [bulkAssignGrade, setBulkAssignGrade] = useState("");

  const { data: students, isLoading } = useQuery({
    queryKey: ["students"],
    queryFn: async () => {
      const res = await fetch("/api/students", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch students");
      return res.json();
    },
    select: (data) => Array.isArray(data) ? data : (data?.students ?? []),
  });

  const { data: grades } = useGrades();

  const addStudent = useMutation({
    mutationFn: (data) =>
      apiRequest("POST", "/students", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["students"] });
      toast({ title: "Student added" });
      setAddOpen(false);
      setFirstName("");
      setLastName("");
      setStudentEmail("");
      setStudentIdNumber("");
      setGradeLevel("");
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const bulkAddStudents = useMutation({
    mutationFn: async (data) => {
      const lines = data.names.split("\n").map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        const parts = line.split(/[\t,]+/).map((p) => p.trim());
        const fName = parts[0] || "";
        const lName = parts[1] || "";
        if (fName && lName) {
          await apiRequest("POST", "/students", { firstName: fName, lastName: lName, ...(data.gradeLevel ? { gradeLevel: data.gradeLevel } : {}) });
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["students"] });
      toast({ title: "Students added" });
      setBulkOpen(false);
      setBulkNames("");
      setBulkGradeLevel("");
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  // Bulk assign grade to selected students
  const bulkUpdateGrade = useMutation({
    mutationFn: async (data) => {
      for (const id of data.ids) {
        await apiRequest("PUT", `/students/${id}`, { gradeLevel: data.gradeLevel });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["students"] });
      toast({ title: "Grade updated", description: `${selectedIds.size} student${selectedIds.size !== 1 ? "s" : ""} updated.` });
      setSelectedIds(new Set());
      setBulkGradeOpen(false);
      setBulkAssignGrade("");
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  // CSV file handler
  const handleCsvFile = (file) => {
    setCsvFile(file);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result;
      const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
      if (lines.length < 2) { setCsvPreview([]); return; }
      const headers = lines[0].split(",").map(h => h.trim());
      const preview = lines.slice(1, 6).map(line => {
        const vals = line.split(",").map(v => v.trim().replace(/^"|"$/g, ""));
        const row = {};
        headers.forEach((h, i) => { row[h] = vals[i] || ""; });
        return row;
      });
      setCsvPreview(preview);
    };
    reader.readAsText(file);
  };

  const csvImport = useMutation({
    mutationFn: async () => {
      if (!csvFile) throw new Error("No file selected");
      const formData = new FormData();
      formData.append("file", csvFile);
      if (csvGradeLevel) formData.append("gradeLevel", csvGradeLevel);
      const res = await fetch("/api/students/import-csv", { method: "POST", body: formData, credentials: "include" });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Import failed"); }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["students"] });
      setImportResult({ imported: data.imported, errors: data.errors });
      setCsvFile(null);
      setCsvPreview([]);
      setCsvGradeLevel("");
      toast({ title: `Imported ${data.imported} students` });
    },
    onError: (err) => toast({ title: "Import failed", description: err.message, variant: "destructive" }),
  });

  // Google Workspace Directory import - OU-based
  const detectGradeFromOUName = (name) => {
    const lower = name.toLowerCase().trim();
    if (/^kindergarten|^kinder\b/.test(lower)) return "K";
    const gradeMatch = lower.match(/grade\s*(\d{1,2})/);
    if (gradeMatch) { const n = parseInt(gradeMatch[1]); if (n >= 1 && n <= 12) return String(n); }
    const ordinalMatch = lower.match(/(\d{1,2})(st|nd|rd|th)\s*(grade)?/);
    if (ordinalMatch) { const n = parseInt(ordinalMatch[1]); if (n >= 1 && n <= 12) return String(n); }
    if (/^k\b/.test(lower)) return "K";
    return null;
  };

  const loadOrgUnits = async () => {
    setOuLoading(true);
    try {
      const res = await fetch("/api/directory/orgunits", { credentials: "include" });
      if (!res.ok) {
        const err = await res.json();
        if (err.code === "NO_TOKENS") {
          toast({ title: "Google not connected", description: "Connect your Google account in Settings first.", variant: "destructive" });
          setGoogleDirOpen(false);
          return;
        }
        throw new Error(err.error || "Failed to load org units");
      }
      const data = await res.json();
      const ous = data.orgUnits || [];
      setOrgUnits(ous);
      // Pre-set auto-detected grades
      const overrides = {};
      for (const ou of ous) {
        const detected = detectGradeFromOUName(ou.name);
        if (detected) overrides[ou.orgUnitPath] = detected;
      }
      setOuGradeOverrides(overrides);
      // If 0 or 1 OUs, skip straight to user list
      if (ous.length <= 1) {
        const ouPath = ous.length === 1 ? ous[0].orgUnitPath : undefined;
        setExpandedOU(ouPath || "__all__");
        loadDirectoryUsers(ouPath);
      }
    } catch (err) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setOuLoading(false);
    }
  };

  const loadDirectoryUsers = async (orgUnitPath) => {
    setGoogleDirLoading(true);
    try {
      const url = orgUnitPath
        ? `/api/directory/users?orgUnitPath=${encodeURIComponent(orgUnitPath)}`
        : "/api/directory/users";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to load users");
      }
      const data = await res.json();
      setGoogleDirUsers(data.users || []);
      setGoogleDirSelected(new Set((data.users || []).map((u) => u.id)));
    } catch (err) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setGoogleDirLoading(false);
    }
  };

  const googleDirImport = useMutation({
    mutationFn: async (params) => {
      const res = await fetch("/api/directory/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        credentials: "include",
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Import failed"); }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["students"] });
      setImportResult({ imported: data.imported, message: `Imported: ${data.imported}, Updated: ${data.updated}` });
      toast({ title: `Imported ${data.imported} students from Google Workspace` });
    },
    onError: (err) => toast({ title: "Import failed", description: err.message, variant: "destructive" }),
  });

  const importSelectedOUs = async () => {
    let totalImported = 0;
    let totalUpdated = 0;
    for (const ouPath of selectedOUs) {
      try {
        const grade = ouGradeOverrides[ouPath] || undefined;
        const res = await fetch("/api/directory/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orgUnitPath: ouPath, gradeLevel: grade }),
          credentials: "include",
        });
        if (res.ok) {
          const data = await res.json();
          totalImported += data.imported;
          totalUpdated += data.updated;
        }
      } catch { /* continue */ }
    }
    queryClient.invalidateQueries({ queryKey: ["students"] });
    setImportResult({ imported: totalImported, message: `Imported: ${totalImported}, Updated: ${totalUpdated}` });
    toast({ title: `Imported ${totalImported} students from ${selectedOUs.size} OU(s)` });
    setSelectedOUs(new Set());
  };

  // Google Classroom import
  const loadClassroomCourses = async () => {
    setClassroomLoading(true);
    try {
      const res = await fetch("/api/classroom/courses", { credentials: "include" });
      if (!res.ok) {
        const err = await res.json();
        if (err.code === "NO_TOKENS") {
          toast({ title: "Google not connected", description: "Connect your Google account in Settings first.", variant: "destructive" });
          setClassroomOpen(false);
          return;
        }
        throw new Error(err.error || "Failed to load courses");
      }
      const data = await res.json();
      setClassroomCourses(data.courses || data || []);
    } catch (err) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setClassroomLoading(false);
    }
  };

  const classroomImport = useMutation({
    mutationFn: async () => {
      if (!classroomSelectedCourse) throw new Error("No course selected");
      const res = await fetch(`/api/classroom/courses/${classroomSelectedCourse}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gradeLevel: classroomGradeLevel || undefined }),
        credentials: "include",
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Sync failed"); }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["students"] });
      setImportResult({ imported: data.imported, message: `Imported: ${data.imported}, Updated: ${data.updated}` });
      toast({ title: `Synced ${data.imported} students from Google Classroom` });
    },
    onError: (err) => toast({ title: "Sync failed", description: err.message, variant: "destructive" }),
  });

  // Parse the school's active grade levels
  const activeGradeLevels = Array.isArray(school?.activeGradeLevels)
    ? school.activeGradeLevels
    : (school?.activeGradeLevels ? JSON.parse(school.activeGradeLevels) : []);

  // Parse grade input like "1-8" or "K,1,2,3" or "K, 1-5, 9-12"
  const parseGradeInput = (input) => {
    const results = [];
    const parts = input.split(/[,\s]+/).filter(Boolean);
    for (const part of parts) {
      const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1]);
        const end = parseInt(rangeMatch[2]);
        for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
          results.push(String(i));
        }
      } else if (part.toUpperCase() === "K") {
        results.push("K");
      } else if (/^\d+$/.test(part) && parseInt(part) >= 1 && parseInt(part) <= 12) {
        results.push(part);
      }
    }
    return [...new Set(results)];
  };

  const saveGradeLevels = useMutation({
    mutationFn: (gradeLevels) =>
      apiRequest("PATCH", "/admin/settings", { activeGradeLevels: JSON.stringify(gradeLevels) }),
    onSuccess: (_data, gradeLevels) => {
      // Update auth cache directly so school.activeGradeLevels is available immediately
      const authData = queryClient.getQueryData(["auth", "me"]);
      if (authData?.school) {
        queryClient.setQueryData(["auth", "me"], {
          ...authData,
          school: { ...authData.school, activeGradeLevels: JSON.stringify(gradeLevels) },
        });
      }
      toast({ title: "Grade levels saved" });
      setAddGradesOpen(false);
      setAddGradesInput("");
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  // Build a grade ID -> grade name map
  const gradeMap = new Map();
  for (const g of grades ?? []) {
    gradeMap.set(g.id, g.name);
  }

  // Count students per grade level for badge counts
  const gradeLevelCounts = new Map();
  let noGradeCount = 0;
  for (const s of students ?? []) {
    if (s.gradeLevel) {
      gradeLevelCounts.set(s.gradeLevel, (gradeLevelCounts.get(s.gradeLevel) ?? 0) + 1);
    } else {
      noGradeCount++;
    }
  }

  const filtered = (students ?? []).filter((s) => {
    if (filterGrade === "none" && s.gradeLevel) return false;
    if (filterGrade !== "all" && filterGrade !== "none" && s.gradeLevel !== filterGrade) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const full = `${s.firstName} ${s.lastName}`.toLowerCase();
      if (!full.includes(q) && !(s.email?.toLowerCase().includes(q)) && !(s.studentIdNumber?.toLowerCase().includes(q))) return false;
    }
    return true;
  });

  // Reset page when filter changes
  const handleFilterChange = (grade) => {
    setFilterGrade(grade);
    setPage(1);
    setSelectedIds(new Set());
  };

  // Pagination
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginatedStudents = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Selection helpers
  const allPageSelected = paginatedStudents.length > 0 && paginatedStudents.every((s) => selectedIds.has(s.id));
  const somePageSelected = paginatedStudents.some((s) => selectedIds.has(s.id));

  const toggleSelectAll = () => {
    const newSet = new Set(selectedIds);
    if (allPageSelected) {
      for (const s of paginatedStudents) newSet.delete(s.id);
    } else {
      for (const s of paginatedStudents) newSet.add(s.id);
    }
    setSelectedIds(newSet);
  };

  const toggleSelect = (id) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setSelectedIds(newSet);
  };

  const selectAllFiltered = () => {
    const newSet = new Set(selectedIds);
    for (const s of filtered) newSet.add(s.id);
    setSelectedIds(newSet);
  };

  const deleteStudent = useMutation({
    mutationFn: (id) => apiRequest("DELETE", `/students/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["students"] });
      toast({ title: "Student deleted" });
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  // Edit student state
  const [editStudentOpen, setEditStudentOpen] = useState(false);
  const [editStudentId, setEditStudentId] = useState("");
  const [editFirstName, setEditFirstName] = useState("");
  const [editLastName, setEditLastName] = useState("");
  const [editGradeLevel, setEditGradeLevel] = useState("");

  const updateStudent = useMutation({
    mutationFn: (data) =>
      apiRequest("PUT", `/students/${data.id}`, { firstName: data.firstName, lastName: data.lastName, gradeLevel: data.gradeLevel }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["students"] });
      toast({ title: "Student updated" });
      setEditStudentOpen(false);
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const gradeLabelWithSuffix = (gl) => {
    if (gl === "K") return "K";
    const n = parseInt(gl);
    if (n === 1) return "1st";
    if (n === 2) return "2nd";
    if (n === 3) return "3rd";
    return `${n}th`;
  };

  if (isLoading) return <Skeleton className="h-40 w-full mt-4" />;

  const selectedGradeLabel = filterGrade === "all"
    ? null
    : filterGrade === "none"
    ? "No Grade"
    : `Grade ${filterGrade}`;
  const filteredCount = filtered.length;

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-xl">Current Student Roster</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {filteredCount} student{filteredCount !== 1 ? "s" : ""}{selectedGradeLabel ? ` in ${selectedGradeLabel}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    <Upload className="h-4 w-4 mr-1" />
                    Import
                    <ChevronDown className="h-3 w-3 ml-1" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setCsvImportOpen(true)}>
                    <FileSpreadsheet className="h-4 w-4 mr-2" />
                    From CSV File
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setGoogleDirOpen(true); loadOrgUnits(); }}>
                    <Cloud className="h-4 w-4 mr-2" />
                    From Google Workspace
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setClassroomOpen(true); loadClassroomCourses(); }}>
                    <GraduationCap className="h-4 w-4 mr-2" />
                    From Google Classroom
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button variant="outline" onClick={() => setBulkOpen(true)}>
                <Plus className="h-4 w-4 mr-1" />
                Bulk Add
              </Button>
              <Button onClick={() => setAddOpen(true)}>
                <Plus className="h-4 w-4 mr-1" />
                Add Student
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Filter by Grade */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium">Filter by Grade</p>
              <Button variant="outline" size="sm" onClick={() => setAddGradesOpen(true)}>
                <Plus className="h-3 w-3 mr-1" />
                Add Grades
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant={filterGrade === "all" ? "default" : "outline"}
                size="sm"
                onClick={() => handleFilterChange("all")}
              >
                All ({(students ?? []).length})
              </Button>
              {GRADE_LEVELS.map((gl) => {
                const count = gradeLevelCounts.get(gl) ?? 0;
                const isActive = activeGradeLevels.includes(gl);
                if (count === 0 && !isActive) return null;
                return (
                  <Button
                    key={gl}
                    variant={filterGrade === gl ? "default" : "outline"}
                    size="sm"
                    onClick={() => handleFilterChange(gl)}
                  >
                    {gradeLabelWithSuffix(gl)} ({count})
                  </Button>
                );
              })}
              {noGradeCount > 0 && (
                <Button
                  variant={filterGrade === "none" ? "default" : "outline"}
                  size="sm"
                  onClick={() => handleFilterChange("none")}
                  className={filterGrade === "none" ? "" : "border-orange-300 text-orange-600 hover:bg-orange-50"}
                >
                  No Grade ({noGradeCount})
                </Button>
              )}
            </div>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search students by name..."
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
              className="pl-8"
            />
          </div>

          {/* Bulk actions bar */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <span className="text-sm font-medium">{selectedIds.size} selected</span>
              {filtered.length > paginatedStudents.length && selectedIds.size < filtered.length && (
                <Button variant="link" size="sm" className="h-auto p-0 text-blue-600" onClick={selectAllFiltered}>
                  Select all {filtered.length}
                </Button>
              )}
              <Button size="sm" onClick={() => setBulkGradeOpen(true)}>
                Assign Grade
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
                Clear
              </Button>
            </div>
          )}

          {/* Student Table */}
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              {(students ?? []).length === 0 ? "No students added yet." : "No students match the current filter."}
            </div>
          ) : (
            <>
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b bg-muted/30">
                      <th className="py-3 px-3 w-10">
                        <Checkbox
                          checked={allPageSelected ? true : somePageSelected ? "indeterminate" : false}
                          onCheckedChange={toggleSelectAll}
                        />
                      </th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-muted-foreground">Name</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-muted-foreground">Grade</th>
                      <th className="text-right py-3 px-4 text-sm font-medium text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedStudents.map((student) => (
                      <tr key={student.id} className={`border-b last:border-b-0 hover:bg-muted/20 ${selectedIds.has(student.id) ? "bg-blue-50/50" : ""}`}>
                        <td className="py-3 px-3">
                          <Checkbox
                            checked={selectedIds.has(student.id)}
                            onCheckedChange={() => toggleSelect(student.id)}
                          />
                        </td>
                        <td className="py-3 px-4">
                          <span className="font-medium">{student.firstName} {student.lastName}</span>
                        </td>
                        <td className="py-3 px-4 text-sm">
                          {student.gradeLevel ? `Grade ${student.gradeLevel}` : <span className="text-orange-500">No Grade</span>}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0"
                              onClick={() => {
                                setEditStudentId(student.id);
                                setEditFirstName(student.firstName || "");
                                setEditLastName(student.lastName || "");
                                setEditGradeLevel(student.gradeLevel || "");
                                setEditStudentOpen(true);
                              }}
                            >
                              <Pencil className="h-4 w-4 text-blue-600" />
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                                  <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Delete student?</AlertDialogTitle>
                                  <AlertDialogDescription>This will permanently delete {student.firstName} {student.lastName}.</AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction onClick={() => deleteStudent.mutate(student.id)}>Delete</AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination controls */}
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    Previous
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Page {page} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                  >
                    Next
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Add Student Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Student</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>First Name</Label>
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="John" />
            </div>
            <div className="space-y-1">
              <Label>Last Name</Label>
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Doe" />
            </div>
            <div className="space-y-1">
              <Label>Email (optional)</Label>
              <Input value={studentEmail} onChange={(e) => setStudentEmail(e.target.value)} placeholder="john.doe@school.edu" />
            </div>
            <div className="space-y-1">
              <Label>Student ID (optional)</Label>
              <Input value={studentIdNumber} onChange={(e) => setStudentIdNumber(e.target.value)} placeholder="12345" />
            </div>
            <div className="space-y-1">
              <Label>Grade Level (optional)</Label>
              <Select value={gradeLevel} onValueChange={setGradeLevel}>
                <SelectTrigger>
                  <SelectValue placeholder="Select grade level" />
                </SelectTrigger>
                <SelectContent>
                  {GRADE_LEVELS.map((gl) => (
                    <SelectItem key={gl} value={gl}>{gl === "K" ? "Kindergarten" : `Grade ${gl}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              className="w-full"
              onClick={() =>
                addStudent.mutate({
                  firstName,
                  lastName,
                  email: studentEmail || undefined,
                  studentIdNumber: studentIdNumber || undefined,
                  gradeLevel: gradeLevel || undefined,
                })
              }
              disabled={addStudent.isPending || !firstName || !lastName}
            >
              {addStudent.isPending ? "Adding..." : "Add Student"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Add Dialog */}
      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Bulk Add Students</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Student Names (one per line, "FirstName, LastName" or "FirstName{'\t'}LastName")</Label>
              <textarea
                className="w-full border rounded-md px-3 py-2 text-sm min-h-[120px] resize-y"
                value={bulkNames}
                onChange={(e) => setBulkNames(e.target.value)}
                placeholder={"John, Doe\nJane, Smith\nAlex, Johnson"}
              />
            </div>
            <div className="space-y-1">
              <Label>Grade Level (optional)</Label>
              <Select value={bulkGradeLevel} onValueChange={setBulkGradeLevel}>
                <SelectTrigger>
                  <SelectValue placeholder="Select grade level" />
                </SelectTrigger>
                <SelectContent>
                  {GRADE_LEVELS.map((gl) => (
                    <SelectItem key={gl} value={gl}>{gl === "K" ? "Kindergarten" : `Grade ${gl}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              className="w-full"
              onClick={() => bulkAddStudents.mutate({ names: bulkNames, gradeLevel: bulkGradeLevel || undefined })}
              disabled={bulkAddStudents.isPending || !bulkNames.trim()}
            >
              {bulkAddStudents.isPending ? "Adding..." : "Add Students"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Student Dialog */}
      <Dialog open={editStudentOpen} onOpenChange={setEditStudentOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit Student</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>First Name</Label>
              <Input value={editFirstName} onChange={(e) => setEditFirstName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Last Name</Label>
              <Input value={editLastName} onChange={(e) => setEditLastName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Grade Level</Label>
              <Select value={editGradeLevel} onValueChange={setEditGradeLevel}>
                <SelectTrigger><SelectValue placeholder="Select grade level" /></SelectTrigger>
                <SelectContent>
                  {GRADE_LEVELS.map((gl) => (
                    <SelectItem key={gl} value={gl}>{gl === "K" ? "Kindergarten" : `Grade ${gl}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              className="w-full"
              onClick={() => updateStudent.mutate({ id: editStudentId, firstName: editFirstName, lastName: editLastName, gradeLevel: editGradeLevel })}
              disabled={updateStudent.isPending || !editFirstName || !editLastName || !editGradeLevel}
            >
              {updateStudent.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Assign Grade Dialog */}
      <Dialog open={bulkGradeOpen} onOpenChange={setBulkGradeOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Assign Grade to {selectedIds.size} Student{selectedIds.size !== 1 ? "s" : ""}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Grade Level</Label>
              <Select value={bulkAssignGrade} onValueChange={setBulkAssignGrade}>
                <SelectTrigger><SelectValue placeholder="Select grade level" /></SelectTrigger>
                <SelectContent>
                  {GRADE_LEVELS.map((gl) => (
                    <SelectItem key={gl} value={gl}>{gl === "K" ? "Kindergarten" : `Grade ${gl}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              className="w-full"
              onClick={() => bulkUpdateGrade.mutate({ ids: [...selectedIds], gradeLevel: bulkAssignGrade })}
              disabled={bulkUpdateGrade.isPending || !bulkAssignGrade}
            >
              {bulkUpdateGrade.isPending ? "Updating..." : "Assign Grade"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Grades Dialog */}
      <Dialog open={addGradesOpen} onOpenChange={setAddGradesOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Grade Levels</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Grade Levels</Label>
              <Input
                value={addGradesInput}
                onChange={(e) => setAddGradesInput(e.target.value)}
                placeholder="e.g. K, 1-8 or 6-12"
              />
              <p className="text-xs text-muted-foreground">Use ranges (1-8) or comma-separated values (K, 1, 2, 3). Examples: "1-8", "K, 1-5", "6-12"</p>
            </div>
            {addGradesInput && (
              <div className="space-y-1">
                <Label className="text-xs">Preview</Label>
                <div className="flex flex-wrap gap-1">
                  {parseGradeInput(addGradesInput).map((gl) => (
                    <Badge key={gl} variant="secondary">{gradeLabelWithSuffix(gl)}</Badge>
                  ))}
                </div>
              </div>
            )}
            {activeGradeLevels.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Current grades</Label>
                <div className="flex flex-wrap gap-1">
                  {activeGradeLevels.map((gl) => (
                    <Badge key={gl} variant="outline">{gradeLabelWithSuffix(gl)}</Badge>
                  ))}
                </div>
              </div>
            )}
            <Button
              className="w-full"
              onClick={() => {
                const newGrades = parseGradeInput(addGradesInput);
                const merged = [...new Set([...activeGradeLevels, ...newGrades])];
                // Sort: K first, then numerically
                merged.sort((a, b) => {
                  if (a === "K") return -1;
                  if (b === "K") return 1;
                  return parseInt(a) - parseInt(b);
                });
                saveGradeLevels.mutate(merged);
              }}
              disabled={saveGradeLevels.isPending || !addGradesInput.trim() || parseGradeInput(addGradesInput).length === 0}
            >
              {saveGradeLevels.isPending ? "Saving..." : "Add Grades"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* CSV Import Dialog */}
      <Dialog open={csvImportOpen} onOpenChange={(open) => { setCsvImportOpen(open); if (!open) { setCsvFile(null); setCsvPreview([]); setCsvGradeLevel(""); setImportResult(null); } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Import Students from CSV</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>CSV File</Label>
              <Input
                type="file"
                accept=".csv"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleCsvFile(file);
                }}
              />
              <p className="text-xs text-muted-foreground">
                Expected columns: firstName, lastName, email, studentIdNumber, gradeLevel (flexible matching).{" "}
                <a href="/api/students/csv-template" download className="text-primary underline hover:no-underline">Download template</a>
              </p>
            </div>

            {csvPreview.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs">Preview (first {csvPreview.length} rows)</Label>
                <div className="border rounded-lg overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/30">
                        {Object.keys(csvPreview[0]).map((h) => (
                          <th key={h} className="text-left py-2 px-3 text-xs font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {csvPreview.map((row, i) => (
                        <tr key={i} className="border-b last:border-b-0">
                          {Object.values(row).map((v, j) => (
                            <td key={j} className="py-2 px-3 text-xs">{v}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="space-y-1">
              <Label>Default Grade Level (optional, applied if CSV has no grade column)</Label>
              <Select value={csvGradeLevel} onValueChange={setCsvGradeLevel}>
                <SelectTrigger><SelectValue placeholder="Select grade level" /></SelectTrigger>
                <SelectContent>
                  {GRADE_LEVELS.map((gl) => (
                    <SelectItem key={gl} value={gl}>{gl === "K" ? "Kindergarten" : `Grade ${gl}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {importResult && (
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm">
                <p className="font-medium text-green-800">Imported {importResult.imported} students</p>
                {importResult.errors && importResult.errors.length > 0 && (
                  <div className="mt-1 text-orange-700">
                    <p className="font-medium">Warnings:</p>
                    {importResult.errors.slice(0, 5).map((e, i) => <p key={i} className="text-xs">{e}</p>)}
                    {importResult.errors.length > 5 && <p className="text-xs">...and {importResult.errors.length - 5} more</p>}
                  </div>
                )}
              </div>
            )}

            <Button
              className="w-full"
              onClick={() => csvImport.mutate()}
              disabled={csvImport.isPending || !csvFile}
            >
              {csvImport.isPending ? "Importing..." : "Import Students"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Google Workspace Directory Import Dialog */}
      <Dialog open={googleDirOpen} onOpenChange={(open) => {
        setGoogleDirOpen(open);
        if (!open) {
          setOrgUnits([]); setSelectedOUs(new Set()); setExpandedOU(null);
          setGoogleDirUsers([]); setGoogleDirSelected(new Set());
          setGoogleDirGradeLevel(""); setImportResult(null); setOuGradeOverrides({});
        }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {expandedOU ? (
                <div className="flex items-center gap-2">
                  {orgUnits.length > 1 && (
                    <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => { setExpandedOU(null); setGoogleDirUsers([]); setGoogleDirSelected(new Set()); }}>
                      &larr; Back
                    </Button>
                  )}
                  <span>{expandedOU === "__all__" ? "Import from Google Workspace" : `Users in ${orgUnits.find(o => o.orgUnitPath === expandedOU)?.name || expandedOU}`}</span>
                </div>
              ) : "Import from Google Workspace"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Loading state */}
            {(ouLoading || googleDirLoading) && (
              <div className="py-8 text-center">
                <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{ouLoading ? "Loading organizational units..." : "Loading users..."}</p>
              </div>
            )}

            {/* OU List View */}
            {!ouLoading && !expandedOU && !googleDirLoading && (
              <>
                {orgUnits.length === 0 ? (
                  <div className="py-8 text-center text-muted-foreground">
                    <Cloud className="h-10 w-10 mx-auto mb-3 opacity-50" />
                    <p>No organizational units found.</p>
                    <p className="text-xs mt-1">Make sure your Google account has admin directory permissions.</p>
                    <Button variant="outline" size="sm" className="mt-3" onClick={loadOrgUnits}>
                      <RefreshCw className="h-3 w-3 mr-1" /> Retry
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-muted-foreground">{orgUnits.length} organizational unit{orgUnits.length !== 1 ? "s" : ""}</p>
                      <Button variant="outline" size="sm" onClick={() => { setExpandedOU("__all__"); loadDirectoryUsers(); }}>
                        View All Users
                      </Button>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => {
                          if (selectedOUs.size === orgUnits.length) setSelectedOUs(new Set());
                          else setSelectedOUs(new Set(orgUnits.map((o) => o.orgUnitPath)));
                        }}>
                          {selectedOUs.size === orgUnits.length ? "Deselect All" : "Select All"}
                        </Button>
                        {selectedOUs.size > 0 && <span className="text-sm font-medium">{selectedOUs.size} selected</span>}
                      </div>
                    </div>
                    <div className="max-h-72 overflow-y-auto border rounded-lg">
                      {orgUnits.map((ou) => {
                        const detectedGrade = ouGradeOverrides[ou.orgUnitPath] || null;
                        return (
                          <div key={ou.orgUnitPath} className={`flex items-center gap-3 p-3 border-b last:border-b-0 hover:bg-muted/20 ${selectedOUs.has(ou.orgUnitPath) ? "bg-blue-50/50" : ""}`}>
                            <Checkbox
                              checked={selectedOUs.has(ou.orgUnitPath)}
                              onCheckedChange={() => {
                                const s = new Set(selectedOUs);
                                if (s.has(ou.orgUnitPath)) s.delete(ou.orgUnitPath); else s.add(ou.orgUnitPath);
                                setSelectedOUs(s);
                              }}
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="text-sm font-medium truncate">{ou.name}</p>
                                {detectedGrade && (
                                  <Badge variant="secondary" className="text-xs shrink-0">
                                    Grade {detectedGrade}
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground truncate">{ou.orgUnitPath}</p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <Select
                                value={ouGradeOverrides[ou.orgUnitPath] || "none"}
                                onValueChange={(val) => {
                                  setOuGradeOverrides(prev => ({ ...prev, [ou.orgUnitPath]: val === "none" ? "" : val }));
                                }}
                              >
                                <SelectTrigger className="h-7 w-24 text-xs">
                                  <SelectValue placeholder="Grade" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">No grade</SelectItem>
                                  {GRADE_LEVELS.map((gl) => (
                                    <SelectItem key={gl} value={gl}>{gl === "K" ? "K" : `Grade ${gl}`}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={() => {
                                  setExpandedOU(ou.orgUnitPath);
                                  setGoogleDirGradeLevel(ouGradeOverrides[ou.orgUnitPath] || "");
                                  loadDirectoryUsers(ou.orgUnitPath);
                                }}
                              >
                                &rarr;
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {importResult && (
                      <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                        <p className="font-medium">{importResult.message || `Imported ${importResult.imported} students`}</p>
                      </div>
                    )}

                    <Button
                      className="w-full"
                      onClick={importSelectedOUs}
                      disabled={googleDirImport.isPending || selectedOUs.size === 0}
                    >
                      {googleDirImport.isPending ? "Importing..." : `Import ${selectedOUs.size} Selected OU${selectedOUs.size !== 1 ? "s" : ""}`}
                    </Button>
                  </>
                )}
              </>
            )}

            {/* User List View (expanded OU) */}
            {!googleDirLoading && expandedOU && (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">{googleDirUsers.length} users</p>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => {
                      if (googleDirSelected.size === googleDirUsers.length) setGoogleDirSelected(new Set());
                      else setGoogleDirSelected(new Set(googleDirUsers.map((u) => u.id)));
                    }}>
                      {googleDirSelected.size === googleDirUsers.length ? "Deselect All" : "Select All"}
                    </Button>
                    <span className="text-sm">{googleDirSelected.size} selected</span>
                  </div>
                </div>
                <div className="max-h-64 overflow-y-auto border rounded-lg">
                  {googleDirUsers.map((user) => (
                    <div key={user.id} className={`flex items-center gap-3 p-2 border-b last:border-b-0 hover:bg-muted/20 ${googleDirSelected.has(user.id) ? "bg-blue-50/50" : ""}`}>
                      <Checkbox checked={googleDirSelected.has(user.id)} onCheckedChange={() => {
                        const s = new Set(googleDirSelected);
                        if (s.has(user.id)) s.delete(user.id); else s.add(user.id);
                        setGoogleDirSelected(s);
                      }} />
                      <div>
                        <p className="text-sm font-medium">{user.name}</p>
                        <p className="text-xs text-muted-foreground">{user.email}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="space-y-1">
                  <Label>Grade Level</Label>
                  <Select value={googleDirGradeLevel} onValueChange={setGoogleDirGradeLevel}>
                    <SelectTrigger><SelectValue placeholder="Select grade level" /></SelectTrigger>
                    <SelectContent>
                      {GRADE_LEVELS.map((gl) => (
                        <SelectItem key={gl} value={gl}>{gl === "K" ? "Kindergarten" : `Grade ${gl}`}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {importResult && (
                  <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                    <p className="font-medium">{importResult.message || `Imported ${importResult.imported} students`}</p>
                  </div>
                )}

                <Button
                  className="w-full"
                  onClick={() => googleDirImport.mutate({
                    orgUnitPath: expandedOU === "__all__" ? undefined : expandedOU,
                    gradeLevel: googleDirGradeLevel || undefined,
                    userIds: Array.from(googleDirSelected),
                  })}
                  disabled={googleDirImport.isPending || googleDirSelected.size === 0}
                >
                  {googleDirImport.isPending ? "Importing..." : `Import ${googleDirSelected.size} Selected User${googleDirSelected.size !== 1 ? "s" : ""}`}
                </Button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Google Classroom Import Dialog */}
      <Dialog open={classroomOpen} onOpenChange={(open) => { setClassroomOpen(open); if (!open) { setClassroomCourses([]); setClassroomSelectedCourse(""); setClassroomGradeLevel(""); setImportResult(null); } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Import from Google Classroom</DialogTitle></DialogHeader>
          <div className="space-y-4">
            {classroomLoading ? (
              <div className="py-8 text-center">
                <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Loading courses from Google Classroom...</p>
              </div>
            ) : classroomCourses.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">
                <GraduationCap className="h-10 w-10 mx-auto mb-3 opacity-50" />
                <p>No courses found or Google account not connected.</p>
                <p className="text-xs mt-1">Make sure your Google account is connected with Classroom permissions.</p>
                <Button variant="outline" size="sm" className="mt-3" onClick={loadClassroomCourses}>
                  <RefreshCw className="h-3 w-3 mr-1" /> Retry
                </Button>
              </div>
            ) : (
              <div className="space-y-1">
                <Label>Select Course</Label>
                <div className="max-h-64 overflow-y-auto border rounded-lg">
                  {classroomCourses.map((course) => (
                    <div
                      key={course.id || course.googleCourseId}
                      className={`flex items-center gap-3 p-3 border-b last:border-b-0 cursor-pointer hover:bg-muted/20 ${classroomSelectedCourse === (course.id || course.googleCourseId) ? "bg-blue-50 border-blue-200" : ""}`}
                      onClick={() => setClassroomSelectedCourse(course.id || course.googleCourseId)}
                    >
                      <input type="radio" checked={classroomSelectedCourse === (course.id || course.googleCourseId)} readOnly className="mt-0.5" />
                      <div>
                        <p className="text-sm font-medium">{course.name}</p>
                        {course.section && <p className="text-xs text-muted-foreground">{course.section}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-1">
              <Label>Grade Level (optional)</Label>
              <Select value={classroomGradeLevel} onValueChange={setClassroomGradeLevel}>
                <SelectTrigger><SelectValue placeholder="Select grade level" /></SelectTrigger>
                <SelectContent>
                  {GRADE_LEVELS.map((gl) => (
                    <SelectItem key={gl} value={gl}>{gl === "K" ? "Kindergarten" : `Grade ${gl}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {importResult && (
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                <p className="font-medium">{importResult.message || `Imported ${importResult.imported} students`}</p>
              </div>
            )}

            <Button
              className="w-full"
              onClick={() => classroomImport.mutate()}
              disabled={classroomImport.isPending || !classroomSelectedCourse}
            >
              {classroomImport.isPending ? "Syncing..." : "Sync Roster"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ClassesTab() {
  const { data: grades, isLoading } = useGrades();
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [className, setClassName] = useState("");
  const [editId, setEditId] = useState("");
  const [editName, setEditName] = useState("");
  const [viewingGrade, setViewingGrade] = useState(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [addStudentOpen, setAddStudentOpen] = useState(false);
  const [, setAddStudentGradeId] = useState("");
  const [addStudentGradeName, setAddStudentGradeName] = useState("");
  const [studentName, setStudentName] = useState("");
  const [studentGradeLevel, setStudentGradeLevel] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [, setBulkGradeId] = useState("");
  const [bulkGradeName, setBulkGradeName] = useState("");
  const [bulkNames, setBulkNames] = useState("");
  const [bulkGradeLevel, setBulkGradeLevel] = useState("");

  // Google Classroom sync state
  const [gcSyncOpen, setGcSyncOpen] = useState(false);
  const [gcCourses, setGcCourses] = useState([]);
  const [gcLoading, setGcLoading] = useState(false);
  const [gcSelected, setGcSelected] = useState(new Set());
  const [gcCourseMapping, setGcCourseMapping] = useState({});
  const [gcSyncing, setGcSyncing] = useState(false);
  const [gcGradeLevels, setGcGradeLevels] = useState({});
  const [gcResult, setGcResult] = useState(null);

  const { data: students } = useQuery({
    queryKey: ["students"],
    queryFn: async () => {
      const res = await fetch("/api/students", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    select: (data) => Array.isArray(data) ? data : (data?.students ?? []),
  });

  // Count students per grade (class)
  const studentCountMap = new Map();
  for (const s of students ?? []) {
    if (s.gradeId) {
      studentCountMap.set(s.gradeId, (studentCountMap.get(s.gradeId) ?? 0) + 1);
    }
  }

  const addClass = useMutation({
    mutationFn: (data) => apiRequest("POST", "/grades", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grades"] });
      toast({ title: "Class added" });
      setAddOpen(false);
      setClassName("");
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const updateClass = useMutation({
    mutationFn: (data) => apiRequest("PUT", `/grades/${data.id}`, { name: data.name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grades"] });
      toast({ title: "Class updated" });
      setEditOpen(false);
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteClass = useMutation({
    mutationFn: (id) => apiRequest("DELETE", `/grades/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grades"] });
      queryClient.invalidateQueries({ queryKey: ["students"] });
      toast({ title: "Class deleted" });
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const addStudent = useMutation({
    mutationFn: (data) =>
      apiRequest("POST", "/students", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["students"] });
      toast({ title: "Student added" });
      setAddStudentOpen(false);
      setStudentName("");
      setStudentGradeLevel("");
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const bulkAddStudents = useMutation({
    mutationFn: async (data) => {
      const lines = data.names.split("\n").map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        const cleanLine = line
          .replace(/^\d+\.\s*/, '')
          .replace(/^\d+\)\s*/, '')
          .replace(/^-\s*/, '')
          .replace(/^\*\s*/, '')
          .trim();
        if (cleanLine) {
          await apiRequest("POST", "/students", { name: cleanLine, grade: data.grade, gradeLevel: data.gradeLevel });
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["students"] });
      toast({ title: "Students added" });
      setBulkOpen(false);
      setBulkNames("");
      setBulkGradeLevel("");
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const loadGcCourses = async () => {
    setGcLoading(true);
    try {
      const res = await fetch("/api/classroom/courses", { credentials: "include" });
      if (!res.ok) {
        const err = await res.json();
        toast({ title: "Error", description: err.error || "Failed to load courses", variant: "destructive" });
        setGcSyncOpen(false);
        return;
      }
      const courses = await res.json();
      setGcCourses(courses);
      setGcSelected(new Set(courses.map((c) => c.id)));
      // Auto-map courses to existing classes by name match
      const mapping = {};
      for (const course of courses) {
        const match = (grades ?? []).find((g) => g.name.toLowerCase() === course.name.toLowerCase());
        if (match) mapping[course.id] = match.id;
      }
      setGcCourseMapping(mapping);
    } catch (err) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setGcLoading(false);
    }
  };

  const syncSelectedCourses = async () => {
    setGcSyncing(true);
    let totalImported = 0;
    let totalUpdated = 0;
    let synced = 0;
    for (const courseId of gcSelected) {
      const course = gcCourses.find((c) => c.id === courseId);
      if (!course) continue;
      try {
        let gradeId = gcCourseMapping[courseId];
        // If no mapping, create a new class with the course name
        if (!gradeId) {
          const createRes = await fetch("/api/grades", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: course.name }),
            credentials: "include",
          });
          if (createRes.ok) {
            const newGrade = await createRes.json();
            gradeId = newGrade.id;
          } else {
            continue;
          }
        }
        const res = await fetch(`/api/classroom/courses/${courseId}/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gradeId, gradeLevel: gcGradeLevels[courseId] || undefined }),
          credentials: "include",
        });
        if (res.ok) {
          const data = await res.json();
          totalImported += data.imported || 0;
          totalUpdated += data.updated || 0;
          synced++;
        }
      } catch { /* continue */ }
    }
    queryClient.invalidateQueries({ queryKey: ["grades"] });
    queryClient.invalidateQueries({ queryKey: ["students"] });
    setGcResult({ synced, imported: totalImported, updated: totalUpdated });
    toast({ title: `Synced ${synced} course(s): ${totalImported} imported, ${totalUpdated} updated` });
    setGcSyncing(false);
  };

  if (isLoading) return <Skeleton className="h-40 w-full mt-4" />;

  const viewingStudents = viewingGrade ? (students ?? []).filter((s) => s.gradeId === viewingGrade.id) : [];

  return (
    <div className="space-y-4 mt-4">
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => { setGcSyncOpen(true); loadGcCourses(); }}>
          <GraduationCap className="h-4 w-4 mr-1" />
          Sync from Google Classroom
        </Button>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Add Class
        </Button>
      </div>

      {(grades ?? []).length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No classes added yet. Add a class to get started.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(grades ?? []).map((grade) => (
            <Card key={grade.id} className="hover:shadow-md transition-all">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold">{grade.name}</h3>
                  <div className="flex items-center space-x-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => { setViewingGrade(grade); setViewOpen(true); }}
                      className="h-6 w-6 p-0"
                    >
                      <Eye className="h-3 w-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditId(grade.id);
                        setEditName(grade.name);
                        setEditOpen(true);
                      }}
                      className="h-6 w-6 p-0"
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0 hover:text-red-600"><Trash2 className="h-3 w-3" /></Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete class?</AlertDialogTitle>
                          <AlertDialogDescription>This will permanently delete the class "{grade.name}".</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => deleteClass.mutate(grade.id)}>Delete</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  {studentCountMap.get(grade.id) ?? 0} student{(studentCountMap.get(grade.id) ?? 0) !== 1 ? "s" : ""}
                </p>
                <div className="flex gap-1 mt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { setAddStudentGradeId(grade.id); setAddStudentGradeName(grade.name); setAddStudentOpen(true); }}
                    className="h-6 text-xs px-2"
                  >
                    Add Student
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { setBulkGradeId(grade.id); setBulkGradeName(grade.name); setBulkOpen(true); }}
                    className="h-6 text-xs px-2"
                  >
                    Bulk Add
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add Class Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Class</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Class Name</Label>
              <Input value={className} onChange={(e) => setClassName(e.target.value)} placeholder="e.g. Room 204, Period 3" />
            </div>
            <Button
              className="w-full"
              onClick={() => addClass.mutate({ name: className })}
              disabled={addClass.isPending || !className.trim()}
            >
              {addClass.isPending ? "Adding..." : "Add Class"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Class Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit Class</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Class Name</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <Button
              className="w-full"
              onClick={() => updateClass.mutate({ id: editId, name: editName })}
              disabled={updateClass.isPending || !editName.trim()}
            >
              {updateClass.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* View Class Roster Dialog */}
      <Dialog open={viewOpen} onOpenChange={setViewOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{viewingGrade?.name} - Roster</DialogTitle>
          </DialogHeader>
          <div className="max-h-96 overflow-y-auto">
            {viewingStudents.length === 0 ? (
              <div className="text-center py-8">
                <Users className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                <p className="text-muted-foreground">No students in this class yet.</p>
                <div className="flex gap-2 justify-center mt-4">
                  <Button size="sm" onClick={() => { if (viewingGrade) { setAddStudentGradeId(viewingGrade.id); setAddStudentGradeName(viewingGrade.name); setViewOpen(false); setAddStudentOpen(true); } }}>Add Student</Button>
                  <Button size="sm" variant="outline" onClick={() => { if (viewingGrade) { setBulkGradeId(viewingGrade.id); setBulkGradeName(viewingGrade.name); setViewOpen(false); setBulkOpen(true); } }}>Bulk Add</Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <p className="text-sm text-muted-foreground">{viewingStudents.length} student{viewingStudents.length !== 1 ? "s" : ""}</p>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => { if (viewingGrade) { setAddStudentGradeId(viewingGrade.id); setAddStudentGradeName(viewingGrade.name); setViewOpen(false); setAddStudentOpen(true); } }}>
                      <Plus className="w-4 h-4 mr-1" />Add Student
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => { if (viewingGrade) { setBulkGradeId(viewingGrade.id); setBulkGradeName(viewingGrade.name); setViewOpen(false); setBulkOpen(true); } }}>
                      <Users className="w-4 h-4 mr-1" />Bulk Add
                    </Button>
                  </div>
                </div>
                {viewingStudents.map((student) => (
                  <div key={student.id} className="flex items-center justify-between p-3 bg-muted/30 rounded-lg">
                    <div>
                      <p className="font-medium">{student.firstName} {student.lastName}</p>
                      {student.studentIdNumber && <p className="text-sm text-muted-foreground">ID: {student.studentIdNumber}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Student to Class Dialog */}
      <Dialog open={addStudentOpen} onOpenChange={setAddStudentOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Student to {addStudentGradeName}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Student Name</Label>
              <Input value={studentName} onChange={(e) => setStudentName(e.target.value)} placeholder="John Doe" />
            </div>
            <div className="space-y-1">
              <Label>Grade Level</Label>
              <Select value={studentGradeLevel} onValueChange={setStudentGradeLevel}>
                <SelectTrigger><SelectValue placeholder="Select grade level" /></SelectTrigger>
                <SelectContent>
                  {GRADE_LEVELS.map((gl) => (
                    <SelectItem key={gl} value={gl}>{gl === "K" ? "Kindergarten" : `Grade ${gl}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              className="w-full"
              onClick={() => addStudent.mutate({ name: studentName, grade: addStudentGradeName, gradeLevel: studentGradeLevel })}
              disabled={addStudent.isPending || !studentName.trim() || !studentGradeLevel}
            >
              {addStudent.isPending ? "Adding..." : "Add Student"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Add Students to Class Dialog */}
      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Bulk Add Students to {bulkGradeName}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Grade Level</Label>
              <Select value={bulkGradeLevel} onValueChange={setBulkGradeLevel}>
                <SelectTrigger><SelectValue placeholder="Select grade level" /></SelectTrigger>
                <SelectContent>
                  {GRADE_LEVELS.map((gl) => (
                    <SelectItem key={gl} value={gl}>{gl === "K" ? "Kindergarten" : `Grade ${gl}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Student Names (one per line)</Label>
              <textarea
                className="w-full border rounded-md px-3 py-2 text-sm min-h-[120px] resize-y"
                value={bulkNames}
                onChange={(e) => setBulkNames(e.target.value)}
                placeholder={"John Doe\nJane Smith\nAlex Johnson"}
              />
            </div>
            <Button
              className="w-full"
              onClick={() => bulkAddStudents.mutate({ names: bulkNames, grade: bulkGradeName, gradeLevel: bulkGradeLevel })}
              disabled={bulkAddStudents.isPending || !bulkNames.trim() || !bulkGradeLevel}
            >
              {bulkAddStudents.isPending ? "Adding..." : "Add Students"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Google Classroom Sync Dialog */}
      <Dialog open={gcSyncOpen} onOpenChange={(open) => {
        setGcSyncOpen(open);
        if (!open) { setGcCourses([]); setGcSelected(new Set()); setGcCourseMapping({}); setGcResult(null); }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Sync from Google Classroom</DialogTitle></DialogHeader>
          <div className="space-y-4">
            {gcLoading && (
              <div className="py-8 text-center">
                <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Loading courses...</p>
              </div>
            )}

            {!gcLoading && gcCourses.length === 0 && !gcResult && (
              <div className="py-8 text-center text-muted-foreground">
                <GraduationCap className="h-10 w-10 mx-auto mb-3 opacity-50" />
                <p>No active courses found in Google Classroom.</p>
                <Button variant="outline" size="sm" className="mt-3" onClick={loadGcCourses}>
                  <RefreshCw className="h-3 w-3 mr-1" /> Retry
                </Button>
              </div>
            )}

            {!gcLoading && gcCourses.length > 0 && (
              <>
                <p className="text-sm text-muted-foreground">
                  Each course will be mapped to a class. Unmapped courses will create a new class automatically.
                </p>
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">{gcCourses.length} active course{gcCourses.length !== 1 ? "s" : ""}</p>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => {
                      if (gcSelected.size === gcCourses.length) setGcSelected(new Set());
                      else setGcSelected(new Set(gcCourses.map((c) => c.id)));
                    }}>
                      {gcSelected.size === gcCourses.length ? "Deselect All" : "Select All"}
                    </Button>
                    <span className="text-sm font-medium">{gcSelected.size} selected</span>
                  </div>
                </div>

                <div className="max-h-72 overflow-y-auto border rounded-lg">
                  {gcCourses.map((course) => (
                    <div key={course.id} className={`flex items-center gap-3 p-3 border-b last:border-b-0 hover:bg-muted/20 ${gcSelected.has(course.id) ? "bg-blue-50/50" : ""}`}>
                      <Checkbox
                        checked={gcSelected.has(course.id)}
                        onCheckedChange={() => {
                          const s = new Set(gcSelected);
                          if (s.has(course.id)) s.delete(course.id); else s.add(course.id);
                          setGcSelected(s);
                        }}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{course.name}</p>
                        {course.section && <p className="text-xs text-muted-foreground">{course.section}</p>}
                      </div>
                      <div className="shrink-0">
                        <Select
                          value={gcCourseMapping[course.id] || "__new__"}
                          onValueChange={(val) => {
                            setGcCourseMapping(prev => {
                              const next = { ...prev };
                              if (val === "__new__") delete next[course.id];
                              else next[course.id] = val;
                              return next;
                            });
                          }}
                        >
                          <SelectTrigger className="h-7 w-40 text-xs">
                            <SelectValue placeholder="Map to class" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__new__">+ Create new class</SelectItem>
                            {(grades ?? []).map((g) => (
                              <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="shrink-0">
                        <Select
                          value={gcGradeLevels[course.id] || "__none__"}
                          onValueChange={(val) => {
                            setGcGradeLevels(prev => {
                              const next = { ...prev };
                              if (val === "__none__") delete next[course.id];
                              else next[course.id] = val;
                              return next;
                            });
                          }}
                        >
                          <SelectTrigger className="h-7 w-24 text-xs">
                            <SelectValue placeholder="Grade" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">No grade</SelectItem>
                            {GRADE_LEVELS.map((gl) => (
                              <SelectItem key={gl} value={gl}>{gl === "K" ? "Kindergarten" : `Grade ${gl}`}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  ))}
                </div>

                {gcResult && (
                  <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                    <p className="font-medium">Synced {gcResult.synced} course(s): {gcResult.imported} students imported, {gcResult.updated} updated</p>
                  </div>
                )}

                <Button
                  className="w-full"
                  onClick={syncSelectedCourses}
                  disabled={gcSyncing || gcSelected.size === 0}
                >
                  {gcSyncing ? "Syncing..." : `Sync ${gcSelected.size} Selected Course${gcSelected.size !== 1 ? "s" : ""}`}
                </Button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AssignmentsTab() {
  const { data: teachers } = useTeachers();
  const { data: grades } = useGrades();
  const [selectedTeacherId, setSelectedTeacherId] = useState("");

  const { data: assignments } = useQuery({
    queryKey: ["teacher-grades", selectedTeacherId],
    queryFn: async () => {
      if (!selectedTeacherId) return [];
      const res = await fetch(`/api/teacher-grades/${selectedTeacherId}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    select: (data) => Array.isArray(data) ? data : (data?.assignments ?? data?.teacherGrades ?? []),
    enabled: !!selectedTeacherId,
  });

  const assignedGradeIds = new Set((assignments ?? []).map((a) => a.gradeId));

  const assignGrade = useMutation({
    mutationFn: (gradeId) =>
      apiRequest("POST", "/teacher-grades", { teacherId: selectedTeacherId, gradeId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["teacher-grades", selectedTeacherId] }),
  });

  const removeGrade = useMutation({
    mutationFn: (gradeId) =>
      apiRequest("DELETE", "/teacher-grades", { teacherId: selectedTeacherId, gradeId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["teacher-grades", selectedTeacherId] }),
  });

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader><CardTitle className="text-base">Assign Teachers to Classes</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label>Select Teacher</Label>
            <select
              className="w-full border rounded-md px-3 py-2 text-sm"
              value={selectedTeacherId}
              onChange={(e) => setSelectedTeacherId(e.target.value)}
            >
              <option value="">Choose a teacher...</option>
              {(teachers ?? []).map((t) => (
                <option key={t.id} value={t.id}>{t.displayName || t.email}</option>
              ))}
            </select>
          </div>

          {selectedTeacherId && (
            <div className="space-y-2">
              <Label>Assigned Classes</Label>
              <div className="flex flex-wrap gap-2">
                {(grades ?? []).map((grade) => {
                  const isAssigned = assignedGradeIds.has(grade.id);
                  return (
                    <Button
                      key={grade.id}
                      variant={isAssigned ? "default" : "outline"}
                      size="sm"
                      onClick={() => {
                        if (isAssigned) {
                          removeGrade.mutate(grade.id);
                        } else {
                          assignGrade.mutate(grade.id);
                        }
                      }}
                    >
                      {grade.name}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SettingsTab() {
  const { school } = usePassPilotAuth();
  const [name, setName] = useState(school?.name ?? "");
  const [kioskEnabled, setKioskEnabled] = useState(school?.kioskEnabled ?? true);
  const [kioskRequiresApproval, setKioskRequiresApproval] = useState(school?.kioskRequiresApproval ?? false);
  const [schoolTimezone, setSchoolTimezone] = useState(school?.schoolTimezone ?? "America/New_York");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (school) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setName(school.name ?? "");
      setKioskEnabled(school.kioskEnabled ?? true);
      setKioskRequiresApproval(school.kioskRequiresApproval ?? false);
      setSchoolTimezone(school.schoolTimezone ?? "America/New_York");
    }
  }, [school]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiRequest("PATCH", "/admin/settings", {
        name,
        kioskEnabled,
        kioskRequiresApproval,
        schoolTimezone,
      });
      toast({ title: "Settings saved" });
      window.location.hash = "setup/settings";
      window.location.reload();
    } catch (err) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader><CardTitle className="text-base">School Settings</CardTitle></CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-1">
            <Label>School Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="space-y-1">
            <Label>School Timezone</Label>
            <select
              className="w-full border rounded-md px-3 py-2 text-sm"
              value={schoolTimezone}
              onChange={(e) => setSchoolTimezone(e.target.value)}
            >
              <option value="America/New_York">Eastern (America/New_York)</option>
              <option value="America/Chicago">Central (America/Chicago)</option>
              <option value="America/Denver">Mountain (America/Denver)</option>
              <option value="America/Los_Angeles">Pacific (America/Los_Angeles)</option>
              <option value="America/Anchorage">Alaska (America/Anchorage)</option>
              <option value="Pacific/Honolulu">Hawaii (Pacific/Honolulu)</option>
            </select>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Kiosk Mode Enabled</Label>
              <p className="text-xs text-muted-foreground">Allow students to self-checkout via kiosk</p>
            </div>
            <Switch checked={kioskEnabled} onCheckedChange={setKioskEnabled} />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Kiosk Requires Approval</Label>
              <p className="text-xs text-muted-foreground">Require teacher approval for kiosk checkouts</p>
            </div>
            <Switch checked={kioskRequiresApproval} onCheckedChange={setKioskRequiresApproval} />
          </div>

          <Button onClick={handleSave} disabled={saving} className="w-full">
            {saving ? "Saving..." : "Save Settings"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default SetupView;
