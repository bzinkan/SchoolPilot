import { Link } from 'react-router-dom';
import { ChevronRight, NotebookPen } from 'lucide-react';

/** One compact entry into My Desk. Its areas are the tabs at the top of the hub, not rows here. */
export default function MyDeskMiniView() {
  return <div className="border-b border-slate-200 dark:border-slate-700">
    <Link to="/classpilot/my-desk" className="flex min-h-12 w-full items-center gap-2.5 px-4 py-3 text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 dark:text-slate-100 dark:hover:bg-slate-800">
      <NotebookPen className="size-5 shrink-0 text-indigo-700 dark:text-indigo-300" aria-hidden="true" />
      My Desk
      <ChevronRight className="ml-auto size-4 shrink-0 text-slate-400" aria-hidden="true" />
    </Link>
  </div>;
}
