import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { Button } from "../../../../components/ui/button";
import { Input } from "../../../../components/ui/input";
import { Label } from "../../../../components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../../../../components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../../components/ui/select";
import { useToast } from "../../../../hooks/use-toast";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "../../../../lib/queryClient";
import { usePassPilotAuth } from "../../../../hooks/usePassPilotAuth";
import { Trash2, Edit, Plus, Users, Eye } from "lucide-react";
import ImportInClassPilotNotice from "../../../../shared/components/ImportInClassPilotNotice";
import { useStudentImportHome } from "../../../../shared/hooks/useStudentImportHome";
import CanonicalClassesView from "../CanonicalClassesView";
import {
  addStudentsToPassPilotClass,
  isCanonicalPassPilotSource,
  PASSPILOT_CLASSES_QUERY_KEY,
  passPilotClassRosterQueryKey,
  removeStudentFromPassPilotClass,
  useCanonicalPassPilotClasses,
  usePassPilotClassRoster,
} from "../../classData";

const GRADE_LEVELS = ['K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
const EMPTY_STUDENTS = Object.freeze([]);
const NO_GRADE_FILTER = "__no_grade__";
const MAX_ASSIGNMENT_SIZE = 1000;

function getStudentGradeFilterValue(student) {
  const gradeLevel = String(student?.gradeLevel ?? "").trim();
  return gradeLevel || NO_GRADE_FILTER;
}

function formatGradeFilterLabel(gradeLevel) {
  if (gradeLevel === NO_GRADE_FILTER) return "No grade";
  if (gradeLevel === "K") return "Kindergarten";
  return `Grade ${gradeLevel}`;
}

function compareGradeLevels(left, right) {
  if (left === NO_GRADE_FILTER) return 1;
  if (right === NO_GRADE_FILTER) return -1;
  const leftIndex = GRADE_LEVELS.indexOf(left);
  const rightIndex = GRADE_LEVELS.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) {
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  }
  return left.localeCompare(right, undefined, { numeric: true });
}

function getStudentDisplayName(student) {
  return student?.name || `${student?.firstName ?? ""} ${student?.lastName ?? ""}`.trim();
}

function getApiErrorMessage(error, fallback = "Request failed") {
  const responseError = error?.response?.data?.error;
  const responseCode = error?.response?.data?.code;
  if (responseError && responseCode) return `${responseError} (${responseCode})`;
  return responseError || responseCode || error?.message || fallback;
}

function LegacyRosterTab({ classRecords }) {
  const { isAdmin } = usePassPilotAuth();
  const navigate = useNavigate();
  const {
    consolidated: classPilotOwnsStudentIdentities,
    canLinkToClassPilot,
    importPath,
  } = useStudentImportHome();
  // This component is rendered only while the persisted PassPilot class
  // source is legacy_grades. ClassPilot licensing owns student identities,
  // while this legacy PassPilot source still owns class membership.
  const [showAddStudentModal, setShowAddStudentModal] = useState(false);
  const [showBulkAddStudentsModal, setShowBulkAddStudentsModal] = useState(false);
  const [showAddClassModal, setShowAddClassModal] = useState(false);
  const [showViewGradeModal, setShowViewGradeModal] = useState(false);
  const [editingStudent, setEditingStudent] = useState(null);
  const [editingGrade, setEditingGrade] = useState(null);
  const [viewingGrade, setViewingGrade] = useState(null);
  const [assigningGrade, setAssigningGrade] = useState(null);
  const [assignSelected, setAssignSelected] = useState(new Set());
  const [assignSearch, setAssignSearch] = useState("");
  const [assignGradeLevel, setAssignGradeLevel] = useState("");
  const [bulkGrade, setBulkGrade] = useState('');
  const [bulkGradeLevel, setBulkGradeLevel] = useState('');
  const [newClassName, setNewClassName] = useState('');
  const [studentForm, setStudentForm] = useState({
    name: '',
    grade: '',
    studentId: '',
    gradeLevel: ''
  });
  const [gradeForm, setGradeForm] = useState({
    name: ''
  });
  const [bulkStudentNames, setBulkStudentNames] = useState('');

  const { toast } = useToast();

  // The normalized class inventory already applies manager/teacher visibility.
  const myClasses = classRecords;

  // Available classes for "Add Class" dialog (teachers only)
  const { data: availableClasses = [] } = useQuery({
    queryKey: ['available-classes'],
    queryFn: async () => {
      try { return await apiRequest('GET', '/grades/available'); } catch { return []; }
    },
    select: (data) => Array.isArray(data) ? data : (data?.grades ?? []),
    enabled: !isAdmin,
  });

  const studentsQuery = useQuery({
    queryKey: ['/api/students'],
    queryFn: () => apiRequest('GET', '/students'),
    select: (data) => Array.isArray(data) ? data : (data?.students ?? []),
  });
  const students = studentsQuery.data ?? EMPTY_STUDENTS;

  const rosterClassId = assigningGrade?.id || (showViewGradeModal ? viewingGrade?.id : "");
  const classRosterQuery = usePassPilotClassRoster(
    rosterClassId,
    !!assigningGrade || (showViewGradeModal && !!viewingGrade),
  );
  const classRoster = classRosterQuery.data ?? EMPTY_STUDENTS;
  const assignableStudents = useMemo(() => {
    const currentRosterIds = new Set(classRoster.map((student) => student.id));
    return students.filter((student) => !currentRosterIds.has(student.id));
  }, [classRoster, students]);
  const assignableStudentIds = useMemo(
    () => new Set(assignableStudents.map((student) => student.id)),
    [assignableStudents],
  );
  const selectedAssignableStudentIds = useMemo(
    () => [...assignSelected].filter((studentId) => assignableStudentIds.has(studentId)),
    [assignSelected, assignableStudentIds],
  );
  const assignGradeOptions = useMemo(() => {
    const counts = new Map();
    for (const student of assignableStudents) {
      const gradeLevel = getStudentGradeFilterValue(student);
      counts.set(gradeLevel, (counts.get(gradeLevel) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([left], [right]) => compareGradeLevels(left, right))
      .map(([value, count]) => ({ value, count, label: formatGradeFilterLabel(value) }));
  }, [assignableStudents]);
  const visibleAssignableStudents = useMemo(() => {
    const query = assignSearch.trim().toLowerCase();
    return assignableStudents
      .filter((student) => !assignGradeLevel || getStudentGradeFilterValue(student) === assignGradeLevel)
      .filter((student) => !query || getStudentDisplayName(student).toLowerCase().includes(query))
      .sort((left, right) => getStudentDisplayName(left).localeCompare(getStudentDisplayName(right)));
  }, [assignGradeLevel, assignSearch, assignableStudents]);
  const allVisibleSelected = visibleAssignableStudents.length > 0
    && visibleAssignableStudents.every((student) => assignSelected.has(student.id));
  const unselectedVisibleCount = visibleAssignableStudents.reduce(
    (count, student) => count + (assignSelected.has(student.id) ? 0 : 1),
    0,
  );
  const selectAllWouldExceedLimit = !allVisibleSelected
    && selectedAssignableStudentIds.length + unselectedVisibleCount > MAX_ASSIGNMENT_SIZE;

  const isLoading = studentsQuery.isLoading;

  const openAssignStudents = (grade, closeRoster = false) => {
    void Promise.all([
      studentsQuery.refetch(),
      queryClient.invalidateQueries({
        queryKey: passPilotClassRosterQueryKey(grade.id),
        exact: true,
      }),
    ]);
    setAssigningGrade(grade);
    setAssignSelected(new Set());
    setAssignSearch("");
    setAssignGradeLevel("");
    if (closeRoster) setShowViewGradeModal(false);
  };

  const assignStudents = useMutation({
    mutationFn: ({ classId, studentIds }) => addStudentsToPassPilotClass(classId, studentIds),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: PASSPILOT_CLASSES_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: passPilotClassRosterQueryKey(variables.classId) });
      setAssigningGrade(null);
      setAssignSelected(new Set());
      setAssignSearch("");
      setAssignGradeLevel("");
      toast({ title: "Students assigned" });
    },
    onError: (error) => toast({
      title: "Students weren’t assigned",
      description: getApiErrorMessage(error, "Students could not be assigned"),
      variant: "destructive",
    }),
  });

  const unassignStudent = useMutation({
    mutationFn: ({ classId, studentId }) => removeStudentFromPassPilotClass(classId, studentId),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: PASSPILOT_CLASSES_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: passPilotClassRosterQueryKey(variables.classId) });
      toast({ title: "Student removed from class" });
    },
    onError: (error) => toast({
      title: "Student wasn’t removed",
      description: getApiErrorMessage(error, "Student could not be removed from this class"),
      variant: "destructive",
    }),
  });

  const handleAssignClass = async (gradeId) => {
    try {
      await apiRequest('POST', '/teacher-grades/self-assign', { gradeId });
      queryClient.invalidateQueries({ queryKey: ['my-classes'] });
      queryClient.invalidateQueries({ queryKey: ['available-classes'] });
      queryClient.invalidateQueries({ queryKey: PASSPILOT_CLASSES_QUERY_KEY });
      toast({ title: "Class added", description: "Class has been added to your list." });
    } catch (error) {
      toast({ title: "Error", description: getApiErrorMessage(error), variant: "destructive" });
    }
  };

  const handleCreateAndAssignClass = async (e) => {
    e.preventDefault();
    if (!newClassName.trim()) {
      toast({ title: "Missing Information", description: "Please enter a class name.", variant: "destructive" });
      return;
    }

    try {
      const newGrade = await apiRequest('POST', '/grades', { name: newClassName.trim() });
      if (!isAdmin) {
        await apiRequest('POST', '/teacher-grades/self-assign', { gradeId: newGrade.id });
      }
      queryClient.invalidateQueries({ queryKey: ['my-classes'] });
      queryClient.invalidateQueries({ queryKey: ['available-classes'] });
      queryClient.invalidateQueries({ queryKey: ['/api/grades'] });
      queryClient.invalidateQueries({ queryKey: PASSPILOT_CLASSES_QUERY_KEY });
      setNewClassName('');
      setShowAddClassModal(false);
      toast({ title: "Class created", description: `${newClassName.trim()} has been created and added.` });
    } catch (error) {
      toast({ title: "Error", description: getApiErrorMessage(error), variant: "destructive" });
    }
  };

  const handleEditGrade = (grade) => {
    setEditingGrade(grade);
    setGradeForm({ name: grade.name });
  };

  const handleUpdateGrade = async (e) => {
    e.preventDefault();
    if (!gradeForm.name || !editingGrade) return;

    try {
      await apiRequest('PUT', `/grades/${editingGrade.id}`, gradeForm);
      queryClient.invalidateQueries({ queryKey: ['my-classes'] });
      queryClient.invalidateQueries({ queryKey: ['/api/grades'] });
      queryClient.invalidateQueries({ queryKey: PASSPILOT_CLASSES_QUERY_KEY });
      setGradeForm({ name: '' });
      setEditingGrade(null);
      toast({ title: "Class updated", description: `Class has been updated to ${gradeForm.name}.` });
    } catch (error) {
      toast({ title: "Error", description: getApiErrorMessage(error), variant: "destructive" });
    }
  };

  const handleDeleteGrade = async (gradeId, gradeName) => {
    if (!confirm(`Are you sure you want to delete "${gradeName}"? This will also delete all students in this class.`)) return;

    try {
      await apiRequest('DELETE', `/grades/${gradeId}`, {});
      queryClient.invalidateQueries({ queryKey: ['my-classes'] });
      queryClient.invalidateQueries({ queryKey: ['/api/grades'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      queryClient.invalidateQueries({ queryKey: ['available-classes'] });
      queryClient.invalidateQueries({ queryKey: PASSPILOT_CLASSES_QUERY_KEY });
      toast({ title: "Class deleted", description: `${gradeName} has been deleted.` });
    } catch (error) {
      toast({ title: "Error", description: getApiErrorMessage(error), variant: "destructive" });
    }
  };

  const handleAddStudent = async (e) => {
    e.preventDefault();
    if (!studentForm.name || !studentForm.grade) {
      toast({ title: "Missing Information", description: "Please enter student name and select a class.", variant: "destructive" });
      return;
    }

    try {
      await apiRequest('POST', '/students', {
        name: studentForm.name,
        gradeId: studentForm.grade,
        studentIdNumber: studentForm.studentId || undefined,
        gradeLevel: studentForm.gradeLevel || undefined
      });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      queryClient.invalidateQueries({ queryKey: PASSPILOT_CLASSES_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: passPilotClassRosterQueryKey(studentForm.grade) });
      setStudentForm({ name: '', grade: '', studentId: '', gradeLevel: '' });
      setShowAddStudentModal(false);
      toast({ title: "Student added", description: `${studentForm.name} has been added.` });
    } catch (error) {
      toast({ title: "Error", description: getApiErrorMessage(error), variant: "destructive" });
    }
  };

  const handleBulkAddStudents = async (e) => {
    e.preventDefault();
    if (!bulkStudentNames.trim() || !bulkGrade) {
      toast({ title: "Missing Information", description: "Please enter student names and select a class.", variant: "destructive" });
      return;
    }

    const lines = bulkStudentNames.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    if (lines.length === 0) return;

    try {
      const promises = lines.map(line => {
        let cleanLine = line
          .replace(/^\d+\.\s*/, '')
          .replace(/^\d+\)\s*/, '')
          .replace(/^\d+\s*-\s*/, '')
          .replace(/^-\s*/, '')
          .replace(/^\*\s*/, '')
          .replace(/,.*$/, '')
          .replace(/\s*\(.*?\)\s*/g, ' ')
          .replace(/\s*\[.*?\]\s*/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        if (!cleanLine) cleanLine = line.trim();

        return apiRequest('POST', '/students', {
          name: cleanLine,
          gradeId: bulkGrade,
          gradeLevel: bulkGradeLevel || undefined
        });
      });

      await Promise.all(promises);
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      queryClient.invalidateQueries({ queryKey: PASSPILOT_CLASSES_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: passPilotClassRosterQueryKey(bulkGrade) });
      setBulkStudentNames('');
      setBulkGrade('');
      setBulkGradeLevel('');
      setShowBulkAddStudentsModal(false);
      toast({ title: "Students added", description: `${lines.length} student${lines.length !== 1 ? 's' : ''} have been added.` });
    } catch (error) {
      toast({ title: "Error", description: getApiErrorMessage(error), variant: "destructive" });
    }
  };

  const handleEditStudent = (student) => {
    setEditingStudent(student);
    const fullName = student.name || `${student.firstName || ''} ${student.lastName || ''}`.trim();
    setStudentForm({
      name: fullName,
      grade: '',
      studentId: student.studentIdNumber || '',
      gradeLevel: student.gradeLevel || ''
    });
  };

  const handleUpdateStudent = async (e) => {
    e.preventDefault();
    if (!studentForm.name || !editingStudent) return;

    try {
      await apiRequest('PUT', `/students/${editingStudent.id}`, {
        name: studentForm.name,
        studentIdNumber: studentForm.studentId || undefined,
        gradeLevel: studentForm.gradeLevel || undefined
      });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      setStudentForm({ name: '', grade: '', studentId: '', gradeLevel: '' });
      setEditingStudent(null);
      toast({ title: "Student updated", description: `${studentForm.name} has been updated.` });
    } catch (error) {
      toast({ title: "Error", description: getApiErrorMessage(error), variant: "destructive" });
    }
  };

  const getInitials = (student) => {
    const firstName = student.firstName || '';
    const lastName = student.lastName || '';
    return (firstName[0] || '') + (lastName[0] || '').toUpperCase();
  };

  const getAvatarColor = (student) => {
    const colors = [
      'bg-blue-100 text-blue-600',
      'bg-pink-100 text-pink-600',
      'bg-green-100 text-green-600',
      'bg-purple-100 text-purple-600',
      'bg-yellow-100 text-yellow-600',
      'bg-red-100 text-red-600'
    ];
    const fullName = (student.firstName || '') + (student.lastName || '');
    const index = fullName.length % colors.length;
    return colors[index];
  };

  if (isLoading) {
    return (
      <div className="p-4">
        <div className="animate-pulse space-y-4">
          <div className="h-4 bg-muted rounded w-1/4"></div>
          <div className="h-20 bg-muted rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4">
      {classPilotOwnsStudentIdentities && (
        <div className="mb-4">
          <ImportInClassPilotNotice
            canLink={isAdmin && canLinkToClassPilot}
            onGoToClassPilot={() => navigate(importPath)}
            unavailableMessage={isAdmin
              ? "Open ClassPilot on the web to import students."
              : "Ask a school administrator to manage student records in ClassPilot."}
          />
        </div>
      )}

      <div className="mb-6">
        <h2 className="text-xl font-semibold text-foreground mb-2">My Classes</h2>
        <p className="text-sm text-muted-foreground">
          Manage your classes and students.
        </p>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              Classes
            </CardTitle>
            <Dialog open={showAddClassModal} onOpenChange={setShowAddClassModal}>
              <DialogTrigger asChild>
                <Button size="sm" data-testid="button-add-class">
                  <Plus className="w-4 h-4 mr-2" />
                  Add Class
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Class</DialogTitle>
                </DialogHeader>
                <div className="space-y-6">
                  {/* Available classes from the bank (teachers only) */}
                  {!isAdmin && availableClasses.length > 0 && (
                    <div>
                      <Label className="text-sm font-medium">Available Classes</Label>
                      <div className="mt-2 space-y-2 max-h-48 overflow-y-auto">
                        {availableClasses.map((cls) => (
                          <div key={cls.id} className="flex items-center justify-between p-2 bg-muted/30 rounded-lg">
                            <span className="text-sm font-medium">{cls.name}</span>
                            <Button size="sm" onClick={() => handleAssignClass(cls.id)}>Add</Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Create new class */}
                  <div>
                    <Label className="text-sm font-medium">Create New Class</Label>
                    <form onSubmit={handleCreateAndAssignClass} className="mt-2 space-y-3">
                      <Input
                        value={newClassName}
                        onChange={(e) => setNewClassName(e.target.value)}
                        placeholder="Enter class name"
                        data-testid="input-new-class-name"
                      />
                      <div className="flex justify-end space-x-2">
                        <Button type="button" variant="outline" onClick={() => setShowAddClassModal(false)}>Cancel</Button>
                        <Button type="submit" data-testid="button-create-class">Create Class</Button>
                      </div>
                    </form>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          {myClasses.length === 0 ? (
            <p className="text-center text-muted-foreground py-4">
              No classes yet. Add a class to get started.
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {myClasses.map((grade) => (
                  <Card
                    key={grade.id}
                    className="hover:shadow-md transition-all"
                    data-testid={`card-grade-${grade.name}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="font-semibold">{grade.name}</h3>
                        <div className="flex items-center space-x-1">
                          <Button size="sm" variant="ghost" onClick={() => { setViewingGrade(grade); setShowViewGradeModal(true); }} className="h-6 w-6 p-0" aria-label={`View ${grade.name} roster`}>
                            <Eye className="h-3 w-3" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => handleEditGrade(grade)} className="h-6 w-6 p-0" aria-label={`Edit ${grade.name}`}>
                            <Edit className="h-3 w-3" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => handleDeleteGrade(grade.id, grade.name)} className="h-6 w-6 p-0 hover:text-red-600" aria-label={`Delete ${grade.name}`}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {grade.studentCount} student{grade.studentCount !== 1 ? 's' : ''}
                      </p>
                      <div className="flex gap-1 mt-2">
                        {!classPilotOwnsStudentIdentities && (
                          <>
                          <Button size="sm" variant="outline" onClick={() => { setStudentForm({ name: '', grade: grade.id, studentId: '', gradeLevel: '' }); setShowAddStudentModal(true); }} className="h-6 text-xs px-2">
                            Add Student
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => { setBulkGrade(grade.id); setBulkGradeLevel(''); setShowBulkAddStudentsModal(true); }} className="h-6 text-xs px-2">
                            Bulk Add
                          </Button>
                          </>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openAssignStudents(grade)}
                          className="h-6 text-xs px-2"
                        >
                          Assign existing students
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Student Dialog */}
      <Dialog open={!classPilotOwnsStudentIdentities && showAddStudentModal} onOpenChange={setShowAddStudentModal}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add New Student</DialogTitle></DialogHeader>
          <form onSubmit={handleAddStudent} className="space-y-4">
            <div>
              <Label htmlFor="studentName">Student Name</Label>
              <Input id="studentName" value={studentForm.name} onChange={(e) => setStudentForm({ ...studentForm, name: e.target.value })} placeholder="Enter student name" />
            </div>
            <div>
              <Label htmlFor="studentGrade">Class</Label>
              <Select value={studentForm.grade} onValueChange={(value) => setStudentForm({ ...studentForm, grade: value })}>
                <SelectTrigger><SelectValue placeholder="Select a class" /></SelectTrigger>
                <SelectContent>
                  {myClasses.map((grade) => (
                    <SelectItem key={grade.id} value={grade.id}>{grade.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="studentGradeLevel">Grade Level</Label>
              <Select value={studentForm.gradeLevel} onValueChange={(value) => setStudentForm({ ...studentForm, gradeLevel: value })}>
                <SelectTrigger><SelectValue placeholder="Select grade level" /></SelectTrigger>
                <SelectContent>
                  {GRADE_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>{level}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="studentId">Student ID (Optional)</Label>
              <Input id="studentId" value={studentForm.studentId} onChange={(e) => setStudentForm({ ...studentForm, studentId: e.target.value })} placeholder="Enter student ID" />
            </div>
            <div className="flex justify-end space-x-2">
              <Button type="button" variant="outline" onClick={() => setShowAddStudentModal(false)}>Cancel</Button>
              <Button type="submit">Add Student</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Bulk Add Students Dialog */}
      <Dialog open={!classPilotOwnsStudentIdentities && showBulkAddStudentsModal} onOpenChange={setShowBulkAddStudentsModal}>
        <DialogContent>
          <DialogHeader><DialogTitle>Bulk Add Students</DialogTitle></DialogHeader>
          <form onSubmit={handleBulkAddStudents} className="space-y-4">
            <div>
              <Label htmlFor="bulkGrade">Class</Label>
              <Select value={bulkGrade} onValueChange={setBulkGrade}>
                <SelectTrigger><SelectValue placeholder="Select a class" /></SelectTrigger>
                <SelectContent>
                  {myClasses.map((grade) => (
                    <SelectItem key={grade.id} value={grade.id}>{grade.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="bulkGradeLevel">Grade Level</Label>
              <Select value={bulkGradeLevel} onValueChange={setBulkGradeLevel}>
                <SelectTrigger><SelectValue placeholder="Select grade level" /></SelectTrigger>
                <SelectContent>
                  {GRADE_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>{level}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="bulkStudentNames">Student Information (one per line)</Label>
              <textarea
                id="bulkStudentNames"
                value={bulkStudentNames}
                onChange={(e) => setBulkStudentNames(e.target.value)}
                placeholder={"Paste any student information, one per line:\nJohn Smith\n1. Jane Doe\nAlex Johnson"}
                className="w-full h-32 p-3 border rounded-md resize-none"
              />
              <p className="text-sm text-muted-foreground mt-1">
                Paste any student information - names will be extracted automatically.
              </p>
            </div>
            <div className="flex justify-end space-x-2">
              <Button type="button" variant="outline" onClick={() => setShowBulkAddStudentsModal(false)}>Cancel</Button>
              <Button type="submit">Add Students</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Assign existing students without removing other class memberships */}
      <Dialog
        open={!!assigningGrade}
        onOpenChange={(open) => {
          if (!open) {
            setAssigningGrade(null);
            setAssignSelected(new Set());
            setAssignSearch("");
            setAssignGradeLevel("");
          }
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
          <DialogHeader><DialogTitle>Assign existing students to {assigningGrade?.name}</DialogTitle></DialogHeader>
          {studentsQuery.isFetching || classRosterQuery.isFetching ? (
            <p className="py-8 text-center text-sm text-muted-foreground" aria-live="polite">Loading students…</p>
          ) : studentsQuery.isError || classRosterQuery.isError ? (
            <div className="py-8 text-center" role="alert">
              <p className="text-sm font-medium">Students couldn’t be loaded.</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => {
                  void Promise.all([studentsQuery.refetch(), classRosterQuery.refetch()]);
                }}
              >
                Retry
              </Button>
            </div>
          ) : assignableStudents.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Every active student is already in {assigningGrade?.name}.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                Students can belong to multiple classes. Adding them here won’t remove them from another class.
              </p>
              <div className="space-y-2">
                <p className="text-sm font-medium">Filter by grade</p>
                <div className="flex flex-wrap gap-1" role="group" aria-label="Filter students by grade">
                  <Button
                    type="button"
                    size="sm"
                    variant={assignGradeLevel === "" ? "default" : "outline"}
                    className="h-7 rounded-full px-3 text-xs"
                    aria-pressed={assignGradeLevel === ""}
                    onClick={() => setAssignGradeLevel("")}
                  >
                    All ({assignableStudents.length})
                  </Button>
                  {assignGradeOptions.map((grade) => (
                    <Button
                      key={grade.value}
                      type="button"
                      size="sm"
                      variant={assignGradeLevel === grade.value ? "default" : "outline"}
                      className="h-7 rounded-full px-3 text-xs"
                      aria-pressed={assignGradeLevel === grade.value}
                      onClick={() => setAssignGradeLevel(grade.value)}
                    >
                      {grade.label} ({grade.count})
                    </Button>
                  ))}
                </div>
              </div>
              <Label htmlFor="assign-student-search" className="sr-only">Search students</Label>
              <Input
                id="assign-student-search"
                value={assignSearch}
                onChange={(event) => setAssignSearch(event.target.value)}
                placeholder="Search students..."
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground" aria-live="polite">
                  {visibleAssignableStudents.length} student{visibleAssignableStudents.length === 1 ? "" : "s"} shown · {selectedAssignableStudentIds.length} selected
                </p>
                <div className="flex flex-wrap gap-1">
                  {selectedAssignableStudentIds.length > 0 ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      onClick={() => setAssignSelected(new Set())}
                    >
                      Clear selection
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={visibleAssignableStudents.length === 0 || selectAllWouldExceedLimit}
                    onClick={() => {
                      setAssignSelected((previous) => {
                        const next = new Set(
                          [...previous].filter((studentId) => assignableStudentIds.has(studentId)),
                        );
                        for (const student of visibleAssignableStudents) {
                          if (allVisibleSelected) next.delete(student.id);
                          else if (next.size < MAX_ASSIGNMENT_SIZE) next.add(student.id);
                        }
                        return next;
                      });
                    }}
                  >
                    {allVisibleSelected
                      ? `Deselect all ${visibleAssignableStudents.length}`
                      : `Select all ${visibleAssignableStudents.length}`}
                  </Button>
                </div>
              </div>
              {selectedAssignableStudentIds.length >= MAX_ASSIGNMENT_SIZE || selectAllWouldExceedLimit ? (
                <p className="text-xs text-muted-foreground" role="status">
                  A maximum of {MAX_ASSIGNMENT_SIZE.toLocaleString()} students can be assigned at once. Narrow the grade or search filter if needed.
                </p>
              ) : null}
              <div className="max-h-72 divide-y overflow-y-auto rounded-md border">
                {visibleAssignableStudents.length === 0 ? (
                  <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                    No students match this grade and search.
                  </p>
                ) : visibleAssignableStudents.map((student) => {
                    const name = getStudentDisplayName(student);
                    const isSelected = assignSelected.has(student.id);
                    return (
                      <label key={student.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/50">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={!isSelected && selectedAssignableStudentIds.length >= MAX_ASSIGNMENT_SIZE}
                          onChange={() => {
                            setAssignSelected((previous) => {
                              const next = new Set(
                                [...previous].filter((studentId) => assignableStudentIds.has(studentId)),
                              );
                              if (next.has(student.id)) next.delete(student.id);
                              else if (next.size < MAX_ASSIGNMENT_SIZE) next.add(student.id);
                              return next;
                            });
                          }}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
                        <span className="text-xs text-muted-foreground">
                          {formatGradeFilterLabel(getStudentGradeFilterValue(student))}
                        </span>
                      </label>
                    );
                  })}
              </div>
              <Button
                type="button"
                className="w-full"
                disabled={assignStudents.isPending || selectedAssignableStudentIds.length === 0 || selectedAssignableStudentIds.length > MAX_ASSIGNMENT_SIZE}
                onClick={() => assignStudents.mutate({ classId: assigningGrade.id, studentIds: selectedAssignableStudentIds })}
              >
                {assignStudents.isPending
                  ? "Assigning..."
                  : `Assign ${selectedAssignableStudentIds.length} Student${selectedAssignableStudentIds.length === 1 ? "" : "s"}`}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit Grade Dialog */}
      {editingGrade && (
        <Dialog open={!!editingGrade} onOpenChange={() => setEditingGrade(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Edit Class</DialogTitle></DialogHeader>
            <form onSubmit={handleUpdateGrade} className="space-y-4">
              <div>
                <Label htmlFor="editGradeName">Class Name</Label>
                <Input id="editGradeName" value={gradeForm.name} onChange={(e) => setGradeForm({ name: e.target.value })} placeholder="e.g. Math Period 1" />
              </div>
              <div className="flex justify-end space-x-2">
                <Button type="button" variant="outline" onClick={() => setEditingGrade(null)}>Cancel</Button>
                <Button type="submit">Update Class</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      )}

      {/* Edit Student Dialog */}
      {editingStudent && !classPilotOwnsStudentIdentities && (
        <Dialog open={!!editingStudent} onOpenChange={() => setEditingStudent(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Edit Student</DialogTitle></DialogHeader>
            <form onSubmit={handleUpdateStudent} className="space-y-4">
              <div>
                <Label htmlFor="editStudentName">Student Name</Label>
                <Input id="editStudentName" value={studentForm.name} onChange={(e) => setStudentForm({ ...studentForm, name: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="editStudentGradeLevel">Grade Level</Label>
                <Select value={studentForm.gradeLevel} onValueChange={(value) => setStudentForm({ ...studentForm, gradeLevel: value })}>
                  <SelectTrigger><SelectValue placeholder="Select grade level" /></SelectTrigger>
                  <SelectContent>
                    {GRADE_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>{level}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="editStudentId">Student ID (Optional)</Label>
                <Input id="editStudentId" value={studentForm.studentId} onChange={(e) => setStudentForm({ ...studentForm, studentId: e.target.value })} />
              </div>
              <div className="flex justify-end space-x-2">
                <Button type="button" variant="outline" onClick={() => setEditingStudent(null)}>Cancel</Button>
                <Button type="submit">Update Student</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      )}

      {/* View Grade Roster Dialog */}
      {viewingGrade && (
        <Dialog open={showViewGradeModal} onOpenChange={setShowViewGradeModal}>
          <DialogContent className="max-w-4xl">
            <DialogHeader>
              <DialogTitle>PassPilot Class Roster — {viewingGrade.name}</DialogTitle>
            </DialogHeader>
            <div className="max-h-96 overflow-y-auto">
              {(() => {
                const gradeStudents = classRoster;

                if (classRosterQuery.isFetching) {
                  return <p className="py-8 text-center text-sm text-muted-foreground" aria-live="polite">Loading class roster…</p>;
                }

                if (classRosterQuery.isError) {
                  return (
                    <div className="py-8 text-center" role="alert">
                      <p className="text-sm font-medium">This roster couldn’t be loaded.</p>
                      <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => classRosterQuery.refetch()}>Retry</Button>
                    </div>
                  );
                }

                if (gradeStudents.length === 0) {
                  return (
                    <div className="text-center py-8">
                      <Users className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                      <p className="text-muted-foreground">
                        {classPilotOwnsStudentIdentities ? `No students assigned to ${viewingGrade.name} yet.` : `No students in ${viewingGrade.name} yet.`}
                      </p>
                      <div className="flex gap-2 justify-center mt-4">
                        {!classPilotOwnsStudentIdentities && (
                          <>
                          <Button onClick={() => { setStudentForm({ name: '', grade: viewingGrade.id, studentId: '', gradeLevel: '' }); setShowViewGradeModal(false); setShowAddStudentModal(true); }} size="sm">Add Student</Button>
                          <Button onClick={() => { setBulkGrade(viewingGrade.id); setBulkGradeLevel(''); setShowViewGradeModal(false); setShowBulkAddStudentsModal(true); }} size="sm" variant="outline">Bulk Add Students</Button>
                          </>
                        )}
                        <Button onClick={() => openAssignStudents(viewingGrade, true)} size="sm" variant="outline">Assign existing students</Button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <p className="text-sm text-muted-foreground">{gradeStudents.length} student{gradeStudents.length !== 1 ? 's' : ''}</p>
                      <div className="flex gap-2">
                        {!classPilotOwnsStudentIdentities && (
                          <>
                          <Button onClick={() => { setStudentForm({ name: '', grade: viewingGrade.id, studentId: '', gradeLevel: '' }); setShowViewGradeModal(false); setShowAddStudentModal(true); }} size="sm"><Plus className="w-4 h-4 mr-2" />Add Student</Button>
                          <Button onClick={() => { setBulkGrade(viewingGrade.id); setBulkGradeLevel(''); setShowViewGradeModal(false); setShowBulkAddStudentsModal(true); }} size="sm" variant="outline"><Users className="w-4 h-4 mr-2" />Bulk Add</Button>
                          </>
                        )}
                        <Button onClick={() => openAssignStudents(viewingGrade, true)} size="sm" variant="outline">Assign existing students</Button>
                      </div>
                    </div>
                    {gradeStudents.map((student) => (
                      <div key={student.id} className="flex items-center justify-between p-3 bg-muted/30 rounded-lg">
                        <div className="flex items-center space-x-3">
                          <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium ${getAvatarColor(student)}`}>
                            {getInitials(student)}
                          </div>
                          <div>
                            <p className="font-medium">{student.name || `${student.firstName ?? ""} ${student.lastName ?? ""}`.trim()}</p>
                            {student.studentIdNumber && <p className="text-sm text-muted-foreground">ID: {student.studentIdNumber}</p>}
                          </div>
                        </div>
                        <div className="flex items-center space-x-2">
                          {!classPilotOwnsStudentIdentities && (
                            <Button size="sm" variant="ghost" onClick={() => { handleEditStudent(student); setShowViewGradeModal(false); }} aria-label={`Edit ${student.name || student.firstName || "student"}`}>
                              <Edit className="h-4 w-4" />
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => unassignStudent.mutate({ classId: viewingGrade.id, studentId: student.id })}
                            className="hover:text-red-600"
                            aria-label={`Remove ${student.name || student.firstName || "student"} from ${viewingGrade.name}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function RosterTab() {
  const classesQuery = useCanonicalPassPilotClasses();

  if (classesQuery.isLoading) {
    return (
      <div className="p-4" aria-live="polite">
        <div className="animate-pulse space-y-4 motion-reduce:animate-none">
          <div className="h-7 w-44 rounded bg-muted" />
          <div className="h-24 rounded-xl bg-muted" />
        </div>
        <span className="sr-only">Loading classes</span>
      </div>
    );
  }

  if (classesQuery.isError) {
    return <CanonicalClassesView />;
  }

  return isCanonicalPassPilotSource(classesQuery.data?.source)
    ? <CanonicalClassesView />
    : <LegacyRosterTab classRecords={classesQuery.data?.classes ?? []} />;
}

export default RosterTab;
