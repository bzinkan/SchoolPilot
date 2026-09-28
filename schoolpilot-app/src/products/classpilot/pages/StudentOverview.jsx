import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronRight, Mail, Phone, Plus } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { useMyDeskAccess, useMyDeskCategories, useMyDeskStudentContext } from '../hooks/useMyDesk';
import { useDisciplineAccess } from '../hooks/useDiscipline';
import { useAdminNavigation } from '../hooks/useAdminNavigation';
import { myDeskApi } from '../lib/myDesk';
import { myDeskError, myDeskKeys } from '../lib/myDeskModel';
import { disciplineApi, disciplineCategory, disciplineKeys } from '../lib/discipline';
import { studentInformationApi } from '../lib/studentInformationApi';
import { informationMessage, studentInformationKeys } from '../lib/studentInformationModel';
import { formatDeskDate } from '../lib/myDeskDates';
import MyDeskHeader from '../components/MyDeskHeader';
import MyDeskTabs from '../components/MyDeskTabs';
import MyDeskVisibility from '../components/MyDeskVisibility';
import MyDeskStudentAction from '../components/MyDeskStudentAction';
import DisciplineIncidentComposer from '../components/DisciplineIncidentComposer';
import '../myDesk.css';
import '../discipline.css';

const ORIGINS = { notes: ['Notes', '/classpilot/my-desk'], discipline: ['Discipline logs', '/classpilot/discipline-records'], 'student-information': ['Student information', '/classpilot/my-desk/student-information'] };
const RECENT = 5;
const denied = error => [401, 403, 404].includes(error?.response?.status);

export default function StudentOverview() {
  const desk = useMyDeskAccess(), discipline = useDisciplineAccess();
  const { studentId } = useParams(); const [params] = useSearchParams(); const navigate = useNavigate();
  const from = ORIGINS[params.get('from')] ? params.get('from') : 'notes';
  return <div className="mydesk-page min-h-screen bg-background text-foreground">
    <MyDeskHeader onBack={() => navigate('/classpilot')} />
    <MyDeskTabs seatingEnabled={desk.seatingEnabled} activeTab={from} />
    {desk.loading ? <p className="mydesk-access" role="status">Opening this student…</p> : desk.enabled
      ? <StudentOverviewContent key={`${desk.schoolId}:${desk.viewerId}:${studentId}`} access={desk} studentId={studentId} from={from}
          discipline={{ ...discipline, importsEnabled: desk.importsEnabled, seatingEnabled: desk.seatingEnabled }} />
      : <section className="mydesk-access"><h1>My Desk is unavailable</h1><p>{desk.error ? 'This student page could not be opened. Please try again.' : 'My Desk is temporarily unavailable.'}</p>{desk.error && <Button onClick={() => desk.refresh()}>Try again</Button>}</section>}
  </div>;
}

/**
 * Everything My Desk knows about one student. Each section loads and fails on its own:
 * private notes stay with their author across years, while incidents and contacts follow
 * current school assignments, so losing a class hides those without hiding your notes.
 */
export function StudentOverviewContent({ access, discipline, studentId, from = 'notes' }) {
  const { schoolId, viewerId } = access; const { navigate } = useAdminNavigation();
  const [composer, setComposer] = useState(null);
  const context = useMyDeskStudentContext(schoolId, viewerId, studentId);
  const categories = useMyDeskCategories(schoolId, viewerId);
  const notes = useQuery({ queryKey: [...myDeskKeys.history(schoolId, viewerId, studentId, { limit: RECENT }), 'overview'],
    queryFn: ({ signal }) => myDeskApi(schoolId, signal).studentHistory(studentId, { limit: RECENT }), retry: false });
  const incidents = useQuery({ queryKey: [...disciplineKeys.students(schoolId, viewerId, { scope: 'assigned', studentId }), 'overview'],
    queryFn: ({ signal }) => disciplineApi(schoolId, signal).studentHistory(studentId, { scope: 'assigned', limit: RECENT }),
    enabled: Boolean(discipline?.ready), retry: false });
  const contacts = useQuery({ queryKey: [...studentInformationKeys.root(schoolId, viewerId), 'overview', studentId],
    queryFn: ({ signal }) => studentInformationApi(schoolId, signal).profile(studentId), retry: false });
  const current = context.data?.student;
  const name = current?.name || notes.data?.student?.name || incidents.data?.student?.name || contacts.data?.student?.name || 'Student';
  const grade = current?.gradeLevel || contacts.data?.student?.gradeLevel;
  const details = [grade ? `Grade ${grade}` : '', (current?.classes || []).map(group => group.name).join(', ')].filter(Boolean).join(' · ');
  const [originLabel, originPath] = ORIGINS[from] || ORIGINS.notes;
  const categoryLabel = key => categories.data?.categories?.find(item => item.key === key)?.label || disciplineCategory(key);
  const noteRows = notes.data?.notes || [], records = incidents.data?.records || [], people = contacts.data?.profile?.data?.contacts || [];
  return <main className="mydesk-shell mydesk-student">
    <Button asChild variant="ghost" className="mydesk-student-back"><Link to={originPath}><ArrowLeft className="size-4" />{originLabel}</Link></Button>
    <div className="mydesk-student-header">
      <div><h1>{name}</h1>{details && <p>{details}</p>}</div>
      <div className="import-entry-actions">
        {current && <MyDeskStudentAction access={access} student={{ id: studentId, name }} />}
        {current && discipline?.ready && <Button onClick={() => setComposer(crypto.randomUUID())}><Plus className="size-4" />Add incident</Button>}
      </div>
    </div>
    <div className="mydesk-student-grid">
      <div>
        <section className="mydesk-student-section" aria-label="Incidents">
          <div className="mydesk-student-section-heading"><h2>Incidents</h2><MyDeskVisibility kind="school" /></div>
          {!discipline?.ready ? <p className="mydesk-section-message">{discipline?.loading ? 'Loading incidents…' : 'Discipline logs are not available for your account.'}</p>
            : incidents.isPending ? <p className="mydesk-section-message" role="status">Loading incidents…</p>
            : incidents.isError ? <p className="mydesk-section-message" role={denied(incidents.error) ? undefined : 'alert'}>{denied(incidents.error) ? 'Incidents are visible to teachers currently assigned to this student.' : myDeskError(incidents.error)}</p>
            : <>
              <p className="mydesk-section-message">{incidents.data?.range?.period === 'school_year' ? 'This school year.' : 'All dates.'} Visible to school administrators and teachers currently assigned to this student.</p>
              {records.length ? <ul className="mydesk-student-list">{records.map(record => <li key={record.id}><Link to={`/classpilot/discipline-records/${encodeURIComponent(record.id)}`}>
                <span><strong>{record.currentVersion.title || disciplineCategory(record.currentVersion.category)}</strong><span>{formatDeskDate(record.currentVersion.entryDate)}{record.currentVersion.className ? ` · ${record.currentVersion.className}` : ''} · Recorded by {record.submittedBy.name}</span></span><ChevronRight className="size-4" aria-hidden="true" /></Link></li>)}</ul>
                : <p className="mydesk-section-message">No incidents recorded in this period.</p>}
              <Link className="mydesk-student-more" to={`/classpilot/discipline-records?studentId=${encodeURIComponent(studentId)}`}>All incidents</Link>
            </>}
        </section>
        <section className="mydesk-student-section" aria-label="Your private notes">
          <div className="mydesk-student-section-heading"><h2>Your private notes</h2><MyDeskVisibility kind="private" /></div>
          {notes.isPending ? <p className="mydesk-section-message" role="status">Loading your notes…</p>
            : notes.isError ? <p className="mydesk-section-message" role="alert">{myDeskError(notes.error)}</p>
            : <>
              <p className="mydesk-section-message">Only you can see these, including notes from past years.</p>
              {noteRows.length ? <ul className="mydesk-student-list">{noteRows.map(note => <li key={note.id}><Link to={`/classpilot/my-desk/notes/students/${encodeURIComponent(studentId)}`}>
                <span><strong>{note.title || note.displayTitle}</strong><span>{formatDeskDate(note.entryDate, { timeZone: access.school?.timezone })} · {categoryLabel(note.category)}{note.groupName ? ` · ${note.groupName}` : ''}</span></span><ChevronRight className="size-4" aria-hidden="true" /></Link></li>)}</ul>
                : <p className="mydesk-section-message">No private notes about this student yet.</p>}
              <Link className="mydesk-student-more" to={`/classpilot/my-desk/notes/students/${encodeURIComponent(studentId)}`}>All private notes</Link>
            </>}
        </section>
      </div>
      <section className="mydesk-contacts" aria-label="Contacts">
        <div className="mydesk-student-section-heading"><h2>Contacts</h2><MyDeskVisibility kind="school" /></div>
        {contacts.isPending ? <p className="mydesk-section-message" role="status">Loading contacts…</p>
          : contacts.isError ? <p className="mydesk-section-message" role={denied(contacts.error) ? undefined : 'alert'}>{denied(contacts.error) ? 'Contacts are visible to staff currently assigned to this student.' : informationMessage(contacts.error)}</p>
          : <>
            {contacts.data?.profile?.revision ? <p className="mydesk-section-message">Version {contacts.data.profile.revision}{contacts.data.profile.updatedByName ? ` · ${contacts.data.profile.updatedByName}` : ''}</p> : null}
            {people.length ? people.map(person => <div className="mydesk-contact" key={person.id}>
              <p><strong>{person.name || 'Unnamed contact'}</strong>{person.relationship ? ` · ${person.relationship}` : ''}</p>
              {(person.phones || []).map(phone => <a key={phone} href={`tel:${phone}`}><Phone className="size-3.5" aria-hidden="true" />{phone}</a>)}
              {(person.emails || []).map(email => <a key={email} href={`mailto:${email}`}><Mail className="size-3.5" aria-hidden="true" />{email}</a>)}
              {(person.preferred === true || person.emergency === true) && <p className="mydesk-contact-tags">{person.preferred === true && <span>Preferred contact</span>}{person.emergency === true && <span>Emergency contact</span>}</p>}
              {(person.preferredMethod || person.language) && <p className="mydesk-section-message">{[person.preferredMethod, person.language].filter(Boolean).join(' · ')}</p>}
            </div>) : <p className="mydesk-section-message">No contacts saved.</p>}
            <Link className="mydesk-student-more" to={`/classpilot/my-desk/student-information/${encodeURIComponent(studentId)}`}>Open contact profile</Link>
          </>}
      </section>
    </div>
    {composer && <DisciplineIncidentComposer key={`${schoolId}:${viewerId}:${composer}`} access={discipline} scope="assigned" selectedStudent={{ id: studentId, name, classes: current?.classes || [] }}
      onClose={() => setComposer(null)} onSaved={async (id, committedNavigate) => { const accepted = await (committedNavigate || navigate)(`/classpilot/discipline-records/${encodeURIComponent(id)}`); if (accepted !== false) setComposer(null); }} />}
  </main>;
}
