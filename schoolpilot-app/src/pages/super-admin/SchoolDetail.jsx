import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ThemeToggle } from '../../components/ThemeToggle';
import api from '../../shared/utils/api';
import { calculateInvoicePreview, formatCents, PRODUCT_PRICING } from '../../shared/utils/pricing';

const statusColors = {
  active: 'bg-green-100 text-green-800',
  trial: 'bg-blue-100 text-blue-800',
  suspended: 'bg-red-100 text-red-800',
};

const ALL_PRODUCTS = [
  { key: 'CLASSPILOT', label: 'ClassPilot', bg: 'bg-amber-400', text: 'text-slate-900' },
  { key: 'PASSPILOT', label: 'PassPilot', bg: 'bg-blue-600', text: 'text-white' },
  { key: 'GOPILOT', label: 'GoPilot', bg: 'bg-indigo-500', text: 'text-white' },
];

export default function SchoolDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [school, setSchool] = useState(null);
  const [loading, setLoading] = useState(true);

  // Edit mode
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({});

  // Add admin
  const [showAddAdmin, setShowAddAdmin] = useState(false);
  const [adminForm, setAdminForm] = useState({ email: '', displayName: '', password: '' });
  const [adminResult, setAdminResult] = useState(null);

  // Edit admin
  const [editingAdminId, setEditingAdminId] = useState(null);
  const [editAdminForm, setEditAdminForm] = useState({ displayName: '' });

  // Reset login
  const [resetResult, setResetResult] = useState(null);

  // School Hours
  const [hoursForm, setHoursForm] = useState({
    enabled: false,
    startTime: '08:00',
    endTime: '15:00',
    timezone: 'America/New_York',
    days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    afterHoursMode: 'off',
  });
  const [hoursSaving, setHoursSaving] = useState(false);

  // Billing
  const [billingData, setBillingData] = useState(null);
  const [invoiceStudentCount, setInvoiceStudentCount] = useState(0);
  const [sendingInvoice, setSendingInvoice] = useState(false);
  const [invoiceResult, setInvoiceResult] = useState(null);

  const [error, setError] = useState(null);

  const loadSchool = async () => {
    try {
      setLoading(true);
      const res = await api.get(`/super-admin/schools/${id}`);
      const data = res.data;
      setSchool(data);
      setEditForm({
        name: data.name || '',
        domain: data.domain || '',
        status: data.status || 'active',
        maxLicenses: data.maxLicenses ?? 100,
        billingEmail: data.billingEmail || '',
      });
      if (data.schoolHours) {
        setHoursForm({
          enabled: data.schoolHours.enabled ?? false,
          startTime: data.schoolHours.startTime ?? '08:00',
          endTime: data.schoolHours.endTime ?? '15:00',
          timezone: data.schoolHours.timezone ?? 'America/New_York',
          days: data.schoolHours.days ?? ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
          afterHoursMode: data.schoolHours.afterHoursMode ?? 'off',
        });
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadSchool(); }, [id]);

  const handleSave = async () => {
    try {
      await api.patch(`/super-admin/schools/${id}`, editForm);
      setEditing(false);
      setError(null);
      loadSchool();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update');
    }
  };

  const handleAddAdmin = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api.post(`/super-admin/schools/${id}/admins`, adminForm);
      setAdminResult(res.data);
      setShowAddAdmin(false);
      setAdminForm({ email: '', displayName: '', password: '' });
      loadSchool();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add admin');
    }
  };

  const handleEditAdmin = async (membershipId) => {
    try {
      setError(null);
      await api.patch(`/super-admin/schools/${id}/admins/${membershipId}`, editAdminForm);
      setEditingAdminId(null);
      setEditAdminForm({ displayName: '' });
      loadSchool();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update admin');
    }
  };

  const handleDeleteAdmin = async (membershipId, adminName) => {
    if (!window.confirm(`Remove ${adminName} as admin from this school?`)) return;
    try {
      setError(null);
      await api.delete(`/super-admin/schools/${id}/admins/${membershipId}`);
      loadSchool();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to remove admin');
    }
  };

  const handleResetLogin = async () => {
    try {
      const res = await api.post(`/super-admin/schools/${id}/reset-login`);
      setResetResult(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to reset login');
    }
  };

  const handleImpersonate = async () => {
    try {
      await api.post(`/super-admin/schools/${id}/impersonate`);
      window.location.href = '/';
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to impersonate');
    }
  };

  const handleSuspend = async () => {
    try {
      await api.post(`/super-admin/schools/${id}/suspend`);
      loadSchool();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to suspend');
    }
  };

  const handleRestore = async () => {
    try {
      await api.post(`/super-admin/schools/${id}/restore`);
      loadSchool();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to restore');
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this school? This is a soft-delete.')) return;
    try {
      await api.delete(`/super-admin/schools/${id}`);
      navigate('/super-admin/schools');
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete');
    }
  };

  const handleSaveHours = async () => {
    try {
      setHoursSaving(true);
      setError(null);
      await api.patch(`/super-admin/schools/${id}`, { schoolHours: hoursForm });
      loadSchool();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save school hours');
    } finally {
      setHoursSaving(false);
    }
  };

  const toggleDay = (day) => {
    setHoursForm((prev) => ({
      ...prev,
      days: prev.days.includes(day)
        ? prev.days.filter((d) => d !== day)
        : [...prev.days, day],
    }));
  };

  const getHoursDuration = () => {
    const [sh, sm] = hoursForm.startTime.split(':').map(Number);
    const [eh, em] = hoursForm.endTime.split(':').map(Number);
    const diff = (eh * 60 + em - sh * 60 - sm) / 60;
    return diff > 0 ? diff : 0;
  };

  const handleAddProduct = async (product) => {
    try {
      setError(null);
      await api.post(`/super-admin/schools/${id}/products`, { product });
      loadSchool();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add product');
    }
  };

  const handleRemoveProduct = async (product) => {
    if (!window.confirm(`Remove ${product} from this school?`)) return;
    try {
      setError(null);
      await api.delete(`/super-admin/schools/${id}/products/${product}`);
      loadSchool();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to remove product');
    }
  };

  const loadBilling = async () => {
    try {
      const res = await api.get(`/super-admin/schools/${id}/billing`);
      setBillingData(res.data);
    } catch { /* ignore - billing may not be configured */ }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (school?.id) { loadBilling(); setInvoiceStudentCount(school.studentCount ?? 0); } }, [school?.id]);

  const handleSendInvoice = async () => {
    const preview = calculateInvoicePreview(activeProducts, invoiceStudentCount);
    if (!window.confirm(`Send invoice for ${formatCents(preview.totalCents)} to ${school.billingEmail || 'the school billing email'}?`)) return;
    try {
      setSendingInvoice(true);
      setError(null);
      const res = await api.post(`/super-admin/schools/${id}/send-invoice`, {
        studentCount: invoiceStudentCount,
        products: activeProducts,
      });
      setInvoiceResult(res.data);
      loadBilling();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send invoice');
    } finally {
      setSendingInvoice(false);
    }
  };

  if (loading) return <div className="p-6 text-center text-slate-400">Loading...</div>;
  if (!school) return <div className="p-6 text-center text-slate-400">School not found</div>;

  const admins = school.admins || [];
  const teachers = school.teachers || [];
  const studentCount = school.studentCount ?? 0;
  const activeProducts = school.products || [];

  // Safe date formatting
  const formatDate = (val) => {
    if (!val) return '—';
    const d = new Date(val);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Back */}
      <button
        onClick={() => navigate('/super-admin/schools')}
        className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700 mb-4"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        Back to Schools
      </button>

      {/* Error banner */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-sm text-red-700">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          {error}
          <button onClick={() => setError(null)} className="ml-auto text-red-500 hover:text-red-700">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      )}

      {/* Admin added result */}
      {adminResult?.tempPassword && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg">
          <p className="font-semibold text-green-800 mb-1">Admin added!</p>
          <p className="text-sm text-green-700">Email: {adminResult.user?.email || adminResult.email}</p>
          <p className="text-sm text-green-700">Temp Password: <span className="font-mono">{adminResult.tempPassword}</span></p>
          <button
            onClick={() => navigator.clipboard.writeText(adminResult.tempPassword)}
            className="mt-2 flex items-center gap-1 text-sm text-green-700 hover:text-green-900"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
            Copy Password
          </button>
        </div>
      )}

      {/* Reset login result */}
      {resetResult && (
        <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <p className="font-semibold text-blue-800 mb-1">Password Reset</p>
          <p className="text-sm text-blue-700">Temp Password: <span className="font-mono text-lg select-all">{resetResult.tempPassword}</span></p>
          <button
            onClick={() => navigator.clipboard.writeText(resetResult.tempPassword)}
            className="mt-2 flex items-center gap-1 text-sm text-blue-700 hover:text-blue-900"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
            Copy Password
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900">{school.name}</h1>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[school.status] || 'bg-slate-100'}`}>
              {school.status}
            </span>
          </div>
          <p className="text-sm text-slate-500">{school.domain || 'No domain'}</p>
        </div>
        <div className="flex gap-2">
          <ThemeToggle />
          <button onClick={handleImpersonate}
            className="flex items-center gap-1.5 px-3 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
            Impersonate
          </button>
          {school.status === 'suspended' ? (
            <button onClick={handleRestore}
              className="flex items-center gap-1.5 px-3 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">
              Restore
            </button>
          ) : (
            <button onClick={handleSuspend}
              className="flex items-center gap-1.5 px-3 py-2 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-700">
              Suspend
            </button>
          )}
          <button onClick={handleDelete}
            className="flex items-center gap-1.5 px-3 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700">
            Delete
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-slate-200 p-4 text-center">
          <p className="text-2xl font-bold text-slate-900">{admins.length}</p>
          <p className="text-sm text-slate-500">Admins</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4 text-center">
          <p className="text-2xl font-bold text-slate-900">{teachers.length}</p>
          <p className="text-sm text-slate-500">Teachers</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4 text-center">
          <p className="text-2xl font-bold text-slate-900">{studentCount}</p>
          <p className="text-sm text-slate-500">Students</p>
        </div>
      </div>

      {/* Products */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
        <h2 className="font-semibold text-slate-900 mb-4">Products</h2>
        <div className="flex flex-wrap gap-2">
          {ALL_PRODUCTS.map((p) => {
            const isActive = activeProducts.includes(p.key);
            return (
              <button
                key={p.key}
                onClick={() => isActive ? handleRemoveProduct(p.key) : handleAddProduct(p.key)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${
                  isActive
                    ? `${p.bg} ${p.text} ring-2 ring-offset-1 ring-slate-300`
                    : 'bg-slate-100 text-slate-400 hover:bg-slate-200 hover:text-slate-600'
                }`}
              >
                {isActive ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                )}
                {p.label}
              </button>
            );
          })}
        </div>
        {activeProducts.length === 0 && (
          <p className="text-sm text-slate-400 mt-2">No products assigned. Click a product above to activate it.</p>
        )}
      </div>

      {/* Billing & Invoicing */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
        <h2 className="font-semibold text-slate-900 mb-4">Billing & Invoicing</h2>

        {invoiceResult && (
          <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg">
            <p className="font-semibold text-green-800 mb-1">Invoice Sent!</p>
            <p className="text-sm text-green-700">Invoice ID: {invoiceResult.invoiceId}</p>
            {invoiceResult.invoiceUrl && (
              <a href={invoiceResult.invoiceUrl} target="_blank" rel="noopener noreferrer"
                className="text-sm text-green-700 underline">View Invoice</a>
            )}
          </div>
        )}

        {activeProducts.length === 0 ? (
          <p className="text-sm text-slate-400">Add products above before creating an invoice.</p>
        ) : (
          <>
            <div className="mb-4">
              <label className="text-xs text-slate-500 block mb-1">Student Count</label>
              <input
                type="number"
                min="1"
                value={invoiceStudentCount}
                onChange={(e) => setInvoiceStudentCount(Math.max(1, parseInt(e.target.value) || 0))}
                className="w-32 px-3 py-1.5 border border-slate-300 rounded text-sm"
              />
            </div>

            {(() => {
              const preview = calculateInvoicePreview(activeProducts, invoiceStudentCount);
              return (
                <div className="border border-slate-200 rounded-lg overflow-hidden mb-4">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="text-left px-4 py-2 text-slate-600 font-medium">Product</th>
                        <th className="text-right px-4 py-2 text-slate-600 font-medium">Base</th>
                        <th className="text-right px-4 py-2 text-slate-600 font-medium">Per-Student</th>
                        <th className="text-right px-4 py-2 text-slate-600 font-medium">Subtotal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.lineItems.map((item) => (
                        <tr key={item.product} className="border-t border-slate-100">
                          <td className="px-4 py-2 font-medium text-slate-900">{item.label}</td>
                          <td className="px-4 py-2 text-right text-slate-700">
                            {item.baseCents > 0 ? formatCents(item.baseCents) : '—'}
                          </td>
                          <td className="px-4 py-2 text-right text-slate-700">
                            {invoiceStudentCount} × ${item.perStudentDollars.toFixed(2)}
                          </td>
                          <td className="px-4 py-2 text-right text-slate-900 font-medium">{formatCents(item.subtotalCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-slate-200">
                        <td colSpan={3} className="px-4 py-2 text-right text-slate-600">Subtotal</td>
                        <td className="px-4 py-2 text-right text-slate-900 font-medium">{formatCents(preview.subtotalCents)}</td>
                      </tr>
                      {preview.discountCents > 0 && (
                        <tr className="border-t border-slate-100">
                          <td colSpan={3} className="px-4 py-2 text-right text-green-700">
                            Bundle Discount ({activeProducts.length} products — {Math.round(preview.discountRate * 100)}% off)
                          </td>
                          <td className="px-4 py-2 text-right text-green-700 font-medium">-{formatCents(preview.discountCents)}</td>
                        </tr>
                      )}
                      <tr className="border-t-2 border-slate-300 bg-slate-50">
                        <td colSpan={3} className="px-4 py-2 text-right text-slate-900 font-semibold">Total Due (Annual)</td>
                        <td className="px-4 py-2 text-right text-slate-900 font-bold text-base">{formatCents(preview.totalCents)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              );
            })()}

            <p className="text-sm text-slate-500 mb-3">
              Invoice will be sent to: <span className="font-medium text-slate-700">{school.billingEmail || 'No billing email set'}</span>
            </p>

            <button
              onClick={handleSendInvoice}
              disabled={sendingInvoice || !school.billingEmail || invoiceStudentCount < 1}
              className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
            >
              {sendingInvoice ? 'Sending...' : 'Send Invoice'}
            </button>
            {!school.billingEmail && (
              <p className="text-xs text-red-500 mt-1">Set a billing email for this school before sending an invoice.</p>
            )}
          </>
        )}

        {billingData?.invoices && billingData.invoices.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-medium text-slate-700 mb-2">Invoice History</h3>
            <div className="space-y-2">
              {billingData.invoices.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{formatCents(inv.amount)}</p>
                    <p className="text-xs text-slate-400">{new Date(inv.created * 1000).toLocaleDateString()}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      inv.status === 'paid' ? 'bg-green-100 text-green-800' :
                      inv.status === 'open' ? 'bg-blue-100 text-blue-800' :
                      inv.status === 'void' ? 'bg-slate-100 text-slate-600' :
                      'bg-red-100 text-red-800'
                    }`}>
                      {inv.status}
                    </span>
                    {inv.hostedUrl && (
                      <a href={inv.hostedUrl} target="_blank" rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:text-blue-700 underline">View</a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* School Hours - shown if school has ClassPilot or PassPilot */}
      {(activeProducts.includes('CLASSPILOT') || activeProducts.includes('PASSPILOT')) && (
        <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-semibold text-slate-900">School Hours</h2>
              <p className="text-xs text-slate-500">Applies to ClassPilot (device monitoring) and PassPilot (hall passes). GoPilot uses its own dismissal time.</p>
            </div>
          </div>

          {/* Enable toggle */}
          <label className="flex items-center gap-3 mb-4 cursor-pointer">
            <div className={`relative w-10 h-6 rounded-full transition-colors ${hoursForm.enabled ? 'bg-green-500' : 'bg-slate-300'}`}
              onClick={() => setHoursForm({ ...hoursForm, enabled: !hoursForm.enabled })}>
              <div className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${hoursForm.enabled ? 'left-5' : 'left-1'}`} />
            </div>
            <span className="text-sm font-medium text-slate-700">
              {hoursForm.enabled ? 'Restricted to school hours' : 'No restriction (24/7 operation)'}
            </span>
          </label>

          {hoursForm.enabled && (
            <div className="space-y-4">
              {/* Time range */}
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <label className="text-xs text-slate-500">Start Time</label>
                  <input type="time" value={hoursForm.startTime}
                    onChange={(e) => setHoursForm({ ...hoursForm, startTime: e.target.value })}
                    className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm" />
                </div>
                <span className="text-slate-400 mt-4">to</span>
                <div className="flex-1">
                  <label className="text-xs text-slate-500">End Time</label>
                  <input type="time" value={hoursForm.endTime}
                    onChange={(e) => setHoursForm({ ...hoursForm, endTime: e.target.value })}
                    className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm" />
                </div>
              </div>

              {/* Duration indicator */}
              {(() => {
                const dur = getHoursDuration();
                return (
                  <div className={`text-sm px-3 py-2 rounded ${dur > 9 ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-slate-50 text-slate-600'}`}>
                    {dur > 0 ? `${dur.toFixed(1)} hours per day` : 'Invalid time range'}
                    {dur > 9 && ' — Schools operating more than 9 hours per day may incur additional infrastructure costs.'}
                  </div>
                );
              })()}

              {/* Days */}
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Active Days</label>
                <div className="flex flex-wrap gap-2">
                  {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day) => (
                    <button key={day} onClick={() => toggleDay(day)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        hoursForm.days.includes(day)
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                      }`}>
                      {day.slice(0, 3)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Timezone */}
              <div>
                <label className="text-xs text-slate-500">Timezone</label>
                <select value={hoursForm.timezone}
                  onChange={(e) => setHoursForm({ ...hoursForm, timezone: e.target.value })}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm">
                  <option value="America/New_York">Eastern (ET)</option>
                  <option value="America/Chicago">Central (CT)</option>
                  <option value="America/Denver">Mountain (MT)</option>
                  <option value="America/Los_Angeles">Pacific (PT)</option>
                  <option value="America/Anchorage">Alaska (AKT)</option>
                  <option value="Pacific/Honolulu">Hawaii (HT)</option>
                </select>
              </div>

              {/* After-hours mode */}
              <div>
                <label className="text-xs text-slate-500">After-Hours Behavior</label>
                <select value={hoursForm.afterHoursMode}
                  onChange={(e) => setHoursForm({ ...hoursForm, afterHoursMode: e.target.value })}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm">
                  <option value="off">Off — Extensions sleep, no passes</option>
                  <option value="limited">Limited — Monitor only, no alerts</option>
                </select>
              </div>

              {/* Save */}
              <button onClick={handleSaveHours} disabled={hoursSaving}
                className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-50">
                {hoursSaving ? 'Saving...' : 'Save School Hours'}
              </button>
            </div>
          )}

          {!hoursForm.enabled && (
            <button onClick={handleSaveHours} disabled={hoursSaving}
              className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-50">
              {hoursSaving ? 'Saving...' : 'Save'}
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* School Info */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-slate-900">School Info</h2>
            {!editing ? (
              <button onClick={() => setEditing(true)} className="text-sm text-blue-600 hover:text-blue-700">Edit</button>
            ) : (
              <div className="flex gap-2">
                <button onClick={handleSave} className="text-sm text-green-600 hover:text-green-700">Save</button>
                <button onClick={() => setEditing(false)} className="text-sm text-slate-500 hover:text-slate-700">Cancel</button>
              </div>
            )}
          </div>
          {editing ? (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-500">Name</label>
                <input value={editForm.name} onChange={(e) => setEditForm({...editForm, name: e.target.value})}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm" />
              </div>
              <div>
                <label className="text-xs text-slate-500">Domain</label>
                <input value={editForm.domain} onChange={(e) => setEditForm({...editForm, domain: e.target.value})}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm" />
              </div>
              <div>
                <label className="text-xs text-slate-500">Status</label>
                <select value={editForm.status} onChange={(e) => setEditForm({...editForm, status: e.target.value})}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm">
                  <option value="trial">Trial</option>
                  <option value="active">Active</option>
                  <option value="suspended">Suspended</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-500">Max Licenses</label>
                <input type="number" value={editForm.maxLicenses} onChange={(e) => setEditForm({...editForm, maxLicenses: parseInt(e.target.value) || 0})}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm" />
              </div>
              <div>
                <label className="text-xs text-slate-500">Billing Email</label>
                <input type="email" value={editForm.billingEmail} onChange={(e) => setEditForm({...editForm, billingEmail: e.target.value})}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm" placeholder="billing@school.edu" />
              </div>
            </div>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">Domain</span><span>{school.domain || '—'}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Max Licenses</span><span>{school.maxLicenses ?? '—'}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Billing Email</span><span className="text-xs">{school.billingEmail || '—'}</span></div>
              {school.trialEndsAt && (
                <div className="flex justify-between"><span className="text-slate-500">Trial Ends</span><span>{formatDate(school.trialEndsAt)}</span></div>
              )}
              <div className="flex justify-between"><span className="text-slate-500">Created</span><span>{formatDate(school.createdAt)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">ID</span><span className="font-mono text-xs">{school.id?.substring(0, 8)}</span></div>
            </div>
          )}
        </div>

        {/* Admins */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-slate-900">Admins</h2>
            <div className="flex gap-2">
              <button onClick={handleResetLogin}
                className="text-sm text-orange-600 hover:text-orange-700">Reset Login</button>
              <button onClick={() => setShowAddAdmin(!showAddAdmin)}
                className="text-sm text-blue-600 hover:text-blue-700">Add Admin</button>
            </div>
          </div>

          {showAddAdmin && (
            <form onSubmit={handleAddAdmin} className="mb-4 p-3 bg-slate-50 rounded-lg space-y-2">
              <input
                placeholder="Email *"
                value={adminForm.email}
                onChange={(e) => setAdminForm({...adminForm, email: e.target.value})}
                className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm"
                required
              />
              <input
                placeholder="Display Name"
                value={adminForm.displayName}
                onChange={(e) => setAdminForm({...adminForm, displayName: e.target.value})}
                className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm"
              />
              <input
                placeholder="Password (optional, auto-generated)"
                type="password"
                value={adminForm.password}
                onChange={(e) => setAdminForm({...adminForm, password: e.target.value})}
                className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm"
              />
              <button type="submit"
                className="w-full px-3 py-1.5 bg-slate-900 text-white rounded text-sm font-medium hover:bg-slate-800">
                Add Admin
              </button>
            </form>
          )}

          <div className="space-y-2">
            {admins.length === 0 ? (
              <p className="text-sm text-slate-400">No admins assigned</p>
            ) : (
              admins.map((admin) => {
                const name = admin.displayName || `${admin.firstName || ''} ${admin.lastName || ''}`.trim() || admin.email;
                const isEditing = editingAdminId === admin.id;

                if (isEditing) {
                  return (
                    <div key={admin.id} className="p-3 bg-slate-50 rounded-lg space-y-2">
                      <input
                        value={editAdminForm.displayName}
                        onChange={(e) => setEditAdminForm({ displayName: e.target.value })}
                        placeholder="Display Name"
                        className="w-full px-3 py-1.5 border border-slate-300 rounded text-sm"
                        autoFocus
                      />
                      <p className="text-xs text-slate-400">{admin.email}</p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleEditAdmin(admin.id)}
                          className="px-3 py-1 bg-slate-900 text-white rounded text-xs font-medium hover:bg-slate-800"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => { setEditingAdminId(null); setEditAdminForm({ displayName: '' }); }}
                          className="px-3 py-1 border border-slate-300 rounded text-xs font-medium hover:bg-slate-100"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={admin.id} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg group">
                    <div>
                      <p className="text-sm font-medium text-slate-900">{name}</p>
                      <p className="text-xs text-slate-400">{admin.email}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => { setEditingAdminId(admin.id); setEditAdminForm({ displayName: name }); }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-slate-400 hover:text-blue-600"
                        title="Edit admin"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                      </button>
                      <button
                        onClick={() => handleDeleteAdmin(admin.id, name)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-slate-400 hover:text-red-600"
                        title="Remove admin"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                      </button>
                      <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">admin</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {teachers.length > 0 && (
            <>
              <h3 className="text-sm font-medium text-slate-500 mt-4 mb-2">Teachers ({teachers.length})</h3>
              <div className="space-y-2 max-h-40 overflow-y-auto">
                {teachers.map((teacher) => (
                  <div key={teacher.id} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg">
                    <div>
                      <p className="text-sm font-medium text-slate-900">{teacher.displayName || `${teacher.firstName || ''} ${teacher.lastName || ''}`.trim() || teacher.email}</p>
                      <p className="text-xs text-slate-400">{teacher.email}</p>
                    </div>
                    <span className="text-xs bg-slate-200 text-slate-700 px-2 py-0.5 rounded-full">teacher</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
