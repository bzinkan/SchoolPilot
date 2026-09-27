import { useDeferredValue, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { ThemeToggle } from "../../../components/ThemeToggle";
import {
  Link,
  useNavigate,
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
import MyDeskScopePicker from "../components/MyDeskScopePicker";
import { myDeskScopeFilters } from "../lib/myDeskScopeModel";
import "../components/studentInformation.css";
import "../myDesk.css";

export function StudentInformationShell({
  children,
  adminEntry = false,
  schoolName,
  seatingEnabled = true,
}) {
  return (
    <div className="mydesk-page min-h-screen">
      <header className="mydesk-header">
        <Link
          className="student-info-back"
          to={adminEntry ? "/classpilot/admin?tab=students" : "/classpilot"}
        >
          <ArrowLeft className="size-4" />
          {adminEntry ? "Back to Students" : "ClassPilot"}
        </Link>
        <ThemeToggle />
      </header>
      {adminEntry ? (
        <p className="student-info-school">{schoolName || "Current school"}</p>
      ) : (
        <MyDeskTabs seatingEnabled={seatingEnabled} />
      )}
      <main className="mydesk-shell student-information">{children}</main>
    </div>
  );
}

function Directory({ access }) {
  const [search, setSearch] = useState(""),
    [inactive, setInactive] = useState(false),
    [importing, setImporting] = useState(false);
  const [params, setParams] = useSearchParams();
  const scope = {
    gradeLevel: params.get("gradeLevel") || "",
    classId: params.get("classId") || "",
  };
  const setScope = (next) => {
    const updated = new URLSearchParams(params);
    for (const key of ["gradeLevel", "classId"]) {
      if (next[key]) updated.set(key, next[key]);
      else updated.delete(key);
    }
    setParams(updated);
  };
  const q = useDeferredValue(search),
    navigate = useNavigate();
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
          <h1>Student information</h1>
          <p>
            Reviewed contact information for the students you currently serve.
          </p>
        </div>
        {access.aiImportEnabled && (
          <button onClick={() => setImporting((value) => !value)}>
            {importing ? "Close upload" : "Add from documents"}
          </button>
        )}
      </div>
      <p className="student-info-scope">
        Shared school contact profiles. Access follows official class
        assignments; private notes and parent accounts stay separate.
      </p>
      {importing && (
        <StudentInformationUpload
          access={access}
          onUploaded={(id) =>
            navigate(`/classpilot/my-desk/student-information/imports/${id}`)
          }
        />
      )}
      <MyDeskScopePicker
        classes={classes}
        schoolId={access.schoolId}
        viewerId={access.viewerId}
        value={scope}
        onChange={setScope}
        includeOtherClasses={access.manager}
      />
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
                      to={`/classpilot/my-desk/student-information/${encodeURIComponent(student.id)}`}
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
                  to={`/classpilot/my-desk/student-information/imports/${run.id}`}
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
  const location = useLocation(),
    adminEntry = location.pathname.startsWith("/classpilot/students/");
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
    >
      {importId ? (
        <StudentInformationImport access={access} importId={importId} />
      ) : studentId ? (
        <>
          {!adminEntry && (
            <Link to="/classpilot/my-desk/student-information">
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
        <Directory access={access} />
      )}
    </StudentInformationShell>
  );
}
