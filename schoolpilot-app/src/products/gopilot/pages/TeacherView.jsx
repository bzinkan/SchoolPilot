import React, { useState, useEffect } from 'react';
import {
  Car, Bus, PersonStanding, Clock, Users, Bell, Check, X,
  ChevronRight, ChevronDown, AlertTriangle, CheckCircle2, Timer,
  Volume2, VolumeX, LogOut, Home, RefreshCw, User,
  AlertCircle, Send, Coffee, Hand, MapPin, Smartphone, Filter,
  Loader2, ArrowRight, Megaphone
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useGoPilotAuth } from '../../../hooks/useGoPilotAuth';
import { useSocket } from '../../../contexts/SocketContext';
import api from '../../../shared/utils/api';

// Utility Components
const Badge = ({ children, variant = 'default', size = 'md', pulse = false }) => {
  const variants = {
    default: 'bg-gray-100 text-gray-800',
    blue: 'bg-blue-100 text-blue-800',
    green: 'bg-green-100 text-green-800',
    yellow: 'bg-yellow-100 text-yellow-800',
    red: 'bg-red-100 text-red-800',
    purple: 'bg-purple-100 text-purple-800',
  };
  const sizes = { sm: 'px-2 py-0.5 text-xs', md: 'px-2.5 py-1 text-sm' };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-medium ${variants[variant]} ${sizes[size]} ${pulse ? 'animate-pulse' : ''}`}>
      {children}
    </span>
  );
};

const Button = ({ children, variant = 'primary', size = 'md', onClick, disabled, className = '' }) => {
  const variants = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300',
    secondary: 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50',
    success: 'bg-green-600 text-white hover:bg-green-700',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    warning: 'bg-yellow-500 text-white hover:bg-yellow-600',
    ghost: 'text-gray-600 hover:bg-gray-100',
  };
  const sizes = { sm: 'px-3 py-1.5 text-sm', md: 'px-4 py-2 text-sm', lg: 'px-6 py-3 text-base' };
  return (
    <button onClick={onClick} disabled={disabled}
      className={`inline-flex items-center justify-center rounded-lg font-medium transition-colors ${variants[variant]} ${sizes[size]} ${className} disabled:cursor-not-allowed`}>
      {children}
    </button>
  );
};

const Card = ({ children, className = '' }) => (
  <div className={`bg-white rounded-xl shadow-sm border border-gray-200 ${className}`}>{children}</div>
);

// Main Teacher View Component
export default function TeacherView() {
  const { currentSchool, user, logout } = useGoPilotAuth();
  const navigate = useNavigate();
  const socket = useSocket();

  const [currentTime, setCurrentTime] = useState(new Date());
  const [soundEnabled, setSoundEnabled] = useState(true);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [homeroom, setHomeroom] = useState(null);
  const [session, setSession] = useState(null);
  const [students, setStudents] = useState([]);
  const teacher = {
    name: user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '',
    homeroom: homeroom ? homeroom.name : 'Loading...',
  };

  // Fetch initial data
  useEffect(() => {
    if (!currentSchool?.id) return;
    let cancelled = false;

    const init = async () => {
      try {
        setLoading(true);
        setError(null);

        const homeroomsRes = await api.get(`/schools/${currentSchool.id}/homerooms`);
        const homerooms = homeroomsRes.data;
        const myHomeroom = homerooms.find(
          (h) => h.teacher_id == user?.id || h.teacherId == user?.id || h.userId == user?.id
        );

        if (!myHomeroom) {
          if (!cancelled) setError('No homeroom found for your account.');
          if (!cancelled) setLoading(false);
          return;
        }

        if (!cancelled) setHomeroom(myHomeroom);

        const studentsRes = await api.get(`/schools/${currentSchool.id}/students`, { params: { homeroomId: myHomeroom.id } });
        const sessionRes = await api.post(`/schools/${currentSchool.id}/sessions`);
        const sessionData = sessionRes.data;
        if (!cancelled) setSession(sessionData);

        const queueRes = await api.get(`/sessions/${sessionData.id}/queue`, { params: { homeroomId: myHomeroom.id } });
        const studentList = studentsRes.data;
        const queueItems = Array.isArray(queueRes.data) ? queueRes.data : queueRes.data?.items || [];

        const queueByStudentId = {};
        queueItems.forEach((q) => {
          queueByStudentId[q.student_id || q.studentId] = q;
        });

        const merged = studentList.map((s) => {
          const q = queueByStudentId[s.id];
          return {
            ...s,
            queueId: q?.id || null,
            queueStatus: q?.status || null, // null = not in queue
            calledAt: q?.called_at || q?.calledAt ? new Date(q.called_at || q.calledAt) : null,
            dismissedAt: q?.dismissed_at || q?.dismissedAt ? new Date(q.dismissed_at || q.dismissedAt) : null,
            releasedAt: q?.released_at || q?.releasedAt ? new Date(q.released_at || q.releasedAt) : null,
            zone: q?.zone || null,
            guardian: q?.guardian_name || q?.guardianName || null,
            checkInMethod: q?.check_in_method || q?.checkInMethod || null,
            holdReason: q?.hold_reason || q?.holdReason || null,
          };
        });

        if (!cancelled) {
          setStudents(merged);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err?.response?.data?.message || err.message || 'Failed to load data.');
          setLoading(false);
        }
      }
    };

    init();
    return () => { cancelled = true; };
  }, [currentSchool?.id, user?.id]);

  // Join socket room (and re-join on reconnect)
  useEffect(() => {
    console.log('[TeacherView] Socket effect:', {
      hasSocket: !!socket,
      schoolId: currentSchool?.id,
      homeroomId: homeroom?.id
    });

    if (!socket) {
      console.log('[TeacherView] MISSING: socket');
      return;
    }
    if (!currentSchool?.id) {
      console.log('[TeacherView] MISSING: currentSchool.id');
      return;
    }
    if (!homeroom?.id) {
      console.log('[TeacherView] MISSING: homeroom.id, homeroom=', homeroom);
      return;
    }

    const joinRoom = () => {
      console.log('[TeacherView] Emitting join:school:', { schoolId: currentSchool.id, homeroomId: homeroom.id });
      socket.emit('join:school', { schoolId: currentSchool.id, role: 'teacher', homeroomId: homeroom.id });
    };

    // Always join when this effect runs (socket may already be connected)
    joinRoom();

    // Also re-join on reconnect
    socket.on('connect', joinRoom);

    return () => {
      socket.off('connect', joinRoom);
    };
  }, [socket, currentSchool?.id, homeroom?.id]);

  // Socket event listeners
  useEffect(() => {
    if (!socket) return;

    // student:checked-in — office entered car/bus/walker, student goes to center as RED
    const handleStudentCheckedIn = (data) => {
      const studentId = data.student_id || data.studentId;
      const guardianName = data.guardian_name || data.guardianName || null;
      const queueId = data.id || data.queueId;
      const checkInMethod = data.check_in_method || data.checkInMethod || null;
      setStudents((prev) =>
        prev.map((s) =>
          s.id === studentId
            ? { ...s, queueStatus: 'waiting', queueId: queueId || s.queueId, guardian: guardianName, checkInMethod }
            : s
        )
      );
    };

    // student:called — legacy, treat same as checked-in
    const handleStudentCalled = (data) => {
      const studentId = data.student_id || data.studentId;
      const guardianName = data.guardian_name || data.guardianName || null;
      const queueId = data.id || data.queueId;
      setStudents((prev) =>
        prev.map((s) =>
          s.id === studentId
            ? { ...s, queueStatus: data.status || 'called', calledAt: new Date(), guardian: guardianName, queueId: queueId || s.queueId }
            : s
        )
      );
    };

    const handleStudentReleased = (data) => {
      const studentId = data.student_id || data.studentId;
      setStudents((prev) =>
        prev.map((s) =>
          s.id === studentId
            ? { ...s, queueStatus: 'released', releasedAt: new Date() }
            : s
        )
      );
    };

    // student:dismissed — picked up by office/parent, move to roster as blue
    const handleStudentDismissed = (data) => {
      const studentId = data.student_id || data.studentId;
      setStudents((prev) =>
        prev.map((s) =>
          s.id === studentId
            ? { ...s, queueStatus: 'dismissed', dismissedAt: new Date() }
            : s
        )
      );
    };

    const handleQueueUpdated = async () => {
      if (!session?.id || !homeroom?.id) return;
      try {
        const queueRes = await api.get(`/sessions/${session.id}/queue`, { params: { homeroomId: homeroom.id } });
        const queueItems = Array.isArray(queueRes.data) ? queueRes.data : queueRes.data?.items || [];
        const queueByStudentId = {};
        queueItems.forEach((q) => {
          queueByStudentId[q.student_id || q.studentId] = q;
        });
        setStudents((prev) =>
          prev.map((s) => {
            const q = queueByStudentId[s.id];
            if (!q) return { ...s, queueStatus: null, calledAt: null, zone: null, guardian: null, queueId: null, checkInMethod: null };
            return {
              ...s,
              queueId: q.id,
              queueStatus: q.status,
              calledAt: q.called_at ? new Date(q.called_at) : null,
              dismissedAt: q.dismissed_at ? new Date(q.dismissed_at) : null,
              releasedAt: q.released_at ? new Date(q.released_at) : null,
              zone: q.zone || null,
              guardian: q.guardian_name || null,
              checkInMethod: q.check_in_method || null,
              holdReason: q.hold_reason || null,
            };
          })
        );
      } catch { /* silent */ }
    };

    socket.on('student:checked-in', handleStudentCheckedIn);
    socket.on('student:called', handleStudentCalled);
    socket.on('student:released', handleStudentReleased);
    socket.on('student:dismissed', handleStudentDismissed);
    socket.on('queue:updated', handleQueueUpdated);

    return () => {
      socket.off('student:checked-in', handleStudentCheckedIn);
      socket.off('student:called', handleStudentCalled);
      socket.off('student:released', handleStudentReleased);
      socket.off('student:dismissed', handleStudentDismissed);
      socket.off('queue:updated', handleQueueUpdated);
    };
  }, [socket, session?.id, homeroom?.id]);

  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Teacher dismisses student from class (waiting/called -> released)
  const handleDismissFromClass = async (student) => {
    if (!student.queueId) return;
    try {
      await api.post(`/queue/${student.queueId}/release`);
      setStudents((prev) =>
        prev.map((s) =>
          s.id === student.id ? { ...s, queueStatus: 'released', releasedAt: new Date() } : s
        )
      );
    } catch (err) {
      setError(err?.response?.data?.message || 'Failed to dismiss student.');
    }
  };

  // Batch dismiss all students in a group
  const handleDismissAll = async (studentList) => {
    const queueIds = studentList.filter(s => s.queueId && (s.queueStatus === 'waiting' || s.queueStatus === 'called')).map(s => s.queueId);
    if (queueIds.length === 0) return;
    try {
      await api.post('/queue/release-batch', { queueIds });
      setStudents((prev) =>
        prev.map((s) =>
          queueIds.includes(s.queueId) ? { ...s, queueStatus: 'released', releasedAt: new Date() } : s
        )
      );
    } catch (err) {
      setError(err?.response?.data?.message || 'Failed to dismiss students.');
    }
  };

  // Categorize students
  // CENTER panel: students in queue (waiting/called = RED, released = GREEN)
  const calledStudents = students.filter(s => s.queueStatus === 'waiting' || s.queueStatus === 'called');
  const inTransitStudents = students.filter(s => s.queueStatus === 'released');
  // LEFT panel: roster (not in queue = grey, dismissed = blue "picked up")
  const rosterStudents = students.filter(s => !s.queueStatus || s.queueStatus === 'dismissed');
  // Group called students by reason (guardian name)
  const calledByReason = {};
  calledStudents.forEach(s => {
    const key = s.guardian || 'Unknown';
    if (!calledByReason[key]) calledByReason[key] = [];
    calledByReason[key].push(s);
  });

  const dismissalTypes = [
    { id: 'car', label: 'Car', icon: Car, color: 'blue' },
    { id: 'bus', label: 'Bus', icon: Bus, color: 'yellow' },
    { id: 'walker', label: 'Walker', icon: PersonStanding, color: 'green' },
    { id: 'afterschool', label: 'After School', icon: Clock, color: 'purple' },
  ];

  const getTypeIcon = (type) => {
    const found = dismissalTypes.find(t => t.id === type);
    return found ? found.icon : Car;
  };

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-10 h-10 text-indigo-600 animate-spin mx-auto mb-4" />
          <p className="text-gray-600 font-medium">Loading your classroom...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error && students.length === 0) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <Card className="max-w-md mx-auto">
          <div className="p-6 text-center">
            <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Unable to Load</h2>
            <p className="text-gray-600 mb-4">{error}</p>
            <Button onClick={() => window.location.reload()}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Retry
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Inline error banner */}
      {error && students.length > 0 && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-red-700 text-sm">
            <AlertCircle className="w-4 h-4" />
            {error}
          </div>
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Header */}
      <header className="bg-white border-b sticky top-0 z-50">
        <div className="px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center">
                  <Home className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h1 className="font-bold text-gray-900">{teacher.homeroom}</h1>
                  <p className="text-xs text-gray-500">{teacher.name} • {currentSchool?.name}</p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="flex items-center gap-4 text-sm">
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                  <span className="font-medium text-red-600">{calledStudents.length} Called</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
                  <span className="font-medium text-green-600">{inTransitStudents.length} In Transit</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />
                  <span className="font-medium text-blue-600">{rosterStudents.filter(s => s.queueStatus === 'dismissed').length} Picked Up</span>
                </div>
              </div>

              <div className="text-right">
                <p className="text-xl font-bold text-gray-900">
                  {currentTime.toLocaleTimeString([], { timeZone: currentSchool?.timezone, hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>

              <Button
                variant={soundEnabled ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setSoundEnabled(!soundEnabled)}
              >
                {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={() => { logout(); navigate('/login'); }}
              >
                <LogOut className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* 3-Panel Layout */}
      <div className="flex h-[calc(100vh-73px)]">

        {/* LEFT PANEL - Class Roster */}
        <aside className="w-64 xl:w-72 bg-white border-r overflow-y-auto flex-shrink-0 hidden lg:block">
          <div className="p-3 border-b bg-gray-50">
            <h2 className="font-semibold text-sm text-gray-700 flex items-center gap-2">
              <Users className="w-4 h-4" />
              Class Roster
              <span className="text-xs text-gray-400 ml-auto">{students.length} students</span>
            </h2>
          </div>
          <div className="divide-y">
            {rosterStudents.map(student => {
              const TypeIcon = getTypeIcon(student.dismissal_type || student.dismissalType);
              const isPickedUp = student.queueStatus === 'dismissed';
              return (
                <div key={student.id} className={`p-3 flex items-center gap-3 ${isPickedUp ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-medium ${
                    isPickedUp ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-600'
                  }`}>
                    {(student.first_name || student.firstName || '?')[0]}{(student.last_name || student.lastName || '?')[0]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium truncate ${isPickedUp ? 'text-blue-700' : 'text-gray-900'}`}>
                      {student.first_name || student.firstName} {student.last_name || student.lastName}
                    </p>
                    <div className="flex items-center gap-1 text-xs text-gray-500">
                      <TypeIcon className="w-3 h-3" />
                      <span className="capitalize">{student.dismissal_type || student.dismissalType || 'car'}</span>
                      {(student.bus_route || student.busRoute) && <span>#{student.bus_route || student.busRoute}</span>}
                    </div>
                  </div>
                  {isPickedUp && (
                    <Badge variant="blue" size="sm">Picked Up</Badge>
                  )}
                </div>
              );
            })}
            {rosterStudents.length === 0 && (
              <div className="p-6 text-center text-gray-400 text-sm">
                All students are in the dismissal queue
              </div>
            )}
          </div>
        </aside>

        {/* CENTER PANEL - Called Students (grouped by reason) */}
        <main className="flex-1 overflow-y-auto p-4">
          {/* Called Students - RED */}
          {Object.keys(calledByReason).length > 0 && (
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <Bell className="w-5 h-5 text-red-500" />
                <h2 className="font-semibold text-red-600">Called - Dismiss from Class</h2>
              </div>
              <div className="space-y-4">
                {Object.entries(calledByReason).map(([reason, groupStudents]) => (
                  <Card key={reason} className="border-2 border-red-200 bg-red-50">
                    <div className="p-3 border-b border-red-200 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-red-800">{reason}</span>
                        <Badge variant="red" size="sm">{groupStudents.length} students</Badge>
                      </div>
                      {groupStudents.length > 1 && (
                        <Button variant="success" size="sm" onClick={() => handleDismissAll(groupStudents)}>
                          <Check className="w-4 h-4 mr-1" /> Dismiss All
                        </Button>
                      )}
                    </div>
                    <div className="divide-y divide-red-100">
                      {groupStudents.map(student => (
                        <div key={student.id} className="p-3 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center animate-pulse">
                              <Bell className="w-5 h-5 text-red-500" />
                            </div>
                            <div>
                              <p className="font-medium text-gray-900">{student.first_name || student.firstName} {student.last_name || student.lastName}</p>
                              <p className="text-xs text-gray-500">
                                Grade {student.grade} • {(student.dismissal_type || student.dismissalType || 'car')}
                                {(student.bus_route || student.busRoute) && ` #${student.bus_route || student.busRoute}`}
                              </p>
                            </div>
                          </div>
                          <Button variant="success" size="sm" onClick={() => handleDismissFromClass(student)}>
                            <Check className="w-4 h-4 mr-1" /> Dismiss
                          </Button>
                        </div>
                      ))}
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* In Transit Students - GREEN */}
          {inTransitStudents.length > 0 && (
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <ArrowRight className="w-5 h-5 text-green-500" />
                <h2 className="font-semibold text-green-600">In Transit</h2>
              </div>
              <div className="space-y-2">
                {inTransitStudents.map(student => (
                  <Card key={student.id} className="border-2 border-green-200 bg-green-50">
                    <div className="p-3 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                          <CheckCircle2 className="w-5 h-5 text-green-500" />
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">{student.first_name || student.firstName} {student.last_name || student.lastName}</p>
                          <p className="text-xs text-green-600">Dismissed from class • {student.guardian}</p>
                        </div>
                      </div>
                      <Badge variant="green" size="sm">
                        <ArrowRight className="w-3 h-3" /> In Transit
                      </Badge>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Empty state */}
          {calledStudents.length === 0 && inTransitStudents.length === 0 && (
            <div className="flex items-center justify-center h-64">
              <div className="text-center text-gray-400">
                <Bell className="w-16 h-16 mx-auto mb-4 opacity-30" />
                <p className="text-lg font-medium">No students called yet</p>
                <p className="text-sm">Students will appear here when the office enters their car number, bus number, or releases walkers</p>
              </div>
            </div>
          )}

          {/* Mobile roster (shown below center content on small screens) */}
          <div className="lg:hidden mt-6">
            <Card>
              <div className="p-3 border-b bg-gray-50">
                <h2 className="font-semibold text-sm text-gray-700 flex items-center gap-2">
                  <Users className="w-4 h-4" />
                  Class Roster
                  <span className="text-xs text-gray-400 ml-auto">{students.length} students</span>
                </h2>
              </div>
              <div className="divide-y">
                {rosterStudents.map(student => {
                  const TypeIcon = getTypeIcon(student.dismissal_type || student.dismissalType);
                  const isPickedUp = student.queueStatus === 'dismissed';
                  return (
                    <div key={student.id} className={`p-3 flex items-center gap-3 ${isPickedUp ? 'bg-blue-50' : ''}`}>
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium ${
                        isPickedUp ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-600'
                      }`}>
                        {(student.first_name || student.firstName || '?')[0]}{(student.last_name || student.lastName || '?')[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium truncate ${isPickedUp ? 'text-blue-700' : 'text-gray-900'}`}>
                          {student.first_name || student.firstName} {student.last_name || student.lastName}
                        </p>
                        <div className="flex items-center gap-1 text-xs text-gray-500">
                          <TypeIcon className="w-3 h-3" />
                          <span className="capitalize">{student.dismissal_type || student.dismissalType || 'car'}</span>
                        </div>
                      </div>
                      {isPickedUp && <Badge variant="blue" size="sm">Picked Up</Badge>}
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>
        </main>

        {/* RIGHT PANEL - Announcements */}
        <aside className="w-64 xl:w-72 bg-white border-l overflow-y-auto flex-shrink-0 hidden xl:block">
          <div className="p-3 border-b bg-gray-50">
            <h2 className="font-semibold text-sm text-gray-700 flex items-center gap-2">
              <Megaphone className="w-4 h-4" />
              Announcements
            </h2>
          </div>
          <div className="p-3 space-y-3">
            {/* Dynamic announcements based on queue state */}
            {(() => {
              const busGroups = {};
              const walkerCount = calledStudents.filter(s => (s.dismissal_type || s.dismissalType) === 'walker').length;
              calledStudents.forEach(s => {
                if ((s.dismissal_type || s.dismissalType) === 'bus' && (s.bus_route || s.busRoute)) {
                  const route = s.bus_route || s.busRoute;
                  if (!busGroups[route]) busGroups[route] = 0;
                  busGroups[route]++;
                }
              });

              const items = [];

              Object.entries(busGroups).forEach(([route, count]) => {
                items.push(
                  <div key={`bus-${route}`} className="flex items-center gap-3 p-3 bg-yellow-50 rounded-lg">
                    <Bus className="w-5 h-5 text-yellow-600 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-yellow-800">Bus #{route} called</p>
                      <p className="text-xs text-yellow-600">{count} student{count > 1 ? 's' : ''} from your class</p>
                    </div>
                  </div>
                );
              });

              if (walkerCount > 0) {
                items.push(
                  <div key="walkers" className="flex items-center gap-3 p-3 bg-green-50 rounded-lg">
                    <PersonStanding className="w-5 h-5 text-green-600 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-green-800">Walkers released</p>
                      <p className="text-xs text-green-600">{walkerCount} student{walkerCount > 1 ? 's' : ''} from your class</p>
                    </div>
                  </div>
                );
              }

              const carCount = calledStudents.filter(s => (s.dismissal_type || s.dismissalType) === 'car' || s.checkInMethod === 'car_number').length;
              if (carCount > 0) {
                items.push(
                  <div key="cars" className="flex items-center gap-3 p-3 bg-blue-50 rounded-lg">
                    <Car className="w-5 h-5 text-blue-600 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-blue-800">Car pickups active</p>
                      <p className="text-xs text-blue-600">{carCount} student{carCount > 1 ? 's' : ''} waiting</p>
                    </div>
                  </div>
                );
              }

              if (items.length === 0) {
                items.push(
                  <div key="empty" className="text-center text-gray-400 py-8 text-sm">
                    <Megaphone className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p>No announcements yet</p>
                    <p className="text-xs mt-1">Announcements will appear when dismissal begins</p>
                  </div>
                );
              }

              return items;
            })()}

            {/* Summary stats */}
            <div className="mt-4 pt-4 border-t">
              <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Today's Summary</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Total Students</span>
                  <span className="font-medium">{students.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Picked Up</span>
                  <span className="font-medium text-blue-600">{rosterStudents.filter(s => s.queueStatus === 'dismissed').length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">In Transit</span>
                  <span className="font-medium text-green-600">{inTransitStudents.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Waiting to Dismiss</span>
                  <span className="font-medium text-red-600">{calledStudents.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Still in Class</span>
                  <span className="font-medium">{rosterStudents.filter(s => !s.queueStatus).length}</span>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
