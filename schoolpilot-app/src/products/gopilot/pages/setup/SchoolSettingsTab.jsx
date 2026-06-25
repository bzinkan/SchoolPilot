import React, { useState, useEffect } from 'react';
import { Save, CheckCircle2, Smartphone, QrCode, Eye } from 'lucide-react';
import api from '../../../../shared/utils/api';
import { TIMEZONES } from './constants';

const DEFAULT_PARENT_DIGEST_SETTINGS = {
  parentTransparencyEnabled: false,
  parentDigestIncludesPassDismissal: true,
  parentDigestIncludesSafety: false,
};

export default function SchoolSettingsTab({ schoolId }) {
  const [dismissalTime, setDismissalTime] = useState('15:00');
  const [timezone, setTimezone] = useState('America/New_York');
  const [changeRequestWarning, setChangeRequestWarning] = useState('');
  const [checkInMethod, setCheckInMethod] = useState('app');
  const [autoDismissalEnabled, setAutoDismissalEnabled] = useState(true);
  const [parentDigestSettings, setParentDigestSettings] = useState(() => ({ ...DEFAULT_PARENT_DIGEST_SETTINGS }));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [parentDigestSaving, setParentDigestSaving] = useState(false);
  const [parentDigestSaved, setParentDigestSaved] = useState(false);
  const [parentDigestError, setParentDigestError] = useState('');

  useEffect(() => {
    if (!schoolId) return;
    Promise.all([
      api.get(`/schools/${schoolId}`),
      api.get(`/schools/${schoolId}/settings`).catch(() => ({ data: {} })),
      api.get('/gopilot/settings/parent-digests').catch(() => ({ data: { settings: DEFAULT_PARENT_DIGEST_SETTINGS } })),
    ]).then(([schoolRes, settingsRes, parentDigestRes]) => {
      const school = schoolRes.data?.school || schoolRes.data;
      setDismissalTime(school.dismissalTime || school.dismissal_time || '15:00');
      setTimezone(school.schoolTimezone || school.school_timezone || school.timezone || 'America/New_York');
      setChangeRequestWarning(settingsRes.data?.changeRequestWarning || '');
      setCheckInMethod(settingsRes.data?.checkInMethod || (settingsRes.data?.enableQrCodes ? 'qr' : 'app'));
      setAutoDismissalEnabled(settingsRes.data?.autoDismissalEnabled !== false);
      setParentDigestSettings({
        ...DEFAULT_PARENT_DIGEST_SETTINGS,
        ...(parentDigestRes.data?.settings || {}),
      });
    }).finally(() => setLoading(false));
  }, [schoolId]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await api.put(`/schools/${schoolId}`, { dismissalTime, schoolTimezone: timezone });
      const currentSettings = await api.get(`/schools/${schoolId}/settings`).then(r => r.data).catch(() => ({}));
      await api.put(`/schools/${schoolId}/settings`, { ...currentSettings, changeRequestWarning: changeRequestWarning.trim() || undefined, checkInMethod, enableQrCodes: checkInMethod === 'qr', autoDismissalEnabled });
      setSaved(true);
    } catch (err) {
      console.error('Failed to save settings:', err);
    } finally {
      setSaving(false);
    }
  };

  const updateParentDigestSetting = async (changes) => {
    const nextSettings = { ...parentDigestSettings, ...changes };
    const previousSettings = parentDigestSettings;
    setParentDigestSettings(nextSettings);
    setParentDigestSaving(true);
    setParentDigestSaved(false);
    setParentDigestError('');
    try {
      const response = await api.patch('/gopilot/settings/parent-digests', {
        parentTransparencyEnabled: !!nextSettings.parentTransparencyEnabled,
        parentDigestIncludesPassDismissal: nextSettings.parentDigestIncludesPassDismissal !== false,
        parentDigestIncludesSafety: !!nextSettings.parentDigestIncludesSafety,
      });
      setParentDigestSettings({
        ...DEFAULT_PARENT_DIGEST_SETTINGS,
        ...(response.data?.settings || nextSettings),
      });
      setParentDigestSaved(true);
    } catch (err) {
      setParentDigestSettings(previousSettings);
      setParentDigestError(err.response?.data?.error || err.message || 'Failed to save parent digest settings.');
    } finally {
      setParentDigestSaving(false);
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
          <div className="flex items-center justify-between mb-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-200">Auto-Start Dismissal</label>
              <p className="text-xs text-gray-500 dark:text-slate-400">Automatically start dismissal at the scheduled time each school day.</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={autoDismissalEnabled}
              onClick={() => setAutoDismissalEnabled(!autoDismissalEnabled)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${autoDismissalEnabled ? 'bg-indigo-600' : 'bg-gray-300 dark:bg-slate-600'}`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${autoDismissalEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
        </div>

        <div className={!autoDismissalEnabled ? 'opacity-50 pointer-events-none' : ''}>
          <label className="block text-sm font-medium text-gray-700 dark:text-slate-200 mb-1">Dismissal Start Time</label>
          <p className="text-xs text-gray-500 dark:text-slate-400 mb-2">{autoDismissalEnabled ? 'Dismissal will automatically start at this time each school day.' : 'Enable auto-start to schedule dismissal.'}</p>
          <input
            type="time"
            value={dismissalTime}
            onChange={e => setDismissalTime(e.target.value)}
            disabled={!autoDismissalEnabled}
            className="w-full px-4 py-2.5 border border-gray-300 dark:border-slate-600 dark:bg-slate-800 dark:text-white rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
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

        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="mb-4 flex items-start gap-3">
            <Eye className="mt-0.5 h-5 w-5 text-gray-600 dark:text-slate-300" />
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Parent Transparency Digest</h3>
              <p className="text-xs text-gray-500 dark:text-slate-400">Weekly opt-in summaries for approved GoPilot parent-child links.</p>
            </div>
          </div>

          <div className="space-y-3">
            <label className="flex items-start gap-3 rounded-lg border border-gray-200 p-3 dark:border-slate-700">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 text-indigo-600"
                checked={!!parentDigestSettings.parentTransparencyEnabled}
                disabled={parentDigestSaving}
                onChange={e => updateParentDigestSetting({ parentTransparencyEnabled: e.target.checked })}
              />
              <span>
                <span className="block text-sm font-medium text-gray-900 dark:text-white">Enable weekly parent digests</span>
                <span className="text-xs text-gray-500 dark:text-slate-400">Uses approved GoPilot parent links only.</span>
              </span>
            </label>

            <label className="flex items-start gap-3 rounded-lg border border-gray-200 p-3 dark:border-slate-700">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 text-indigo-600"
                checked={parentDigestSettings.parentDigestIncludesPassDismissal !== false}
                disabled={parentDigestSaving}
                onChange={e => updateParentDigestSetting({ parentDigestIncludesPassDismissal: e.target.checked })}
              />
              <span>
                <span className="block text-sm font-medium text-gray-900 dark:text-white">Include pass and dismissal summary</span>
                <span className="text-xs text-gray-500 dark:text-slate-400">Shows counts and high-level school day context.</span>
              </span>
            </label>

            <label className="flex items-start gap-3 rounded-lg border border-gray-200 p-3 dark:border-slate-700">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 text-indigo-600"
                checked={!!parentDigestSettings.parentDigestIncludesSafety}
                disabled={parentDigestSaving}
                onChange={e => updateParentDigestSetting({ parentDigestIncludesSafety: e.target.checked })}
              />
              <span>
                <span className="block text-sm font-medium text-gray-900 dark:text-white">Include staff-approved safety notes</span>
                <span className="text-xs text-gray-500 dark:text-slate-400">No screenshots, raw browsing timelines, or raw email content are included.</span>
              </span>
            </label>
          </div>

          <div className="mt-3 min-h-5 text-xs">
            {parentDigestSaving && <span className="text-gray-500 dark:text-slate-400">Saving digest settings...</span>}
            {!parentDigestSaving && parentDigestSaved && <span className="text-green-600">Digest settings saved.</span>}
            {!parentDigestSaving && parentDigestError && <span className="text-red-600">{parentDigestError}</span>}
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
