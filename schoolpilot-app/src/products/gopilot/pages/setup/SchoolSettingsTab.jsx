import React, { useState, useEffect } from 'react';
import { Save, CheckCircle2, Smartphone, QrCode } from 'lucide-react';
import api from '../../../../shared/utils/api';
import { TIMEZONES } from './constants';

export default function SchoolSettingsTab({ schoolId }) {
  const [dismissalTime, setDismissalTime] = useState('15:00');
  const [timezone, setTimezone] = useState('America/New_York');
  const [changeRequestWarning, setChangeRequestWarning] = useState('');
  const [checkInMethod, setCheckInMethod] = useState('app');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!schoolId) return;
    Promise.all([
      api.get(`/schools/${schoolId}`),
      api.get(`/schools/${schoolId}/settings`).catch(() => ({ data: {} })),
    ]).then(([schoolRes, settingsRes]) => {
      const school = schoolRes.data?.school || schoolRes.data;
      setDismissalTime(school.dismissalTime || school.dismissal_time || '15:00');
      setTimezone(school.schoolTimezone || school.school_timezone || school.timezone || 'America/New_York');
      setChangeRequestWarning(settingsRes.data?.changeRequestWarning || '');
      setCheckInMethod(settingsRes.data?.checkInMethod || (settingsRes.data?.enableQrCodes ? 'qr' : 'app'));
    }).finally(() => setLoading(false));
  }, [schoolId]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await api.put(`/schools/${schoolId}`, { dismissalTime, schoolTimezone: timezone });
      const currentSettings = await api.get(`/schools/${schoolId}/settings`).then(r => r.data).catch(() => ({}));
      await api.put(`/schools/${schoolId}/settings`, { ...currentSettings, changeRequestWarning: changeRequestWarning.trim() || undefined, checkInMethod, enableQrCodes: checkInMethod === 'qr' });
      setSaved(true);
    } catch (err) {
      console.error('Failed to save settings:', err);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-6 text-center text-gray-500 dark:text-slate-400">Loading settings...</div>;
  }

  return (
    <div className="p-6 max-w-2xl">
      <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-6">School Settings</h2>

      <div className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Dismissal Start Time</label>
          <p className="text-xs text-gray-500 dark:text-slate-400 mb-2">Dismissal will automatically start at this time each school day.</p>
          <input
            type="time"
            value={dismissalTime}
            onChange={e => setDismissalTime(e.target.value)}
            className="w-full px-4 py-2.5 border border-gray-300 dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">School Timezone</label>
          <p className="text-xs text-gray-500 dark:text-slate-400 mb-2">Auto-detected at registration. Change only if your school is in a different timezone.</p>
          <select
            value={timezone}
            onChange={e => setTimezone(e.target.value)}
            className="w-full px-4 py-2.5 border border-gray-300 dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          >
            {TIMEZONES.map(tz => (
              <option key={tz.value} value={tz.value}>{tz.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Change Request Warning (Optional)</label>
          <p className="text-xs text-gray-500 dark:text-slate-400 mb-2">If set, parents will see this message when submitting a change request. Leave blank for no warning.</p>
          <textarea
            value={changeRequestWarning}
            onChange={e => setChangeRequestWarning(e.target.value)}
            placeholder="e.g. Changes submitted after 2:30 PM require office approval."
            rows={2}
            className="w-full px-4 py-2.5 border border-gray-300 dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Parent Check-In Method</label>
          <p className="text-xs text-gray-500 dark:text-slate-400 mb-3">How parents check in when they arrive for pickup.</p>
          <div className="space-y-2">
            <label
              className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${checkInMethod === 'app' ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20' : 'border-gray-200 dark:border-slate-600 hover:border-gray-300 dark:hover:border-slate-500'}`}
              onClick={() => setCheckInMethod('app')}
            >
              <input type="radio" name="checkInMethod" value="app" checked={checkInMethod === 'app'} onChange={() => setCheckInMethod('app')} className="text-indigo-600" />
              <Smartphone className="w-5 h-5 text-gray-600 dark:text-slate-300" />
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-white">GoPilot App</p>
                <p className="text-xs text-gray-500 dark:text-slate-400">Parents tap "I'm Here" in the app when they arrive</p>
              </div>
            </label>
            <label
              className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${checkInMethod === 'qr' ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20' : 'border-gray-200 dark:border-slate-600 hover:border-gray-300 dark:hover:border-slate-500'}`}
              onClick={() => setCheckInMethod('qr')}
            >
              <input type="radio" name="checkInMethod" value="qr" checked={checkInMethod === 'qr'} onChange={() => setCheckInMethod('qr')} className="text-indigo-600" />
              <QrCode className="w-5 h-5 text-gray-600 dark:text-slate-300" />
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-white">QR Code Tag</p>
                <p className="text-xs text-gray-500 dark:text-slate-400">Parents display their QR code tag in the car window</p>
              </div>
            </label>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
          {saved && (
            <span className="flex items-center gap-1 text-sm text-green-600">
              <CheckCircle2 className="w-4 h-4" /> Saved
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
