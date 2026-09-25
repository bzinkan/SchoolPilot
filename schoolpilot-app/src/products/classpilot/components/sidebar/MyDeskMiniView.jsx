import { useNavigate } from 'react-router-dom';
import { LockKeyhole, NotebookPen } from 'lucide-react';
import { Button } from '../../../../components/ui/button';

export default function MyDeskMiniView() {
  const navigate = useNavigate();
  return <section className="border-b border-slate-200 dark:border-slate-700 p-4" aria-label="My Desk">
    <div className="flex items-center gap-2 text-slate-800 dark:text-slate-100"><NotebookPen className="size-5 text-indigo-700 dark:text-indigo-300" aria-hidden="true" /><h2 className="font-semibold">My Desk</h2></div>
    <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">A place for your notes and the papers you want to keep.</p>
    <Button variant="outline" className="mt-3 w-full justify-start" onClick={() => navigate('/classpilot/my-desk')}>Open my notebook</Button>
    <p className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400"><LockKeyhole className="size-3" aria-hidden="true" />Private to you</p>
  </section>;
}
