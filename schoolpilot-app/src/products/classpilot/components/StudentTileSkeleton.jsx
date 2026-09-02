import { Card } from "../../../components/ui/card";
import { Skeleton } from "../../../components/ui/skeleton";

/**
 * First-paint stand-in for a StudentTile whose cohort screenshot batch has not
 * resolved yet. It mirrors the tile chrome (avatar, name line, aspect-video
 * preview, badge row, action row) at the real tile height so the wall neither
 * reflows nor flashes featureless gray boxes when the first frames arrive.
 * StudentTile may render this itself once it exposes a loading state; until
 * then the dashboard swaps it in for cohorts whose first fetch is in flight.
 */
export default function StudentTileSkeleton({ studentId, studentName = "" }) {
  return (
    <Card
      role="status"
      aria-busy="true"
      aria-label={`Loading ${studentName || "student"} screen preview`}
      className="min-h-[420px] overflow-hidden shadow-md"
      data-testid={`student-tile-skeleton-${studentId}`}
    >
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-1.5">
              {studentName ? (
                <h3
                  className="truncate text-sm font-semibold text-muted-foreground"
                  data-testid={`student-tile-skeleton-name-${studentId}`}
                >
                  {studentName}
                </h3>
              ) : (
                <Skeleton className="h-3.5 w-1/2" />
              )}
              <Skeleton className="h-2.5 w-14" />
            </div>
          </div>
          <Skeleton className="h-7 w-7 shrink-0 rounded-md" />
        </div>
        <Skeleton className="aspect-video w-full rounded-lg" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-8 flex-1 rounded-md" />
        </div>
      </div>
    </Card>
  );
}
