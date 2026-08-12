import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import api from '../../../../shared/utils/api';
import SchoolCalendarMonth from '../../../classpilot/components/SchoolCalendarMonth';
import { TIMEZONES } from './constants';
import { nextPickupZoneId } from '../../utils/pickupZones';

const DEFAULT_SETTINGS = Object.freeze({
  dismissalTime: null,
  schoolTimezone: 'America/New_York',
  autoStartEnabled: false,
  pickupZones: [],
  revision: 0,
});

function normalizeSettings(payload) {
  const source = payload?.settings || payload || {};
  return {
    dismissalTime: typeof source.dismissalTime === 'string' && source.dismissalTime
      ? source.dismissalTime
      : null,
    schoolTimezone: source.schoolTimezone || DEFAULT_SETTINGS.schoolTimezone,
    autoStartEnabled: source.autoStartEnabled === true,
    pickupZones: Array.isArray(source.pickupZones)
      ? source.pickupZones.map((zone, index) => ({
          id: String(zone.id || `zone_${index + 1}`),
          name: String(zone.name || '').trim(),
        }))
      : [],
    revision: Number.isInteger(source.revision) ? source.revision : 0,
  };
}

function editable(settings) {
  const { revision: _revision, ...draft } = settings;
  return draft;
}

function sameSettings(a, b) {
  return JSON.stringify(editable(a)) === JSON.stringify(editable(b));
}

function currentMonthInTimeZone(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}`;
}

export default function SchoolSettingsTab({ onDirtyChange = () => {} }) {
  const [savedSettings, setSavedSettings] = useState(DEFAULT_SETTINGS);
  const [draft, setDraft] = useState(editable(DEFAULT_SETTINGS));
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [conflict, setConflict] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => currentMonthInTimeZone(DEFAULT_SETTINGS.schoolTimezone));
  const [calendarDirty, setCalendarDirty] = useState(false);
  const calendarInitializedRef = useRef(false);

  const dirty = useMemo(
    () => !sameSettings({ ...draft, revision: savedSettings.revision }, savedSettings),
    [draft, savedSettings],
  );

  useEffect(() => {
    onDirtyChange(dirty || calendarDirty);
    return () => onDirtyChange(false);
  }, [calendarDirty, dirty, onDirtyChange]);

  const loadSettings = useCallback(async ({ preserveDraft = false } = {}) => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await api.get('/gopilot/settings');
      const authoritative = normalizeSettings(response.data);
      setSavedSettings(authoritative);
      if (!preserveDraft) setDraft(editable(authoritative));
      if (!calendarInitializedRef.current) {
        setCalendarMonth(currentMonthInTimeZone(authoritative.schoolTimezone));
        calendarInitializedRef.current = true;
      }
      setHasLoaded(true);
      setLoadError(null);
      setConflict(false);
    } catch (error) {
      const text = error.response?.data?.error || 'Settings could not be loaded. Try again before making changes.';
      setLoadError(text);
      setMessage({
        type: 'error',
        text,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const updateZone = (index, value) => {
    setDraft((current) => ({
      ...current,
      pickupZones: current.pickupZones.map((zone, zoneIndex) => (
        zoneIndex === index ? { ...zone, name: value } : zone
      )),
    }));
    setMessage(null);
  };

  const addZone = () => {
    setDraft((current) => ({
      ...current,
      pickupZones: [
        ...current.pickupZones,
        { id: nextPickupZoneId(current.pickupZones), name: '' },
      ],
    }));
    setMessage(null);
  };

  const removeZone = (index) => {
    setDraft((current) => ({
      ...current,
      pickupZones: current.pickupZones.filter((_, zoneIndex) => zoneIndex !== index),
    }));
    setMessage(null);
  };

  const handleSave = async () => {
    const pickupZones = draft.pickupZones.map((zone) => ({ ...zone, name: zone.name.trim() }));
    if (draft.autoStartEnabled && !draft.dismissalTime) {
      setMessage({ type: 'error', text: 'Choose a dismissal time before enabling auto-start.' });
      return;
    }
    if (pickupZones.length === 0) {
      setMessage({ type: 'error', text: 'At least one pickup zone is required.' });
      return;
    }
    if (pickupZones.some((zone) => !zone.name)) {
      setMessage({ type: 'error', text: 'Every pickup zone needs a name.' });
      return;
    }
    if (new Set(pickupZones.map((zone) => zone.name.toLocaleLowerCase())).size !== pickupZones.length) {
      setMessage({ type: 'error', text: 'Pickup zone names must be unique.' });
      return;
    }

    setSaving(true);
    setMessage(null);
    setConflict(false);
    try {
      const response = await api.patch('/gopilot/settings', {
        ...draft,
        pickupZones,
        expectedRevision: savedSettings.revision,
      });
      const authoritative = normalizeSettings(response.data);
      setSavedSettings(authoritative);
      setDraft(editable(authoritative));
      setMessage({ type: 'success', text: `Settings saved and verified (revision ${authoritative.revision}).` });
    } catch (error) {
      if (error.response?.status === 409) {
        setConflict(true);
        setMessage({
          type: 'error',
          text: 'Another administrator saved settings first. Reload the latest version, review it, and save again.',
        });
      } else {
        setMessage({
          type: 'error',
          text: error.response?.data?.error || 'Nothing was saved. Your changes are still here so you can try again.',
        });
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 p-10 text-sm text-gray-500 dark:text-slate-400" role="status">
        <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading school settings…
      </div>
    );
  }

  if (!hasLoaded) {
    return (
      <section className="mx-auto max-w-3xl pb-10" aria-labelledby="gopilot-settings-unavailable-title">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-amber-950 shadow-sm dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100" role="alert">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <div>
              <h2 id="gopilot-settings-unavailable-title" className="font-bold">Dismissal settings are unavailable</h2>
              <p className="mt-1 text-sm">{loadError || 'Settings could not be loaded. Try again before making changes.'}</p>
              <p className="mt-2 text-xs opacity-80">No settings can be edited or saved until the current school configuration loads successfully.</p>
              <button type="button" onClick={() => loadSettings()} className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-lg bg-amber-900 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700 focus-visible:ring-offset-2 dark:bg-amber-200 dark:text-amber-950 dark:hover:bg-amber-100">
                <RefreshCw className="h-4 w-4" aria-hidden="true" /> Retry loading settings
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-5xl pb-10" aria-labelledby="gopilot-settings-title">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-indigo-600 dark:text-indigo-400">Staff workflow</p>
          <h2 id="gopilot-settings-title" className="mt-1 text-2xl font-bold tracking-tight text-gray-950 dark:text-white">Dismissal settings</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">GoPilot arrivals are entered by authorized school staff.</p>
        </div>
        <span className="text-xs font-medium text-gray-500 dark:text-slate-400">Saved revision {savedSettings.revision}</span>
      </div>

      {message && (
        <div
          role={message.type === 'error' ? 'alert' : 'status'}
          className={`mb-5 flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${
            message.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'
          }`}
        >
          {message.type === 'success'
            ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
          <div className="flex-1">
            <p>{message.text}</p>
            {conflict && (
              <button type="button" onClick={() => loadSettings()} className="mt-2 font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                Reload latest settings
              </button>
            )}
          </div>
        </div>
      )}

      <div className="space-y-5 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900 sm:p-6">
        <div className="flex items-start justify-between gap-5 rounded-xl bg-slate-50 p-4 dark:bg-slate-800/60">
          <div>
            <label htmlFor="gopilot-auto-start" className="font-semibold text-gray-950 dark:text-white">Auto-start dismissal</label>
            <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">Start automatically on instructional days at the school-local time below.</p>
          </div>
          <button
            id="gopilot-auto-start"
            type="button"
            role="switch"
            aria-checked={draft.autoStartEnabled}
            onClick={() => { setDraft((current) => ({ ...current, autoStartEnabled: !current.autoStartEnabled })); setMessage(null); }}
            className={`relative mt-1 inline-flex h-7 w-12 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 ${draft.autoStartEnabled ? 'bg-indigo-600' : 'bg-gray-300 dark:bg-slate-600'}`}
          >
            <span className={`mt-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${draft.autoStartEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label htmlFor="gopilot-dismissal-time" className="mb-1 block text-sm font-semibold text-gray-800 dark:text-slate-200">Dismissal time</label>
            <input
              id="gopilot-dismissal-time"
              type="time"
              value={draft.dismissalTime || ''}
              onChange={(event) => { setDraft((current) => ({ ...current, dismissalTime: event.target.value || null })); setMessage(null); }}
              className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            />
          </div>
          <div>
            <label htmlFor="gopilot-timezone" className="mb-1 block text-sm font-semibold text-gray-800 dark:text-slate-200">School timezone</label>
            <select
              id="gopilot-timezone"
              value={draft.schoolTimezone}
              onChange={(event) => { setDraft((current) => ({ ...current, schoolTimezone: event.target.value })); setMessage(null); }}
              className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            >
              {TIMEZONES.map((timezone) => <option key={timezone.value} value={timezone.value}>{timezone.label}</option>)}
            </select>
          </div>
        </div>

        <fieldset>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <legend className="text-sm font-semibold text-gray-800 dark:text-slate-200">Pickup zones</legend>
              <p id="pickup-zone-requirement" className="mt-1 text-xs text-gray-500 dark:text-slate-400">Staff choose one of these locations when calling a student. At least one zone is required.</p>
            </div>
            <button type="button" onClick={addZone} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800">
              <Plus className="h-4 w-4" aria-hidden="true" /> Add zone
            </button>
          </div>
          <div className="space-y-2">
            {draft.pickupZones.length === 0 && (
              <p className="rounded-lg border border-dashed border-gray-300 px-4 py-5 text-center text-sm text-gray-500 dark:border-slate-600 dark:text-slate-400">No pickup zones configured.</p>
            )}
            {draft.pickupZones.map((zone, index) => (
              <div key={zone.id} className="flex items-center gap-2">
                <label htmlFor={`pickup-zone-${zone.id}`} className="sr-only">Pickup zone {index + 1}</label>
                <input
                  id={`pickup-zone-${zone.id}`}
                  type="text"
                  maxLength={80}
                  value={zone.name}
                  onChange={(event) => updateZone(index, event.target.value)}
                  placeholder={`Pickup zone ${index + 1}`}
                  className="min-h-11 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                />
                <button
                  type="button"
                  onClick={() => removeZone(index)}
                  disabled={draft.pickupZones.length === 1}
                  aria-describedby={draft.pickupZones.length === 1 ? 'pickup-zone-requirement' : undefined}
                  aria-label={`Remove ${zone.name || `pickup zone ${index + 1}`}`}
                  title={draft.pickupZones.length === 1 ? 'At least one pickup zone is required.' : undefined}
                  className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-gray-500 dark:text-slate-400 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-col-reverse gap-3 border-t border-gray-200 pt-5 dark:border-slate-700 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-gray-500 dark:text-slate-400" aria-live="polite">{dirty ? 'Unsaved changes' : 'All changes saved'}</p>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 font-semibold text-white transition-colors hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:ring-offset-slate-900"
          >
            {saving ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </div>

      <div className="mt-8 space-y-3" aria-labelledby="gopilot-instructional-calendar-title">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="gopilot-instructional-calendar-title" className="text-xl font-bold tracking-tight text-gray-950 dark:text-white">Instructional calendar</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">Mark holidays and school closures so GoPilot auto-start runs only on instructional days.</p>
          </div>
          <p className="text-xs font-medium text-gray-500 dark:text-slate-400" aria-live="polite">
            {calendarDirty ? 'Calendar has unsaved changes' : 'Calendar changes saved'}
          </p>
        </div>
        <SchoolCalendarMonth
          month={calendarMonth}
          onMonthChange={setCalendarMonth}
          onDirtyChange={setCalendarDirty}
          apiBasePath="/gopilot/instructional-calendar"
        />
      </div>
    </section>
  );
}
