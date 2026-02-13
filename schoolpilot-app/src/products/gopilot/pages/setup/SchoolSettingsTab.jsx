import React, { useState, useEffect } from 'react';
import { Save, CheckCircle2 } from 'lucide-react';
import api from '../../../../shared/utils/api';
import { TIMEZONES } from './constants';

export default function SchoolSettingsTab({ schoolId }) {
  const [name, setName] = useState('');
  const [dismissalTime, setDismissalTime] = useState('15:00');
  const [timezone, setTimezone] = useState('America/New_York');
  const [changeRequestWarning, setChangeRequestWarning] = useState('');
  const [enableQrCodes, setEnableQrCodes] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!schoolId) return;
    Promise.all([
      api.get(`/schools/${schoolId}`),
      api.get(`/schools/${schoolId}/settings`).catch(() => ({ data: {} })),
    ]).then(([schoolRes, settingsRes]) => {
      const school = schoolRes.data;
      setName(school.name || '');
      setDismissalTime(school.dismissal_time || '15:00');
      setTimezone(school.timezone || 'America/New_York');
      setChangeRequestWarning(settingsRes.data?.changeRequestWarning || '');
      setEnableQrCodes(settingsRes.data?.enableQrCodes || false);
    }).finally(() => setLoading(false));
  }, [schoolId]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await api.put(`/schools/${schoolId}`, { name, dismissalTime, timezone });
      // Save settings separately (changeRequestWarning goes in settings JSON)
      const currentSettings = await api.get(`/schools/${schoolId}/settings`).then(r => r.data).catch(() => ({}));
      await api.put(`/schools/${schoolId}/settings`, { ...currentSettings, changeRequestWarning: changeRequestWarning.trim() || undefined, enableQrCodes });
      window.location.reload();
    } catch (err) {
      console.error('Failed to save settings:', err);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-6 text-center text-gray-500">Loading settings...</div>;
  }

  return (
    <div className="p-6 max-w-2xl">
      <h2 className="text-lg font-bold text-gray-900 mb-6">School Settings</h2>

      <div className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">School Name</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Dismissal Start Time</label>
          <p className="text-xs text-gray-500 mb-2">Dismissal will automatically start at this time each school day.</p>
          <input
            type="time"
            value={dismissalTime}
            onChange={e => setDismissalTime(e.target.value)}
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">School Timezone</label>
          <p className="text-xs text-gray-500 mb-2">Auto-detected at registration. Change only if your school is in a different timezone.</p>
          <select
            value={timezone}
            onChange={e => setTimezone(e.target.value)}
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          >
            {TIMEZONES.map(tz => (
              <option key={tz.value} value={tz.value}>{tz.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Change Request Warning (Optional)</label>
          <p className="text-xs text-gray-500 mb-2">If set, parents will see this message when submitting a change request. Leave blank for no warning.</p>
          <textarea
            value={changeRequestWarning}
            onChange={e => setChangeRequestWarning(e.target.value)}
            placeholder="e.g. Changes submitted after 2:30 PM require office approval."
            rows={2}
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>

        <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
          <div>
            <p className="text-sm font-medium text-gray-700">Enable QR Codes</p>
            <p className="text-xs text-gray-500">Allow printing QR codes for students so parents can scan to link their account.</p>
          </div>
          <button
            type="button"
            onClick={() => setEnableQrCodes(!enableQrCodes)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${enableQrCodes ? 'bg-indigo-600' : 'bg-gray-300'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enableQrCodes ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
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
