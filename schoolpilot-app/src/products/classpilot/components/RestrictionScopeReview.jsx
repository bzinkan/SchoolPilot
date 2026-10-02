import { Button } from '../../../components/ui/button';

export default function RestrictionScopeReview({ review, disabled = false }) {
  return <div className="space-y-3" data-testid="restriction-scope-review">
    <Button type="button" variant="outline" disabled={disabled || review.pending} onClick={() => void review.review()} data-testid="button-review-restriction-scope">
      {review.pending ? 'Reviewing scope…' : review.preview ? 'Review scope again' : 'Review allowed scope'}
    </Button>
    {review.error && <p role="alert" className="text-sm text-destructive">{review.error}</p>}
    {review.preview && <section aria-label="Reviewed allowed scope" className="space-y-3 rounded-md border bg-muted/30 p-3 text-sm">
      <p className="font-medium">Reviewed allowed scope</p>
      {review.preview.scopes.length === 0 ? <p>No usable entries were found.</p> : <ul className="space-y-3">
        {review.preview.scopes.map((scope, index) => <li key={`${scope.url}:${index}`}>
          <p className="font-medium">{scope.label}</p><p className="break-all text-xs">{scope.url}</p>
          <p className="text-xs text-muted-foreground">{scope.description}</p>
        </li>)}
      </ul>}
      {review.preview.warnings.map(warning => <p key={warning.hostname} className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">{warning.message}</p>)}
      {review.preview.skipped.length > 0 && <div className="text-xs">
        <p className="font-medium">{review.preview.skipped.length} linked item{review.preview.skipped.length === 1 ? '' : 's'} left out because the requested boundary could not be established.</p>
        <ul className="mt-1 space-y-1">{review.preview.skipped.map((item, index) => <li className="break-all text-muted-foreground" key={`${item.url}:${index}`}>{item.url}</li>)}</ul>
      </div>}
    </section>}
  </div>;
}
