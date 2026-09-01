import { createElement } from "react";
import { NavLink } from "react-router-dom";
import { BookOpenCheck, CalendarClock, GraduationCap, Settings2, SlidersHorizontal } from "lucide-react";

const baseClass = "inline-flex min-h-10 items-center gap-2 border-b-2 px-1 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2";

function RouteTabs({ ariaLabel, items }) {
  return (
    <nav aria-label={ariaLabel} className="overflow-x-auto border-b border-slate-200 dark:border-slate-700">
      <div className="flex min-w-max gap-6">
        {items.map(({ label, path, icon, end }) => (
          <NavLink
            key={path}
            to={path}
            end={end}
            className={({ isActive }) => `${baseClass} ${
              isActive
                ? "border-amber-500 text-slate-950 dark:text-slate-50"
                : "border-transparent text-muted-foreground hover:border-slate-300 hover:text-foreground dark:hover:border-slate-600"
            }`}
          >
            {createElement(icon, { className: "h-4 w-4", "aria-hidden": true })}
            {label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

export function TeacherSettingsTabs() {
  return (
    <RouteTabs
      ariaLabel="My Settings sections"
      items={[
        { label: "Teaching Tools", path: "/classpilot/my-settings", icon: SlidersHorizontal, end: true },
        { label: "Schedule Changes", path: "/classpilot/my-settings/schedule-changes", icon: CalendarClock },
        { label: "Teacher Guide", path: "/classpilot/my-settings/guide", icon: BookOpenCheck },
      ]}
    />
  );
}

export function AdminSettingsTabs() {
  return (
    <RouteTabs
      ariaLabel="Admin Settings sections"
      items={[
        { label: "School Settings", path: "/classpilot/settings", icon: Settings2, end: true },
        { label: "Admin Guide", path: "/classpilot/settings/guide", icon: BookOpenCheck },
      ]}
    />
  );
}

export function AdminClassesTabs({ canManageClasses = true }) {
  const items = [
    canManageClasses ? { label: "Classes", path: "/classpilot/admin/classes", icon: GraduationCap, end: true } : null,
    { label: "Schedule Changes", path: "/classpilot/admin/classes/schedule-changes", icon: CalendarClock },
  ].filter(Boolean);
  return (
    <RouteTabs
      ariaLabel="Class Management sections"
      items={items}
    />
  );
}
