import { Link } from 'react-router-dom';
import { Armchair, ChevronRight, ContactRound, FileText, NotebookPen } from 'lucide-react';
import { myDeskTabList } from '../../lib/myDeskTabsModel';

const TAB_ICONS = { notes: NotebookPen, discipline: FileText, 'student-information': ContactRound, seating: Armchair };

export default function MyDeskMiniView({ seatingEnabled = false }) {
  return <section className="border-b border-slate-200 dark:border-slate-700 p-4" aria-label="My Desk">
    <div className="flex items-center gap-2 text-slate-800 dark:text-slate-100"><NotebookPen className="size-5 text-indigo-700 dark:text-indigo-300" aria-hidden="true" /><h2 className="font-semibold">My Desk</h2></div>
    <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">{seatingEnabled ? 'Your notes, school records and seating charts for the students you teach.' : 'Your notes and school records for the students you teach.'}</p>
    <nav className="mt-3 flex flex-col gap-1" aria-label="My Desk areas">
      {myDeskTabList(seatingEnabled).map(tab => { const Icon = TAB_ICONS[tab.key]; return <Link key={tab.key} to={tab.path} className="flex min-h-11 items-center gap-2.5 rounded-md border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"><Icon className="size-4 shrink-0 text-indigo-700 dark:text-indigo-300" aria-hidden="true" />{tab.label}<ChevronRight className="ml-auto size-4 shrink-0 text-slate-400" aria-hidden="true" /></Link>; })}
    </nav>
  </section>;
}
