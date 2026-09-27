import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { studentInformationApi } from "../lib/studentInformationApi";
import {
  informationMessage,
  studentInformationKeys,
  sourceContactDecision,
  informationFileType,
  emptyContact,
} from "../lib/studentInformationModel";
import { attachmentDigest } from "../lib/myDesk";
import StudentContactFields from "./StudentContactFields";
import { useAdminNavigation, useAdminNavigationBlocker, useAdminShell } from "../hooks/useAdminNavigation";
import { withDisciplineEntry } from "../lib/disciplineNavigation";
import { useStudentInformationDraftGuard } from "../hooks/useStudentInformationDraftGuard";

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.docx,.xlsx,.csv";
function SourcePreview({ access, run, assetId }) {
  const [content, setContent] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let url;
    studentInformationApi(access.schoolId, controller.signal)
      .content(run.id, assetId)
      .then(async (blob) => {
        if (controller.signal.aborted) return;
        if (blob.type.startsWith("text/")) {
          const text = await blob.text();
          if (!controller.signal.aborted) setContent({ text });
        } else {
          url = URL.createObjectURL(blob);
          setContent({ url });
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(informationMessage(failure));
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [access.schoolId, run.id, assetId]);
  return (
    <aside className="student-info-preview">
      <h3>Selected source</h3>
      {error ? (
        <p role="alert">{error}</p>
      ) : content?.text ? (
        <pre>{content.text}</pre>
      ) : content?.url ? (
        <img src={content.url} alt="Selected source for contact review" />
      ) : (
        <p role="status">Loading source…</p>
      )}
    </aside>
  );
}
function SectionPreview({ access, run, section }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Preview {section.label}</summary>
      {open && <SourcePreview access={access} run={run} assetId={section.id} />}
    </details>
  );
}
function StudentMatch({ access, value, onChange }) {
  const [query, setQuery] = useState("");
  const q = useDeferredValue(query);
  const result = useQuery({
    queryKey: [
      ...studentInformationKeys.root(access.schoolId, access.viewerId),
      "match",
      q,
    ],
    queryFn: ({ signal }) =>
      studentInformationApi(access.schoolId, signal).search({ q, limit: 100 }),
    retry: false,
    staleTime: 0,
  });
  return (
    <div>
      <label>
        Find the student
        <input
          value={query}
          maxLength={200}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <label>
        Student for this profile
        <select
          value={value || ""}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">Choose explicitly</option>
          {result.data?.students.map((student) => (
            <option key={student.id} value={student.id}>
              {student.name} · Grade {student.gradeLevel || "not set"} · ID{" "}
              {student.id}
            </option>
          ))}
        </select>
      </label>
      {result.isError && <p role="alert">{informationMessage(result.error)}</p>}
      {result.data?.nextCursor && (
        <p>Enter more of the name to narrow the matches.</p>
      )}
    </div>
  );
}
function ProfileReview({ access, run, item, onAction, busy, onDirty }) {
  const [manualContacts, setManualContacts] = useState([]),
    [removed, setRemoved] = useState([]);
  const [studentId, setStudentId] = useState(item.studentId),
    [resolved, setResolved] = useState(false),
    [decisions, setDecisions] = useState({});
  const [previewId, setPreviewId] = useState(item.sourceSectionId),
    [combineId, setCombineId] = useState("");
  const current = useQuery({
    queryKey: studentInformationKeys.profile(
      access.schoolId,
      access.viewerId,
      studentId,
    ),
    queryFn: ({ signal }) =>
      studentInformationApi(access.schoolId, signal).profile(studentId),
    enabled: Boolean(studentId),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: "always",
  });
  const dirty = manualContacts.length > 0 || removed.length > 0 || studentId !== item.studentId || resolved || Object.keys(decisions).length > 0;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const profile = current.isError ? null : current.data?.profile;
  const proposedContacts = [...item.proposed.contacts, ...manualContacts];
  const decided = proposedContacts.every(
    (contact) =>
      decisions[contact.id]?.kind &&
      (decisions[contact.id]?.kind === "keep" ||
        (decisions[contact.id]?.contact || contact).name.trim()),
  );
  const review = () => {
    try {
      const changes = proposedContacts
        .map((contact) => sourceContactDecision(contact, decisions[contact.id]))
        .filter(Boolean)
        .concat(removed.map((contactId) => ({ kind: "remove", contactId })));
      onAction("review", {
        itemId: item.id,
        itemRevision: item.revision,
        studentId,
        baseRevision: profile.revision,
        changes,
        reviewed: true,
        excluded: false,
        resolvedWarnings: resolved,
      });
    } catch (error) {
      window.alert(error.message);
    }
  };
  return (
    <div className="student-info-review">
      <div>
        <label>
          Source section
          <select
            value={previewId}
            onChange={(e) => setPreviewId(e.target.value)}
          >
            {run.assets
              .filter(
                (asset) =>
                  asset.kind === "section" &&
                  run.selectedSectionIds.includes(asset.id),
              )
              .map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.label}
                </option>
              ))}
          </select>
        </label>
        <SourcePreview
          key={previewId}
          access={access}
          run={run}
          assetId={previewId}
        />
      </div>
      <section>
        <h2>{item.studentName || "Unmatched student"}</h2>
        <p>
          Review each adult and every phone and email against the source. These
          suggestions have not changed the school profile.
        </p>
        <StudentMatch
          access={access}
          value={studentId}
          onChange={(next) => {
            setStudentId(next);
            setResolved(false);
            setDecisions({});
            setRemoved([]);
          }}
        />
        <details>
          <summary>Combine another draft for the same student</summary>
          <p>
            Only combine after verifying both sources identify this student. You
            must review the combined contacts again.
          </p>
          <select
            aria-label="Draft to combine"
            value={combineId}
            onChange={(e) => setCombineId(e.target.value)}
          >
            <option value="">Choose another draft</option>
            {run.items
              .filter((value) => value.id !== item.id && !value.excluded)
              .map((value) => (
                <option key={value.id} value={value.id}>
                  {value.studentName}
                </option>
              ))}
          </select>
          <button
            disabled={busy || !combineId}
            onClick={() => {
              const source = run.items.find((value) => value.id === combineId);
              onAction("join", {
                itemId: item.id,
                itemRevision: item.revision,
                sourceItemId: source.id,
                sourceItemRevision: source.revision,
              });
            }}
          >
            Combine and review again
          </button>
        </details>
        {item.warnings.length > 0 && (
          <p className="student-info-warning">
            Needs review:{" "}
            {item.warnings
              .map((value) => value.replaceAll("_", " "))
              .join(", ")}
            .
          </p>
        )}
        {current.isError ? (
          <p role="alert">{informationMessage(current.error)}</p>
        ) : studentId && !profile ? (
          <p role="status">Loading current profile…</p>
        ) : (
          profile && (
            <div className="student-info-current">
              <h3>Current saved values</h3>
              {profile.data.contacts.length ? (
                profile.data.contacts.map((contact) => (
                  <p key={contact.id}>
                    <strong>{contact.name}</strong> {contact.relationship || ""}
                    <br />
                    {contact.phones.join(", ")}
                    <br />
                    {contact.emails.join(", ")}
                    <br />
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (removed.includes(contact.id))
                          setRemoved((value) =>
                            value.filter((id) => id !== contact.id),
                          );
                        else if (
                          window.confirm(
                            `Explicitly remove ${contact.name} from this student's current profile?`,
                          )
                        )
                          setRemoved((value) => [...value, contact.id]);
                        setResolved(false);
                      }}
                    >
                      {removed.includes(contact.id)
                        ? "Undo contact removal"
                        : "Remove this current contact"}
                    </button>
                  </p>
                ))
              ) : (
                <p>No contacts saved.</p>
              )}
            </div>
          )
        )}
        {profile &&
          proposedContacts.map((contact) => {
            const decision = decisions[contact.id] || {};
            return (
              <section key={contact.id}>
                <StudentContactFields
                  contact={decision.contact || contact}
                  disabled={busy}
                  onChange={(next) => {
                    setResolved(false);
                    setDecisions((value) => ({
                      ...value,
                      [contact.id]: { ...decision, contact: next },
                    }));
                  }}
                />
                <label>
                  Decision for {contact.name}
                  <select
                    value={decision.kind || ""}
                    onChange={(e) => {
                      setResolved(false);
                      setDecisions((value) => ({
                        ...value,
                        [contact.id]: { ...decision, kind: e.target.value },
                      }));
                    }}
                  >
                    <option value="">Choose a decision</option>
                    <option value="keep">
                      Keep current; do not use this suggestion
                    </option>
                    <option value="add">Add as a new contact</option>
                    <option value="replace">
                      Replace stated fields on a current contact
                    </option>
                  </select>
                </label>
                {decision.kind === "replace" && (
                  <label>
                    Current contact to update
                    <select
                      value={decision.contactId || ""}
                      onChange={(e) => {
                        setResolved(false);
                        setDecisions((value) => ({
                          ...value,
                          [contact.id]: {
                            ...decision,
                            contactId: e.target.value,
                          },
                        }));
                      }}
                    >
                      <option value="">Choose current contact</option>
                      {profile.data.contacts.map((existing) => (
                        <option key={existing.id} value={existing.id}>
                          {existing.name} ·{" "}
                          {existing.relationship || "relationship not stated"}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </section>
            );
          })}
        <p>
          Blank source fields keep current values. Only contacts explicitly
          marked for removal will be deleted from the current profile.
        </p>
        {profile && (
          <button
            disabled={busy || proposedContacts.length >= 20}
            onClick={() => {
              const contact = emptyContact();
              setManualContacts((value) => [...value, contact]);
              setDecisions((value) => ({
                ...value,
                [contact.id]: { kind: "add" },
              }));
              setResolved(false);
            }}
          >
            Add a contact missed in the source reading
          </button>
        )}
        <label className="student-info-section">
          <input
            type="checkbox"
            checked={resolved}
            onChange={(e) => setResolved(e.target.checked)}
          />
          I checked this student, adult associations, and every uncertain digit,
          email, and relationship against the source.
        </label>
        <button
          disabled={busy || !profile || !resolved || !decided}
          onClick={review}
        >
          Mark profile reviewed
        </button>
        <button
          disabled={busy}
          onClick={() =>
            onAction("review", {
              itemId: item.id,
              itemRevision: item.revision,
              studentId,
              baseRevision: profile?.revision || 0,
              changes: [],
              reviewed: false,
              excluded: true,
              resolvedWarnings: false,
            })
          }
        >
          Exclude this profile
        </button>
      </section>
    </div>
  );
}
export function StudentInformationUpload({ access, run, onUploaded }) {
  const [files, setFiles] = useState([]),
    [busy, setBusy] = useState(false),
    [hasAttempt, setHasAttempt] = useState(false),
    [error, setError] = useState("");
  const lifetime = useRef(null),
    attempt = useRef(null);
  const committedNavigation = useAdminNavigationBlocker({ id: `contact-upload:${run?.id || "new"}`, dirty: files.length > 0 || hasAttempt, busy,
    onDiscard: () => { setFiles([]); setHasAttempt(false); attempt.current = null; } });
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const upload = async () => {
    const controller = lifetime.current;
    if (busy || !files.length || !controller || controller.signal.aborted)
      return;
    if (
      files.length > 5 ||
      files.some((file) => !file.size || file.size > 10 * 1024 * 1024)
    ) {
      setError(
        "Choose one to five nonempty files, no larger than 10 MiB each.",
      );
      return;
    }
    if (!attempt.current) {
      attempt.current = {
        clientRequestId: crypto.randomUUID(),
        files: files.map((file) => ({ file, requestId: crypto.randomUUID() })),
        runId: run?.id,
      };
      setHasAttempt(true);
    }
    setBusy(true);
    setError("");
    try {
      const api = studentInformationApi(access.schoolId, controller.signal),
        saved = attempt.current;
      if (!saved.runId)
        saved.runId = (
          await api.createImport({
            clientRequestId: saved.clientRequestId,
            expectedSourceCount: saved.files.length,
          })
        ).import.id;
      const current = (await api.import(saved.runId)).import;
      for (const selection of saved.files) {
        const file = selection.file,
          contentType = informationFileType(file),
          sha256 = await attachmentDigest(file);
        controller.signal.throwIfAborted();
        const prior = current.assets.find(
          (asset) =>
            asset.kind === "source" &&
            asset.inputSha256 === sha256 &&
            asset.byteSize === file.size &&
            asset.contentType === contentType,
        );
        const asset =
          prior ||
          (
            await api.reserve(saved.runId, {
              clientRequestId: selection.requestId,
              filename: file.name,
              size: file.size,
              contentType,
              sha256,
            })
          ).asset;
        if (asset.status !== "ready")
          await api.upload(saved.runId, asset.id, file, contentType);
      }
      controller.signal.throwIfAborted();
      setFiles([]); setHasAttempt(false); attempt.current = null;
      await onUploaded(saved.runId, committedNavigation.navigateAfterCommit);
    } catch (failure) {
      if (!controller.signal.aborted) setError(informationMessage(failure));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <section>
      <h2>
        {run ? "Finish source uploads" : "Import student contact information"}
      </h2>
      <p>
        Choose PDF, photos, DOCX, XLSX, or CSV. Up to five files, 10 MiB each;
        20 pages or photos, five sheets, 500 rows and 50 columns, 500 student
        profiles, and 1 MiB of extracted text. Only the sections you select
        will be used to prepare suggestions.
      </p>
      <p>
        Private drafts expire after seven days. Sources, previews, and
        unapproved suggestions are deleted after saving or cancellation. Saved
        contact values remain in the shared profile history.
      </p>
      <input
        aria-label="Contact information files"
        type="file"
        accept={ACCEPT}
        multiple
        disabled={busy || hasAttempt}
        onChange={(e) => {
          setFiles(Array.from(e.target.files || []));
          setError("");
        }}
      />
      {error && <p role="alert">{error}</p>}
      <button disabled={busy || !files.length} onClick={upload}>
        {busy
          ? "Preparing source previews…"
          : hasAttempt
            ? "Retry uploads"
            : "Upload for private review"}
      </button>
    </section>
  );
}
function ManualProfile({ access, run, busy, onAction }) {
  const [studentId, setStudentId] = useState(null),
    [sourceSectionId, setSourceSectionId] = useState("");
  useAdminNavigationBlocker({ id: `contact-manual-profile:${run.id}`, dirty: Boolean(studentId || sourceSectionId), busy,
    onDiscard: () => { setStudentId(null); setSourceSectionId(""); } });
  return (
    <details>
      <summary>Add a student missed in the source reading</summary>
      <StudentMatch access={access} value={studentId} onChange={setStudentId} />
      <label>
        Source for this student
        <select
          value={sourceSectionId}
          onChange={(e) => setSourceSectionId(e.target.value)}
        >
          <option value="">Choose a selected source section</option>
          {run.assets
            .filter((asset) => run.selectedSectionIds.includes(asset.id))
            .map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.label}
              </option>
            ))}
        </select>
      </label>
      <button
        disabled={busy || !studentId || !sourceSectionId}
        onClick={async () => { if (await onAction("addItem", { studentId, sourceSectionId })) { setStudentId(null); setSourceSectionId(""); } }}
      >
        Add draft for manual review
      </button>
    </details>
  );
}
export default function StudentInformationImport({ access, importId }) {
  const client = useQueryClient();
  const { navigate, requestAction } = useAdminNavigation();
  const shell = useAdminShell();
  const Heading = shell ? "h2" : "h1";
  const [params] = useSearchParams();
  const directoryPath = withDisciplineEntry("/classpilot/my-desk/student-information", params);
  const key = [
    ...studentInformationKeys.root(access.schoolId, access.viewerId),
    "import",
    importId,
  ];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      studentInformationApi(access.schoolId, signal).import(importId),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: "always",
    refetchInterval: (query) =>
      ["queued", "processing"].includes(query.state.data?.import.status)
        ? 3000
        : false,
  });
  const [selected, setSelected] = useState([]),
    [acknowledged, setAcknowledged] = useState(false),
    [processingConfirmed, setProcessingConfirmed] = useState(false),
    [itemId, setItemId] = useState(null),
    [reviewDirty, setReviewDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lifetime = useRef(null),
    frozen = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const run = query.isError ? null : query.data?.import;
  const guard = useStudentInformationDraftGuard(shell ? reviewDirty || selected.length > 0 || acknowledged || processingConfirmed : Boolean(itemId), {
    id: `contact-import:${importId}`, busy, onDiscard: () => { setItemId(null); setReviewDirty(false); setSelected([]); setAcknowledged(false); setProcessingConfirmed(false); },
  });
  const action = async (kind, details = {}) => {
    const controller = lifetime.current;
    if (busy || !run || !controller || controller.signal.aborted) return;
    const { itemId: target, ...payload } = details,
      signature = JSON.stringify([kind, target, run.revision, payload]);
    if (frozen.current?.signature !== signature)
      frozen.current = {
        signature,
        input: {
          ...payload,
          revision: run.revision,
          requestId: crypto.randomUUID(),
        },
      };
    setBusy(true);
    setError("");
    try {
      const api = studentInformationApi(access.schoolId, controller.signal),
        input = frozen.current.input;
      if (kind === "review" || kind === "join")
        await api[kind](importId, target, input);
      else await api[kind](importId, input);
      controller.signal.throwIfAborted();
      frozen.current = null;
      await client.invalidateQueries({
        queryKey: studentInformationKeys.root(access.schoolId, access.viewerId),
      });
      setItemId(null); setReviewDirty(false); setSelected([]); setAcknowledged(false); setProcessingConfirmed(false);
      return true;
    } catch (failure) {
      if (!controller.signal.aborted) setError(informationMessage(failure));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  if (query.isError)
    return <p role="alert">{informationMessage(query.error)}</p>;
  if (!run) return <p role="status">Loading import…</p>;
  const sections = run.assets.filter(
      (asset) => asset.kind === "section" && asset.status === "ready",
    ),
    units = sections
      .filter((section) => selected.includes(section.id))
      .reduce((n, section) => n + section.units, 0);
  const item = run.items.find((value) => value.id === itemId),
    complete =
      run.items.length &&
      run.items.every((value) => value.reviewed || value.excluded) &&
      run.items.some((value) => value.reviewed && !value.excluded);
  return (
    <section>
      <Link to={directoryPath}>
        Student information
      </Link>
      <Heading>Review contact import</Heading>
      <p>
        State: {run.status}. Private review expires{" "}
        {new Date(run.expiresAt).toLocaleString()}.
      </p>
      {error && <p role="alert">{error}</p>}
      {guard.destination && (
        <div role="alertdialog" aria-label="Discard contact review">
          <p>
            Leave this open review? Only previously saved review decisions will
            be retained.
          </p>
          <button onClick={guard.stay}>Keep reviewing</button>
          <button onClick={guard.leave}>Discard and leave</button>
        </div>
      )}
      {run.status === "uploading" && (
        <>
          {run.assets.filter((a) => a.kind === "source" && a.status === "ready")
            .length < run.expectedSourceCount && (
            <StudentInformationUpload
              access={access}
              run={run}
              onUploaded={() => query.refetch()}
            />
          )}
          <h2>Choose exactly what to read</h2>
          {sections.map((section) => (
            <div key={section.id}>
              <label className="student-info-section">
                <input
                  type="checkbox"
                  checked={selected.includes(section.id)}
                  onChange={(e) =>
                    setSelected((value) =>
                      e.target.checked
                        ? [...value, section.id]
                        : value.filter((id) => id !== section.id),
                    )
                  }
                />
                <span>
                  {section.label}
                  {section.hidden
                    ? " — hidden content, excluded unless selected"
                    : ""}{" "}
                  · {section.units} {section.units === 1 ? "unit" : "units"}
                  {section.warnings.length > 0 && (
                    <small className="student-info-warning">
                      {" "}
                      {section.warnings
                        .map((w) => w.replaceAll("_", " "))
                        .join(", ")}
                    </small>
                  )}
                </span>
              </label>
              <SectionPreview access={access} run={run} section={section} />
            </div>
          ))}
          <p>
            {units} of 20 units selected. A page or photo is one unit, a DOCX
            text section uses one unit per started 4,000 characters, and
            spreadsheet rows use one per started 25 rows. Daily allowance is
            shared with paperwork imports: {access.limits?.teacherDailyUnits}{" "}
            per teacher and {access.limits?.schoolDailyUnits} per school.
          </p>
          <label className="student-info-section">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            I reviewed hidden and unsupported content warnings. Formula values
            require manual verification.
          </label>
          <label className="student-info-section">
            <input
              type="checkbox"
              checked={processingConfirmed}
              onChange={(e) => setProcessingConfirmed(e.target.checked)}
            />
            Prepare contact suggestions from only these selected sections.
            I will review the suggestions before saving.
          </label>
          <button
            disabled={
              busy ||
              !access.aiImportEnabled ||
              !selected.length ||
              units > 20 ||
              !processingConfirmed ||
              !acknowledged
            }
            onClick={() =>
              action("process", {
                sectionIds: selected,
                acknowledgedWarnings: acknowledged,
                confirmedProvider: processingConfirmed,
              })
            }
          >
            Read selected sections
          </button>
        </>
      )}
      {["queued", "processing"].includes(run.status) && (
        <p role="status">
          Preparing contact suggestions. You can leave this page and return
          later.
        </p>
      )}
      {run.status === "failed" && (
        <p role="alert">
          Processing stopped safely. No student profile was changed. Cancel this
          import and start a smaller source packet if it cannot be read.
        </p>
      )}
      {run.status === "review" && (
        <>
          <h2>Review every student</h2>
          {!itemId && (
            <ManualProfile
              access={access}
              run={run}
              busy={busy}
              onAction={action}
            />
          )}
          <p>
            {run.items.filter((value) => value.reviewed).length} reviewed,{" "}
            {run.items.filter((value) => value.excluded).length} excluded,{" "}
            {
              run.items.filter((value) => !value.reviewed && !value.excluded)
                .length
            }{" "}
            still to decide.
          </p>
          {run.items.map((value) => (
            <button
              key={value.id}
              onClick={() => {
                if (shell) { if (itemId !== value.id) void requestAction(() => setItemId(value.id), { id: "contact-review-switch" }); return; }
                if (
                  !itemId ||
                  itemId === value.id ||
                  window.confirm(
                    "Discard unsaved decisions in the open profile and switch students?",
                  )
                )
                  setItemId(value.id);
              }}
            >
              {value.studentName} —{" "}
              {value.reviewed
                ? "Reviewed"
                : value.excluded
                  ? "Excluded"
                  : "Needs review"}
            </button>
          ))}
          {item && (
            <ProfileReview
              key={`${item.id}:${item.revision}`}
              access={access}
              run={run}
              item={item}
              onDirty={setReviewDirty}
              onAction={action}
              busy={busy}
            />
          )}
          {item && (
            <button
              onClick={() => {
                if (shell) { void requestAction(() => setItemId(null), { id: "contact-review-close" }); return; }
                if (
                  window.confirm(
                    "Discard unsaved edits and close this profile review?",
                  )
                )
                  setItemId(null);
              }}
            >
              Close profile review
            </button>
          )}
          <p>
            Save together rechecks every student and profile version. If
            anything changed, nothing is applied and your drafts remain
            available.
          </p>
          <button
            disabled={busy || !complete || Boolean(item)}
            onClick={() => action("commit")}
          >
            Save all reviewed profiles together
          </button>
        </>
      )}
      {run.status === "completed" && (
        <>
          <p>
            Reviewed profiles saved. Source files and draft suggestions have
            been queued for deletion.
          </p>
          {run.receipt?.profiles.map((profile) => (
            <p key={profile.itemId}>
              <Link
                to={withDisciplineEntry(`/classpilot/my-desk/student-information/${encodeURIComponent(profile.studentId)}`, params)}
              >
                Open saved student profile
              </Link>
            </p>
          ))}
        </>
      )}
      {!["completed", "cancelled", "expired"].includes(run.status) && (
        <button
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                "Cancel this import and delete its source files and drafts? Shared profiles will stay unchanged.",
              )
            )
              action("cancel");
          }}
        >
          Cancel import and delete sources
        </button>
      )}
      <button
        onClick={() => {
          if (shell) { void navigate(directoryPath); return; }
          if (
            !itemId ||
            window.confirm("Discard unsaved review edits and return?")
          )
            navigate(directoryPath);
        }}
      >
        Return to student information
      </button>
    </section>
  );
}
