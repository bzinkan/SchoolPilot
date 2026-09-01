import { Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { useClassPilotAuth } from "../../../hooks/useClassPilotAuth";
import { GuideLayout } from "../components/GuideLayout";
import { TeacherSettingsTabs } from "../components/ScheduleRouteTabs";
import { teacherGuidePhases, teacherGuideTopics } from "../guides/teacherGuideContent";

export default function TeacherGuide() {
  const { currentUser, isAdmin, isTeacher, isLoading } = useClassPilotAuth();

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading guide" /></div>;
  }

  if (!currentUser || (!isTeacher && !isAdmin && currentUser.isSuperAdmin !== true)) {
    return <Navigate to="/classpilot" replace />;
  }

  return (
    <GuideLayout
      guideLabel="ClassPilot Flight Plan · Teacher Edition"
      title="Teach with a clear route from bell to wrap-up."
      description="Short, practical workflows for starting class, guiding exact students, reading monitoring status, and closing the session cleanly."
      phases={teacherGuidePhases}
      topics={teacherGuideTopics}
      backPath="/classpilot"
      tabs={<TeacherSettingsTabs />}
    />
  );
}
