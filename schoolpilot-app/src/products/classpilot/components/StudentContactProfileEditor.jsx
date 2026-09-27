import { useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { studentInformationApi } from "../lib/studentInformationApi";
import {
  studentInformationKeys,
  contactChanges,
  emptyContact,
  informationMessage,
} from "../lib/studentInformationModel";
import StudentContactFields from "./StudentContactFields";
import { useAdminNavigation } from "../hooks/useAdminNavigation";
import { useStudentInformationDraftGuard } from "../hooks/useStudentInformationDraftGuard";
import "./studentInformation.css";

function ProfileForm({
  schoolId,
  viewerId,
  studentId,
  result: suppliedResult,
  onSaved,
  onDenied,
}) {
  const [result] = useState(suppliedResult);
  const [draft, setDraft] = useState(() =>
    structuredClone(result.profile.data),
  );
  const [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const lifetime = useRef(null),
    frozen = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const changes = contactChanges(result.profile.data, draft);
  const guard = useStudentInformationDraftGuard(changes.length > 0, {
    id: `student-contact:${studentId}`, busy,
    onDiscard: () => { setDraft(structuredClone(result.profile.data)); setReason(""); },
  });
  const save = async (event) => {
    event.preventDefault();
    if (busy || !changes.length) return;
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted) return;
    const payload = { revision: result.profile.revision, changes, reason };
    const signature = JSON.stringify(payload);
    if (frozen.current?.signature !== signature)
      frozen.current = {
        signature,
        input: { ...payload, requestId: crypto.randomUUID() },
      };
    setBusy(true);
    setError("");
    try {
      await studentInformationApi(schoolId, controller.signal).save(
        studentId,
        frozen.current.input,
      );
      controller.signal.throwIfAborted();
      await onSaved();
    } catch (failure) {
      if (!controller.signal.aborted) {
        if ([401, 403, 404].includes(failure?.response?.status))
          onDenied(failure);
        else setError(informationMessage(failure));
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="student-info-form" data-viewer={viewerId}>
      <p className="student-info-scope">
        Shared with authorized teachers and school administrators. This does not
        change parent accounts or pickup permissions.
      </p>
      {result.profile.updatedAt && (
        <p>
          Updated by {result.profile.updatedByName} on{" "}
          {new Date(result.profile.updatedAt).toLocaleString()}
        </p>
      )}
      {!draft.contacts.length && (
        <p>No contact information has been saved for this student.</p>
      )}
      {draft.contacts.map((contact) => (
        <div key={contact.id}>
          <StudentContactFields
            contact={contact}
            disabled={busy}
            onChange={(next) =>
              setDraft((value) => ({
                contacts: value.contacts.map((item) =>
                  item.id === contact.id ? next : item,
                ),
              }))
            }
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  `Remove ${contact.name || "this contact"} from the current profile? The prior version stays in history.`,
                )
              )
                setDraft((value) => ({
                  contacts: value.contacts.filter(
                    (item) => item.id !== contact.id,
                  ),
                }));
            }}
          >
            Remove contact
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={busy || draft.contacts.length >= 20}
        onClick={() =>
          setDraft((value) => ({
            contacts: [...value.contacts, emptyContact()],
          }))
        }
      >
        Add contact
      </button>
      {changes.length > 0 && (
        <>
          <p>
            {changes.length} explicit{" "}
            {changes.length === 1 ? "change" : "changes"} to review. Cleared
            fields and removed contacts will be removed from the current
            profile.
          </p>
          <label>
            Reason for this update
            <textarea
              required
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {guard.destination && (
        <div role="alertdialog" aria-label="Discard contact changes">
          <p>
            Discard unsaved contact changes and leave? A save with an
            interrupted response may already have succeeded.
          </p>
          <button type="button" onClick={guard.stay}>
            Keep editing
          </button>
          <button type="button" onClick={guard.leave}>
            Discard and leave
          </button>
        </div>
      )}
      <button
        type="submit"
        disabled={busy || !changes.length || !reason.trim()}
      >
        {busy ? "Saving…" : "Save reviewed changes"}
      </button>
    </form>
  );
}
function History({ schoolId, viewerId, studentId, onDenied }) {
  const query = useInfiniteQuery({
    queryKey: [
      ...studentInformationKeys.profile(schoolId, viewerId, studentId),
      "history",
    ],
    initialPageParam: undefined,
    queryFn: ({ signal, pageParam }) =>
      studentInformationApi(schoolId, signal).history(studentId, pageParam),
    getNextPageParam: (page) => page.nextCursor || undefined,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: "always",
  });
  useEffect(() => {
    if (
      query.isError &&
      [401, 403, 404].includes(query.error?.response?.status)
    )
      onDenied(query.error);
  }, [query.isError, query.error, onDenied]);
  if (query.isError)
    return <p role="alert">{informationMessage(query.error)}</p>;
  return (
    <section>
      <h3>Profile history</h3>
      {query.data?.pages
        .flatMap((page) => page.versions)
        .map((version) => (
          <details key={version.id}>
            <summary>
              Version {version.revision} · {version.authorName} ·{" "}
              {new Date(version.createdAt).toLocaleString()}
            </summary>
            <p>{version.reason}</p>
            {version.data.contacts.map((contact) => (
              <StudentContactFields
                key={contact.id}
                contact={contact}
                disabled
                onChange={() => {}}
              />
            ))}
          </details>
        ))}
      {query.hasNextPage && (
        <button onClick={() => query.fetchNextPage()}>
          Load earlier versions
        </button>
      )}
    </section>
  );
}
export default function StudentContactProfileEditor({
  schoolId,
  viewerId,
  studentId,
  onClose,
}) {
  const client = useQueryClient();
  const { requestAction } = useAdminNavigation();
  const [session, setSession] = useState(0);
  const [denied, setDenied] = useState(null);
  const query = useQuery({
    queryKey: studentInformationKeys.profile(schoolId, viewerId, studentId),
    queryFn: ({ signal }) =>
      studentInformationApi(schoolId, signal).profile(studentId),
    enabled: Boolean(schoolId && viewerId && studentId && !denied),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: "always",
  });
  // A denied refresh must remove the editor and history immediately, including
  // unsaved inputs. Cached success never authorizes continued shared access.
  const deny = (failure) => {
    setDenied(failure);
    void client.cancelQueries({
      queryKey: studentInformationKeys.profile(schoolId, viewerId, studentId),
    });
    client.removeQueries({
      queryKey: studentInformationKeys.profile(schoolId, viewerId, studentId),
    });
  };
  if (denied || query.isError)
    return (
      <div role="alert">
        <p>{informationMessage(denied || query.error)}</p>
        <button
          onClick={async () => {
            const result = await query.refetch();
            if (!result.isError) {
              setDenied(null);
              setSession((value) => value + 1);
            }
          }}
        >
          Refresh access
        </button>
      </div>
    );
  if (!query.data) return <p role="status">Loading student information…</p>;
  const identity = `${schoolId}:${viewerId}:${studentId}:${session}`;
  return (
    <section className="student-info-profile">
      <header>
        <h2>{query.data.student.name}</h2>
        {onClose && <button onClick={() => requestAction(onClose, { id: "student-contact-close" })}>Close student</button>}
      </header>
      <ProfileForm
        key={identity}
        {...{ schoolId, viewerId, studentId }}
        result={query.data}
        onDenied={deny}
        onSaved={async () => {
          await client.invalidateQueries({
            queryKey: studentInformationKeys.root(schoolId, viewerId),
          });
          setSession((value) => value + 1);
        }}
      />
      <History
        key={`${identity}:history`}
        {...{ schoolId, viewerId, studentId }}
        onDenied={deny}
      />
    </section>
  );
}
