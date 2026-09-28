import { paperworkProgress } from '../lib/importReviewModel';

export default function PaperworkProgress({ batch, compact = false }) {
  const progress = paperworkProgress(batch);
  const supportsEarlyReview = batch.processingVersion >= 2 || batch.progress?.actions?.reviewFields === true;
  return <div className={compact ? 'import-progress-compact' : 'import-processing-progress'}>
    <p className="import-progress-phase">{progress.phase}</p>
    <p role="status" aria-live="polite">{progress.description}</p>
    {!compact && <><progress aria-label="Pages checked" max={Math.max(1, progress.total)} value={progress.checked} />
      <p>{progress.found} {progress.found === 1 ? 'form' : 'forms'} {progress.detectionComplete ? 'found' : 'found so far'}.</p>
      <p>{supportsEarlyReview ? 'You can review finished forms while preparation continues.' : 'Preparation is still running. Use Save for later to leave and return when it finishes.'} Nothing is published until you review and save.</p>
      {batch.progress?.retryAt && <p>A preparation step will retry automatically. Your completed forms are kept.</p>}</>}
  </div>;
}
