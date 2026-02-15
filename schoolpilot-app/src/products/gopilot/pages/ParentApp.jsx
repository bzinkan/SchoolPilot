import React, { useState, useEffect } from 'react';
import {
  Car, Bus, PersonStanding, Clock, Users, Bell, Check, X,
  ChevronRight, ChevronDown, AlertTriangle, CheckCircle2, Timer,
  Home, Settings, History, User, Plus, Edit, Calendar,
  Phone, Shield, AlertCircle, RefreshCw, Send,
  ArrowLeft, Camera, QrCode, MessageSquare, Smartphone, Coffee,
  Loader2, LogOut, Save
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { useGoPilotAuth } from '../../../hooks/useGoPilotAuth';
import { useSocket } from '../../../contexts/SocketContext';
import api from '../../../shared/utils/api';

// Utility Components
const Badge = ({ children, variant = 'default', size = 'md' }) => {
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
    <span className={`inline-flex items-center gap-1 rounded-full font-medium ${variants[variant]} ${sizes[size]}`}>
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
  const sizes = { sm: 'px-3 py-1.5 text-sm', md: 'px-4 py-2 text-sm', lg: 'px-6 py-3 text-base', xl: 'px-8 py-4 text-lg' };
  return (
    <button onClick={onClick} disabled={disabled}
      className={`inline-flex items-center justify-center rounded-xl font-medium transition-all ${variants[variant]} ${sizes[size]} ${className} disabled:cursor-not-allowed`}>
      {children}
    </button>
  );
};

const Card = ({ children, className = '', onClick }) => (
  <div
    className={`bg-white rounded-2xl shadow-sm border border-gray-100 ${onClick ? 'cursor-pointer active:scale-[0.98] transition-transform' : ''} ${className}`}
    onClick={onClick}
  >
    {children}
  </div>
);

// Main Parent App Component
export default function ParentApp() {
  const { user, logout, refetchUser, currentSchool } = useGoPilotAuth();
  const navigate = useNavigate();
  const socket = useSocket();

  const [currentView, setCurrentView] = useState('home');
  const [currentTime, setCurrentTime] = useState(new Date());
  const [checkInStatus, setCheckInStatus] = useState(null); // null, 'checking', 'queued', 'called', 'complete'
  const [queueIds, setQueueIds] = useState([]); // queue entry IDs for dismiss calls
  const [queuePosition, setQueuePosition] = useState(null);
  const [estimatedWait, setEstimatedWait] = useState(null);
  const [, setSelectedChild] = useState(null);
  const [showChangeRequest, setShowChangeRequest] = useState(false);
  const [showAddChild, setShowAddChild] = useState(false);
  const [linkCode, setLinkCode] = useState('');
  const [linkRelationship, setLinkRelationship] = useState('parent');
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [linkSuccess, setLinkSuccess] = useState(null);

  // Settings modal states
  const [showPhoneEdit, setShowPhoneEdit] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showAuthorizedPickups, setShowAuthorizedPickups] = useState(false);
  const [showMyQrCode, setShowMyQrCode] = useState(false);
  const [showCheckInMethod, setShowCheckInMethod] = useState(false);
  const [showQrModal, setShowQrModal] = useState(false);

  // Data states
  const [children, setChildren] = useState([]);
  const [authorizedPickups, setAuthorizedPickups] = useState([]);
  const [history] = useState([]);
  const [sessionId, setSessionId] = useState(null);

  const [schoolSettings, setSchoolSettings] = useState({});

  // Loading / error states
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [checkInError, setCheckInError] = useState(null);
  const [changeError, setChangeError] = useState(null);

  // Fetch children and their authorized pickups on mount
  useEffect(() => {
    let cancelled = false;
    async function fetchData() {
      try {
        setLoading(true);
        setError(null);

        const childrenRes = await api.get('/me/children');
        const childrenData = childrenRes.data.map(c => ({
          ...c,
          firstName: c.first_name,
          lastName: c.last_name,
          homeroom: c.homeroom_name || 'Unassigned',
          dismissalType: c.dismissal_type || 'car',
        }));
        if (cancelled) return;
        setChildren(childrenData);

        // Fetch authorized pickups for each child and merge
        const allPickups = [];
        const seenIds = new Set();
        for (const child of childrenData) {
          try {
            const pickupsRes = await api.get(`/students/${child.id}/pickups`);
            for (const p of pickupsRes.data) {
              if (!seenIds.has(p.id)) {
                seenIds.add(p.id);
                allPickups.push(p);
              }
            }
          } catch {
            // Non-critical; continue with other children
          }
        }
        if (cancelled) return;
        setAuthorizedPickups(allPickups);

        // Fetch school settings for configurable warnings
        if (currentSchool?.id) {
          try {
            const settingsRes = await api.get(`/schools/${currentSchool.id}/settings`);
            if (!cancelled) setSchoolSettings(settingsRes.data || {});
          } catch { /* non-critical */ }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.response?.data?.message || 'Failed to load data. Please try again.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchData();
    return () => { cancelled = true; };
  }, []);

  // Get or create dismissal session when school is known
  useEffect(() => {
    if (!currentSchool?.id) return;
    let cancelled = false;
    async function initSession() {
      try {
        const res = await api.post(`/schools/${currentSchool.id}/sessions`);
        if (cancelled) return;
        const sid = res.data.id;
        setSessionId(sid);

        // Check if children are already in the queue (e.g. parent reopens app)
        if (children.length > 0) {
          try {
            const queueRes = await api.get(`/sessions/${sid}/queue`);
            if (cancelled) return;
            const childIds = children.map(c => c.id);
            const myQueue = queueRes.data.filter(q =>
              childIds.includes(q.student_id) && q.status !== 'dismissed'
            );
            if (myQueue.length > 0) {
              setQueueIds(myQueue.map(q => q.id));
              const statuses = myQueue.map(q => q.status);
              if (statuses.includes('released')) {
                setCheckInStatus('called');
              } else {
                setCheckInStatus('queued');
              }
            }
          } catch {
            // Non-critical; queue check failed
          }
        }
      } catch {
        // Session may not be active yet; non-critical
      }
    }
    initSession();
    return () => { cancelled = true; };
  }, [currentSchool, children]);

  // Update time
  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Join socket room
  useEffect(() => {
    if (!socket || !currentSchool?.id) return;
    socket.emit('join:school', { schoolId: currentSchool.id, role: 'parent' });
  }, [socket, currentSchool?.id]);

  // Socket events
  useEffect(() => {
    if (!socket) return;

    const handleStudentCalled = (data) => {
      const studentId = data.student_id || data.studentId;
      const queueId = data.id || data.queueId;
      const childIds = children.map(c => c.id);
      if (childIds.includes(studentId)) {
        setCheckInStatus('called');
        setQueuePosition(0);
        if (queueId) setQueueIds(prev => [...new Set([...prev, queueId])]);
      }
    };

    const handleStudentDismissed = (data) => {
      const studentId = data.student_id || data.studentId;
      const childIds = children.map(c => c.id);
      if (childIds.includes(studentId)) {
        setCheckInStatus('complete');
        setQueueIds([]);
        setTimeout(() => {
          setCheckInStatus(null);
          setQueuePosition(null);
          setEstimatedWait(null);
        }, 10000);
      }
    };

    const handleQueueUpdated = (data) => {
      if (data.position != null) setQueuePosition(data.position);
      if (data.estimatedWait != null) setEstimatedWait(data.estimatedWait);
    };

    socket.on('student:called', handleStudentCalled);
    socket.on('student:dismissed', handleStudentDismissed);
    socket.on('queue:updated', handleQueueUpdated);

    return () => {
      socket.off('student:called', handleStudentCalled);
      socket.off('student:dismissed', handleStudentDismissed);
      socket.off('queue:updated', handleQueueUpdated);
    };
  }, [socket, children]);

  // Cancel check-in
  const cancelCheckIn = () => {
    setCheckInStatus(null);
    setQueuePosition(null);
    setEstimatedWait(null);
  };

  // Complete pickup (confirmation from parent side - calls server)
  const completePickup = async () => {
    try {
      // Dismiss all queued children on server
      for (const qId of queueIds) {
        await api.post(`/queue/${qId}/dismiss`);
      }
    } catch (err) {
      console.error('Failed to complete pickup:', err);
    }
    setCheckInStatus('complete');
    setQueueIds([]);
    setTimeout(() => {
      setCheckInStatus(null);
      setQueuePosition(null);
      setEstimatedWait(null);
    }, 3000);
  };

  // Change request handler
  const handleChangeSubmit = async ({ changes, note }) => {
    if (!sessionId) return;
    setChangeError(null);
    try {
      await api.post(`/sessions/${sessionId}/changes`, { changes, note });
      setShowChangeRequest(false);
    } catch (err) {
      setChangeError(err.response?.data?.message || 'Failed to submit change request.');
    }
  };

  // Get dismissal type icon
  const getDismissalIcon = (type) => {
    switch (type) {
      case 'car': return Car;
      case 'bus': return Bus;
      case 'walker': return PersonStanding;
      case 'afterschool': return Clock;
      default: return Car;
    }
  };

  const carRiderChildren = children.filter(c => c.dismissalType === 'car');

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-10 h-10 text-indigo-600 animate-spin mx-auto mb-4" />
          <p className="text-gray-500">Loading...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <Card className="p-6 max-w-sm w-full text-center">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <p className="font-semibold text-lg mb-2">Something went wrong</p>
          <p className="text-gray-500 text-sm mb-4">{error}</p>
          <Button variant="primary" onClick={() => window.location.reload()}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Retry
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Home View */}
      {currentView === 'home' && (
        <>
          {/* Header */}
          <header className="bg-indigo-600 text-white px-4 pt-12 pb-6 rounded-b-3xl">
            <div className="flex items-center justify-between mb-6">
              <div>
                <p className="text-indigo-200 text-sm">Good afternoon,</p>
                <h1 className="text-xl font-bold">{user.first_name}</h1>
                <p className="text-indigo-200 text-xs">{currentSchool?.name}</p>
              </div>
              <div className="flex items-center gap-3">
                {currentSchool?.carNumber && (
                  <div className="bg-white/20 rounded-xl px-3 py-2 text-center">
                    <p className="text-indigo-200 text-[10px]">Car #</p>
                    <p className="text-lg font-bold leading-tight">{currentSchool.carNumber}</p>
                  </div>
                )}
                <button
                  onClick={() => setCurrentView('settings')}
                  className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center"
                >
                  <User className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Dismissal Time */}
            <div className="bg-white/10 rounded-xl p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-indigo-200 text-sm">Dismissal Time</p>
                  <p className="text-2xl font-bold">3:00 PM</p>
                </div>
                <div className="text-right">
                  <p className="text-indigo-200 text-sm">Current Time</p>
                  <p className="text-2xl font-bold">
                    {currentTime.toLocaleTimeString([], { timeZone: currentSchool?.timezone, hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            </div>
          </header>

          <main className="px-4 -mt-4 pb-24">
            {/* Check-in error */}
            {checkInError && (
              <Card className="p-4 mb-4 border-red-200 bg-red-50">
                <div className="flex items-center gap-3">
                  <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
                  <p className="text-sm text-red-700">{checkInError}</p>
                  <button onClick={() => setCheckInError(null)} className="ml-auto">
                    <X className="w-4 h-4 text-red-400" />
                  </button>
                </div>
              </Card>
            )}

            {/* Check-In Card */}
            {!checkInStatus && (
              <Card className="p-6 mb-4">
                <h2 className="font-semibold mb-4">Ready for Pickup?</h2>

                {/* Children for pickup */}
                <div className="space-y-2 mb-4">
                  {carRiderChildren.map(child => (
                    <div key={child.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                      <div className="w-10 h-10 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-600 font-medium">
                        {child.firstName[0]}
                      </div>
                      <div className="flex-1">
                        <p className="font-medium">{child.firstName}</p>
                        <p className="text-sm text-gray-500">Grade {child.grade} • {child.homeroom}</p>
                      </div>
                      <Badge variant="blue">
                        <Car className="w-3 h-3" />
                        Car
                      </Badge>
                    </div>
                  ))}
                </div>

                {schoolSettings.enableQrCodes && currentSchool?.carNumber ? (
                  <p className="text-sm text-center text-gray-400 mt-2">
                    Tap the QR button below to show your check-in code
                  </p>
                ) : (
                  <p className="text-sm text-center text-gray-400 mt-2">
                    Office staff will enter your car number to check you in
                  </p>
                )}
              </Card>
            )}

            {/* In Queue */}
            {checkInStatus === 'queued' && (
              <Card className="p-6 mb-4 border-2 border-indigo-200 bg-indigo-50">
                <div className="text-center">
                  <Badge variant="blue" size="md" className="mb-4">In Queue</Badge>
                  <div className="w-24 h-24 bg-white rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg">
                    <span className="text-4xl font-bold text-indigo-600">#{queuePosition}</span>
                  </div>
                  <p className="font-semibold text-lg">You're in line!</p>
                  <p className="text-sm text-gray-600 mb-4">
                    Estimated wait: <span className="font-semibold">{estimatedWait} min</span>
                  </p>

                  <div className="bg-white rounded-xl p-4 mb-4">
                    <p className="text-sm text-gray-500 mb-2">Picking up:</p>
                    <div className="flex justify-center gap-2">
                      {carRiderChildren.map(child => (
                        <Badge key={child.id} variant="default">{child.firstName}</Badge>
                      ))}
                    </div>
                  </div>

                  <Button variant="ghost" size="sm" onClick={cancelCheckIn}>
                    Cancel Check-in
                  </Button>
                </div>
              </Card>
            )}

            {/* Called - Ready for Pickup */}
            {checkInStatus === 'called' && (
              <Card className="p-6 mb-4 border-2 border-green-400 bg-green-50">
                <div className="text-center">
                  <div className="w-20 h-20 bg-green-500 rounded-full flex items-center justify-center mx-auto mb-4 animate-bounce">
                    <CheckCircle2 className="w-10 h-10 text-white" />
                  </div>
                  <p className="font-bold text-xl text-green-800">Proceed to Zone B</p>
                  <p className="text-green-600 mb-6">Your children are on their way!</p>

                  <div className="bg-white rounded-xl p-4 mb-4">
                    {carRiderChildren.map(child => (
                      <div key={child.id} className="flex items-center justify-between py-2">
                        <span className="font-medium">{child.firstName}</span>
                        <Badge variant="green">On the way</Badge>
                      </div>
                    ))}
                  </div>

                  <Button variant="success" size="lg" className="w-full" onClick={completePickup}>
                    <Check className="w-5 h-5 mr-2" />
                    Pickup Complete
                  </Button>
                </div>
              </Card>
            )}

            {/* Pickup Complete */}
            {checkInStatus === 'complete' && (
              <Card className="p-6 mb-4 bg-green-500 text-white">
                <div className="text-center py-4">
                  <CheckCircle2 className="w-16 h-16 mx-auto mb-4" />
                  <p className="font-bold text-xl">Pickup Complete!</p>
                  <p className="text-green-100">Have a great day!</p>
                </div>
              </Card>
            )}

            {/* Quick Actions */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <Card className="p-4" onClick={() => setShowChangeRequest(true)}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-yellow-100 rounded-xl flex items-center justify-center">
                    <Edit className="w-5 h-5 text-yellow-600" />
                  </div>
                  <div>
                    <p className="font-medium text-sm">Change</p>
                    <p className="text-xs text-gray-500">Today's pickup</p>
                  </div>
                </div>
              </Card>
              <Card className="p-4" onClick={() => setCurrentView('history')}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-purple-100 rounded-xl flex items-center justify-center">
                    <History className="w-5 h-5 text-purple-600" />
                  </div>
                  <div>
                    <p className="font-medium text-sm">History</p>
                    <p className="text-xs text-gray-500">Past pickups</p>
                  </div>
                </div>
              </Card>
            </div>

            {/* Children */}
            <Card className="mb-4">
              <div className="p-4 border-b flex items-center justify-between">
                <h3 className="font-semibold">My Children</h3>
                <button className="text-indigo-600 text-sm font-medium">Manage</button>
              </div>
              <div className="divide-y">
                {children.map(child => {
                  const DismissalIcon = getDismissalIcon(child.dismissalType);
                  return (
                    <div
                      key={child.id}
                      className="p-4 flex items-center justify-between"
                      onClick={() => {
                        setSelectedChild(child);
                        setCurrentView('child-detail');
                      }}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-600 font-bold">
                          {child.firstName[0]}
                        </div>
                        <div>
                          <p className="font-medium">{child.firstName} {child.lastName}</p>
                          <p className="text-sm text-gray-500">Grade {child.grade} • {child.homeroom}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={child.dismissalType === 'car' ? 'blue' : child.dismissalType === 'bus' ? 'yellow' : 'green'}>
                          <DismissalIcon className="w-3 h-3" />
                          {child.dismissalType}
                        </Badge>
                        <ChevronRight className="w-4 h-4 text-gray-400" />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* Authorized Pickups */}
            <Card>
              <div className="p-4 border-b flex items-center justify-between">
                <h3 className="font-semibold">Authorized Pickups</h3>
                <button className="text-indigo-600 text-sm font-medium">
                  <Plus className="w-4 h-4 inline mr-1" />
                  Add
                </button>
              </div>
              <div className="divide-y">
                {authorizedPickups.map(pickup => (
                  <div key={pickup.id} className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center">
                        <User className="w-5 h-5 text-gray-500" />
                      </div>
                      <div>
                        <p className="font-medium">{pickup.name}</p>
                        <p className="text-sm text-gray-500">{pickup.relationship}</p>
                      </div>
                    </div>
                    <Badge variant="green" size="sm">Approved</Badge>
                  </div>
                ))}
              </div>
            </Card>
          </main>

          {/* Bottom Navigation */}
          <nav className="fixed bottom-0 left-0 right-0 bg-white border-t px-4 py-2">
            <div className="flex items-center justify-around">
              {[
                { id: 'home', icon: Home, label: 'Home' },
                { id: 'children', icon: Users, label: 'Children' },
              ].map(item => (
                <button
                  key={item.id}
                  onClick={() => setCurrentView(item.id)}
                  className={`flex flex-col items-center py-2 px-4 rounded-lg ${
                    currentView === item.id ? 'text-indigo-600' : 'text-gray-400'
                  }`}
                >
                  <item.icon className="w-6 h-6" />
                  <span className="text-xs mt-1">{item.label}</span>
                </button>
              ))}

              {/* QR Code Button */}
              <button
                onClick={() => {
                  if (schoolSettings.enableQrCodes && currentSchool?.carNumber) {
                    setShowQrModal(true);
                  }
                }}
                className={`flex flex-col items-center py-2 px-4 rounded-lg ${
                  schoolSettings.enableQrCodes && currentSchool?.carNumber
                    ? 'text-indigo-600'
                    : 'text-gray-300 cursor-not-allowed'
                }`}
              >
                <QrCode className="w-6 h-6" />
                <span className="text-xs mt-1">QR Code</span>
              </button>

              {[
                { id: 'history', icon: History, label: 'History' },
                { id: 'settings', icon: Settings, label: 'Settings' },
              ].map(item => (
                <button
                  key={item.id}
                  onClick={() => setCurrentView(item.id)}
                  className={`flex flex-col items-center py-2 px-4 rounded-lg ${
                    currentView === item.id ? 'text-indigo-600' : 'text-gray-400'
                  }`}
                >
                  <item.icon className="w-6 h-6" />
                  <span className="text-xs mt-1">{item.label}</span>
                </button>
              ))}
            </div>
          </nav>

          {/* QR Code Modal */}
          {showQrModal && currentSchool?.carNumber && (
            <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowQrModal(false)}>
              <div className="bg-white rounded-3xl shadow-xl w-full max-w-sm p-6 text-center" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-bold text-lg">Check-in QR Code</h2>
                  <button onClick={() => setShowQrModal(false)} className="p-2">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <p className="text-sm text-gray-500 mb-4">Show this to office staff at pickup</p>
                <div className="inline-block p-4 bg-white rounded-2xl shadow-lg border mb-4">
                  <QRCodeSVG
                    value={`gopilot://checkin?car=${currentSchool.carNumber}&school=${currentSchool.slug}`}
                    size={220}
                    level="M"
                  />
                </div>
                <div>
                  <Badge variant="blue" size="md">
                    <Car className="w-3 h-3" />
                    Car #{currentSchool.carNumber}
                  </Badge>
                </div>
              </div>
            </div>
          )}

          {/* Change Request Modal */}
          {showChangeRequest && (
            <ChangeRequestModal
              children={children}
              onClose={() => { setShowChangeRequest(false); setChangeError(null); }}
              onSubmit={handleChangeSubmit}
              error={changeError}
              schoolSettings={schoolSettings}
            />
          )}
        </>
      )}

      {/* History View */}
      {currentView === 'history' && (
        <div className="min-h-screen bg-gray-50">
          <header className="bg-white border-b px-4 py-4 sticky top-0">
            <div className="flex items-center gap-4">
              <button onClick={() => setCurrentView('home')} className="p-2 -ml-2">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h1 className="font-bold text-lg">Pickup History</h1>
            </div>
          </header>

          <main className="p-4 pb-24">
            <div className="space-y-3">
              {history.map((item, index) => (
                <Card key={index} className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="font-medium">
                      {new Date(item.date).toLocaleDateString([], { timeZone: currentSchool?.timezone, weekday: 'long', month: 'short', day: 'numeric' })}
                    </p>
                    <Badge variant="green" size="sm">Complete</Badge>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2 text-gray-500">
                      <Car className="w-4 h-4" />
                      <span>{Array.isArray(item.children) ? item.children.join(', ') : item.children}</span>
                    </div>
                    <div className="text-gray-500">
                      {item.pickupTime} • {item.waitTime} wait
                    </div>
                  </div>
                </Card>
              ))}
              {history.length === 0 && (
                <div className="text-center py-12 text-gray-400">
                  <History className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>No pickup history yet</p>
                </div>
              )}
            </div>
          </main>

          {/* Bottom Navigation */}
          <nav className="fixed bottom-0 left-0 right-0 bg-white border-t px-4 py-2">
            <div className="flex items-center justify-around">
              {[
                { id: 'home', icon: Home, label: 'Home' },
                { id: 'children', icon: Users, label: 'Children' },
                { id: 'history', icon: History, label: 'History' },
                { id: 'settings', icon: Settings, label: 'Settings' },
              ].map(item => (
                <button
                  key={item.id}
                  onClick={() => setCurrentView(item.id)}
                  className={`flex flex-col items-center py-2 px-4 rounded-lg ${
                    currentView === item.id ? 'text-indigo-600' : 'text-gray-400'
                  }`}
                >
                  <item.icon className="w-6 h-6" />
                  <span className="text-xs mt-1">{item.label}</span>
                </button>
              ))}
            </div>
          </nav>
        </div>
      )}

      {/* Children View */}
      {currentView === 'children' && (
        <div className="min-h-screen bg-gray-50">
          <header className="bg-white border-b px-4 py-4 sticky top-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <button onClick={() => setCurrentView('home')} className="p-2 -ml-2">
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <h1 className="font-bold text-lg">My Children</h1>
              </div>
              <Button variant="primary" size="sm" onClick={() => { setShowAddChild(true); setLinkCode(''); setLinkError(''); setLinkSuccess(null); }}>
                <Plus className="w-4 h-4 mr-1" />
                Add
              </Button>
            </div>
          </header>

          <main className="p-4 pb-24">
            <div className="space-y-4">
              {children.map(child => {
                const DismissalIcon = getDismissalIcon(child.dismissalType);
                return (
                  <Card key={child.id} className="overflow-hidden">
                    <div className="p-4">
                      <div className="flex items-center gap-4 mb-4">
                        <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-600 text-xl font-bold">
                          {child.firstName[0]}{child.lastName[0]}
                        </div>
                        <div>
                          <p className="font-bold text-lg">{child.firstName} {child.lastName}</p>
                          <p className="text-gray-500">Grade {child.grade}</p>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between py-2 border-t">
                          <span className="text-gray-500">School</span>
                          <span className="font-medium">{child.school}</span>
                        </div>
                        <div className="flex items-center justify-between py-2 border-t">
                          <span className="text-gray-500">Homeroom</span>
                          <span className="font-medium">{child.homeroom}</span>
                        </div>
                        <div className="flex items-center justify-between py-2 border-t">
                          <span className="text-gray-500">Dismissal</span>
                          <Badge variant="blue">
                            <DismissalIcon className="w-3 h-3" />
                            {child.dismissalType}
                          </Badge>
                        </div>
                      </div>
                    </div>
                    <div className="bg-gray-50 px-4 py-3 flex justify-end">
                      <Button variant="secondary" size="sm">
                        <Edit className="w-4 h-4 mr-1" />
                        Edit
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>
          </main>

          {/* Add Child Modal */}
          {showAddChild && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
              <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
                {linkSuccess ? (
                  <div className="text-center">
                    <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-3" />
                    <h3 className="text-lg font-bold mb-1">Link Request Sent!</h3>
                    <p className="text-sm text-gray-600 mb-4">
                      Your request to link to <strong>{linkSuccess.firstName} {linkSuccess.lastName}</strong> has been submitted for approval.
                    </p>
                    <button onClick={() => setShowAddChild(false)} className="px-6 py-2 bg-indigo-600 text-white rounded-lg font-medium">Done</button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-lg font-bold">Add Child</h3>
                      <button onClick={() => setShowAddChild(false)} className="p-1 hover:bg-gray-100 rounded-lg">
                        <X className="w-5 h-5" />
                      </button>
                    </div>
                    <p className="text-sm text-gray-500 mb-4">Enter the student code provided by your school.</p>
                    {linkError && (
                      <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg mb-3 text-sm">
                        <AlertCircle className="w-4 h-4 flex-shrink-0" />
                        {linkError}
                      </div>
                    )}
                    <div className="space-y-3 mb-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Student Code</label>
                        <input
                          value={linkCode}
                          onChange={e => setLinkCode(e.target.value.toUpperCase())}
                          placeholder="e.g. ABC123"
                          maxLength={6}
                          className="w-full px-4 py-3 border border-gray-300 rounded-lg font-mono text-center text-lg tracking-widest focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Relationship</label>
                        <select
                          value={linkRelationship}
                          onChange={e => setLinkRelationship(e.target.value)}
                          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                        >
                          <option value="parent">Parent</option>
                          <option value="guardian">Guardian</option>
                          <option value="grandparent">Grandparent</option>
                          <option value="other">Other</option>
                        </select>
                      </div>
                    </div>
                    <button
                      onClick={async () => {
                        if (!linkCode.trim()) return;
                        setLinkLoading(true);
                        setLinkError('');
                        try {
                          const res = await api.post('/me/children/link', { code: linkCode.trim(), relationship: linkRelationship, schoolId: currentSchool?.id });
                          setLinkSuccess(res.data.student);
                        } catch (err) {
                          setLinkError(err.response?.data?.error || 'Failed to link student');
                        } finally {
                          setLinkLoading(false);
                        }
                      }}
                      disabled={linkLoading || !linkCode.trim()}
                      className="w-full py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {linkLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                      {linkLoading ? 'Linking...' : 'Link Child'}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Bottom Navigation */}
          <nav className="fixed bottom-0 left-0 right-0 bg-white border-t px-4 py-2">
            <div className="flex items-center justify-around">
              {[
                { id: 'home', icon: Home, label: 'Home' },
                { id: 'children', icon: Users, label: 'Children' },
                { id: 'history', icon: History, label: 'History' },
                { id: 'settings', icon: Settings, label: 'Settings' },
              ].map(item => (
                <button
                  key={item.id}
                  onClick={() => setCurrentView(item.id)}
                  className={`flex flex-col items-center py-2 px-4 rounded-lg ${
                    currentView === item.id ? 'text-indigo-600' : 'text-gray-400'
                  }`}
                >
                  <item.icon className="w-6 h-6" />
                  <span className="text-xs mt-1">{item.label}</span>
                </button>
              ))}
            </div>
          </nav>
        </div>
      )}

      {/* Settings View */}
      {currentView === 'settings' && (
        <div className="min-h-screen bg-gray-50">
          <header className="bg-white border-b px-4 py-4 sticky top-0">
            <div className="flex items-center gap-4">
              <button onClick={() => setCurrentView('home')} className="p-2 -ml-2">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h1 className="font-bold text-lg">Settings</h1>
            </div>
          </header>

          <main className="p-4 pb-24">
            {/* Profile */}
            <Card className="mb-4">
              <div className="p-4 flex items-center gap-4">
                <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center">
                  <User className="w-8 h-8 text-indigo-600" />
                </div>
                <div className="flex-1">
                  <p className="font-bold text-lg">{user.first_name} {user.last_name}</p>
                  <p className="text-sm text-gray-500">{user.email}</p>
                </div>
                <Button variant="secondary" size="sm">Edit</Button>
              </div>
            </Card>

            {/* Settings List */}
            <Card>
              <div className="divide-y">
                {[
                  { icon: Bell, label: 'Notifications', value: user.notification_prefs?.enabled === false ? 'Off' : 'On', onClick: () => setShowNotifications(true) },
                  { icon: Smartphone, label: 'Check-in Method', value: user.check_in_method || 'App', onClick: () => setShowCheckInMethod(true) },
                  { icon: Phone, label: 'Phone Number', value: user.phone || 'Not set', onClick: () => setShowPhoneEdit(true) },
                  { icon: Shield, label: 'Authorized Pickups', value: `${authorizedPickups.length} people`, onClick: () => setShowAuthorizedPickups(true) },
                  { icon: QrCode, label: 'My QR Code', value: '', onClick: () => setShowMyQrCode(true) },
                  ...(currentSchool?.carNumber ? [{ icon: Car, label: 'My Car Number', value: `#${currentSchool.carNumber}`, onClick: () => {} }] : []),
                ].map((item, index) => (
                  <div key={index} className="p-4 flex items-center justify-between cursor-pointer hover:bg-gray-50 active:bg-gray-100 transition-colors" onClick={item.onClick}>
                    <div className="flex items-center gap-3">
                      <item.icon className="w-5 h-5 text-gray-400" />
                      <span>{item.label}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {item.value && <span className="text-gray-500 text-sm">{item.value}</span>}
                      <ChevronRight className="w-4 h-4 text-gray-400" />
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="mt-4">
              <button
                onClick={() => { logout(); navigate('/login'); }}
                className="w-full p-4 flex items-center gap-3 text-red-600 hover:bg-red-50 transition-colors"
              >
                <LogOut className="w-5 h-5" />
                <span>Sign Out</span>
              </button>
            </Card>

            {/* Phone Number Edit Modal */}
            {showPhoneEdit && (
              <PhoneEditModal
                currentPhone={user.phone || ''}
                onClose={() => setShowPhoneEdit(false)}
                onSave={async (phone) => {
                  await api.put('/me', { phone });
                  await refetchUser();
                  setShowPhoneEdit(false);
                }}
              />
            )}

            {/* Notifications Modal */}
            {showNotifications && (
              <NotificationsModal
                prefs={user.notification_prefs || { enabled: true, dismissal: true, changes: true }}
                onClose={() => setShowNotifications(false)}
                onSave={async (prefs) => {
                  await api.put('/me', { notificationPrefs: prefs });
                  await refetchUser();
                  setShowNotifications(false);
                }}
              />
            )}

            {/* Check-in Method Modal */}
            {showCheckInMethod && (
              <CheckInMethodModal
                current={user.check_in_method || 'app'}
                onClose={() => setShowCheckInMethod(false)}
                onSave={async (method) => {
                  await api.put('/me', { checkInMethod: method });
                  await refetchUser();
                  setShowCheckInMethod(false);
                }}
              />
            )}

            {/* Authorized Pickups Modal */}
            {showAuthorizedPickups && (
              <AuthorizedPickupsModal
                pickups={authorizedPickups}
                children={children}
                onClose={() => setShowAuthorizedPickups(false)}
              />
            )}

            {/* My QR Code Modal */}
            {showMyQrCode && (
              <MyQrCodeModal
                children={children}
                schoolSlug={currentSchool?.slug || ''}
                onClose={() => setShowMyQrCode(false)}
              />
            )}
          </main>
        </div>
      )}
    </div>
  );
}

// Change Request Modal
function ChangeRequestModal({ children, onClose, onSubmit, error, schoolSettings = {} }) {
  const [changes, setChanges] = useState(
    children.reduce((acc, child) => {
      acc[child.id] = { type: child.dismissalType, busRoute: child.busRoute || '' };
      return acc;
    }, {})
  );
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const dismissalOptions = [
    { id: 'car', label: 'Car Rider', icon: Car },
    { id: 'bus', label: 'Bus', icon: Bus },
    { id: 'walker', label: 'Walker', icon: PersonStanding },
    { id: 'afterschool', label: 'After School', icon: Clock },
  ];

  const handleSubmit = async () => {
    setSubmitting(true);
    await onSubmit({ changes, note });
    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end">
      <div className="bg-white w-full rounded-t-3xl max-h-[90vh] overflow-y-auto">
        <div className="p-4 border-b sticky top-0 bg-white">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-lg">Change Today's Pickup</h2>
            <button onClick={onClose} className="p-2">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-4 space-y-6">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <div className="flex items-center gap-3">
                <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
                <p className="text-sm text-red-700">{error}</p>
              </div>
            </div>
          )}

          {children.map(child => (
            <div key={child.id}>
              <p className="font-medium mb-3">{child.firstName}</p>
              <div className="grid grid-cols-2 gap-2">
                {dismissalOptions.map(option => {
                  const isSelected = changes[child.id].type === option.id;
                  return (
                    <button
                      key={option.id}
                      onClick={() => setChanges(prev => ({
                        ...prev,
                        [child.id]: { ...prev[child.id], type: option.id }
                      }))}
                      className={`p-3 rounded-xl border-2 flex items-center gap-2 ${
                        isSelected ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200'
                      }`}
                    >
                      <option.icon className={`w-5 h-5 ${isSelected ? 'text-indigo-600' : 'text-gray-400'}`} />
                      <span className={isSelected ? 'font-medium' : ''}>{option.label}</span>
                    </button>
                  );
                })}
              </div>

              {changes[child.id].type === 'bus' && (
                <div className="mt-3">
                  <label className="block text-sm text-gray-600 mb-1">Bus Number</label>
                  <input
                    type="text"
                    value={changes[child.id].busRoute}
                    onChange={(e) => setChanges(prev => ({
                      ...prev,
                      [child.id]: { ...prev[child.id], busRoute: e.target.value }
                    }))}
                    placeholder="Enter bus number"
                    className="w-full px-4 py-2 border rounded-lg"
                  />
                </div>
              )}
            </div>
          ))}

          <div>
            <label className="block text-sm text-gray-600 mb-1">Note (optional)</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note for the school..."
              className="w-full px-4 py-2 border rounded-lg h-20"
            />
          </div>

          {schoolSettings.changeRequestWarning && (
            <div className="bg-yellow-50 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium text-yellow-800">Notice</p>
                  <p className="text-yellow-700">
                    {schoolSettings.changeRequestWarning}
                  </p>
                </div>
              </div>
            </div>
          )}

          <Button
            variant="primary"
            size="lg"
            className="w-full"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? (
              <Loader2 className="w-5 h-5 mr-2 animate-spin" />
            ) : (
              <Send className="w-5 h-5 mr-2" />
            )}
            {submitting ? 'Submitting...' : 'Submit Change Request'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Phone Edit Modal
function PhoneEditModal({ currentPhone, onClose, onSave }) {
  const [phone, setPhone] = useState(currentPhone);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await onSave(phone);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update phone number');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end">
      <div className="bg-white w-full rounded-t-3xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bold text-lg">Phone Number</h2>
          <button onClick={onClose} className="p-2"><X className="w-5 h-5" /></button>
        </div>
        {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
        <input
          type="tel"
          value={phone}
          onChange={e => setPhone(e.target.value)}
          placeholder="(555) 123-4567"
          className="w-full px-4 py-3 border border-gray-300 rounded-xl mb-4 text-lg"
        />
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full py-3 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// Notifications Modal
function NotificationsModal({ prefs, onClose, onSave }) {
  const [local, setLocal] = useState({
    enabled: prefs.enabled !== false,
    dismissal: prefs.dismissal !== false,
    changes: prefs.changes !== false,
  });
  const [saving, setSaving] = useState(false);

  const toggle = (key) => setLocal(p => ({ ...p, [key]: !p[key] }));

  const handleSave = async () => {
    setSaving(true);
    try { await onSave(local); } catch { setSaving(false); }
  };

  const Toggle = ({ on, onToggle }) => (
    <button onClick={onToggle} className={`w-12 h-7 rounded-full transition-colors ${on ? 'bg-indigo-600' : 'bg-gray-300'} relative`}>
      <div className={`w-5 h-5 bg-white rounded-full absolute top-1 transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end">
      <div className="bg-white w-full rounded-t-3xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bold text-lg">Notifications</h2>
          <button onClick={onClose} className="p-2"><X className="w-5 h-5" /></button>
        </div>
        <div className="space-y-4 mb-6">
          <div className="flex items-center justify-between">
            <div><p className="font-medium">All Notifications</p><p className="text-sm text-gray-500">Enable or disable all</p></div>
            {/* eslint-disable-next-line react-hooks/static-components */}
            <Toggle on={local.enabled} onToggle={() => toggle('enabled')} />
          </div>
          <div className="flex items-center justify-between">
            <div><p className="font-medium">Dismissal Updates</p><p className="text-sm text-gray-500">When your child is released</p></div>
            {/* eslint-disable-next-line react-hooks/static-components */}
            <Toggle on={local.dismissal && local.enabled} onToggle={() => toggle('dismissal')} />
          </div>
          <div className="flex items-center justify-between">
            <div><p className="font-medium">Change Requests</p><p className="text-sm text-gray-500">Status of your requests</p></div>
            {/* eslint-disable-next-line react-hooks/static-components */}
            <Toggle on={local.changes && local.enabled} onToggle={() => toggle('changes')} />
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full py-3 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// Check-in Method Modal
function CheckInMethodModal({ current, onClose, onSave }) {
  const [method, setMethod] = useState(current);
  const [saving, setSaving] = useState(false);

  const options = [
    { id: 'app', label: 'App', description: 'Tap "I\'m Here" in the app', icon: Smartphone },
    { id: 'qr', label: 'QR Code', description: 'Show QR code at pickup', icon: QrCode },
  ];

  const handleSave = async () => {
    setSaving(true);
    try { await onSave(method); } catch { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end">
      <div className="bg-white w-full rounded-t-3xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bold text-lg">Check-in Method</h2>
          <button onClick={onClose} className="p-2"><X className="w-5 h-5" /></button>
        </div>
        <div className="space-y-3 mb-6">
          {options.map(opt => (
            <button
              key={opt.id}
              onClick={() => setMethod(opt.id)}
              className={`w-full p-4 rounded-xl border-2 flex items-center gap-4 text-left ${method === opt.id ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200'}`}
            >
              <opt.icon className={`w-6 h-6 ${method === opt.id ? 'text-indigo-600' : 'text-gray-400'}`} />
              <div>
                <p className="font-medium">{opt.label}</p>
                <p className="text-sm text-gray-500">{opt.description}</p>
              </div>
              {method === opt.id && <CheckCircle2 className="w-5 h-5 text-indigo-600 ml-auto" />}
            </button>
          ))}
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full py-3 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// Authorized Pickups Modal
function AuthorizedPickupsModal({ pickups, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end">
      <div className="bg-white w-full rounded-t-3xl max-h-[85vh] overflow-y-auto">
        <div className="p-4 border-b sticky top-0 bg-white flex items-center justify-between">
          <h2 className="font-bold text-lg">Authorized Pickups</h2>
          <button onClick={onClose} className="p-2"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4">
          {pickups.length === 0 ? (
            <p className="text-gray-500 text-center py-8">No authorized pickups added yet. Contact your school to add authorized pickup persons.</p>
          ) : (
            <div className="space-y-3">
              {pickups.map(p => (
                <div key={p.id} className="p-4 bg-gray-50 rounded-xl flex items-center gap-4">
                  <div className="w-10 h-10 bg-indigo-100 rounded-full flex items-center justify-center">
                    <User className="w-5 h-5 text-indigo-600" />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium">{p.name}</p>
                    <p className="text-sm text-gray-500">{p.relationship}{p.phone ? ` • ${p.phone}` : ''}</p>
                  </div>
                  <Badge variant={p.status === 'active' ? 'green' : 'yellow'} size="sm">{p.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// My QR Code Modal
function MyQrCodeModal({ children, schoolSlug, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end">
      <div className="bg-white w-full rounded-t-3xl max-h-[85vh] overflow-y-auto">
        <div className="p-4 border-b sticky top-0 bg-white flex items-center justify-between">
          <h2 className="font-bold text-lg">My QR Codes</h2>
          <button onClick={onClose} className="p-2"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4">
          {children.length === 0 ? (
            <p className="text-gray-500 text-center py-8">No children linked yet.</p>
          ) : (
            <div className="space-y-6">
              <p className="text-sm text-gray-500 text-center">Show these QR codes to other parents/guardians so they can link to your children.</p>
              {children.map(child => (
                <div key={child.id} className="text-center p-4 bg-gray-50 rounded-xl">
                  <p className="font-bold text-lg mb-1">{child.firstName} {child.lastName}</p>
                  <p className="text-sm text-gray-500 mb-3">{child.homeroom} • Code: {child.student_code}</p>
                  <div className="flex justify-center">
                    <QRCodeSVG
                      value={`${window.location.origin}/gopilot/link?school=${schoolSlug}&code=${child.student_code}`}
                      size={180}
                      level="M"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
