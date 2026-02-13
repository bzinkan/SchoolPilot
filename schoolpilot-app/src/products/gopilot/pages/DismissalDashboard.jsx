import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGoPilotAuth } from '../../../hooks/useGoPilotAuth';
import { useSocket } from '../../../contexts/SocketContext';
import api from '../../../shared/utils/api';
import {
  Car, Bus, PersonStanding, Clock, Users, Search, Bell, AlertTriangle,
  Check, X, ChevronRight, ChevronDown, Phone, MapPin, Play, Pause,
  Volume2, VolumeX, RefreshCw, Filter, MoreVertical, CheckCircle2,
  AlertCircle, Timer, UserCheck, Send, ArrowRight, Shield, Eye,
  Smartphone, QrCode, MessageSquare, Home, Settings, LogOut, Menu,
  Zap, TrendingUp, Calendar, Download, Plus, Edit, Trash2
} from 'lucide-react';

const Badge = ({ children, variant = 'default', size = 'md', dot = false }) => {
  const variants = {
    default: 'bg-gray-100 text-gray-800', blue: 'bg-blue-100 text-blue-800',
    green: 'bg-green-100 text-green-800', yellow: 'bg-yellow-100 text-yellow-800',
    red: 'bg-red-100 text-red-800', purple: 'bg-purple-100 text-purple-800',
    orange: 'bg-orange-100 text-orange-800',
  };
  const sizes = { sm: 'px-2 py-0.5 text-xs', md: 'px-2.5 py-1 text-sm' };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-medium ${variants[variant]} ${sizes[size]}`}>
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current" />}
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

export default function DismissalDashboard() {
  const { user, logout, currentSchool, currentRole } = useGoPilotAuth();
  const socket = useSocket();
  const navigate = useNavigate();

  const [currentTime, setCurrentTime] = useState(new Date());
  const [session, setSession] = useState(null);
  const [dismissalActive, setDismissalActive] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [selectedView, setSelectedView] = useState('queue');
  const [queueTab, setQueueTab] = useState('active'); // 'active' or 'dismissed'
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [queue, setQueue] = useState([]);
  const [stats, setStats] = useState({ waiting: 0, called: 0, released: 0, dismissed: 0, held: 0, total: 0, avg_wait_seconds: null });
  const [homerooms, setHomerooms] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pickupZones, setPickupZones] = useState([]);
  const [selectedZone, setSelectedZone] = useState(null);
  const [showZoneManager, setShowZoneManager] = useState(false);
  const [zoneSaving, setZoneSaving] = useState(false);
  const [carNumberInput, setCarNumberInput] = useState('');
  const [carNumberLoading, setCarNumberLoading] = useState(false);
  const [carNumberResult, setCarNumberResult] = useState(null); // { type: 'success'|'error', message };
  const [showQrScanner, setShowQrScanner] = useState(false);
  const [busNumberInput, setBusNumberInput] = useState('');
  const [busNumberLoading, setBusNumberLoading] = useState(false);
  const [busNumberResult, setBusNumberResult] = useState(null);
  const [busQueueTab, setBusQueueTab] = useState('active'); // 'active' or 'dismissed'

  // Walker state
  const [walkerViewTab, setWalkerViewTab] = useState('grade'); // 'grade' or 'homeroom'
  const [walkerQueueTab, setWalkerQueueTab] = useState('active'); // 'active' or 'dismissed'
  const [selectedGrades, setSelectedGrades] = useState([]);
  const [selectedWalkerHomerooms, setSelectedWalkerHomerooms] = useState([]);
  const [walkerStudents, setWalkerStudents] = useState([]); // All walker students from roster

  // Student lookup state
  const [showStudentLookup, setShowStudentLookup] = useState(false);
  const [studentSearchTerm, setStudentSearchTerm] = useState('');
  const [studentSearchResults, setStudentSearchResults] = useState([]);
  const [studentSearchLoading, setStudentSearchLoading] = useState(false);
  const studentSearchTimeout = useRef(null);

  // Initialize session and load data
  const loadData = useCallback(async () => {
    if (!currentSchool) return;
    try {
      setLoading(true);
      const sessionRes = await api.post(`/schools/${currentSchool.id}/sessions`);
      setSession(sessionRes.data);
      setDismissalActive(sessionRes.data.status === 'active');

      const [queueRes, statsRes, homeroomRes, alertsRes, settingsRes] = await Promise.all([
        api.get(`/sessions/${sessionRes.data.id}/queue`),
        api.get(`/sessions/${sessionRes.data.id}/stats`),
        api.get(`/schools/${currentSchool.id}/homerooms`),
        api.get(`/schools/${currentSchool.id}/custody-alerts`),
        api.get(`/schools/${currentSchool.id}/settings`),
      ]);

      setQueue(queueRes.data);
      setStats(statsRes.data);
      setHomerooms(homeroomRes.data);
      setAlerts(alertsRes.data);
      const zones = settingsRes.data.pickupZones || [
        { id: 'A', name: 'Zone A' }, { id: 'B', name: 'Zone B' }, { id: 'C', name: 'Zone C' }
      ];
      setPickupZones(zones);
      if (zones.length > 0 && !selectedZone) setSelectedZone(zones[0].id);
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
    } finally {
      setLoading(false);
    }
  }, [currentSchool]);

  useEffect(() => { loadData(); }, [loadData]);

  // Clock
  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Socket listeners
  useEffect(() => {
    if (!socket || !currentSchool) return;
    socket.emit('join:school', { schoolId: currentSchool.id, role: 'admin' });

    const handleQueueUpdate = () => {
      if (session) {
        api.get(`/sessions/${session.id}/queue`).then(r => setQueue(r.data));
        api.get(`/sessions/${session.id}/stats`).then(r => setStats(r.data));
      }
    };

    socket.on('queue:updated', handleQueueUpdate);
    socket.on('student:called', handleQueueUpdate);
    socket.on('student:released', handleQueueUpdate);
    socket.on('student:dismissed', handleQueueUpdate);
    socket.on('change:requested', () => { /* could show notification */ });

    return () => {
      socket.off('queue:updated', handleQueueUpdate);
      socket.off('student:called', handleQueueUpdate);
      socket.off('student:released', handleQueueUpdate);
      socket.off('student:dismissed', handleQueueUpdate);
      socket.off('change:requested');
    };
  }, [socket, currentSchool, session]);

  // Actions
  const handleToggleDismissal = async () => {
    if (!session) return;
    const newStatus = dismissalActive ? 'paused' : 'active';
    await api.put(`/sessions/${session.id}`, { status: newStatus });
    setDismissalActive(!dismissalActive);
  };

  const handleCallStudent = async (queueId) => {
    if (!session) return;
    await api.post(`/sessions/${session.id}/call`, { queueId, zone: selectedZone || pickupZones[0]?.id });
    await refreshQueue();
  };

  const handleMarkPickedUp = async (queueId) => {
    await api.post(`/queue/${queueId}/dismiss`);
    await refreshQueue();
  };

  const handlePickupAll = async (students) => {
    const eligible = students.filter(s => s.status === 'waiting' || s.status === 'called' || s.status === 'released');
    if (eligible.length === 0) return;
    await api.post('/queue/dismiss-batch', { queueIds: eligible.map(s => s.id) });
    await refreshQueue();
  };

  const [walkerLoading, setWalkerLoading] = useState(false);
  const [walkerResult, setWalkerResult] = useState(null);
  const handleReleaseWalkers = async () => {
    if (!session) return;
    setWalkerLoading(true);
    setWalkerResult(null);
    try {
      const res = await api.post(`/sessions/${session.id}/release-walkers`);
      if (res.data.alreadySubmitted) {
        setWalkerResult({ type: 'info', message: 'Walkers already dismissed' });
      } else {
        setWalkerResult({ type: 'success', message: `Dismissed ${res.data.entries.length} walker students` });
        await refreshQueue();
      }
      setTimeout(() => setWalkerResult(null), 5000);
    } catch (err) {
      setWalkerResult({ type: 'error', message: err.response?.data?.error || 'Failed to dismiss walkers' });
    } finally {
      setWalkerLoading(false);
    }
  };

  const handleReleaseSelectedWalkers = async () => {
    if (!session) return;
    const filterType = walkerViewTab; // 'grade' or 'homeroom'
    const filterValues = walkerViewTab === 'grade' ? selectedGrades : selectedWalkerHomerooms;
    if (filterValues.length === 0) {
      setWalkerResult({ type: 'error', message: `Please select at least one ${filterType}` });
      setTimeout(() => setWalkerResult(null), 3000);
      return;
    }
    setWalkerLoading(true);
    setWalkerResult(null);
    try {
      const res = await api.post(`/sessions/${session.id}/release-walkers-by-filter`, { filterType, filterValues });
      if (res.data.entries.length === 0) {
        setWalkerResult({ type: 'info', message: 'No walker students to dismiss for selected ' + filterType + 's' });
      } else {
        setWalkerResult({ type: 'success', message: `Dismissed ${res.data.entries.length} walker students` });
        await refreshQueue();
      }
      setSelectedGrades([]);
      setSelectedWalkerHomerooms([]);
      setTimeout(() => setWalkerResult(null), 5000);
    } catch (err) {
      setWalkerResult({ type: 'error', message: err.response?.data?.error || 'Failed to dismiss walkers' });
    } finally {
      setWalkerLoading(false);
    }
  };

  const toggleGradeSelection = (grade) => {
    setSelectedGrades(prev => prev.includes(grade) ? prev.filter(g => g !== grade) : [...prev, grade]);
  };

  const toggleHomeroomSelection = (homeroomId) => {
    setSelectedWalkerHomerooms(prev => prev.includes(homeroomId) ? prev.filter(h => h !== homeroomId) : [...prev, homeroomId]);
  };

  const handleCallNextBatch = async () => {
    if (!session) return;
    await api.post(`/sessions/${session.id}/call-batch`, { count: 3, zone: selectedZone || pickupZones[0]?.id });
    await refreshQueue();
  };

  const handleSaveZones = async (zones) => {
    if (!currentSchool) return;
    setZoneSaving(true);
    try {
      const settingsRes = await api.get(`/schools/${currentSchool.id}/settings`);
      const settings = settingsRes.data;
      settings.pickupZones = zones;
      await api.put(`/schools/${currentSchool.id}/settings`, settings);
      setPickupZones(zones);
      if (zones.length > 0 && !zones.find(z => z.id === selectedZone)) {
        setSelectedZone(zones[0].id);
      }
      setShowZoneManager(false);
    } catch (err) {
      console.error('Failed to save zones:', err);
    } finally {
      setZoneSaving(false);
    }
  };

  const handleCarNumberCheckIn = async () => {
    if (!carNumberInput.trim() || !session) return;
    setCarNumberLoading(true);
    setCarNumberResult(null);
    try {
      const res = await api.post(`/sessions/${session.id}/check-in-by-number`, { carNumber: carNumberInput.trim() });
      if (res.data.alreadySubmitted) {
        setCarNumberResult({ type: 'info', message: 'Car ID already submitted' });
        setCarNumberInput('');
        setTimeout(() => setCarNumberResult(null), 5000);
      } else {
        const names = res.data.entries.map(e => `${e.first_name} ${e.last_name}`).join(', ');
        const label = res.data.parent ? `${res.data.parent.firstName} ${res.data.parent.lastName}` : `Car #${res.data.carNumber}`;
        setCarNumberResult({ type: 'success', message: `${label} — checked in: ${names}` });
        setCarNumberInput('');
        await refreshQueue();
        setTimeout(() => setCarNumberResult(null), 5000);
      }
    } catch (err) {
      setCarNumberResult({ type: 'error', message: err.response?.data?.error || 'Check-in failed' });
    } finally {
      setCarNumberLoading(false);
    }
  };

  const handleBusNumberCheckIn = async () => {
    if (!busNumberInput.trim() || !session) return;
    setBusNumberLoading(true);
    setBusNumberResult(null);
    try {
      const res = await api.post(`/sessions/${session.id}/check-in-by-bus`, { busNumber: busNumberInput.trim() });
      if (res.data.alreadySubmitted) {
        setBusNumberResult({ type: 'info', message: 'Bus # already submitted' });
        setBusNumberInput('');
        setTimeout(() => setBusNumberResult(null), 5000);
      } else {
        const names = res.data.entries.map(e => `${e.first_name} ${e.last_name}`).join(', ');
        setBusNumberResult({ type: 'success', message: `Bus #${res.data.busNumber} — checked in: ${names}` });
        setBusNumberInput('');
        await refreshQueue();
        setTimeout(() => setBusNumberResult(null), 5000);
      }
    } catch (err) {
      setBusNumberResult({ type: 'error', message: err.response?.data?.error || 'Check-in failed' });
    } finally {
      setBusNumberLoading(false);
    }
  };

  const handleQrScanned = (decodedText) => {
    setShowQrScanner(false);
    // Parse gopilot://checkin?car=142&school=demo
    let carNumber = null;
    try {
      const url = new URL(decodedText);
      carNumber = url.searchParams.get('car');
    } catch {
      // Try plain number
      const match = decodedText.match(/\d+/);
      if (match) carNumber = match[0];
    }
    if (carNumber) {
      setCarNumberInput(carNumber);
      // Auto-submit after a tick so state updates
      setTimeout(async () => {
        setCarNumberLoading(true);
        setCarNumberResult(null);
        try {
          const res = await api.post(`/sessions/${session.id}/check-in-by-number`, { carNumber });
          if (res.data.alreadySubmitted) {
            setCarNumberResult({ type: 'info', message: 'Car ID already submitted' });
            setCarNumberInput('');
            setTimeout(() => setCarNumberResult(null), 5000);
          } else {
            const names = res.data.entries.map(e => `${e.first_name} ${e.last_name}`).join(', ');
            const label = res.data.parent ? `${res.data.parent.firstName} ${res.data.parent.lastName}` : `Car #${res.data.carNumber}`;
            setCarNumberResult({ type: 'success', message: `${label} — checked in: ${names}` });
            setCarNumberInput('');
            await refreshQueue();
            setTimeout(() => setCarNumberResult(null), 5000);
          }
        } catch (err) {
          setCarNumberResult({ type: 'error', message: err.response?.data?.error || 'Check-in failed' });
        } finally {
          setCarNumberLoading(false);
        }
      }, 0);
    } else {
      setCarNumberResult({ type: 'error', message: 'Could not read car number from QR code' });
      setTimeout(() => setCarNumberResult(null), 5000);
    }
  };

  const refreshQueue = async () => {
    if (!session) return;
    const [queueRes, statsRes] = await Promise.all([
      api.get(`/sessions/${session.id}/queue`),
      api.get(`/sessions/${session.id}/stats`),
    ]);
    setQueue(queueRes.data);
    setStats(statsRes.data);
  };

  // Student lookup search with debounce
  const handleStudentSearch = (term) => {
    setStudentSearchTerm(term);
    if (studentSearchTimeout.current) clearTimeout(studentSearchTimeout.current);
    if (!term.trim()) {
      setStudentSearchResults([]);
      return;
    }
    studentSearchTimeout.current = setTimeout(async () => {
      setStudentSearchLoading(true);
      try {
        const res = await api.get(`/schools/${currentSchool.id}/students`, { params: { search: term.trim() } });
        setStudentSearchResults(res.data || []);
      } catch (err) {
        console.error('Student search failed:', err);
        setStudentSearchResults([]);
      } finally {
        setStudentSearchLoading(false);
      }
    }, 300);
  };

  const handleUseCarNumber = (carNumber) => {
    setCarNumberInput(carNumber);
    setShowStudentLookup(false);
    setStudentSearchTerm('');
    setStudentSearchResults([]);
  };

  // Filter queue - exclude bus students from car queue (they show in Buses tab)
  // Split into active (in progress) and dismissed (completed)
  const carQueue = queue.filter(q => q.check_in_method !== 'bus_number' && q.check_in_method !== 'walker');
  const activeQueue = carQueue.filter(q => q.status !== 'dismissed');
  const dismissedQueue = carQueue.filter(q => q.status === 'dismissed');

  const filteredQueue = (queueTab === 'dismissed' ? dismissedQueue : activeQueue).filter(q => {
    const name = `${q.first_name} ${q.last_name}`.toLowerCase();
    if (searchTerm && !name.includes(searchTerm.toLowerCase())) return false;
    if (queueTab === 'active') {
      if (filterType === 'waiting' && q.status !== 'waiting') return false;
      if (filterType === 'called' && q.status !== 'called') return false;
      if (filterType === 'released' && q.status !== 'released') return false;
    }
    return true;
  });

  const avgWait = stats.avg_wait_seconds ? `${Math.floor(stats.avg_wait_seconds / 60)}:${String(Math.floor(stats.avg_wait_seconds % 60)).padStart(2, '0')}` : '--:--';

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-white border-b sticky top-0 z-50">
        <div className="px-3 sm:px-4 py-2 sm:py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 sm:gap-4">
              <div className="flex items-center gap-2 sm:gap-3">
                <div className="w-8 h-8 sm:w-10 sm:h-10 bg-indigo-600 rounded-xl flex items-center justify-center">
                  <Car className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
                </div>
                <div>
                  <h1 className="font-bold text-sm sm:text-base text-gray-900">GoPilot</h1>
                  <p className="text-[10px] sm:text-xs text-gray-500 truncate max-w-[100px] sm:max-w-none">{currentSchool?.name || 'No School Selected'}</p>
                </div>
              </div>
              <div className={`hidden sm:flex ml-2 sm:ml-6 px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg items-center gap-2 ${dismissalActive ? 'bg-green-100' : 'bg-gray-100'}`}>
                <span className={`w-2 h-2 rounded-full ${dismissalActive ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`} />
                <span className={`text-xs sm:text-sm font-medium ${dismissalActive ? 'text-green-700' : 'text-gray-600'}`}>
                  {dismissalActive ? 'Active' : 'Paused'}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 sm:gap-4">
              <div className="text-right hidden md:block">
                <p className="text-2xl font-bold text-gray-900">
                  {currentTime.toLocaleTimeString([], { timeZone: currentSchool?.timezone, hour: '2-digit', minute: '2-digit' })}
                </p>
                <p className="text-xs text-gray-500">
                  {currentTime.toLocaleDateString([], { timeZone: currentSchool?.timezone, weekday: 'long', month: 'short', day: 'numeric' })}
                </p>
              </div>
              <p className="text-sm font-bold text-gray-900 md:hidden">
                {currentTime.toLocaleTimeString([], { timeZone: currentSchool?.timezone, hour: '2-digit', minute: '2-digit' })}
              </p>
              <div className="flex items-center gap-1 sm:gap-2">
                <Button variant={soundEnabled ? 'secondary' : 'ghost'} size="sm" onClick={() => setSoundEnabled(!soundEnabled)}>
                  {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                </Button>
                <Button variant={dismissalActive ? 'warning' : 'success'} size="sm" onClick={handleToggleDismissal}>
                  {dismissalActive ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                  <span className="hidden sm:inline ml-1">{dismissalActive ? 'Pause' : 'Start'}</span>
                </Button>
                <Button variant="ghost" size="sm" onClick={logout}>
                  <LogOut className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
        {alerts.length > 0 && (
          <div className="bg-red-50 border-t border-red-200 px-4 py-2">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-red-500" />
              <span className="text-sm text-red-700 font-medium">
                Custody alert: {alerts[0].person_name} - {alerts[0].alert_type} ({alerts[0].student_first_name} {alerts[0].student_last_name})
              </span>
              <Button variant="ghost" size="sm" className="ml-auto text-red-600">View Details</Button>
            </div>
          </div>
        )}
      </header>

      {/* Stats Bar */}
      <div className="bg-white border-b px-3 sm:px-4 py-2 sm:py-3 overflow-x-auto">
        <div className="flex items-center gap-4 sm:gap-6 min-w-max sm:min-w-0">
          <div className="text-center">
            <p className="text-lg sm:text-2xl font-bold text-green-600">{stats.dismissed}</p>
            <p className="text-[10px] sm:text-xs text-gray-500">Dismissed</p>
          </div>
          <div className="text-center">
            <p className="text-lg sm:text-2xl font-bold text-red-600">{(stats.waiting || 0) + (stats.called || 0)}</p>
            <p className="text-[10px] sm:text-xs text-gray-500">In Queue</p>
          </div>
          <div className="text-center">
            <p className="text-lg sm:text-2xl font-bold text-green-600">{stats.released || 0}</p>
            <p className="text-[10px] sm:text-xs text-gray-500">In Transit</p>
          </div>
          <div className="text-center">
            <p className="text-lg sm:text-2xl font-bold text-red-600">{stats.held}</p>
            <p className="text-[10px] sm:text-xs text-gray-500">Held</p>
          </div>
          <div className="border-l pl-4 sm:pl-6 text-center">
            <p className="text-lg sm:text-2xl font-bold text-indigo-600">{avgWait}</p>
            <p className="text-[10px] sm:text-xs text-gray-500">Avg Wait</p>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex pb-16 sm:pb-0">
        {/* Desktop sidebar */}
        <aside className="hidden sm:flex w-16 bg-white border-r flex-col items-center py-4 gap-2">
          {[
            { id: 'queue', icon: Users, label: 'Queue' },
            { id: 'homerooms', icon: Home, label: 'Rooms' },
            { id: 'buses', icon: Bus, label: 'Buses' },
            { id: 'walkers', icon: PersonStanding, label: 'Walkers' },
          ].map(view => (
            <button key={view.id} onClick={() => setSelectedView(view.id)}
              className={`w-12 h-12 rounded-lg flex flex-col items-center justify-center gap-1 transition-colors ${
                selectedView === view.id ? 'bg-indigo-100 text-indigo-600' : 'text-gray-400 hover:bg-gray-100'
              }`}>
              <view.icon className="w-5 h-5" />
              <span className="text-[10px]">{view.label}</span>
            </button>
          ))}
          {(currentRole === 'admin' || currentRole === 'office_staff') && (
            <button onClick={() => navigate('/gopilot/setup')}
              className="w-12 h-12 rounded-lg flex flex-col items-center justify-center gap-1 text-gray-400 hover:bg-gray-100">
              <Settings className="w-5 h-5" />
              <span className="text-[10px]">Setup</span>
            </button>
          )}
        </aside>

        {/* Mobile bottom nav */}
        <nav className="sm:hidden fixed bottom-0 left-0 right-0 bg-white border-t z-50 px-2 py-1">
          <div className="flex items-center justify-around">
            {[
              { id: 'queue', icon: Users, label: 'Queue' },
              { id: 'homerooms', icon: Home, label: 'Rooms' },
              { id: 'buses', icon: Bus, label: 'Buses' },
              { id: 'walkers', icon: PersonStanding, label: 'Walk' },
            ].map(view => (
              <button key={view.id} onClick={() => setSelectedView(view.id)}
                className={`flex flex-col items-center justify-center py-1.5 px-3 rounded-lg ${
                  selectedView === view.id ? 'text-indigo-600' : 'text-gray-400'
                }`}>
                <view.icon className="w-5 h-5" />
                <span className="text-[10px]">{view.label}</span>
              </button>
            ))}
            {(currentRole === 'admin' || currentRole === 'office_staff') && (
              <button onClick={() => navigate('/gopilot/setup')}
                className="flex flex-col items-center justify-center py-1.5 px-3 rounded-lg text-gray-400">
                <Settings className="w-5 h-5" />
                <span className="text-[10px]">Setup</span>
              </button>
            )}
          </div>
        </nav>

        <main className="flex-1 p-3 sm:p-4">
          {selectedView === 'queue' && (
            <div className="flex flex-col lg:grid lg:grid-cols-3 gap-3 sm:gap-4">
              {/* Car Number Input - shows first on mobile */}
              <div className="lg:hidden space-y-3">
                <Card className="p-3 sm:p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold flex items-center gap-2 text-sm">
                      <Car className="w-4 h-4 text-indigo-600" />
                      Enter Car #
                    </h3>
                    <Button variant="secondary" size="sm" onClick={() => setShowQrScanner(true)}>
                      <QrCode className="w-4 h-4 mr-1" /> Scan
                    </Button>
                  </div>
                  <form onSubmit={(e) => { e.preventDefault(); handleCarNumberCheckIn(); }} className="flex gap-2">
                    <input
                      type="text"
                      value={carNumberInput}
                      onChange={(e) => setCarNumberInput(e.target.value)}
                      placeholder="e.g. 142"
                      className="flex-1 px-3 py-2 border rounded-lg text-lg font-mono text-center tracking-widest"
                    />
                    <Button variant="primary" size="md" onClick={handleCarNumberCheckIn} disabled={carNumberLoading || !carNumberInput.trim()}>
                      {carNumberLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                    </Button>
                  </form>
                  {carNumberResult && (
                    <div className={`mt-2 p-2 rounded-lg text-sm ${carNumberResult.type === 'success' ? 'bg-green-50 text-green-700' : carNumberResult.type === 'info' ? 'bg-yellow-50 text-yellow-700' : 'bg-red-50 text-red-700'}`}>
                      {carNumberResult.message}
                    </div>
                  )}
                </Card>
              </div>

              <div className="lg:col-span-2">
                <Card>
                  <div className="p-3 sm:p-4 border-b">
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="font-semibold flex items-center gap-2 text-sm sm:text-base">
                        <Users className="w-5 h-5 text-indigo-600" />
                        Car Line
                      </h2>
                      {/* Queue / Dismissed tabs */}
                      <div className="flex bg-gray-100 rounded-lg p-0.5">
                        <button
                          onClick={() => setQueueTab('active')}
                          className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                            queueTab === 'active' ? 'bg-white shadow text-indigo-600' : 'text-gray-600 hover:text-gray-900'
                          }`}
                        >
                          Queue {activeQueue.length > 0 && <span className="ml-1 text-xs bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-full">{activeQueue.length}</span>}
                        </button>
                        <button
                          onClick={() => setQueueTab('dismissed')}
                          className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                            queueTab === 'dismissed' ? 'bg-white shadow text-green-600' : 'text-gray-600 hover:text-gray-900'
                          }`}
                        >
                          Dismissed {dismissedQueue.length > 0 && <span className="ml-1 text-xs bg-green-100 text-green-600 px-1.5 py-0.5 rounded-full">{dismissedQueue.length}</span>}
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="relative flex-1 min-w-[140px]">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <input type="text" placeholder="Search..." value={searchTerm}
                          onChange={(e) => setSearchTerm(e.target.value)}
                          className="pl-10 pr-4 py-1.5 border rounded-lg text-sm w-full" />
                      </div>
                      {queueTab === 'active' && (
                        <select value={filterType} onChange={(e) => setFilterType(e.target.value)}
                          className="border rounded-lg px-2 sm:px-3 py-1.5 text-sm">
                          <option value="all">All</option>
                          <option value="waiting">In Queue</option>
                          <option value="released">In Transit</option>
                        </select>
                      )}
                    </div>
                  </div>
                  <div className="max-h-[calc(100vh-320px)] overflow-y-auto">
                    {(() => {
                      const grouped = {};
                      filteredQueue.forEach(item => {
                        const key = item.guardian_name || 'Unknown';
                        if (!grouped[key]) grouped[key] = [];
                        grouped[key].push(item);
                      });
                      const groups = Object.entries(grouped);
                      if (groups.length === 0) {
                        return (
                          <div className="p-8 text-center text-gray-500">
                            {queueTab === 'dismissed' ? (
                              <>
                                <CheckCircle2 className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                                <p>No dismissed students yet</p>
                              </>
                            ) : (
                              <>
                                <Users className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                                <p>No students in queue</p>
                              </>
                            )}
                          </div>
                        );
                      }
                      return groups.map(([groupName, students]) => (
                        <QueueGroup key={groupName} name={groupName} students={students}
                          onPickupAll={() => handlePickupAll(students)}
                          onCall={handleCallStudent}
                          onPickup={handleMarkPickedUp} />
                      ));
                    })()}
                  </div>
                </Card>
              </div>
              <div className="hidden lg:block space-y-4">
                <Card className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold flex items-center gap-2">
                      <Car className="w-5 h-5 text-indigo-600" />
                      Enter Car #
                    </h3>
                    <Button variant="secondary" size="sm" onClick={() => setShowQrScanner(true)}>
                      <QrCode className="w-4 h-4 mr-1" /> Scan QR
                    </Button>
                  </div>
                  <form onSubmit={(e) => { e.preventDefault(); handleCarNumberCheckIn(); }} className="flex gap-2">
                    <input
                      type="text"
                      value={carNumberInput}
                      onChange={(e) => setCarNumberInput(e.target.value)}
                      placeholder="e.g. 142"
                      className="flex-1 px-3 py-2 border rounded-lg text-lg font-mono text-center tracking-widest"
                      autoFocus
                    />
                    <Button variant="primary" size="md" onClick={handleCarNumberCheckIn} disabled={carNumberLoading || !carNumberInput.trim()}>
                      {carNumberLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                    </Button>
                  </form>
                  {carNumberResult && (
                    <div className={`mt-2 p-2 rounded-lg text-sm ${carNumberResult.type === 'success' ? 'bg-green-50 text-green-700' : carNumberResult.type === 'info' ? 'bg-yellow-50 text-yellow-700' : 'bg-red-50 text-red-700'}`}>
                      {carNumberResult.message}
                    </div>
                  )}
                </Card>
                <Card className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold">Pickup Zones</h3>
                    <Button variant="ghost" size="sm" onClick={() => setShowZoneManager(true)}>
                      <Settings className="w-4 h-4" />
                    </Button>
                  </div>
                  <div className={`grid gap-2 ${pickupZones.length <= 2 ? 'grid-cols-2' : pickupZones.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
                    {pickupZones.map(zone => {
                      const count = queue.filter(q => q.zone === zone.id && q.status === 'called').length;
                      const isSelected = selectedZone === zone.id;
                      return (
                        <button key={zone.id} onClick={() => setSelectedZone(zone.id)}
                          className={`p-3 rounded-lg text-center transition-colors ${
                            isSelected ? 'ring-2 ring-indigo-500 bg-indigo-50' :
                            count > 0 ? 'bg-green-100' : 'bg-gray-100'
                          }`}>
                          <p className="text-lg font-bold truncate">{zone.name}</p>
                          <p className="text-xs text-gray-500">{count} waiting</p>
                        </button>
                      );
                    })}
                  </div>
                  {pickupZones.length === 0 && (
                    <p className="text-sm text-gray-400 text-center py-2">No zones configured</p>
                  )}
                </Card>
                <Card className="p-4">
                  <h3 className="font-semibold mb-3">Quick Actions</h3>
                  <div className="space-y-2">
                    <Button variant="secondary" size="sm" className="w-full justify-start" onClick={() => setShowStudentLookup(true)}>
                      <Search className="w-4 h-4 mr-2" /> Find Student
                    </Button>
                  </div>
                </Card>
              </div>
            </div>
          )}

          {selectedView === 'homerooms' && (
            <Card>
              <div className="p-4 border-b flex items-center justify-between">
                <h2 className="font-semibold flex items-center gap-2">
                  <Home className="w-5 h-5 text-indigo-600" /> Homeroom Status
                </h2>
              </div>
              <div className="divide-y">
                {homerooms.map(room => (
                  <div key={room.id} className="p-4 flex items-center justify-between hover:bg-gray-50">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-indigo-100 rounded-lg flex items-center justify-center">
                        <span className="text-indigo-600 font-bold">{room.grade}</span>
                      </div>
                      <div>
                        <p className="font-medium">{room.teacher_first_name} {room.teacher_last_name}</p>
                        <p className="text-sm text-gray-500">Grade {room.grade} - {room.name}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-6">
                      <div className="text-center">
                        <p className="text-lg font-bold text-indigo-600">{room.student_count}</p>
                        <p className="text-xs text-gray-500">Students</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {selectedView === 'buses' && (() => {
            const allBusQueue = queue.filter(q => q.check_in_method === 'bus_number');
            const activeBusCount = allBusQueue.filter(q => q.status !== 'dismissed').length;
            const dismissedBusCount = allBusQueue.filter(q => q.status === 'dismissed').length;

            // Filter by tab
            const busQueue = busQueueTab === 'active'
              ? allBusQueue.filter(q => q.status !== 'dismissed')
              : allBusQueue.filter(q => q.status === 'dismissed');

            // Group by guardian_name (e.g. "Bus #42")
            const busByRoute = {};
            busQueue.forEach(q => {
              const key = q.guardian_name || 'Unknown';
              if (!busByRoute[key]) busByRoute[key] = [];
              busByRoute[key].push(q);
            });
            return (
              <div className="space-y-4">
                <Card className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold flex items-center gap-2">
                      <Bus className="w-5 h-5 text-yellow-600" />
                      Enter Bus #
                    </h3>
                    <div className="flex rounded-lg border border-gray-200 overflow-hidden">
                      <button
                        onClick={() => setBusQueueTab('active')}
                        className={`px-3 py-1 text-sm font-medium ${busQueueTab === 'active' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                      >
                        Queue <span className="ml-1 bg-white/20 px-1.5 rounded">{activeBusCount}</span>
                      </button>
                      <button
                        onClick={() => setBusQueueTab('dismissed')}
                        className={`px-3 py-1 text-sm font-medium ${busQueueTab === 'dismissed' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                      >
                        Dismissed <span className="ml-1 bg-white/20 px-1.5 rounded">{dismissedBusCount}</span>
                      </button>
                    </div>
                  </div>
                  <form onSubmit={(e) => { e.preventDefault(); handleBusNumberCheckIn(); }} className="flex gap-2">
                    <input
                      type="text"
                      value={busNumberInput}
                      onChange={(e) => setBusNumberInput(e.target.value)}
                      placeholder="e.g. 42"
                      className="flex-1 px-3 py-2 border rounded-lg text-lg font-mono text-center tracking-widest"
                    />
                    <Button variant="primary" size="md" onClick={handleBusNumberCheckIn} disabled={busNumberLoading || !busNumberInput.trim()}>
                      {busNumberLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                    </Button>
                  </form>
                  {busNumberResult && (
                    <div className={`mt-2 p-2 rounded-lg text-sm ${busNumberResult.type === 'success' ? 'bg-green-50 text-green-700' : busNumberResult.type === 'info' ? 'bg-yellow-50 text-yellow-700' : 'bg-red-50 text-red-700'}`}>
                      {busNumberResult.message}
                    </div>
                  )}
                </Card>

                {Object.keys(busByRoute).length > 0 ? (
                  Object.entries(busByRoute).map(([routeName, students]) => (
                    <QueueGroup key={routeName} name={routeName} students={students}
                      onPickupAll={() => handlePickupAll(students)}
                      onCall={handleCallStudent}
                      onPickup={handleMarkPickedUp} />
                  ))
                ) : (
                  <Card>
                    <div className="p-8 text-center text-gray-500">
                      <Bus className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                      <p>{busQueueTab === 'active' ? 'Enter a bus number above to check in bus students' : 'No dismissed bus students yet'}</p>
                    </div>
                  </Card>
                )}
              </div>
            );
          })()}

          {selectedView === 'walkers' && (() => {
            const allWalkerQueue = queue.filter(q => q.check_in_method === 'walker');
            const activeWalkerCount = allWalkerQueue.filter(q => q.status !== 'dismissed').length;
            const dismissedWalkerCount = allWalkerQueue.filter(q => q.status === 'dismissed').length;
            const walkerQueue = walkerQueueTab === 'active'
              ? allWalkerQueue.filter(q => q.status !== 'dismissed')
              : allWalkerQueue.filter(q => q.status === 'dismissed');

            // Get unique grades and homerooms from the homerooms list
            const uniqueGrades = [...new Set(homerooms.map(h => h.grade))].sort((a, b) => {
              const aNum = parseInt(a) || 0;
              const bNum = parseInt(b) || 0;
              if (a === 'K' || a === 'PK') return -1;
              if (b === 'K' || b === 'PK') return 1;
              return aNum - bNum;
            });

            return (
              <div className="space-y-4">
                <Card className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="font-semibold flex items-center gap-2">
                      <PersonStanding className="w-5 h-5 text-green-600" /> Walker Dismissal
                    </h2>
                    <div className="flex items-center gap-2">
                      <div className="flex rounded-lg border border-gray-200 overflow-hidden">
                        <button
                          onClick={() => setWalkerQueueTab('active')}
                          className={`px-3 py-1 text-sm font-medium ${walkerQueueTab === 'active' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                        >
                          Queue <span className="ml-1 bg-white/20 px-1.5 rounded">{activeWalkerCount}</span>
                        </button>
                        <button
                          onClick={() => setWalkerQueueTab('dismissed')}
                          className={`px-3 py-1 text-sm font-medium ${walkerQueueTab === 'dismissed' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                        >
                          Dismissed <span className="ml-1 bg-white/20 px-1.5 rounded">{dismissedWalkerCount}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                  {walkerResult && (
                    <div className={`mb-3 p-2 rounded-lg text-sm ${walkerResult.type === 'success' ? 'bg-green-50 text-green-700' : walkerResult.type === 'info' ? 'bg-yellow-50 text-yellow-700' : 'bg-red-50 text-red-700'}`}>
                      {walkerResult.message}
                    </div>
                  )}

                  {/* Release Options */}
                  <div className="border-t pt-3 mt-3">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-700">Release by:</span>
                        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
                          <button
                            onClick={() => setWalkerViewTab('grade')}
                            className={`px-3 py-1 text-sm font-medium ${walkerViewTab === 'grade' ? 'bg-green-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                          >
                            Grade
                          </button>
                          <button
                            onClick={() => setWalkerViewTab('homeroom')}
                            className={`px-3 py-1 text-sm font-medium ${walkerViewTab === 'homeroom' ? 'bg-green-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                          >
                            Homeroom
                          </button>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="success"
                          size="sm"
                          onClick={handleReleaseSelectedWalkers}
                          disabled={walkerLoading || (walkerViewTab === 'grade' ? selectedGrades.length === 0 : selectedWalkerHomerooms.length === 0)}
                        >
                          {walkerLoading ? <RefreshCw className="w-4 h-4 animate-spin mr-1" /> : <PersonStanding className="w-4 h-4 mr-1" />}
                          Dismiss Selected {walkerViewTab === 'grade' ? `(${selectedGrades.length} grades)` : `(${selectedWalkerHomerooms.length} homerooms)`}
                        </Button>
                        <Button variant="danger" size="sm" onClick={handleReleaseWalkers} disabled={walkerLoading}>
                          {walkerLoading ? <RefreshCw className="w-4 h-4 animate-spin mr-1" /> : <PersonStanding className="w-4 h-4 mr-1" />}
                          Dismiss All Walkers
                        </Button>
                      </div>
                    </div>

                    {/* Scrollable selection list */}
                    <div className="max-h-64 overflow-y-auto border rounded-lg bg-gray-50 p-2">
                      {walkerViewTab === 'grade' && (
                        <div className="space-y-1">
                          {uniqueGrades.length === 0 ? (
                            <p className="text-sm text-gray-500 p-2">No grades found</p>
                          ) : uniqueGrades.map(grade => (
                            <label key={grade} className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${selectedGrades.includes(grade) ? 'bg-green-100 border border-green-500' : 'bg-white border border-gray-200 hover:bg-gray-100'}`}>
                              <input
                                type="checkbox"
                                checked={selectedGrades.includes(grade)}
                                onChange={() => toggleGradeSelection(grade)}
                                className="w-4 h-4 text-green-600 rounded"
                              />
                              <span className="font-medium flex-1">Grade {grade}</span>
                              {selectedGrades.includes(grade) && <Check className="w-4 h-4 text-green-600" />}
                            </label>
                          ))}
                        </div>
                      )}

                      {walkerViewTab === 'homeroom' && (
                        <div className="space-y-1">
                          {homerooms.length === 0 ? (
                            <p className="text-sm text-gray-500 p-2">No homerooms found</p>
                          ) : homerooms.map(room => (
                            <label key={room.id} className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${selectedWalkerHomerooms.includes(room.id) ? 'bg-green-100 border border-green-500' : 'bg-white border border-gray-200 hover:bg-gray-100'}`}>
                              <input
                                type="checkbox"
                                checked={selectedWalkerHomerooms.includes(room.id)}
                                onChange={() => toggleHomeroomSelection(room.id)}
                                className="w-4 h-4 text-green-600 rounded"
                              />
                              <span className="font-medium flex-1">{room.name}</span>
                              <span className="text-xs text-gray-500">Grade {room.grade}</span>
                              {selectedWalkerHomerooms.includes(room.id) && <Check className="w-4 h-4 text-green-600" />}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </Card>

                {/* Dismissed Walkers List */}
                {walkerQueueTab === 'dismissed' && walkerQueue.length > 0 && (
                  <Card className="p-4">
                    <h3 className="font-medium text-gray-700 mb-3">Dismissed Walkers ({walkerQueue.length})</h3>
                    <div className="max-h-96 overflow-y-auto space-y-2">
                      {walkerQueue.map(student => (
                        <div key={student.id} className="flex items-center gap-3 p-2 bg-gray-50 rounded-lg">
                          <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
                            <Check className="w-4 h-4 text-green-600" />
                          </div>
                          <div className="flex-1">
                            <p className="font-medium text-sm">{student.first_name} {student.last_name}</p>
                            <p className="text-xs text-gray-500">{student.guardian_name}</p>
                          </div>
                          <span className="text-xs text-gray-400">
                            {student.dismissed_at && new Date(student.dismissed_at).toLocaleTimeString([], { timeZone: currentSchool?.timezone, hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}

                {walkerQueueTab === 'dismissed' && walkerQueue.length === 0 && (
                  <Card>
                    <div className="p-8 text-center text-gray-500">
                      <PersonStanding className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                      <p>No dismissed walker students yet</p>
                    </div>
                  </Card>
                )}
              </div>
            );
          })()}
        </main>
      </div>

      {/* Zone Manager Modal */}
      {showZoneManager && (
        <ZoneManagerModal
          zones={pickupZones}
          onSave={handleSaveZones}
          onClose={() => setShowZoneManager(false)}
          saving={zoneSaving}
        />
      )}

      {/* QR Scanner Modal */}
      {showQrScanner && (
        <QrScannerModal
          onScan={handleQrScanned}
          onClose={() => setShowQrScanner(false)}
        />
      )}

      {/* Student Lookup Modal */}
      {showStudentLookup && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[80vh] flex flex-col">
            <div className="p-4 border-b flex items-center justify-between">
              <h2 className="text-lg font-semibold">Find Student</h2>
              <button onClick={() => { setShowStudentLookup(false); setStudentSearchTerm(''); setStudentSearchResults([]); }}
                className="p-1 hover:bg-gray-100 rounded-lg">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 border-b">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-3 text-gray-400" />
                <input
                  type="text"
                  value={studentSearchTerm}
                  onChange={(e) => handleStudentSearch(e.target.value)}
                  placeholder="Search by student name..."
                  className="w-full pl-9 pr-4 py-2 border rounded-lg"
                  autoFocus
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {studentSearchLoading && (
                <div className="p-4 text-center text-gray-400">
                  <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
                  Searching...
                </div>
              )}
              {!studentSearchLoading && studentSearchTerm && studentSearchResults.length === 0 && (
                <div className="p-4 text-center text-gray-400">No students found</div>
              )}
              {!studentSearchLoading && studentSearchResults.map(student => (
                <div key={student.id} className="p-3 hover:bg-gray-50 rounded-lg flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-600 font-medium">
                      {student.first_name?.[0]}{student.last_name?.[0]}
                    </div>
                    <div>
                      <p className="font-medium">{student.first_name} {student.last_name}</p>
                      <p className="text-sm text-gray-500">
                        {student.homeroom_name ? `${student.homeroom_name} • Grade ${student.homeroom_grade || student.grade}` : `Grade ${student.grade || '—'}`}
                      </p>
                    </div>
                  </div>
                  {student.car_number ? (
                    <button
                      onClick={() => handleUseCarNumber(student.car_number)}
                      className="flex items-center gap-2 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700"
                    >
                      <Car className="w-4 h-4" />
                      #{student.car_number}
                    </button>
                  ) : (
                    <span className="text-sm text-gray-400 italic">No car #</span>
                  )}
                </div>
              ))}
              {!studentSearchTerm && (
                <div className="p-4 text-center text-gray-400 text-sm">
                  Start typing to search for a student by name
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ZoneManagerModal({ zones, onSave, onClose, saving }) {
  const [editZones, setEditZones] = useState(zones.map(z => ({ ...z })));
  const [newZoneName, setNewZoneName] = useState('');

  const handleAdd = () => {
    if (!newZoneName.trim()) return;
    const id = newZoneName.trim().replace(/\s+/g, '_').substring(0, 50);
    if (editZones.find(z => z.id === id)) return;
    setEditZones([...editZones, { id, name: newZoneName.trim() }]);
    setNewZoneName('');
  };

  const handleRemove = (id) => {
    setEditZones(editZones.filter(z => z.id !== id));
  };

  const handleRename = (id, newName) => {
    setEditZones(editZones.map(z => z.id === id ? { ...z, name: newName } : z));
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="font-semibold text-lg">Manage Pickup Zones</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-full">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-sm text-gray-500">
            Add, rename, or remove pickup zones. Students will be released to these zones during dismissal.
          </p>
          <div className="space-y-2">
            {editZones.map((zone) => (
              <div key={zone.id} className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-gray-400 flex-shrink-0" />
                <input
                  type="text"
                  value={zone.name}
                  onChange={(e) => handleRename(zone.id, e.target.value)}
                  className="flex-1 p-2 border rounded-lg text-sm"
                />
                <button onClick={() => handleRemove(zone.id)}
                  className="p-1.5 hover:bg-red-50 rounded text-red-500">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="New zone name (e.g. Side Entrance)"
              value={newZoneName}
              onChange={(e) => setNewZoneName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              className="flex-1 p-2 border rounded-lg text-sm"
            />
            <button onClick={handleAdd}
              className="p-2 bg-indigo-100 text-indigo-600 rounded-lg hover:bg-indigo-200">
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="p-4 border-t flex gap-3">
          <button onClick={onClose}
            className="flex-1 px-4 py-2 border rounded-lg text-sm font-medium hover:bg-gray-50">
            Cancel
          </button>
          <button onClick={() => onSave(editZones)} disabled={saving}
            className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:bg-indigo-300">
            {saving ? 'Saving...' : 'Save Zones'}
          </button>
        </div>
      </div>
    </div>
  );
}

function QrScannerModal({ onScan, onClose }) {
  const scannerRef = useRef(null);
  const html5QrCodeRef = useRef(null);

  useEffect(() => {
    let scanner = null;
    let mounted = true;

    const startScanner = async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        if (!mounted) return;
        scanner = new Html5Qrcode('qr-reader');
        html5QrCodeRef.current = scanner;
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          (decodedText) => {
            scanner.stop().catch(() => {});
            onScan(decodedText);
          },
          () => {} // ignore errors (no QR in frame)
        );
      } catch (err) {
        console.error('QR scanner error:', err);
      }
    };

    startScanner();

    return () => {
      mounted = false;
      if (html5QrCodeRef.current) {
        html5QrCodeRef.current.stop().catch(() => {});
      }
    };
  }, [onScan]);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="font-semibold text-lg flex items-center gap-2">
            <QrCode className="w-5 h-5 text-indigo-600" />
            Scan Parent QR
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-full">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4">
          <div id="qr-reader" ref={scannerRef} className="w-full rounded-lg overflow-hidden" />
          <p className="text-sm text-gray-500 text-center mt-3">
            Point camera at parent's QR code
          </p>
        </div>
      </div>
    </div>
  );
}

function QueueGroup({ name, students, onPickupAll, onCall, onPickup }) {
  const eligible = students.filter(s => s.status === 'waiting' || s.status === 'called' || s.status === 'released');

  if (students.length === 1) {
    return (
      <div className="border-b border-gray-100">
        <QueueItem item={students[0]} position={1} onCall={onCall} onPickup={onPickup} />
      </div>
    );
  }

  return (
    <div className="border-b border-gray-200">
      <div className="flex items-center justify-between px-3 sm:px-4 py-2 bg-gray-50">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm sm:text-base text-gray-800">{name}</span>
          <span className="text-xs bg-gray-200 text-gray-600 rounded-full px-2 py-0.5">{students.length} students</span>
        </div>
        {eligible.length > 0 && (
          <button
            onClick={onPickupAll}
            className="text-xs sm:text-sm px-3 py-1 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
          >
            Pickup Complete All ({eligible.length})
          </button>
        )}
      </div>
      <div className="divide-y divide-gray-100">
        {students.map((item, idx) => (
          <QueueItem key={item.id} item={item} position={idx + 1} onCall={onCall} onPickup={onPickup} />
        ))}
      </div>
    </div>
  );
}

function QueueItem({ item, position, onCall, onPickup }) {
  const getStatusColor = (status) => {
    switch (status) {
      case 'waiting': return 'red';
      case 'called': return 'red';
      case 'released': return 'green';
      case 'held': return 'purple';
      case 'delayed': return 'red';
      default: return 'default';
    }
  };

  const getCheckInIcon = (method) => {
    switch (method) {
      case 'sms': return MessageSquare;
      case 'qr': return QrCode;
      case 'car_number': return Car;
      default: return Smartphone;
    }
  };

  const CheckInIcon = getCheckInIcon(item.check_in_method);
  // Calculate wait time: from check-in to dismissal (or now if not yet dismissed)
  const getWaitTime = () => {
    if (!item.check_in_time) return 0;
    const start = new Date(item.check_in_time).getTime();
    const end = item.status === 'dismissed' && item.dismissed_at
      ? new Date(item.dismissed_at).getTime()
      : Date.now();
    return Math.floor((end - start) / 60000);
  };
  const waitTime = getWaitTime();

  return (
    <div className={`p-3 sm:p-4 ${item.status === 'called' || item.status === 'waiting' ? 'bg-red-50' : item.status === 'released' ? 'bg-green-50' : 'hover:bg-gray-50'}`}>
      <div className="flex items-start sm:items-center gap-3 sm:gap-4">
        <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-gray-100 flex items-center justify-center text-xs sm:text-sm font-medium text-gray-500 flex-shrink-0">
          {position}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-medium text-sm sm:text-base truncate">{item.first_name} {item.last_name}</p>
            <Badge variant={getStatusColor(item.status)} size="sm">
              {item.status === 'released' ? 'In Transit' : item.status === 'waiting' ? 'In Queue' : item.status === 'called' ? 'In Queue' : item.status}
            </Badge>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 text-xs sm:text-sm text-gray-500 flex-wrap">
            <span>Gr {item.grade}</span>
            <span className="hidden sm:inline">•</span>
            <span className="hidden sm:inline">{item.homeroom_name || 'No homeroom'}</span>
            <span>•</span>
            <span className="truncate">{item.guardian_name}</span>
            <span className="flex items-center gap-1 ml-auto sm:ml-0">
              <Timer className="w-3 h-3" />
              {waitTime}m
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
          {item.status !== 'dismissed' && (
            <Button variant="success" size="sm" onClick={() => onPickup(item.id)}>
              <Check className="w-4 h-4" /><span className="hidden sm:inline ml-1">Pickup Complete</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
