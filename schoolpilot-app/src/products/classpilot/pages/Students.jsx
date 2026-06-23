import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import { useToast } from "../../../hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Checkbox } from "../../../components/ui/checkbox";
import { ArrowLeft, Upload, Download, Edit, Trash2, FileSpreadsheet, GraduationCap, RefreshCw, Users, Loader2, Building2, AlertCircle, Plus, Search, ChevronRight, ChevronDown, KeyRound, Printer } from "lucide-react";
import { ThemeToggle } from "../../../components/ThemeToggle";
import { useNavigate } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { EditStudentDialog } from "../components/EditStudentDialog";
import { useClassPilotAuth } from "../../../hooks/useClassPilotAuth";
import { useLicenses } from "../../../contexts/LicenseContext";

// Helper to normalize grade levels
function normalizeGrade(grade) {
  if (!grade) return null;
  const trimmed = grade.trim();
  if (!trimmed) return null;
  return trimmed.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function columnName(index) {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, value, true);
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function zipDateParts(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function buildZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  const { time, day } = zipDateParts();
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = encoder.encode(file.content);
    const crc = crc32(dataBytes);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0x0800);
    writeUint16(localView, 8, 0);
    writeUint16(localView, 10, time);
    writeUint16(localView, 12, day);
    writeUint32(localView, 14, crc);
    writeUint32(localView, 18, dataBytes.length);
    writeUint32(localView, 22, dataBytes.length);
    writeUint16(localView, 26, nameBytes.length);
    writeUint16(localView, 28, 0);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, dataBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0x0800);
    writeUint16(centralView, 10, 0);
    writeUint16(centralView, 12, time);
    writeUint16(centralView, 14, day);
    writeUint32(centralView, 16, crc);
    writeUint32(centralView, 20, dataBytes.length);
    writeUint32(centralView, 24, dataBytes.length);
    writeUint16(centralView, 28, nameBytes.length);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0);
    writeUint32(centralView, 42, offset);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + dataBytes.length;
  }

  const localData = concatBytes(localParts);
  const centralData = concatBytes(centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 8, files.length);
  writeUint16(endView, 10, files.length);
  writeUint32(endView, 12, centralData.length);
  writeUint32(endView, 16, localData.length);
  return concatBytes([localData, centralData, end]);
}

function buildXlsxBlob(rows, sheetName) {
  const sheetData = rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cells = row.map((value, colIndex) => {
      const ref = `${columnName(colIndex)}${rowNumber}`;
      return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
    }).join("");
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join("");
  const safeSheetName = escapeXml(sheetName).slice(0, 31) || "Sheet1";
  const files = [
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${safeSheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: "xl/styles.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf xfId="0"/></cellXfs></styleSheet>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="28" customWidth="1"/><col min="2" max="2" width="12" customWidth="1"/><col min="3" max="3" width="18" customWidth="1"/></cols><sheetData>${sheetData}</sheetData></worksheet>`,
    },
  ];
  return new Blob([buildZip(files)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// Admin Guard Wrapper - Only checks auth, doesn't run any queries/mutations
export default function StudentsPage() {
  const navigate = useNavigate();
  const { toast } = useToast();

  // Only fetch current user for auth check
  const { currentUser, isLoading: isLoadingUser } = useClassPilotAuth();

  // Redirect non-admin users (allow admin, school_admin, and super_admin)
  const isAdminRole = currentUser?.role === 'admin' || currentUser?.role === 'school_admin' || currentUser?.role === 'super_admin';

  useEffect(() => {
    if (!isLoadingUser && !isAdminRole) {
      toast({
        title: "Access Denied",
        description: "This page is only accessible to administrators",
        variant: "destructive",
      });
      navigate("/classpilot");
    }
  }, [currentUser, isLoadingUser, isAdminRole, navigate, toast]);

  // Show loading while checking auth
  if (isLoadingUser) {
    return (
      <div className="container mx-auto p-6 max-w-7xl">
        <div className="text-center py-20">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      </div>
    );
  }

  // Don't render anything for non-admins
  if (!isAdminRole) {
    return null;
  }

  // Only render content for confirmed admins
  return <StudentsContent />;
}

// Content Component - Only runs for confirmed admins
function StudentsContent() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { hasGoPilot } = useLicenses();
  const [selectedGrade, setSelectedGrade] = useState("");
  const [csvFile, setCsvFile] = useState(null);
  const [importResults, setImportResults] = useState(null);
  const [editingStudent, setEditingStudent] = useState(null);
  const [deletingStudent, setDeletingStudent] = useState(null);
  const [showClassroomDialog, setShowClassroomDialog] = useState(false);
  const [syncingCourseId, setSyncingCourseId] = useState(null);
  const [showWorkspaceDialog, setShowWorkspaceDialog] = useState(false);
  const [workspaceImportResult, setWorkspaceImportResult] = useState(null);
  const [, setSelectedOrgUnit] = useState("");
  const [, setImportGradeLevel] = useState("");
  // Enhanced multi-OU import state
  const [checkedOUs, setCheckedOUs] = useState(new Set());
  const [ouGradeOverrides, setOuGradeOverrides] = useState({});
  const [expandedOU, setExpandedOU] = useState(null);
  const [excludedEmails, setExcludedEmails] = useState({});
  const [classroomImportGrade, setClassroomImportGrade] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedStudents, setSelectedStudents] = useState(new Set());
  const [showAddStudentDialog, setShowAddStudentDialog] = useState(false);
  const [newStudentName, setNewStudentName] = useState("");
  const [newStudentEmail, setNewStudentEmail] = useState("");
  const [newStudentGrade, setNewStudentGrade] = useState("");
  const [generatedPins, setGeneratedPins] = useState([]);
  const [showAddGradeDialog, setShowAddGradeDialog] = useState(false);
  const [manualGrades, setManualGrades] = useState([]); // Manually added grade categories
  const [showBulkGradeDialog, setShowBulkGradeDialog] = useState(false);
  const [bulkGradeLevel, setBulkGradeLevel] = useState("");

  // Fetch all students (only runs for admins)
  const { data: studentsData, isLoading } = useQuery({
    queryKey: ["/api/admin/teacher-students"],
    queryFn: () => apiRequest("GET", "/admin/teacher-students"),
  });

  const { data: settings } = useQuery({
    queryKey: ["/api/settings"],
    queryFn: () => apiRequest("GET", "/settings"),
  });

  // Fetch Google Classroom courses (only when dialog is open)
  const { data: classroomData, isLoading: isLoadingCourses, error: classroomError, refetch: refetchCourses } = useQuery({
    queryKey: ["/api/classroom/courses"],
    queryFn: () => apiRequest("GET", "/classroom/courses"),
    enabled: showClassroomDialog,
  });

  const classroomCourses = classroomData?.courses || [];

  // Parse error code from classroom error (axios errors have response data in error.response.data)
  // Treats both NO_TOKENS (never connected) and MISSING_GOOGLE_SCOPE (connected
  // before the classroom.profile.emails scope was added — needs reconnect) as
  // "not connected" so the reconnect prompt is shown for both.
  const classroomNotConnected = (() => {
    if (!classroomError) return false;
    const serverMsg = classroomError.response?.data?.error || "";
    if (
      serverMsg.includes("Google not connected") ||
      serverMsg.includes("NO_TOKENS") ||
      serverMsg.includes("MISSING_GOOGLE_SCOPE")
    ) {
      return true;
    }
    const errorMessage = classroomError.message || "";
    try {
      const jsonMatch = errorMessage.match(/\{.*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed.code === "NO_TOKENS" || parsed.code === "MISSING_GOOGLE_SCOPE";
      }
    } catch {
      return (
        errorMessage.includes("NO_TOKENS") ||
        errorMessage.includes("MISSING_GOOGLE_SCOPE")
      );
    }
    return errorMessage.includes("MISSING_GOOGLE_SCOPE");
  })();

  // Sync Google Classroom roster mutation
  const syncClassroomMutation = useMutation({
    mutationFn: async ({ courseId, gradeLevel }) => {
      setSyncingCourseId(courseId);
      return apiRequest("POST", `/classroom/courses/${courseId}/sync`, { gradeLevel: gradeLevel || undefined });
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"], exact: false });
      await queryClient.invalidateQueries({ queryKey: ["/api/groups"], exact: false });
      await queryClient.invalidateQueries({ queryKey: ["/api/teacher/groups"], exact: false });
      await queryClient.invalidateQueries({ queryKey: ["/api/classroom/courses"] });
      setGeneratedPins(data.generatedPins || []);
      toast({
        title: "Import Complete",
        description: `Imported ${data.imported || 0} students from Google Classroom`,
      });
      setSyncingCourseId(null);
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Sync Failed",
        description: error.message,
      });
      setSyncingCourseId(null);
    },
  });

  // Fetch Google Workspace Directory users (only when dialog is open)
  const { data: directoryData, isLoading: isLoadingDirectory, error: directoryError, refetch: refetchDirectory } = useQuery({
    queryKey: ["/api/directory/users"],
    queryFn: () => apiRequest("GET", "/directory/users"),
    enabled: showWorkspaceDialog,
  });

  // Fetch organizational units (only when dialog is open)
  const { data: orgUnitsData, isLoading: isLoadingOrgUnits, error: orgUnitsError, refetch: refetchOrgUnits } = useQuery({
    queryKey: ["/api/directory/orgunits"],
    queryFn: () => apiRequest("GET", "/directory/orgunits"),
    enabled: showWorkspaceDialog,
  });

  const directoryUsers = directoryData?.users || [];
  const orgUnits = orgUnitsData?.orgUnits || [];

  // Parse error codes from the error (axios errors have response data in error.response.data)
  const getApiErrorMessage = (error) => error?.response?.data?.error || error?.message || "Unknown error";

  const getDirectoryErrorCode = (error) => {
    if (!error) return null;
    const serverCode = error.response?.data?.code;
    if (serverCode) return serverCode;
    const serverMsg = error.response?.data?.error || "";
    if (serverMsg.includes("Google not connected") || serverMsg.includes("NO_TOKENS")) return "NO_TOKENS";
    if (serverMsg.includes("Reconnect Google") || serverMsg.includes("GOOGLE_RECONNECT_REQUIRED")) return "GOOGLE_RECONNECT_REQUIRED";
    if (serverMsg.includes("GOOGLE_DOMAIN_MISMATCH")) return "GOOGLE_DOMAIN_MISMATCH";
    if (serverMsg.includes("INSUFFICIENT_PERMISSIONS")) return "INSUFFICIENT_PERMISSIONS";
    const errorMessage = error.message || "";
    try {
      const jsonMatch = errorMessage.match(/\{.*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed.code || null;
      }
    } catch {
      if (errorMessage.includes("NO_TOKENS")) return "NO_TOKENS";
      if (errorMessage.includes("GOOGLE_RECONNECT_REQUIRED")) return "GOOGLE_RECONNECT_REQUIRED";
      if (errorMessage.includes("GOOGLE_DOMAIN_MISMATCH")) return "GOOGLE_DOMAIN_MISMATCH";
      if (errorMessage.includes("INSUFFICIENT_PERMISSIONS")) return "INSUFFICIENT_PERMISSIONS";
    }
    if (errorMessage.includes("GOOGLE_RECONNECT_REQUIRED")) return "GOOGLE_RECONNECT_REQUIRED";
    if (errorMessage.includes("GOOGLE_DOMAIN_MISMATCH")) return "GOOGLE_DOMAIN_MISMATCH";
    return "UNKNOWN_ERROR";
  };

  const directoryErrorCode = getDirectoryErrorCode(directoryError) || getDirectoryErrorCode(orgUnitsError);
  const directoryNeedsReconnect = directoryErrorCode === "NO_TOKENS" || directoryErrorCode === "GOOGLE_RECONNECT_REQUIRED";
  const directoryNoPermission = directoryErrorCode === "INSUFFICIENT_PERMISSIONS";
  const directoryDomainMismatch = directoryErrorCode === "GOOGLE_DOMAIN_MISMATCH";
  const directoryUnknownError = directoryErrorCode === "UNKNOWN_ERROR";
  const directoryEmptyDiagnostics = directoryUsers.length === 0 && !directoryError && !orgUnitsError ? directoryData?.diagnostics : null;

  const connectGoogleWorkspace = async () => {
    try {
      const params = new URLSearchParams({
        purpose: "workspace_import",
        returnTo: `${window.location.origin}/classpilot/students`,
      });
      const data = await apiRequest("GET", `/google/auth-url?${params.toString()}`);
      if (data?.url) {
        window.location.href = data.url;
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Google Reconnect Failed",
        description: getApiErrorMessage(error),
      });
    }
  };

  // Import from Google Workspace Directory mutation
  const importDirectoryMutation = useMutation({
    mutationFn: (params) => apiRequest("POST", "/directory/import", {
      orgUnitPath: params.orgUnitPath || undefined,
      gradeLevel: params.gradeLevel || undefined,
      entries: params.entries || undefined,
      importAll: params.importAll || undefined,
    }),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"], exact: false });
      setWorkspaceImportResult(data);
      setGeneratedPins(data.generatedPins || []);
      toast({
        title: "Import Complete",
        description: `Imported ${data.imported} new students, updated ${data.updated} existing`,
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Import Failed",
        description: error.message,
      });
    },
  });

  const allStudents = studentsData?.students || [];
  const activeStudents = allStudents.filter((student) => !student.status || student.status === "active");
  const sharedSignInEnabled = settings?.sharedChromebookSignInEnabled === true;
  const pinLoginStudentsMissingPins = activeStudents.filter((student) => !student.hasClassPilotPin);
  const pinLoginStudentsNeedReset = activeStudents.filter((student) => student.hasClassPilotPin && !student.classpilotPin);
  const pinRosterRows = activeStudents
    .filter((student) => student.classpilotPin)
    .map((student) => ({
      studentId: student.id,
      studentName: student.studentName || "",
      gradeLevel: student.gradeLevel || "",
      pin: student.classpilotPin,
    }))
    .sort((a, b) => {
      const gradeA = normalizeGrade(a.gradeLevel) || "";
      const gradeB = normalizeGrade(b.gradeLevel) || "";
      const byGrade = gradeA.localeCompare(gradeB, undefined, { numeric: true });
      if (byGrade !== 0) return byGrade;
      return a.studentName.localeCompare(b.studentName);
    });

  // All possible grades for the Add Grade dialog (K-12)
  const allPossibleGrades = ["K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];

  // Get grades that have students (from imports)
  const gradesWithStudents = Array.from(
    new Set(
      allStudents
        .map(s => normalizeGrade(s.gradeLevel))
        .filter(g => g !== null)
    )
  );

  // Combine imported grades with manually added grades (unique, sorted)
  const activeGrades = Array.from(new Set([...gradesWithStudents, ...manualGrades])).sort((a, b) => {
    if (a === "K") return -1;
    if (b === "K") return 1;
    return parseInt(a) - parseInt(b);
  });

  // Get student counts per grade for badge display
  const gradeStudentCounts = activeGrades.reduce((acc, grade) => {
    acc[grade] = allStudents.filter(s => normalizeGrade(s.gradeLevel) === grade).length;
    return acc;
  }, {});

  // Count students without a grade assigned
  const studentsWithoutGrade = allStudents.filter(s => normalizeGrade(s.gradeLevel) === null);

  // Filter students by selected grade and search query
  const filteredStudents = allStudents.filter(student => {
    // Grade filter - handle special "__no_grade__" value
    if (selectedGrade === "__no_grade__") {
      if (normalizeGrade(student.gradeLevel) !== null) {
        return false;
      }
    } else if (selectedGrade && normalizeGrade(student.gradeLevel) !== selectedGrade) {
      return false;
    }
    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const nameMatch = student.studentName?.toLowerCase().includes(query);
      const emailMatch = student.studentEmail?.toLowerCase().includes(query);
      return nameMatch || emailMatch;
    }
    return true;
  });

  // Selection helpers
  const isAllSelected = filteredStudents.length > 0 && filteredStudents.every(s => selectedStudents.has(s.id));
  const isSomeSelected = filteredStudents.some(s => selectedStudents.has(s.id));

  const toggleSelectAll = () => {
    if (isAllSelected) {
      // Deselect all filtered students
      const newSelected = new Set(selectedStudents);
      filteredStudents.forEach(s => newSelected.delete(s.id));
      setSelectedStudents(newSelected);
    } else {
      // Select all filtered students
      const newSelected = new Set(selectedStudents);
      filteredStudents.forEach(s => newSelected.add(s.id));
      setSelectedStudents(newSelected);
    }
  };

  const toggleSelectStudent = (studentId) => {
    const newSelected = new Set(selectedStudents);
    if (newSelected.has(studentId)) {
      newSelected.delete(studentId);
    } else {
      newSelected.add(studentId);
    }
    setSelectedStudents(newSelected);
  };

  const clearSelection = () => {
    setSelectedStudents(new Set());
  };

  // Handle adding a new grade category
  const handleAddGrade = (grade) => {
    if (!manualGrades.includes(grade) && !gradesWithStudents.includes(grade)) {
      setManualGrades([...manualGrades, grade]);
    }
    setShowAddGradeDialog(false);
  };

  // Get grades available to add (not already active)
  const availableGradesToAdd = allPossibleGrades.filter(g => !activeGrades.includes(g));

  // Bulk import mutation
  const bulkImportMutation = useMutation({
    mutationFn: async ({ fileContent }) => {
      // Parse CSV client-side into rows array for the backend
      const lines = fileContent.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) throw new Error("CSV must have a header row and at least one data row");
      const headers = lines[0].split(",").map(h => h.trim());
      const rows = lines.slice(1).map(line => {
        const values = line.split(",").map(v => v.trim());
        const row = {};
        headers.forEach((h, i) => { row[h] = values[i] || ""; });
        return row;
      });
      return await apiRequest("POST", "/students/import-csv", { rows });
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"], exact: false });
      await queryClient.invalidateQueries({ queryKey: ["/api/groups"], exact: false });
      await queryClient.invalidateQueries({ queryKey: ["/api/teacher/groups"], exact: false });
      setImportResults(data);
      setGeneratedPins(data.generatedPins || []);
      const errorMsg = data.errors?.length ? `, ${data.errors.length} errors` : "";
      toast({
        title: "Import Complete",
        description: `Imported ${data.imported} of ${data.total} students${errorMsg}`,
      });
      setCsvFile(null);
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Import Failed",
        description: error.message,
      });
    },
  });

  // Delete student mutation
  const deleteStudentMutation = useMutation({
    mutationFn: async (studentId) => {
      return await apiRequest("DELETE", `/students/${studentId}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"] });
      queryClient.invalidateQueries({ queryKey: ["/api/groups"], exact: false });
      toast({
        title: "Student Deleted",
        description: "Student has been removed from the system",
      });
      setDeletingStudent(null);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to delete student",
        variant: "destructive",
      });
    },
  });

  // Bulk delete students mutation
  const bulkDeleteMutation = useMutation({
    mutationFn: async (studentIds) => {
      return await apiRequest("POST", "/admin/students/bulk-delete", { studentIds });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"] });
      queryClient.invalidateQueries({ queryKey: ["/api/groups"], exact: false });
      toast({
        title: "Bulk Delete Complete",
        description: `Deleted ${data.deleted} student${data.deleted !== 1 ? 's' : ''}${data.failed > 0 ? `, ${data.failed} failed` : ''}`,
      });
      setSelectedStudents(new Set());
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to delete students",
        variant: "destructive",
      });
    },
  });

  // Bulk update student grades mutation
  const bulkUpdateGradeMutation = useMutation({
    mutationFn: async ({ studentIds, gradeLevel }) => {
      return await apiRequest("POST", "/admin/students/bulk-update-grade", { studentIds, gradeLevel });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"] });
      queryClient.invalidateQueries({ queryKey: ["/api/groups"], exact: false });
      toast({
        title: "Grade Assignment Complete",
        description: `Updated ${data.updated} student${data.updated !== 1 ? 's' : ''}${data.failed > 0 ? `, ${data.failed} failed` : ''}`,
      });
      setSelectedStudents(new Set());
      setShowBulkGradeDialog(false);
      setBulkGradeLevel("");
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to update student grades",
        variant: "destructive",
      });
    },
  });

  const bulkGeneratePinsMutation = useMutation({
    mutationFn: async (input = {}) => {
      const studentIds = Array.isArray(input) ? input : (input.studentIds || []);
      const gradeLevel = !Array.isArray(input) ? input.gradeLevel : undefined;
      const onlyMissing = !Array.isArray(input) && input.onlyMissing !== undefined
        ? input.onlyMissing
        : false;
      return await apiRequest("POST", "/students/classpilot-pins/bulk-generate", {
        studentIds: studentIds.length ? studentIds : undefined,
        gradeLevel,
        onlyMissing,
      });
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"], exact: false });
      const pins = data.generated || [];
      setGeneratedPins(pins);
      toast({
        title: "ClassPilot PINs generated",
        description: pins.length
          ? `Generated ${pins.length} PIN${pins.length !== 1 ? "s" : ""}. The roster, print sheet, CSV, and Excel export are updated.`
          : "No active students needed new PINs.",
      });
    },
    onError: (error) => {
      toast({
        title: "PIN generation failed",
        description: error.message || "Could not generate ClassPilot PINs",
        variant: "destructive",
      });
    },
  });

  // Add student mutation
  const addStudentMutation = useMutation({
    mutationFn: async (data) => {
      return await apiRequest("POST", "/students", data);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"] });
      setGeneratedPins(data.generatedPins || []);
      toast({
        title: "Student Added",
        description: data.generatedPins?.length
          ? "Student has been added and a ClassPilot PIN was generated"
          : "Student has been added to the roster",
      });
      setShowAddStudentDialog(false);
      setNewStudentName("");
      setNewStudentEmail("");
      setNewStudentGrade("");
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to add student",
        variant: "destructive",
      });
    },
  });

  const handleAddStudent = () => {
    const name = newStudentName.trim();
    const email = newStudentEmail.trim();

    // Validate name
    if (!name) {
      toast({
        title: "Validation Error",
        description: "Student name is required",
        variant: "destructive",
      });
      return;
    }

    // Validate email
    if (!email) {
      toast({
        title: "Validation Error",
        description: "Email address is required",
        variant: "destructive",
      });
      return;
    }

    // Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      toast({
        title: "Validation Error",
        description: "Please enter a valid email address",
        variant: "destructive",
      });
      return;
    }

    // Build mutation data with optional grade
    const mutationData = {
      studentName: name,
      studentEmail: email,
    };

    if (newStudentGrade) {
      mutationData.gradeLevel = newStudentGrade;
    }

    addStudentMutation.mutate(mutationData);
  };

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setCsvFile(file);
      setImportResults(null);
      setGeneratedPins([]);
    }
  };

  const handleBulkImport = async () => {
    if (!csvFile) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Please select a file",
      });
      return;
    }

    try {
      const fileContent = await csvFile.text();
      bulkImportMutation.mutate({ fileContent });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to read file",
      });
    }
  };

  const downloadTemplate = () => {
    const headers = ["Email", "Name", "Grade", "Class", "ClassPilot PIN"];
    const rowOne = ["student@school.edu", "John Doe", "8", "8th Math (sarah)", ""];
    const rowTwo = ["student2@school.edu", "Jane Smith", "2", "2nd Homeroom (lee)", "1234"];

    if (hasGoPilot) {
      headers.push("Dismissal Type", "Bus #");
      rowOne.push("car", "");
      rowTwo.push("bus", "12");
    }

    const template = [headers.join(","), rowOne.join(","), rowTwo.join(",")].join("\n");
    const blob = new Blob([template], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'student_import_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadPinRoster = (rows = pinRosterRows, filename = "classpilot-pin-roster.csv") => {
    if (!rows.length) {
      toast({
        title: "No PINs available",
        description: "Generate or reset PINs before exporting the roster.",
        variant: "destructive",
      });
      return;
    }
    const headers = ["Student Name", "Grade", "ClassPilot PIN"];
    const csvRows = rows.map((pin) => [
      `"${String(pin.studentName || "").replace(/"/g, '""')}"`,
      pin.gradeLevel || "",
      pin.pin,
    ]);
    const csv = [headers.join(","), ...csvRows.map((row) => row.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const printPinRoster = (rowsToPrint = pinRosterRows) => {
    if (!rowsToPrint.length) {
      toast({
        title: "No PINs available",
        description: "Generate or reset PINs before printing the roster.",
        variant: "destructive",
      });
      return;
    }
    const rows = rowsToPrint.map((pin) => `
      <tr>
        <td>${escapeHtml(pin.studentName || "")}</td>
        <td>${escapeHtml(pin.gradeLevel || "")}</td>
        <td class="pin">${escapeHtml(pin.pin || "")}</td>
      </tr>
    `).join("");
    const printWindow = window.open("", "_blank", "noopener,noreferrer");
    if (!printWindow) {
      toast({
        title: "Pop-up blocked",
        description: "Allow pop-ups to print the PIN roster.",
        variant: "destructive",
      });
      return;
    }
    printWindow.document.write(`
      <!doctype html>
      <html>
        <head>
          <title>ClassPilot PIN Roster</title>
          <style>
            body { font-family: Arial, sans-serif; color: #111827; margin: 32px; }
            h1 { font-size: 22px; margin: 0 0 6px; }
            p { margin: 0 0 20px; color: #4b5563; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #d1d5db; padding: 10px 12px; text-align: left; }
            th { background: #f3f4f6; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
            .pin { font-family: "Courier New", monospace; font-size: 18px; font-weight: 700; letter-spacing: .08em; }
          </style>
        </head>
        <body>
          <h1>ClassPilot PIN Roster</h1>
          <p>Admin roster copy for shared Chromebook sign-in.</p>
          <table>
            <thead><tr><th>Student Name</th><th>Grade</th><th>ClassPilot PIN</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  };

  const downloadPinRosterExcel = (rowsToExport = pinRosterRows, filename = "classpilot-pin-roster.xlsx") => {
    if (!rowsToExport.length) {
      toast({
        title: "No PINs available",
        description: "Generate or reset PINs before exporting the roster.",
        variant: "destructive",
      });
      return;
    }
    const rows = [
      ["Student Name", "Grade", "ClassPilot PIN"],
      ...rowsToExport.map((pin) => [pin.studentName || "", pin.gradeLevel || "", pin.pin || ""]),
    ];
    const blob = buildXlsxBlob(rows, "ClassPilot PINs");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleEditSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"] });
    queryClient.invalidateQueries({ queryKey: ["/api/groups"], exact: false });
  };

  return (
    <div className="container mx-auto p-6 max-w-7xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/classpilot/admin")}
            data-testid="button-back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-3xl font-bold">Students</h1>
            <p className="text-muted-foreground">Manage student roster and import students</p>
          </div>
        </div>
        <ThemeToggle />
      </div>

      {/* CSV Import Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            Bulk Import Students
          </CardTitle>
          <CardDescription>
            Upload a CSV (.csv) file to import multiple students at once
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="csv-upload">CSV File</Label>
            <div className="flex gap-2">
              <Input
                id="csv-upload"
                type="file"
                accept=".csv"
                onChange={handleFileUpload}
                data-testid="input-csv-upload"
              />
              <Button
                onClick={handleBulkImport}
                disabled={!csvFile || bulkImportMutation.isPending}
                data-testid="button-import-students"
              >
                <Upload className="h-4 w-4 mr-2" />
                {bulkImportMutation.isPending ? "Importing..." : "Import Students"}
              </Button>
              <Button
                variant="outline"
                onClick={downloadTemplate}
                data-testid="button-download-template"
              >
                <Download className="h-4 w-4 mr-2" />
                Download CSV Template
              </Button>
            </div>
          </div>

          <div className="text-sm text-muted-foreground space-y-1">
            <p className="font-medium">CSV Format:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Required columns: Email, Name</li>
              <li>Optional columns: Grade, Class, ClassPilot PIN</li>
              <li>If ClassPilot PIN is blank, SchoolPilot generates a 4-digit PIN automatically</li>
              {hasGoPilot && <li>GoPilot columns: Dismissal Type and Bus #</li>}
              <li>Class names must match existing classes exactly</li>
              <li>Students with existing emails will be updated</li>
            </ul>
          </div>

          {importResults && (
            <div className="p-4 border rounded-md space-y-2" data-testid="import-results">
              <p className="font-medium">Import Results:</p>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Imported</p>
                  <p className="text-2xl font-bold text-green-600">{importResults.imported}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Total Rows</p>
                  <p className="text-2xl font-bold text-blue-600">{importResults.total}</p>
                </div>
              </div>
              {importResults.errors && importResults.errors.length > 0 && (
                <div className="mt-3 p-3 bg-destructive/10 rounded-md">
                  <p className="font-medium text-destructive mb-2">Errors:</p>
                  <ul className="list-disc list-inside text-sm text-destructive space-y-1">
                    {importResults.errors.map((error, i) => (
                      <li key={i}>Row {error.row}: {error.error}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            ClassPilot Shared Device Readiness
          </CardTitle>
          <CardDescription>
            Shared Chromebook Sign-In uses Grade, Name, and 4-digit PIN when Chrome profile email is not detected.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className={`rounded-md border p-3 ${pinLoginStudentsMissingPins.length || pinLoginStudentsNeedReset.length ? "bg-amber-50 border-amber-200 dark:bg-amber-950/20" : "bg-muted/30"}`}>
            <div className="flex items-start gap-2">
              {(pinLoginStudentsMissingPins.length > 0 || pinLoginStudentsNeedReset.length > 0) && <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5" />}
              <div>
                <p className="text-sm font-medium">PIN readiness</p>
                <p className="text-sm text-muted-foreground">
                  {!sharedSignInEnabled
                    ? "Shared Chromebook Sign-In is disabled in ClassPilot Settings"
                    : pinLoginStudentsMissingPins.length
                      ? `${pinLoginStudentsMissingPins.length} student${pinLoginStudentsMissingPins.length !== 1 ? "s" : ""} missing a 4-digit PIN`
                      : pinLoginStudentsNeedReset.length
                        ? `${pinLoginStudentsNeedReset.length} existing PIN${pinLoginStudentsNeedReset.length !== 1 ? "s" : ""} need to be reset before the number can be shown`
                      : "Ready for Grade, Name, and PIN sign-in"}
                </p>
                {pinLoginStudentsNeedReset.length > 0 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {pinLoginStudentsNeedReset.length} older PIN{pinLoginStudentsNeedReset.length !== 1 ? "s" : ""} must be reset once before the number can be shown.
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={() => bulkGeneratePinsMutation.mutate({ onlyMissing: true })}
              disabled={bulkGeneratePinsMutation.isPending || activeStudents.length === 0}
              data-testid="button-generate-pins"
            >
              {bulkGeneratePinsMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4 mr-2" />
              )}
              Generate Missing PINs
            </Button>
            {selectedGrade && selectedGrade !== "__no_grade__" && (
              <Button
                variant="outline"
                onClick={() => bulkGeneratePinsMutation.mutate({ gradeLevel: selectedGrade, onlyMissing: false })}
                disabled={bulkGeneratePinsMutation.isPending}
                data-testid="button-generate-grade-pins"
              >
                {bulkGeneratePinsMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <KeyRound className="h-4 w-4 mr-2" />
                )}
                Reset Grade {selectedGrade} PINs
              </Button>
            )}
            {pinRosterRows.length > 0 && (
              <>
                <Button
                  variant="outline"
                  onClick={() => printPinRoster(pinRosterRows)}
                  data-testid="button-print-generated-pins"
                >
                  <Printer className="h-4 w-4 mr-2" />
                  Print PIN Roster
                </Button>
                <Button
                  variant="outline"
                  onClick={() => downloadPinRoster(pinRosterRows)}
                  data-testid="button-download-generated-pins"
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download CSV
                </Button>
                <Button
                  variant="outline"
                  onClick={() => downloadPinRosterExcel(pinRosterRows)}
                  data-testid="button-download-generated-pins-excel"
                >
                  <FileSpreadsheet className="h-4 w-4 mr-2" />
                  Download Excel
                </Button>
              </>
            )}
          </div>

          {generatedPins.length > 0 && (
            <div className="rounded-md border p-3 bg-blue-50 dark:bg-blue-950/20" data-testid="generated-pins-panel">
              <p className="text-sm font-medium mb-2">Newly generated/reset PINs</p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {generatedPins.slice(0, 12).map((pin) => (
                  <div key={pin.studentId} className="flex items-center justify-between rounded border bg-background px-3 py-2 text-sm">
                    <span className="truncate">{pin.studentName}</span>
                    <span className="font-mono font-semibold">{pin.pin}</span>
                  </div>
                ))}
              </div>
              {generatedPins.length > 12 && (
                <p className="text-xs text-muted-foreground mt-2">
                  Showing 12 of {generatedPins.length}. Use CSV or Excel export for the full roster.
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-2">
                These PINs also remain visible in the admin roster table for future print and export.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Google Classroom Import Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GraduationCap className="h-5 w-5" />
            Import from Google Classroom
          </CardTitle>
          <CardDescription>
            Sync student rosters directly from your Google Classroom courses
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={() => setShowClassroomDialog(true)}
            data-testid="button-open-classroom-import"
          >
            <GraduationCap className="h-4 w-4 mr-2" />
            Import from Google Classroom
          </Button>
        </CardContent>
      </Card>

      {/* Google Classroom Import Dialog */}
      <Dialog open={showClassroomDialog} onOpenChange={(open) => {
        setShowClassroomDialog(open);
        if (!open) {
          setClassroomImportGrade("");
        }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GraduationCap className="h-5 w-5" />
              Import from Google Classroom
            </DialogTitle>
            <DialogDescription>
              Select a course to import its student roster into ClassPilot
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {isLoadingCourses ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin mr-2" />
                <span className="text-muted-foreground">Loading courses...</span>
              </div>
            ) : classroomNotConnected ? (
              <div className="text-center py-8 space-y-4">
                <p className="text-muted-foreground">
                  Google Classroom is not connected. Please sign out and sign back in with Google,
                  making sure to grant Google Classroom access permissions.
                </p>
                <Button
                  variant="outline"
                  onClick={() => window.location.href = "/api/auth/google?redirect=/classpilot/students"}
                  data-testid="button-reconnect-google"
                >
                  Reconnect Google Account
                </Button>
              </div>
            ) : classroomCourses.length === 0 ? (
              <div className="text-center py-8 space-y-2">
                <p className="text-muted-foreground">No courses found in your Google Classroom account.</p>
                <Button
                  variant="outline"
                  onClick={() => refetchCourses()}
                  data-testid="button-refresh-courses"
                >
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Refresh Courses
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    Found {classroomCourses.length} course{classroomCourses.length !== 1 ? 's' : ''}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => refetchCourses()}
                    data-testid="button-refresh-courses"
                  >
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Refresh
                  </Button>
                </div>

                {/* Grade Level Assignment */}
                <div className="space-y-2">
                  <Label htmlFor="classroom-grade-level">Assign Grade Level (Optional)</Label>
                  <Select
                    value={classroomImportGrade}
                    onValueChange={setClassroomImportGrade}
                  >
                    <SelectTrigger id="classroom-grade-level" data-testid="select-classroom-import-grade">
                      <SelectValue placeholder="No grade assignment" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No grade assignment</SelectItem>
                      <SelectItem value="K">Kindergarten</SelectItem>
                      <SelectItem value="1">Grade 1</SelectItem>
                      <SelectItem value="2">Grade 2</SelectItem>
                      <SelectItem value="3">Grade 3</SelectItem>
                      <SelectItem value="4">Grade 4</SelectItem>
                      <SelectItem value="5">Grade 5</SelectItem>
                      <SelectItem value="6">Grade 6</SelectItem>
                      <SelectItem value="7">Grade 7</SelectItem>
                      <SelectItem value="8">Grade 8</SelectItem>
                      <SelectItem value="9">Grade 9</SelectItem>
                      <SelectItem value="10">Grade 10</SelectItem>
                      <SelectItem value="11">Grade 11</SelectItem>
                      <SelectItem value="12">Grade 12</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    All imported students from the selected course will be assigned to this grade level
                  </p>
                </div>

                <div className="border rounded-md divide-y max-h-72 overflow-auto">
                  {classroomCourses.map((course) => (
                    <div
                      key={course.id}
                      className="flex items-center justify-between p-4 hover-elevate"
                      data-testid={`row-course-${course.id}`}
                    >
                      <div className="space-y-1">
                        <p className="font-medium">{course.name}</p>
                        {course.section && (
                          <p className="text-sm text-muted-foreground">{course.section}</p>
                        )}
                        {course.lastSyncedAt && (
                          <p className="text-xs text-muted-foreground">
                            Last synced: {new Date(course.lastSyncedAt).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                      <Button
                        onClick={() => syncClassroomMutation.mutate({
                          courseId: course.id,
                          gradeLevel: classroomImportGrade && classroomImportGrade !== "__none__" ? classroomImportGrade : undefined,
                        })}
                        disabled={syncingCourseId !== null}
                        data-testid={`button-sync-course-${course.id}`}
                      >
                        {syncingCourseId === course.id ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Importing...
                          </>
                        ) : (
                          <>
                            <Users className="h-4 w-4 mr-2" />
                            Import Students
                          </>
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Google Workspace Import Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            Import from Google Workspace
          </CardTitle>
          <CardDescription>
            Import all students from your school's Google Workspace domain (requires admin access)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={() => setShowWorkspaceDialog(true)}
            data-testid="button-open-workspace-import"
          >
            <Building2 className="h-4 w-4 mr-2" />
            Import from Google Workspace
          </Button>
        </CardContent>
      </Card>

      {/* Google Workspace Import Dialog */}
      <Dialog open={showWorkspaceDialog} onOpenChange={(open) => {
        setShowWorkspaceDialog(open);
        if (!open) {
          setWorkspaceImportResult(null);
          setSelectedOrgUnit("");
          setImportGradeLevel("");
          setCheckedOUs(new Set());
          setOuGradeOverrides({});
          setExpandedOU(null);
          setExcludedEmails({});
        }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" />
              Import from Google Workspace
            </DialogTitle>
            <DialogDescription>
              Import all students from your school's Google Workspace domain
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {isLoadingDirectory || isLoadingOrgUnits ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin mr-2" />
                <span className="text-muted-foreground">Loading users from Google Workspace...</span>
              </div>
            ) : directoryNeedsReconnect ? (
              <div className="text-center py-8 space-y-4">
                <p className="text-muted-foreground">
                  {directoryErrorCode === "GOOGLE_RECONNECT_REQUIRED"
                    ? "Google Workspace needs to be reconnected so SchoolPilot can verify the connected domain."
                    : "Google Workspace is not connected. Connect your Google Workspace admin account to import students."}
                </p>
                <Button
                  variant="outline"
                  onClick={connectGoogleWorkspace}
                  data-testid="button-reconnect-google-workspace"
                >
                  {directoryErrorCode === "GOOGLE_RECONNECT_REQUIRED" ? "Reconnect Google Workspace" : "Connect Google Workspace"}
                </Button>
              </div>
            ) : directoryDomainMismatch ? (
              <div className="text-center py-8 space-y-4">
                <div className="flex items-center justify-center gap-2 text-destructive">
                  <AlertCircle className="h-5 w-5" />
                  <span className="font-medium">Google Workspace Domain Mismatch</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {getApiErrorMessage(directoryError || orgUnitsError)}
                </p>
                <Button
                  variant="outline"
                  onClick={connectGoogleWorkspace}
                  data-testid="button-reconnect-google-workspace-domain"
                >
                  Reconnect Google Workspace
                </Button>
              </div>
            ) : directoryNoPermission ? (
              <div className="text-center py-8 space-y-4">
                <div className="flex items-center justify-center gap-2 text-yellow-600">
                  <AlertCircle className="h-5 w-5" />
                  <span className="font-medium">Admin Access Required</span>
                </div>
                <p className="text-muted-foreground">
                  This feature requires Google Workspace administrator privileges.
                  Your Google account must have admin access to your school's domain to import users directly.
                </p>
                <p className="text-sm text-muted-foreground">
                  Alternatively, use the Google Classroom import or CSV upload options above.
                </p>
              </div>
            ) : directoryUnknownError ? (
              <div className="text-center py-8 space-y-4">
                <div className="flex items-center justify-center gap-2 text-destructive">
                  <AlertCircle className="h-5 w-5" />
                  <span className="font-medium">Google Workspace Import Error</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {getApiErrorMessage(directoryError || orgUnitsError)}
                </p>
              </div>
            ) : workspaceImportResult ? (
              <div className="space-y-4">
                <div className="p-4 border rounded-md space-y-3">
                  <p className="font-medium">Import Results:</p>
                  <div className="grid grid-cols-3 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">Imported</p>
                      <p className="text-2xl font-bold text-green-600">{workspaceImportResult.imported}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Updated</p>
                      <p className="text-2xl font-bold text-blue-600">{workspaceImportResult.updated}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Skipped</p>
                      <p className="text-2xl font-bold text-gray-600">{workspaceImportResult.skipped || 0}</p>
                    </div>
                  </div>
                  {workspaceImportResult.errors?.length > 0 && (
                    <div className="mt-3 p-3 bg-destructive/10 rounded-md">
                      <p className="font-medium text-destructive mb-2">Errors:</p>
                      <ul className="list-disc list-inside text-sm text-destructive space-y-1">
                        {workspaceImportResult.errors.slice(0, 10).map((error, i) => (
                          <li key={i}>{error}</li>
                        ))}
                        {workspaceImportResult.errors.length > 10 && (
                          <li>...and {workspaceImportResult.errors.length - 10} more</li>
                        )}
                      </ul>
                    </div>
                  )}
                </div>
                <div className="flex justify-end">
                  <Button onClick={() => setShowWorkspaceDialog(false)}>
                    Done
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    Found {directoryUsers.length} user{directoryUsers.length !== 1 ? 's' : ''} in your domain
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      refetchDirectory();
                      refetchOrgUnits();
                    }}
                    data-testid="button-refresh-directory"
                  >
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Refresh
                  </Button>
                </div>

                {directoryEmptyDiagnostics && (
                  <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
                    Google returned 0 users
                    {directoryEmptyDiagnostics.domainFallbackAttempted
                      ? ` after checking the Workspace customer and ${directoryEmptyDiagnostics.queriedDomain || "the school domain"}.`
                      : " from the connected Workspace customer."}
                  </div>
                )}

                {expandedOU ? (
                  /* Expanded OU - individual user selection */
                  (() => {
                    const ouUsers = directoryUsers.filter(u => u.orgUnitPath === expandedOU && !u.suspended && !u.isAdmin);
                    const ouExcluded = excludedEmails[expandedOU] || new Set();
                    const ouInfo = orgUnits.find(o => o.orgUnitPath === expandedOU);
                    const gradeVal = ouGradeOverrides[expandedOU] ?? ouInfo?.detectedGrade ?? "";
                    return (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2">
                          <Button variant="ghost" size="sm" onClick={() => setExpandedOU(null)}>
                            <ArrowLeft className="h-4 w-4 mr-1" /> Back to OUs
                          </Button>
                          <span className="font-medium">{ouInfo?.name || expandedOU}</span>
                          <span className="text-xs text-muted-foreground">({ouUsers.length} users)</span>
                        </div>

                        <div className="flex items-center gap-2">
                          <Label className="text-xs whitespace-nowrap">Grade:</Label>
                          <Select
                            value={gradeVal || "__none__"}
                            onValueChange={(v) => setOuGradeOverrides(prev => ({ ...prev, [expandedOU]: v === "__none__" ? "" : v }))}
                          >
                            <SelectTrigger className="w-40 h-8 text-xs">
                              <SelectValue placeholder="No grade" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">No grade</SelectItem>
                              <SelectItem value="PK">Pre-K</SelectItem>
                              <SelectItem value="K">Kindergarten</SelectItem>
                              {[1,2,3,4,5,6,7,8,9,10,11,12].map(g => (
                                <SelectItem key={g} value={String(g)}>Grade {g}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="border rounded-md divide-y max-h-72 overflow-auto">
                          {ouUsers.map((user) => {
                            const isExcluded = ouExcluded.has(user.email.toLowerCase());
                            return (
                              <div
                                key={user.id}
                                className="flex items-center gap-3 p-2 text-sm"
                                data-testid={`row-user-${user.id}`}
                              >
                                <Checkbox
                                  checked={!isExcluded}
                                  onCheckedChange={(checked) => {
                                    setExcludedEmails(prev => {
                                      const set = new Set(prev[expandedOU] || []);
                                      if (checked) set.delete(user.email.toLowerCase());
                                      else set.add(user.email.toLowerCase());
                                      return { ...prev, [expandedOU]: set };
                                    });
                                  }}
                                />
                                <div className="flex-1 min-w-0">
                                  <p className="font-medium truncate">{user.name}</p>
                                  <p className="text-muted-foreground text-xs truncate">{user.email}</p>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()
                ) : (
                  /* OU list with checkboxes */
                  <div className="space-y-3">
                    {isLoadingOrgUnits ? (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        <span className="text-sm text-muted-foreground">Loading organizational units...</span>
                      </div>
                    ) : orgUnitsError ? (
                      <div className="text-center py-4 text-sm text-destructive">
                        Could not load organizational units: {getApiErrorMessage(orgUnitsError)}
                      </div>
                    ) : orgUnits.length === 0 ? (
                      <div className="text-center py-4 text-sm text-muted-foreground">
                        No organizational units found. You can still import all domain users below.
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center justify-between">
                          <Label className="text-sm">Select Organizational Units to Import</Label>
                          <div className="flex gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-xs h-7"
                              onClick={() => setCheckedOUs(new Set(orgUnits.map(o => o.orgUnitPath)))}
                            >
                              Select All
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-xs h-7"
                              onClick={() => setCheckedOUs(new Set())}
                            >
                              Deselect All
                            </Button>
                          </div>
                        </div>

                        <div className="border rounded-md divide-y max-h-72 overflow-auto">
                          {orgUnits.map((ou) => {
                            const ouUsers = directoryUsers.filter(u => u.orgUnitPath === ou.orgUnitPath && !u.suspended && !u.isAdmin);
                            const ouExcluded = excludedEmails[ou.orgUnitPath] || new Set();
                            const effectiveCount = ouUsers.length - ouExcluded.size;
                            const isChecked = checkedOUs.has(ou.orgUnitPath);
                            const gradeVal = ouGradeOverrides[ou.orgUnitPath] ?? ou.detectedGrade ?? "";

                            return (
                              <div key={ou.orgUnitId} className="flex items-center gap-2 p-2 text-sm hover:bg-muted/50">
                                <Checkbox
                                  checked={isChecked}
                                  onCheckedChange={(checked) => {
                                    setCheckedOUs(prev => {
                                      const next = new Set(prev);
                                      if (checked) next.add(ou.orgUnitPath);
                                      else next.delete(ou.orgUnitPath);
                                      return next;
                                    });
                                  }}
                                  data-testid={`checkbox-ou-${ou.orgUnitId}`}
                                />
                                <div className="flex-1 min-w-0">
                                  <span className="font-medium">{ou.name}</span>
                                  <span className="text-xs text-muted-foreground ml-2">
                                    {effectiveCount} user{effectiveCount !== 1 ? 's' : ''}
                                  </span>
                                </div>

                                <Select
                                  value={gradeVal || "__none__"}
                                  onValueChange={(v) => setOuGradeOverrides(prev => ({ ...prev, [ou.orgUnitPath]: v === "__none__" ? "" : v }))}
                                >
                                  <SelectTrigger className="w-28 h-7 text-xs" onClick={(e) => e.stopPropagation()}>
                                    <SelectValue placeholder="Grade" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="__none__">No grade</SelectItem>
                                    <SelectItem value="PK">Pre-K</SelectItem>
                                    <SelectItem value="K">Kindergarten</SelectItem>
                                    {[1,2,3,4,5,6,7,8,9,10,11,12].map(g => (
                                      <SelectItem key={g} value={String(g)}>Grade {g}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>

                                {ou.detectedGrade && !ouGradeOverrides[ou.orgUnitPath] && (
                                  <span className="text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 px-1.5 py-0.5 rounded">
                                    auto
                                  </span>
                                )}

                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 p-0"
                                  onClick={() => setExpandedOU(ou.orgUnitPath)}
                                  title="View individual users"
                                >
                                  <ChevronRight className="h-4 w-4" />
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setShowWorkspaceDialog(false)}>
                    Cancel
                  </Button>
                  {checkedOUs.size > 0 ? (
                    <Button
                      onClick={() => {
                        const entries = Array.from(checkedOUs).map(ouPath => {
                          const ou = orgUnits.find(o => o.orgUnitPath === ouPath);
                          const gradeVal = ouGradeOverrides[ouPath] ?? ou?.detectedGrade ?? "";
                          const ouExcluded = excludedEmails[ouPath];
                          return {
                            orgUnitPath: ouPath,
                            gradeLevel: gradeVal || undefined,
                            excludeEmails: ouExcluded ? Array.from(ouExcluded) : undefined,
                          };
                        });
                        importDirectoryMutation.mutate({ entries });
                      }}
                      disabled={importDirectoryMutation.isPending}
                      data-testid="button-import-workspace-users"
                    >
                      {importDirectoryMutation.isPending ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Importing...
                        </>
                      ) : (
                        <>
                          <Users className="h-4 w-4 mr-2" />
                          Import {checkedOUs.size} OU{checkedOUs.size !== 1 ? 's' : ''} ({(() => {
                            let total = 0;
                            checkedOUs.forEach(ouPath => {
                              const ouUsers = directoryUsers.filter(u => u.orgUnitPath === ouPath && !u.suspended && !u.isAdmin);
                              const ouExcluded = excludedEmails[ouPath] || new Set();
                              total += ouUsers.length - ouExcluded.size;
                            });
                            return total;
                          })()} students)
                        </>
                      )}
                    </Button>
                  ) : (
                    <Button
                      onClick={() => importDirectoryMutation.mutate({
                        importAll: true,
                        gradeLevel: undefined,
                      })}
                      disabled={importDirectoryMutation.isPending || directoryUsers.length === 0}
                      data-testid="button-import-workspace-users"
                    >
                      {importDirectoryMutation.isPending ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Importing...
                        </>
                      ) : (
                        <>
                          <Users className="h-4 w-4 mr-2" />
                          Import All {directoryUsers.length} Students
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Student Roster */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <CardTitle>Current Student Roster</CardTitle>
              <CardDescription>
                {filteredStudents.length} student{filteredStudents.length !== 1 ? 's' : ''}{selectedGrade === "__no_grade__" ? ' without a grade' : selectedGrade ? ` in Grade ${selectedGrade}` : ''}{searchQuery ? ` matching "${searchQuery}"` : ''}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setShowAddGradeDialog(true)}
                disabled={availableGradesToAdd.length === 0}
                data-testid="button-add-grade"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Grade
              </Button>
              <Button
                onClick={() => setShowAddStudentDialog(true)}
                data-testid="button-add-student"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Student
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Grade Filter Buttons - Only show if there are active grades or students without grades */}
          {(activeGrades.length > 0 || studentsWithoutGrade.length > 0) && (
            <div className="space-y-3">
              <Label className="text-sm font-medium">Filter by Grade</Label>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={selectedGrade === "" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSelectedGrade("")}
                  data-testid="button-grade-all"
                >
                  All
                  <span className="ml-1 text-xs opacity-70">({allStudents.length})</span>
                </Button>
                {activeGrades.map((grade) => (
                  <Button
                    key={grade}
                    variant={selectedGrade === grade ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSelectedGrade(grade)}
                    data-testid={`button-grade-${grade}`}
                  >
                    {grade === "K" ? "K" : `${grade}${grade === "1" ? "st" : grade === "2" ? "nd" : grade === "3" ? "rd" : "th"}`}
                    <span className="ml-1 text-xs opacity-70">({gradeStudentCounts[grade] || 0})</span>
                  </Button>
                ))}
                {/* No Grade tab - only shows if there are students without grades */}
                {studentsWithoutGrade.length > 0 && (
                  <Button
                    variant={selectedGrade === "__no_grade__" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSelectedGrade("__no_grade__")}
                    data-testid="button-grade-none"
                  >
                    No Grade
                    <span className="ml-1 text-xs opacity-70">({studentsWithoutGrade.length})</span>
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Search Input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search students by name or email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              data-testid="input-search-students"
            />
          </div>

          {/* Selection Actions Bar */}
          {selectedStudents.size > 0 && (
            <div className="flex items-center justify-between p-3 bg-muted rounded-lg border" data-testid="selection-bar">
              <span className="text-sm font-medium">
                {selectedStudents.size} student{selectedStudents.size !== 1 ? 's' : ''} selected
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={clearSelection}
                  data-testid="button-clear-selection"
                >
                  Clear Selection
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowBulkGradeDialog(true)}
                  disabled={bulkUpdateGradeMutation.isPending}
                  data-testid="button-bulk-assign-grade"
                >
                  <GraduationCap className="h-4 w-4 mr-2" />
                  Assign Grade
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => bulkGeneratePinsMutation.mutate({ studentIds: Array.from(selectedStudents), onlyMissing: false })}
                  disabled={bulkGeneratePinsMutation.isPending}
                  data-testid="button-generate-selected-pins"
                >
                  {bulkGeneratePinsMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <KeyRound className="h-4 w-4 mr-2" />
                  )}
                  Generate PINs
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => bulkDeleteMutation.mutate(Array.from(selectedStudents))}
                  disabled={bulkDeleteMutation.isPending}
                  data-testid="button-bulk-delete"
                >
                  {bulkDeleteMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Deleting...
                    </>
                  ) : (
                    <>
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete Selected
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}

          {/* Student Table */}
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">
              Loading students...
            </div>
          ) : filteredStudents.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {selectedGrade === "__no_grade__"
                ? "No students without a grade assigned"
                : selectedGrade
                  ? `No students found in grade ${selectedGrade}`
                  : "No students found. Import students to get started."}
            </div>
          ) : (
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[50px]">
                      <Checkbox
                        checked={isAllSelected}
                        ref={(el) => {
                          if (el) {
                            el.dataset.state = isSomeSelected && !isAllSelected ? "indeterminate" : isAllSelected ? "checked" : "unchecked";
                          }
                        }}
                        onCheckedChange={toggleSelectAll}
                        aria-label="Select all students"
                        data-testid="checkbox-select-all"
                      />
                    </TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Grade</TableHead>
                    <TableHead>PIN Login</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredStudents.map((student) => (
                    <TableRow
                      key={student.id}
                      data-testid={`row-student-${student.id}`}
                      className={selectedStudents.has(student.id) ? "bg-muted/50" : ""}
                    >
                      <TableCell>
                        <Checkbox
                          checked={selectedStudents.has(student.id)}
                          onCheckedChange={() => toggleSelectStudent(student.id)}
                          aria-label={`Select ${student.studentName}`}
                          data-testid={`checkbox-student-${student.id}`}
                        />
                      </TableCell>
                      <TableCell className="font-medium">{student.studentName}</TableCell>
                      <TableCell>{student.studentEmail}</TableCell>
                      <TableCell>
                        {student.gradeLevel ? `Grade ${student.gradeLevel}` : '-'}
                      </TableCell>
                      <TableCell>
                        {student.classpilotPin ? (
                          <span className="font-mono font-semibold text-green-700 dark:text-green-400">
                            {student.classpilotPin}
                          </span>
                        ) : student.hasClassPilotPin ? (
                          <span className="text-amber-700 dark:text-amber-400">Reset to view</span>
                        ) : (
                          <span className="text-amber-700 dark:text-amber-400">Missing</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setEditingStudent(student)}
                            data-testid={`button-edit-${student.id}`}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setDeletingStudent(student)}
                            data-testid={`button-delete-${student.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit Student Dialog */}
      {editingStudent && (
        <EditStudentDialog
          student={editingStudent}
          open={!!editingStudent}
          onOpenChange={(open) => !open && setEditingStudent(null)}
          onSuccess={handleEditSuccess}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deletingStudent} onOpenChange={(open) => !open && setDeletingStudent(null)}>
        <AlertDialogContent data-testid="dialog-delete-student">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Student?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{deletingStudent?.studentName}</strong>?
              This will remove them from all classes and delete their activity history.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingStudent && deleteStudentMutation.mutate(deletingStudent.id)}
              disabled={deleteStudentMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteStudentMutation.isPending ? "Deleting..." : "Delete Student"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add Student Dialog */}
      <Dialog open={showAddStudentDialog} onOpenChange={(open) => {
        setShowAddStudentDialog(open);
        if (!open) {
          setNewStudentName("");
          setNewStudentEmail("");
          setNewStudentGrade("");
        }
      }}>
        <DialogContent data-testid="dialog-add-student">
          <DialogHeader>
            <DialogTitle>Add New Student</DialogTitle>
            <DialogDescription>
              Manually add a student to your school roster
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label htmlFor="studentName">Student Name *</Label>
              <Input
                id="studentName"
                placeholder="Enter student's full name"
                value={newStudentName}
                onChange={(e) => setNewStudentName(e.target.value)}
                data-testid="input-new-student-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="studentEmail">Email Address *</Label>
              <Input
                id="studentEmail"
                type="email"
                placeholder="student@school.edu"
                value={newStudentEmail}
                onChange={(e) => setNewStudentEmail(e.target.value)}
                data-testid="input-new-student-email"
              />
            </div>
            <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
              A 4-digit ClassPilot PIN will be generated after the student is added.
            </div>
            <div className="space-y-2">
              <Label htmlFor="gradeLevel">Grade Level</Label>
              <div className="flex flex-wrap gap-2">
                {allPossibleGrades.map((grade) => (
                  <Button
                    key={grade}
                    type="button"
                    variant={newStudentGrade === grade ? "default" : "outline"}
                    size="sm"
                    onClick={() => setNewStudentGrade(grade)}
                    data-testid={`button-select-grade-${grade}`}
                  >
                    {grade === "K" ? "K" : `${grade}${grade === "1" ? "st" : grade === "2" ? "nd" : grade === "3" ? "rd" : "th"}`}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={() => setShowAddStudentDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleAddStudent}
                disabled={addStudentMutation.isPending || !newStudentName.trim() || !newStudentEmail.trim()}
                data-testid="button-submit-add-student"
              >
                {addStudentMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Adding...
                  </>
                ) : (
                  <>
                    <Plus className="h-4 w-4 mr-2" />
                    Add Student
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Grade Dialog */}
      <Dialog open={showAddGradeDialog} onOpenChange={setShowAddGradeDialog}>
        <DialogContent data-testid="dialog-add-grade">
          <DialogHeader>
            <DialogTitle>Add Grade Level</DialogTitle>
            <DialogDescription>
              Select a grade level to add to your roster. Students can then be assigned to this grade.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div className="grid grid-cols-4 gap-2">
              {availableGradesToAdd.map((grade) => (
                <Button
                  key={grade}
                  variant="outline"
                  onClick={() => handleAddGrade(grade)}
                  data-testid={`button-add-grade-${grade}`}
                  className="h-12"
                >
                  {grade === "K" ? "Kindergarten" : `${grade}${grade === "1" ? "st" : grade === "2" ? "nd" : grade === "3" ? "rd" : "th"} Grade`}
                </Button>
              ))}
            </div>
            {availableGradesToAdd.length === 0 && (
              <p className="text-center text-muted-foreground">All grade levels have been added.</p>
            )}
            <div className="flex justify-end">
              <Button variant="outline" onClick={() => setShowAddGradeDialog(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Assign Grade Dialog */}
      <Dialog open={showBulkGradeDialog} onOpenChange={(open) => {
        setShowBulkGradeDialog(open);
        if (!open) setBulkGradeLevel("");
      }}>
        <DialogContent data-testid="dialog-bulk-assign-grade">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GraduationCap className="h-5 w-5" />
              Assign Grade to Students
            </DialogTitle>
            <DialogDescription>
              Assign a grade level to {selectedStudents.size} selected student{selectedStudents.size !== 1 ? 's' : ''}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label htmlFor="bulk-grade-select">Grade Level</Label>
              <Select value={bulkGradeLevel} onValueChange={setBulkGradeLevel}>
                <SelectTrigger id="bulk-grade-select" data-testid="select-bulk-grade">
                  <SelectValue placeholder="Select a grade" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="K">Kindergarten</SelectItem>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((g) => (
                    <SelectItem key={g} value={String(g)}>
                      {g}{g === 1 ? "st" : g === 2 ? "nd" : g === 3 ? "rd" : "th"} Grade
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowBulkGradeDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => bulkUpdateGradeMutation.mutate({
                  studentIds: Array.from(selectedStudents),
                  gradeLevel: bulkGradeLevel,
                })}
                disabled={!bulkGradeLevel || bulkUpdateGradeMutation.isPending}
                data-testid="button-confirm-bulk-grade"
              >
                {bulkUpdateGradeMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Assigning...
                  </>
                ) : (
                  `Assign to ${selectedStudents.size} Student${selectedStudents.size !== 1 ? 's' : ''}`
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
