import { Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { useClassPilotAuth } from "../../../hooks/useClassPilotAuth";
import { GuideLayout } from "../components/GuideLayout";
import { AdminSettingsTabs } from "../components/ScheduleRouteTabs";
import { adminGuidePhases, adminGuideTopics } from "../guides/adminGuideContent";

export default function AdminGuide() {
  const { currentUser, isAdmin, isLoading } = useClassPilotAuth();

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading guide" /></div>;
  }

  if (!currentUser || (!isAdmin && currentUser.isSuperAdmin !== true)) {
    return <Navigate to="/classpilot" replace />;
  }

  const topics = currentUser.mailpilotEntitled === true
    ? adminGuideTopics
    : adminGuideTopics.filter((topic) => topic.entitlement !== "mailpilot");

  return (
    <GuideLayout
      guideLabel="ClassPilot Flight Plan · Administrator Edition"
      title="Launch, govern, and support the whole ClassPilot program."
      description="School-wide setup and operations—from staff and managed Chromebooks to identity-provider policy, Coverage, safety workflows, and careful recovery."
      phases={adminGuidePhases}
      topics={topics}
      backPath="/classpilot/admin"
      backLabel="Admin Panel"
      tabs={<AdminSettingsTabs />}
    />
  );
}
