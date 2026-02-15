import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { Button } from "../../../../components/ui/button";
import { Input } from "../../../../components/ui/input";
import { Label } from "../../../../components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../../../../components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../../components/ui/select";
import { useToast } from "../../../../hooks/use-toast";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "../../../../lib/queryClient";
import { usePassPilotAuth } from "../../../../hooks/usePassPilotAuth";
import { Trash2, Edit, Plus, Users, Eye } from "lucide-react";

const GRADE_LEVELS = ['K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

function RosterTab() {
  const { isAdmin } = usePassPilotAuth();
  const [showAddStudentModal, setShowAddStudentModal] = useState(false);
  const [showBulkAddStudentsModal, setShowBulkAddStudentsModal] = useState(false);
  const [showAddClassModal, setShowAddClassModal] = useState(false);
  const [showViewGradeModal, setShowViewGradeModal] = useState(false);
  const [editingStudent, setEditingStudent] = useState(null);
  const [editingGrade, setEditingGrade] = useState(null);
  const [viewingGrade, setViewingGrade] = useState(null);
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

  // For teachers - their assigned classes; for admins - all classes
  const { data: myClasses = [], isLoading: classesLoading } = useQuery({
    queryKey: ['my-classes'],
    queryFn: async () => {
      const url = isAdmin ? '/api/grades' : '/api/my-classes';
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch classes');
      return res.json();
    },
    select: (data) => Array.isArray(data) ? data : (data?.grades ?? data?.classes ?? []),
  });

  // Available classes for "Add Class" dialog (teachers only)
  const { data: availableClasses = [] } = useQuery({
    queryKey: ['available-classes'],
    queryFn: async () => {
      const res = await fetch('/api/grades/available', { credentials: 'include' });
      if (!res.ok) return [];
      return res.json();
    },
    select: (data) => Array.isArray(data) ? data : (data?.grades ?? []),
    enabled: !isAdmin,
  });

  const { data: students = [], isLoading: studentsLoading } = useQuery({
    queryKey: ['/api/students'],
    queryFn: async () => {
      const res = await fetch('/api/students', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch students');
      return res.json();
    },
    select: (data) => Array.isArray(data) ? data : (data?.students ?? []),
  });

  const isLoading = classesLoading || studentsLoading;

  const handleAssignClass = async (gradeId) => {
    try {
      await apiRequest('POST', '/teacher-grades/self-assign', { gradeId });
      queryClient.invalidateQueries({ queryKey: ['my-classes'] });
      queryClient.invalidateQueries({ queryKey: ['available-classes'] });
      toast({ title: "Class added", description: "Class has been added to your list." });
    } catch (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
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
      setNewClassName('');
      setShowAddClassModal(false);
      toast({ title: "Class created", description: `${newClassName.trim()} has been created and added.` });
    } catch (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
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
      setGradeForm({ name: '' });
      setEditingGrade(null);
      toast({ title: "Class updated", description: `Class has been updated to ${gradeForm.name}.` });
    } catch (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
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
      toast({ title: "Class deleted", description: `${gradeName} has been deleted.` });
    } catch (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
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
        grade: studentForm.grade,
        studentId: studentForm.studentId || undefined,
        gradeLevel: studentForm.gradeLevel || undefined
      });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      setStudentForm({ name: '', grade: '', studentId: '', gradeLevel: '' });
      setShowAddStudentModal(false);
      toast({ title: "Student added", description: `${studentForm.name} has been added.` });
    } catch (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
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
          grade: bulkGrade,
          gradeLevel: bulkGradeLevel || undefined
        });
      });

      await Promise.all(promises);
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      setBulkStudentNames('');
      setBulkGrade('');
      setBulkGradeLevel('');
      setShowBulkAddStudentsModal(false);
      toast({ title: "Students added", description: `${lines.length} student${lines.length !== 1 ? 's' : ''} have been added.` });
    } catch (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const handleEditStudent = (student) => {
    setEditingStudent(student);
    const fullName = `${student.firstName || ''} ${student.lastName || ''}`.trim();
    const grade = myClasses.find((g) => g.id === student.gradeId);
    setStudentForm({
      name: fullName,
      grade: grade ? grade.name : '',
      studentId: student.studentIdNumber || '',
      gradeLevel: student.gradeLevel || ''
    });
  };

  const handleUpdateStudent = async (e) => {
    e.preventDefault();
    if (!studentForm.name || !studentForm.grade || !editingStudent) return;

    try {
      await apiRequest('PUT', `/students/${editingStudent.id}`, {
        name: studentForm.name,
        grade: studentForm.grade,
        studentId: studentForm.studentId || undefined,
        gradeLevel: studentForm.gradeLevel || undefined
      });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      setStudentForm({ name: '', grade: '', studentId: '', gradeLevel: '' });
      setEditingStudent(null);
      toast({ title: "Student updated", description: `${studentForm.name} has been updated.` });
    } catch (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const handleDeleteStudent = async (studentId, studentName) => {
    if (!confirm(`Are you sure you want to delete ${studentName}?`)) return;

    try {
      await apiRequest('DELETE', `/students/${studentId}`, {});
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({ title: "Student deleted", description: `${studentName} has been deleted.` });
    } catch (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
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
              {myClasses.map((grade) => {
                const gradeStudents = students.filter((student) => student.gradeId === grade.id);

                return (
                  <Card
                    key={grade.id}
                    className="hover:shadow-md transition-all"
                    data-testid={`card-grade-${grade.name}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="font-semibold">{grade.name}</h3>
                        <div className="flex items-center space-x-1">
                          <Button size="sm" variant="ghost" onClick={() => { setViewingGrade(grade); setShowViewGradeModal(true); }} className="h-6 w-6 p-0">
                            <Eye className="h-3 w-3" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => handleEditGrade(grade)} className="h-6 w-6 p-0">
                            <Edit className="h-3 w-3" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => handleDeleteGrade(grade.id, grade.name)} className="h-6 w-6 p-0 hover:text-red-600">
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {gradeStudents.length} student{gradeStudents.length !== 1 ? 's' : ''}
                      </p>
                      <div className="flex gap-1 mt-2">
                        <Button size="sm" variant="outline" onClick={() => { setStudentForm({ name: '', grade: grade.name, studentId: '', gradeLevel: '' }); setShowAddStudentModal(true); }} className="h-6 text-xs px-2">
                          Add Student
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => { setBulkGrade(grade.name); setBulkGradeLevel(''); setShowBulkAddStudentsModal(true); }} className="h-6 text-xs px-2">
                          Bulk Add
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Student Dialog */}
      <Dialog open={showAddStudentModal} onOpenChange={setShowAddStudentModal}>
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
                    <SelectItem key={grade.id} value={grade.name}>{grade.name}</SelectItem>
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
      <Dialog open={showBulkAddStudentsModal} onOpenChange={setShowBulkAddStudentsModal}>
        <DialogContent>
          <DialogHeader><DialogTitle>Bulk Add Students</DialogTitle></DialogHeader>
          <form onSubmit={handleBulkAddStudents} className="space-y-4">
            <div>
              <Label htmlFor="bulkGrade">Class</Label>
              <Select value={bulkGrade} onValueChange={setBulkGrade}>
                <SelectTrigger><SelectValue placeholder="Select a class" /></SelectTrigger>
                <SelectContent>
                  {myClasses.map((grade) => (
                    <SelectItem key={grade.id} value={grade.name}>{grade.name}</SelectItem>
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
      {editingStudent && (
        <Dialog open={!!editingStudent} onOpenChange={() => setEditingStudent(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Edit Student</DialogTitle></DialogHeader>
            <form onSubmit={handleUpdateStudent} className="space-y-4">
              <div>
                <Label htmlFor="editStudentName">Student Name</Label>
                <Input id="editStudentName" value={studentForm.name} onChange={(e) => setStudentForm({ ...studentForm, name: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="editStudentGrade">Class</Label>
                <Select value={studentForm.grade} onValueChange={(value) => setStudentForm({ ...studentForm, grade: value })}>
                  <SelectTrigger><SelectValue placeholder="Select a class" /></SelectTrigger>
                  <SelectContent>
                    {myClasses.map((grade) => (
                      <SelectItem key={grade.id} value={grade.name}>{grade.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
              <DialogTitle>{viewingGrade.name} - Full Roster</DialogTitle>
            </DialogHeader>
            <div className="max-h-96 overflow-y-auto">
              {(() => {
                const gradeStudents = students.filter((student) => student.gradeId === viewingGrade.id);

                if (gradeStudents.length === 0) {
                  return (
                    <div className="text-center py-8">
                      <Users className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                      <p className="text-muted-foreground">No students in {viewingGrade.name} yet.</p>
                      <div className="flex gap-2 justify-center mt-4">
                        <Button onClick={() => { setStudentForm({ name: '', grade: viewingGrade.name, studentId: '', gradeLevel: '' }); setShowViewGradeModal(false); setShowAddStudentModal(true); }} size="sm">Add Student</Button>
                        <Button onClick={() => { setBulkGrade(viewingGrade.name); setBulkGradeLevel(''); setShowViewGradeModal(false); setShowBulkAddStudentsModal(true); }} size="sm" variant="outline">Bulk Add Students</Button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <p className="text-sm text-muted-foreground">{gradeStudents.length} student{gradeStudents.length !== 1 ? 's' : ''}</p>
                      <div className="flex gap-2">
                        <Button onClick={() => { setStudentForm({ name: '', grade: viewingGrade.name, studentId: '', gradeLevel: '' }); setShowViewGradeModal(false); setShowAddStudentModal(true); }} size="sm"><Plus className="w-4 h-4 mr-2" />Add Student</Button>
                        <Button onClick={() => { setBulkGrade(viewingGrade.name); setBulkGradeLevel(''); setShowViewGradeModal(false); setShowBulkAddStudentsModal(true); }} size="sm" variant="outline"><Users className="w-4 h-4 mr-2" />Bulk Add</Button>
                      </div>
                    </div>
                    {gradeStudents.map((student) => (
                      <div key={student.id} className="flex items-center justify-between p-3 bg-muted/30 rounded-lg">
                        <div className="flex items-center space-x-3">
                          <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium ${getAvatarColor(student)}`}>
                            {getInitials(student)}
                          </div>
                          <div>
                            <p className="font-medium">{student.firstName} {student.lastName}</p>
                            {student.studentIdNumber && <p className="text-sm text-muted-foreground">ID: {student.studentIdNumber}</p>}
                          </div>
                        </div>
                        <div className="flex items-center space-x-2">
                          <Button size="sm" variant="ghost" onClick={() => { handleEditStudent(student); setShowViewGradeModal(false); }}>
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => handleDeleteStudent(student.id, `${student.firstName} ${student.lastName}`)} className="hover:text-red-600">
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

export default RosterTab;
