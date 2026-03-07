import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Check, X, ChevronRight, Mail, Phone, User, Users, Shield,
  Car, Bus, PersonStanding, Clock, Plus, Camera, AlertCircle,
  CheckCircle2, ArrowRight, ArrowLeft, Bell, MapPin, Edit,
  Smartphone, MessageSquare, QrCode, Home
} from 'lucide-react';
import { useGoPilotAuth } from '../../../hooks/useGoPilotAuth';
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
    <span className={`inline-flex items-center rounded-full font-medium ${variants[variant]} ${sizes[size]}`}>
      {children}
    </span>
  );
};

const Button = ({ children, variant = 'primary', size = 'md', onClick, disabled, className = '', type = 'button' }) => {
  const variants = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300',
    secondary: 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50',
    success: 'bg-green-600 text-white hover:bg-green-700',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    ghost: 'text-gray-600 hover:bg-gray-100',
  };
  const sizes = { sm: 'px-3 py-1.5 text-sm', md: 'px-4 py-2 text-sm', lg: 'px-6 py-3 text-base' };
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={`inline-flex items-center justify-center rounded-lg font-medium transition-colors ${variants[variant]} ${sizes[size]} ${className} disabled:cursor-not-allowed`}>
      {children}
    </button>
  );
};

const Card = ({ children, className = '', onClick }) => (
  <div
    className={`bg-white rounded-xl shadow-sm border border-gray-200 ${onClick ? 'cursor-pointer hover:shadow-md transition-shadow' : ''} ${className}`}
    onClick={onClick}
  >
    {children}
  </div>
);

export default function ParentOnboarding() {
  const navigate = useNavigate();
  const { user, currentSchool } = useGoPilotAuth();

  const [currentStep, setCurrentStep] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const [children, setChildren] = useState([]);
  const [childrenLoading, setChildrenLoading] = useState(false);

  const [authorizedPickups, setAuthorizedPickups] = useState([]);

  const [notifications, setNotifications] = useState({
    pushEnabled: true,
    smsEnabled: true,
    emailEnabled: false,
    dismissalAlerts: true,
    changeConfirmations: true,
    arrivalReminders: true,
  });

  const [carNumber, setCarNumber] = useState('');
  const [autoLinked, setAutoLinked] = useState(false);
  const [phone, setPhone] = useState('');
  const [schoolCheckInMethod, setSchoolCheckInMethod] = useState('app');

  const steps = [
    { num: 1, title: 'Sign In', icon: User },
    { num: 2, title: 'Link Children', icon: Users },
    { num: 3, title: 'Add Pickups', icon: Shield },
    { num: 4, title: 'Preferences', icon: Bell },
    { num: 5, title: 'Ready!', icon: CheckCircle2 },
  ];

  const fetchChildren = useCallback(async () => {
    setChildrenLoading(true);
    setError(null);
    try {
      const res = await api.get('/me/children');
      const data = Array.isArray(res.data) ? res.data : (res.data?.children || []);
      setChildren(data);
    } catch (err) {
      console.error('Failed to fetch children:', err);
      setError('Failed to load children. Please try again.');
    } finally {
      setChildrenLoading(false);
    }
  }, []);

  const fetchPickups = useCallback(async (childList) => {
    try {
      const allPickups = [];
      for (const child of childList) {
        const res = await api.get(`/students/${child.id}/pickups`);
        if (res.data) {
          allPickups.push(...res.data.map(p => ({ ...p, studentId: child.id })));
        }
      }
      setAuthorizedPickups(allPickups);
    } catch (err) {
      console.error('Failed to fetch pickups:', err);
    }
  }, []);

  useEffect(() => {
    fetchChildren();
  }, [fetchChildren]);

  // Auto-populate car number from school membership and auto-link children
  useEffect(() => {
    if (currentSchool?.carNumber && !autoLinked && children.length === 0) {
      setCarNumber(currentSchool.carNumber);
      setAutoLinked(true);
      handleLinkByCarNumber(currentSchool.carNumber);
    }
  }, [currentSchool?.carNumber, autoLinked, children.length]);

  useEffect(() => {
    if (!currentSchool?.id) return;
    api.get(`/schools/${currentSchool.id}/settings`).then(res => {
      setSchoolCheckInMethod(res.data?.checkInMethod || 'app');
    }).catch(() => {});
  }, [currentSchool?.id]);

  useEffect(() => {
    if (children.length > 0) {
      fetchPickups(children);
    }
  }, [children, fetchPickups]);

  const handleLinkByCarNumber = async (num) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await api.post('/me/children/link-by-car', {
        carNumber: num,
        schoolId: currentSchool?.id,
      });
      // Directly set children from response if available
      if (res.data?.students && Array.isArray(res.data.students)) {
        setChildren(res.data.students);
      } else {
        await fetchChildren();
      }
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Failed to link. Please try again.';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddAuthorizedPickup = async (pickup) => {
    setIsLoading(true);
    setError(null);
    try {
      const newPickups = [];
      for (const child of children) {
        const res = await api.post(`/students/${child.id}/pickups`, pickup);
        newPickups.push({ ...res.data, studentId: child.id });
      }
      setAuthorizedPickups([...authorizedPickups, ...newPickups]);
    } catch (err) {
      console.error('Failed to add pickup:', err);
      setError(err.response?.data?.error || 'Failed to add authorized pickup. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const removeAuthorizedPickup = (id) => {
    setAuthorizedPickups(authorizedPickups.filter(p => p.id !== id));
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-indigo-50 to-white text-black" style={{ colorScheme: 'light' }}>
      {/* Header */}
      <header className="bg-white border-b">
        <div className="max-w-lg mx-auto px-4 py-4">
          <div className="flex items-center justify-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center">
              <Car className="w-5 h-5 text-white" />
            </div>
            <div className="text-center">
              <h1 className="font-bold text-gray-900">GoPilot</h1>
              <p className="text-xs text-gray-500">{currentSchool?.name || 'Your School'}</p>
            </div>
          </div>
        </div>
      </header>

      {/* Progress */}
      {currentStep > 0 && currentStep < 6 && (
        <div className="bg-white border-b">
          <div className="max-w-lg mx-auto px-4 py-3">
            <div className="flex items-center justify-between">
              {steps.map((step, index) => (
                <React.Fragment key={step.num}>
                  <div className={`flex flex-col items-center ${step.num <= currentStep ? 'text-indigo-600' : 'text-gray-300'}`}>
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                      step.num < currentStep ? 'bg-green-500 text-white' :
                      step.num === currentStep ? 'bg-indigo-600 text-white' :
                      'bg-gray-200 text-gray-500'
                    }`}>
                      {step.num < currentStep ? <Check className="w-4 h-4" /> : step.num}
                    </div>
                    <span className="text-xs mt-1 hidden sm:block">{step.title}</span>
                  </div>
                  {index < steps.length - 1 && (
                    <div className={`flex-1 h-0.5 mx-1 ${step.num < currentStep ? 'bg-green-500' : 'bg-gray-200'}`} />
                  )}
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="max-w-lg mx-auto px-4 py-8">

        {/* Global Error Banner */}
        {error && (
          <div className="mb-6 p-4 bg-red-100 border-2 border-red-400 rounded-lg flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-800">{error}</p>
              <button onClick={() => setError(null)} className="text-sm font-bold text-red-600 underline mt-1">Dismiss</button>
            </div>
          </div>
        )}

        {/* Step 1: Account Confirmation */}
        {currentStep === 1 && (
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-2xl font-bold text-gray-900">Welcome to GoPilot</h2>
              <p className="text-gray-500 mt-1">Let's get your family set up for dismissal</p>
            </div>

            <Card className="p-6">
              <div className="flex items-center gap-4 mb-6">
                <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center">
                  <User className="w-8 h-8 text-indigo-600" />
                </div>
                <div>
                  <p className="font-semibold text-lg">{user?.name || 'Parent'}</p>
                  <p className="text-sm text-gray-500">{user?.email || ''}</p>
                </div>
                <CheckCircle2 className="w-6 h-6 text-green-500 ml-auto" />
              </div>

              {children.length > 0 && (
                <div className="bg-green-50 rounded-lg p-4 mb-4">
                  <div className="flex items-center gap-2 text-green-700 mb-2">
                    <CheckCircle2 className="w-5 h-5" />
                    <span className="font-medium">Children automatically linked!</span>
                  </div>
                  <p className="text-sm text-green-600">
                    We found {children.length} {children.length === 1 ? 'child' : 'children'} registered with your account.
                  </p>
                </div>
              )}

              {childrenLoading && (
                <div className="text-center py-4 text-gray-500 text-sm">
                  <span className="animate-pulse">Loading your children...</span>
                </div>
              )}

              <Button variant="primary" size="lg" className="w-full" onClick={() => setCurrentStep(2)}>
                Continue
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </Card>
          </div>
        )}

        {/* Step 2: Link Children by Car Number */}
        {currentStep === 2 && (
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-2xl font-bold text-gray-900">Link Your Children</h2>
              <p className="text-gray-500 mt-1">Enter your family car number to find your children</p>
            </div>

            {children.length > 0 && (
              <Card>
                <div className="p-4 border-b">
                  <h3 className="font-semibold text-black flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-green-500" />
                    Linked Children ({children.length})
                  </h3>
                </div>
                <div className="divide-y">
                  {children.map(child => (
                    <div key={child.id} className="p-4 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-600 font-bold">
                          {(child.firstName || child.first_name || '?')[0]}{(child.lastName || child.last_name || '?')[0]}
                        </div>
                        <div>
                          <p className="font-semibold text-black">{child.firstName || child.first_name} {child.lastName || child.last_name}</p>
                          <p className="text-sm text-gray-600">
                            {(child.gradeLevel || child.grade_level || child.grade) && `Grade ${child.gradeLevel || child.grade_level || child.grade}`}
                            {child.homeroom && ` • ${child.homeroom}`}
                          </p>
                        </div>
                      </div>
                      <Badge variant="green" size="sm">Linked</Badge>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {children.length === 0 && (
              <Card className="p-5">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 bg-indigo-100 rounded-full flex items-center justify-center">
                    <Car className="w-5 h-5 text-indigo-600" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-black">Enter Your Car Number</h3>
                    <p className="text-sm text-gray-600">This links all your children at once</p>
                  </div>
                </div>
                <form onSubmit={(e) => { e.preventDefault(); if (carNumber.trim()) handleLinkByCarNumber(carNumber.trim()); }} className="space-y-3">
                  <input
                    type="text"
                    value={carNumber}
                    onChange={(e) => setCarNumber(e.target.value)}
                    placeholder="e.g. 42"
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg text-center text-2xl tracking-widest font-mono font-bold text-black bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    autoFocus
                  />
                  <p className="text-xs text-gray-400 text-center">Your family car number assigned by the school</p>
                  <Button type="submit" variant="primary" size="lg" className="w-full" disabled={isLoading || childrenLoading || !carNumber.trim()}>
                    {isLoading ? 'Linking...' : 'Link My Children'}
                  </Button>
                </form>
              </Card>
            )}

            <div className="flex gap-3">
              <Button variant="secondary" size="lg" onClick={() => setCurrentStep(1)} className="flex-1">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back
              </Button>
              <Button variant="primary" size="lg" onClick={() => setCurrentStep(3)} className="flex-1" disabled={children.length === 0}>
                Continue
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Authorized Pickups */}
        {currentStep === 3 && (
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-2xl font-bold text-gray-900">Authorized Pickups</h2>
              <p className="text-gray-500 mt-1">Who else can pick up your children?</p>
            </div>

            <Card className="p-4">
              <div className="flex items-start gap-3 text-sm text-gray-600 mb-4">
                <Shield className="w-5 h-5 text-indigo-500 flex-shrink-0 mt-0.5" />
                <p>
                  Add trusted adults who may pick up your children. They'll need to show ID
                  and the school will verify before releasing your child.
                </p>
              </div>

              {children.length === 0 && (
                <div className="p-3 bg-yellow-50 rounded-lg text-sm text-yellow-700 mb-4">
                  <AlertCircle className="w-4 h-4 inline mr-1" />
                  Link at least one child first to add authorized pickups.
                </div>
              )}

              <AuthorizedPickupForm onAdd={handleAddAuthorizedPickup} disabled={isLoading || children.length === 0} />

              {authorizedPickups.length > 0 && (
                <div className="mt-4 space-y-2">
                  {authorizedPickups.map(pickup => (
                    <div key={pickup.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-gray-200 rounded-full flex items-center justify-center">
                          <User className="w-5 h-5 text-gray-500" />
                        </div>
                        <div>
                          <p className="font-medium">{pickup.name}</p>
                          <p className="text-sm text-gray-500">{pickup.relationship} {pickup.phone && `\u2022 ${pickup.phone}`}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={pickup.status === 'approved' ? 'green' : 'yellow'} size="sm">
                          {pickup.status === 'approved' ? 'Approved' : 'Pending'}
                        </Badge>
                        <button onClick={() => removeAuthorizedPickup(pickup.id)} className="text-red-500 hover:text-red-700">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <div className="flex gap-3">
              <Button variant="secondary" size="lg" onClick={() => setCurrentStep(2)} className="flex-1">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back
              </Button>
              <Button variant="primary" size="lg" onClick={() => setCurrentStep(4)} className="flex-1">
                {authorizedPickups.length === 0 ? 'Skip' : 'Continue'}
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 4: Check-in Method (informational — set by school) */}
        {currentStep === 4 && (
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-2xl font-bold text-gray-900">How You'll Check In</h2>
              <p className="text-gray-500 mt-1">Your school has set the check-in method for pickup</p>
            </div>

            <Card className="p-5">
              <div className="flex items-center gap-4">
                <div className={`w-14 h-14 rounded-full flex items-center justify-center ${schoolCheckInMethod === 'qr' ? 'bg-purple-100' : 'bg-indigo-100'}`}>
                  {schoolCheckInMethod === 'qr'
                    ? <QrCode className="w-7 h-7 text-purple-600" />
                    : <Smartphone className="w-7 h-7 text-indigo-600" />
                  }
                </div>
                <div>
                  <p className="text-lg font-bold text-gray-900">
                    {schoolCheckInMethod === 'qr' ? 'QR Code Tag' : 'GoPilot App'}
                  </p>
                  <p className="text-sm text-gray-500 mt-1">
                    {schoolCheckInMethod === 'qr'
                      ? 'Display your QR code tag in your car window when you arrive for pickup.'
                      : 'When you arrive for pickup, tap "I\'m Here" in the app to check in.'
                    }
                  </p>
                </div>
              </div>
            </Card>

            <Card className="p-4 bg-amber-50 border-amber-200">
              <div className="flex items-start gap-3">
                <Shield className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-amber-900">Office Confirmation Required</p>
                  <p className="text-sm text-amber-700 mt-1">
                    After you check in, your child will only be released once office staff confirms and approves the dismissal.
                  </p>
                </div>
              </div>
            </Card>

            <div className="flex gap-3">
              <Button variant="secondary" size="lg" onClick={() => setCurrentStep(3)} className="flex-1">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back
              </Button>
              <Button variant="primary" size="lg" onClick={() => setCurrentStep(5)} className="flex-1">
                Continue
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 5: Ready */}
        {currentStep === 5 && (
          <div className="space-y-6">
            <div className="text-center">
              <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="w-10 h-10 text-green-500" />
              </div>
              <h2 className="text-2xl font-bold text-gray-900">You're All Set!</h2>
              <p className="text-gray-500 mt-1">GoPilot is ready for your family</p>
            </div>

            <Card className="p-4">
              <h3 className="font-semibold mb-4">Your Setup</h3>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Children linked</span>
                  <span className="font-medium">{children.length}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Authorized pickups</span>
                  <span className="font-medium">{authorizedPickups.length}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Check-in method</span>
                  <span className="font-medium">{schoolCheckInMethod === 'qr' ? 'QR Code Tag' : 'GoPilot App'}</span>
                </div>
              </div>
            </Card>

            <Card className="p-4">
              <h3 className="font-semibold mb-3">Quick Actions</h3>
              <div className="grid grid-cols-2 gap-3">
                <button className="flex flex-col items-center gap-2 p-4 bg-gray-50 rounded-lg hover:bg-gray-100">
                  <Car className="w-6 h-6 text-indigo-600" />
                  <span className="text-sm font-medium">I'm Here</span>
                </button>
                <button className="flex flex-col items-center gap-2 p-4 bg-gray-50 rounded-lg hover:bg-gray-100">
                  <Edit className="w-6 h-6 text-indigo-600" />
                  <span className="text-sm font-medium">Change Pickup</span>
                </button>
                <button className="flex flex-col items-center gap-2 p-4 bg-gray-50 rounded-lg hover:bg-gray-100">
                  <Users className="w-6 h-6 text-indigo-600" />
                  <span className="text-sm font-medium">My Children</span>
                </button>
                <button className="flex flex-col items-center gap-2 p-4 bg-gray-50 rounded-lg hover:bg-gray-100">
                  <Clock className="w-6 h-6 text-indigo-600" />
                  <span className="text-sm font-medium">History</span>
                </button>
              </div>
            </Card>

            <Button variant="primary" size="lg" className="w-full" onClick={() => navigate('/gopilot/parent')}>
              <Home className="w-5 h-5 mr-2" />
              Go to Dashboard
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}

// Add Child Form Component
function CarNumberForm({ onLink, disabled }) {
  const [carNumber, setCarNumber] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (carNumber.trim()) {
      onLink(carNumber.trim());
    }
  };

  return (
    <Card className="p-5">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 bg-indigo-100 rounded-full flex items-center justify-center">
          <Car className="w-5 h-5 text-indigo-600" />
        </div>
        <div>
          <h3 className="font-semibold">Enter Your Car Number</h3>
          <p className="text-sm text-gray-500">This links all your children at once</p>
        </div>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="text"
          value={carNumber}
          onChange={(e) => setCarNumber(e.target.value)}
          placeholder="e.g. 42"
          className="w-full px-4 py-3 border rounded-lg text-center text-2xl tracking-widest font-mono font-bold"
          autoFocus
        />
        <p className="text-xs text-gray-400 text-center">Your family car number assigned by the school</p>
        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={disabled || !carNumber.trim()}>
          {disabled ? 'Linking...' : 'Link My Children'}
        </Button>
      </form>
    </Card>
  );
}

// Authorized Pickup Form Component
function AuthorizedPickupForm({ onAdd, disabled }) {
  const [showForm, setShowForm] = useState(false);
  const [pickup, setPickup] = useState({
    name: '',
    relationship: '',
    phone: '',
  });

  const relationships = ['Grandparent', 'Aunt/Uncle', 'Sibling (18+)', 'Family Friend', 'Nanny/Caregiver', 'Neighbor', 'Other'];

  const handleSubmit = (e) => {
    e.preventDefault();
    if (pickup.name && pickup.relationship && pickup.phone) {
      onAdd(pickup);
      setPickup({ name: '', relationship: '', phone: '' });
      setShowForm(false);
    }
  };

  if (!showForm) {
    return (
      <Button variant="secondary" size="md" onClick={() => setShowForm(true)} className="w-full" disabled={disabled}>
        <Plus className="w-4 h-4 mr-2" />
        Add Authorized Pickup
      </Button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 p-4 bg-gray-50 rounded-lg">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
        <input
          type="text"
          value={pickup.name}
          onChange={(e) => setPickup({ ...pickup, name: e.target.value })}
          placeholder="John Smith"
          className="w-full px-3 py-2 border rounded-lg"
          autoFocus
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Relationship</label>
        <select
          value={pickup.relationship}
          onChange={(e) => setPickup({ ...pickup, relationship: e.target.value })}
          className="w-full px-3 py-2 border rounded-lg"
        >
          <option value="">Select relationship...</option>
          {relationships.map(r => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Phone Number</label>
        <input
          type="tel"
          value={pickup.phone}
          onChange={(e) => setPickup({ ...pickup, phone: e.target.value })}
          placeholder="(555) 123-4567"
          className="w-full px-3 py-2 border rounded-lg"
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" className="flex-1" disabled={disabled}>
          Add Person
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
