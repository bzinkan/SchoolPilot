import { AlertCircle, ArrowRight, BookOpen, Loader2, RefreshCw, Users } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { usePassPilotAuth } from "../../../hooks/usePassPilotAuth";
import { useStudentImportHome } from "../../../shared/hooks/useStudentImportHome";
import { teacherLabel, useCanonicalPassPilotClasses } from "../classData";

const MANAGE_CLASSES_PATH = "/classpilot/admin/classes?returnTo=%2Fpasspilot%2Fclasses";

function ClassPilotSourceBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
      Managed in ClassPilot
    </span>
  );
}

export default function CanonicalClassesView() {
  const { isAdmin, isSchoolwideManager } = usePassPilotAuth();
  const { canLinkToClassPilot } = useStudentImportHome();
  const classesQuery = useCanonicalPassPilotClasses();
  const classes = classesQuery.data?.classes || [];

  return (
    <div className="space-y-5 p-4 sm:p-6" data-testid="canonical-passpilot-classes">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
              {isSchoolwideManager ? "Classes" : "My Classes"}
            </h2>
            <ClassPilotSourceBadge />
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {isSchoolwideManager
              ? "Classes and rosters are managed in ClassPilot. Changes appear here automatically."
              : "Your PassPilot classes come from your ClassPilot teacher and co-teacher assignments."}
          </p>
        </div>
        {isAdmin && canLinkToClassPilot ? (
          <Button asChild className="shrink-0">
            <Link to={MANAGE_CLASSES_PATH} data-testid="manage-classpilot-classes">
              Manage in ClassPilot
              <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        ) : null}
      </div>

      {classesQuery.isLoading ? (
        <Card>
          <CardContent className="flex min-h-40 items-center justify-center gap-3 text-sm text-muted-foreground" aria-live="polite">
            <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Loading classes…
          </CardContent>
        </Card>
      ) : classesQuery.isError ? (
        <Card className="border-destructive/40">
          <CardContent className="flex min-h-48 flex-col items-center justify-center px-6 py-8 text-center">
            <AlertCircle className="mb-3 h-8 w-8 text-destructive" aria-hidden="true" />
            <h3 className="font-semibold">Classes couldn’t be loaded</h3>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Try again. No class changes were made.
            </p>
            <Button type="button" variant="outline" className="mt-4" onClick={() => classesQuery.refetch()}>
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : classes.length === 0 ? (
        <Card>
          <CardContent className="flex min-h-56 flex-col items-center justify-center px-6 py-10 text-center">
            <BookOpen className="mb-4 h-10 w-10 text-muted-foreground" aria-hidden="true" />
            <h3 className="text-lg font-semibold">
              {isSchoolwideManager ? "No official classes yet" : "No ClassPilot classes are assigned to you"}
            </h3>
            <p className="mt-2 max-w-lg text-sm text-muted-foreground">
              {isSchoolwideManager
                ? "Create a class in ClassPilot to use it in PassPilot."
                : "Ask IT to assign you as a teacher or co-teacher in ClassPilot."}
            </p>
            {isAdmin && canLinkToClassPilot ? (
              <Button asChild className="mt-5">
                <Link to={MANAGE_CLASSES_PATH}>Create Classes in ClassPilot</Link>
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="ClassPilot classes">
          {classes.map((item) => {
            const coTeacherNames = item.coTeachers.map((teacher) => teacher.displayName).join(", ");
            return (
              <Card
                key={item.id}
                className="min-w-0 border-l-4 border-l-amber-400 transition-shadow hover:shadow-md"
                data-testid={`canonical-class-${item.id}`}
              >
                <CardHeader className="space-y-3 pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <CardTitle className="min-w-0 break-words text-lg">{item.name}</CardTitle>
                    <ClassPilotSourceBadge />
                  </div>
                  {(item.gradeLevel || item.periodLabel) ? (
                    <p className="text-sm text-muted-foreground">
                      {[item.gradeLevel ? `Grade ${item.gradeLevel}` : null, item.periodLabel].filter(Boolean).join(" · ")}
                    </p>
                  ) : null}
                </CardHeader>
                <CardContent className="space-y-3 pt-0">
                  <div className="flex items-center gap-2 text-sm">
                    <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="font-medium tabular-nums">
                      {item.studentCount} {item.studentCount === 1 ? "student" : "students"}
                    </span>
                  </div>
                  <div className="min-w-0 text-sm text-muted-foreground">
                    <p className="break-words">{teacherLabel(item)}</p>
                    {coTeacherNames ? <p className="mt-1 break-words text-xs">Co-teachers: {coTeacherNames}</p> : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {!canLinkToClassPilot && isAdmin ? (
        <p className="text-sm text-muted-foreground">
          Manage ClassPilot classes in Schoolpilot on the web.
        </p>
      ) : null}
    </div>
  );
}
