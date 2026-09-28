import { useDeferredValue, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  Link,
  useParams,
  useSearchParams,
  useLocation,
} from "react-router-dom";
import { useMyDeskAccess, useMyDeskClasses } from "../hooks/useMyDesk";
import { studentInformationApi } from "../lib/studentInformationApi";
import {
  studentInformationKeys,
  informationMessage,
} from "../lib/studentInformationModel";
import StudentContactProfileEditor from "../components/StudentContactProfileEditor";
import StudentInformationImport, {
  StudentInformationUpload,
} from "../components/StudentInformationImport";
import MyDeskTabs from "../components/MyDeskTabs";
import MyDeskHeader from "../components/MyDeskHeader";
import MyDeskVisibility from "../components/MyDeskVisibility";
import MyDeskScopePicker from "../components/MyDeskScopePicker";
import { myDeskScopeFilters } from "../lib/myDeskScopeModel";
import { useMyDeskScopeParams } from "../hooks/useMyDeskScopeParams";
import { withDisciplineEntry } from "../lib/disciplineNavigation";
import { useAdminNavigation, useAdminShell } from "../hooks/useAdminNavigation";
import "../components/studentInformation.css";
import "../myDesk.css";

export function StudentInformationShell({
  children,
  adminEntry = false,
  schoolName,
  seatingEnabled = true,
  scopeBar = null,
}) {
  const shell = useAdminShell();
  const { navigate } = useAdminNavigation();
  if (shell) return <section className="student-information">{children}</section>;
  return (
    <div className="mydesk-page min-h-screen">
      <MyDeskHeader
        backLabel={adminEntry ? "Back to Students" : "ClassPilot"}
        onBack={() => navigate(adminEntry ? "/classpilot/students" : "/classpilot")}
        title={adminEntry ? null : "My Desk"}
      />
      {adminEntry ? (
        <p className="student-info-school">{schoolName || "Current school"}</p>
      ) : (
        <>
          <MyDeskTabs seatingEnabled={seatingEnabled} />
          {scopeBar}
        </>
      )}
      <main className="mydesk-shell student-information">{children}</main>
    </div>
  );
}

function DirectoryScopeBar({ access }) {
  const [scope, setScope] = useMyDeskScopeParams();
  const classes = useMyDeskClasses(access.schoolId, access.viewerId);
  return (
    <MyDeskScopePicker
      layout="bar"
      classes={classes}
      schoolId={access.schoolId}
      viewerId={access.viewerId}
      value={scope}
      onChange={setScope}
      includeOtherClasses={access.manager}
    />
  );
}

function Directory({ access, adminEntry }) {
  const Heading = useAdminShell() ? "h2" : "h1";
  const [search, setSearch] = useState(""),
    [inactive, setInactive] = useState(false),
    [importing, setImporting] = useState(false);
  const [params] = useSearchParams();
  const [scope, setScope] = useMyDeskScopeParams();
  const q = useDeferredValue(search);
  const { navigate, requestAction } = useAdminNavigation();
  const classes = useMyDeskClasses(access.schoolId, access.viewerId);
  const filters = {
    q,
    ...myDeskScopeFilters(scope),
    includeInactive: inactive,
  };
  const query = useInfiniteQuery({
    queryKey: [
      ...studentInformationKeys.root(access.schoolId, access.viewerId),
      "search",
      filters,
    ],
    initialPageParam: "",
    queryFn: ({ signal, pageParam }) =>
      studentInformationApi(access.schoolId, signal).search({
        ...filters,
        ...(pageParam ? { cursor: pageParam } : {}),
        limit: 50,
      }),
    getNextPageParam: (page) => page.nextCursor || undefined,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: "always",
  });
  const imports = useInfiniteQuery({
    queryKey: [
      ...studentInformationKeys.root(access.schoolId, access.viewerId),
      "imports",
    ],
    initialPageParam: "",
    queryFn: ({ signal, pageParam }) =>
      studentInformationApi(access.schoolId, signal).get(
        `/imports${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    getNextPageParam: (page) => page.nextCursor || undefined,
    retry: false,
    staleTime: 0,
  });
  return (
    <>
      <div className="student-info-toolbar">
        <div>
          <Heading>Student information</Heading>
          <p>
            Reviewed contact information for the students you currently serve.
          </p>
          <MyDeskVisibility kind="school">
            Shared school contact profiles. Access follows official class
            assignments; private notes and parent accounts stay separate.
          </MyDeskVisibility>
        </div>
        {access.aiImportEnabled && (
          <button onClick={() => requestAction(() => setImporting((value) => !value), { id: "contact-upload-toggle" })}>
            {importing ? "Close upload" : "Add from documents"}
          </button>
        )}
      </div>
      {importing && (
        <StudentInformationUpload
          access={access}
          onUploaded={(id, committedNavigate) =>
            (committedNavigate || navigate)(withDisciplineEntry(`/classpilot/my-desk/student-information/imports/${encodeURIComponent(id)}`, params))
          }
        />
      )}
      {adminEntry && (
        <MyDeskScopePicker
          classes={classes}
          schoolId={access.schoolId}
          viewerId={access.viewerId}
          value={scope}
          onChange={setScope}
          includeOtherClasses={access.manager}
        />
      )}
      <label>
        Find a student
        <input
          maxLength={200}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      {access.manager && (
        <label className="student-info-section">
          <input
            type="checkbox"
            checked={inactive}
            onChange={(e) => setInactive(e.target.checked)}
          />
          Include former students
        </label>
      )}
      {query.isError ? (
        <p role="alert">{informationMessage(query.error)}</p>
      ) : query.isPending ? (
        <p role="status">Loading students…</p>
      ) : (
        <table className="student-info-directory">
          <thead>
            <tr>
              <th>Student</th>
              <th>Grade</th>
              <th>Profile</th>
            </tr>
          </thead>
          <tbody>
            {query.data?.pages
              .flatMap((page) => page.students)
              .map((student) => (
                <tr key={student.id}>
                  <td>
                    <Link
                      to={
                        adminEntry
                          ? withDisciplineEntry(`/classpilot/my-desk/student-information/${encodeURIComponent(student.id)}`, params)
                          : `/classpilot/my-desk/student-overview/${encodeURIComponent(student.id)}?from=student-information`
                      }
                    >
                      {student.name}
                    </Link>
                    {student.status !== "active" ? " · Former student" : ""}
                  </td>
                  <td>{student.gradeLevel || "Not set"}</td>
                  <td>
                    {student.revision
                      ? `Version ${student.revision} · ${student.updatedByName}`
                      : "No contacts saved"}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
      {query.hasNextPage && (
        <button onClick={() => query.fetchNextPage()}>
          Load more students
        </button>
      )}
      <details>
        <summary>Your private contact import drafts</summary>
        {imports.isError ? (
          <p role="alert">{informationMessage(imports.error)}</p>
        ) : (
          imports.data?.pages
            .flatMap((page) => page.imports)
            .map((run) => (
              <p key={run.id}>
                <Link
                  to={withDisciplineEntry(`/classpilot/my-desk/student-information/imports/${encodeURIComponent(run.id)}`, params)}
                >
                  {new Date(run.createdAt).toLocaleString()} · {run.status}
                </Link>
              </p>
            ))
        )}
        {imports.hasNextPage && (
          <button onClick={() => imports.fetchNextPage()}>
            Load older imports
          </button>
        )}
      </details>
    </>
  );
}
export default function StudentInformation() {
  const base = useMyDeskAccess(),
    { studentId, importId } = useParams();
  const location = useLocation();
  const shell = useAdminShell();
  const [params] = useSearchParams();
  const adminEntry = Boolean(shell) || location.pathname.startsWith("/classpilot/students/");
  const capabilities = useQuery({
    queryKey: [
      ...studentInformationKeys.root(base.schoolId, base.viewerId),
      "capabilities",
    ],
    queryFn: ({ signal }) =>
      studentInformationApi(base.schoolId, signal).get("/capabilities"),
    enabled: base.eligible,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: "always",
  });
  if (!base.eligible)
    return (
      <StudentInformationShell
        adminEntry={adminEntry}
        schoolName={base.school?.name}
        seatingEnabled={base.seatingEnabled}
      >
        <p>
          Sign in with your active school staff account to open student
          information.
        </p>
      </StudentInformationShell>
    );
  if (capabilities.isError)
    return (
      <StudentInformationShell
        adminEntry={adminEntry}
        schoolName={base.school?.name}
        seatingEnabled={base.seatingEnabled}
      >
        <p role="alert">{informationMessage(capabilities.error)}</p>
      </StudentInformationShell>
    );
  if (!capabilities.data)
    return (
      <StudentInformationShell
        adminEntry={adminEntry}
        schoolName={base.school?.name}
        seatingEnabled={base.seatingEnabled}
      >
        <p role="status">Checking student information access…</p>
      </StudentInformationShell>
    );
  const access = { ...base, ...capabilities.data },
    key = `${base.schoolId}:${base.viewerId}:${studentId || importId || "directory"}:${access.manager}`;
  return (
    <StudentInformationShell
      key={key}
      adminEntry={adminEntry}
      schoolName={base.school?.name}
      seatingEnabled={base.seatingEnabled}
      scopeBar={!importId && !studentId ? <DirectoryScopeBar access={access} /> : null}
    >
      {importId ? (
        <StudentInformationImport access={access} importId={importId} />
      ) : studentId ? (
        <>
          {!adminEntry && (
            <Link to={withDisciplineEntry('/classpilot/my-desk/student-information', params)}>
              Student information
            </Link>
          )}
          <StudentContactProfileEditor
            schoolId={base.schoolId}
            viewerId={base.viewerId}
            studentId={studentId}
          />
        </>
      ) : (
        <Directory access={access} adminEntry={adminEntry} />
      )}
    </StudentInformationShell>
  );
}
