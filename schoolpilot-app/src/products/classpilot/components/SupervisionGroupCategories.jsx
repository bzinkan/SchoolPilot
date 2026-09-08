import { useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/queryClient";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../../../components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "../../../components/ui/alert-dialog";
import { useClassPilotAuth } from "../../../hooks/useClassPilotAuth";
import { refreshSupervisionSetup } from "./supervisionGroupQueries";

const API = "/coverage/supervision-group-categories";
export default function SupervisionGroupCategories({
  schoolId,
  open,
  onOpenChange,
}) {
  const { currentUser } = useClassPilotAuth();
  const [owner] = useState({ schoolId, actorId: currentUser?.id });
  const live =
    owner.schoolId === currentUser?.schoolId &&
    owner.actorId === currentUser?.id &&
    (currentUser?.isSuperAdmin ||
      ["admin", "school_admin"].includes(currentUser?.role));
  const committed = useRef(false),
    opener = useRef(document.activeElement);
  useLayoutEffect(() => {
    committed.current = live;
    return () => {
      committed.current = false;
    };
  }, [live]);
  useLayoutEffect(() => {
    if (!live) onOpenChange(false);
  }, [live, onOpenChange]);
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [notice, setNotice] = useState("");
  const headers = { "X-School-Id": owner.schoolId };
  const query = useQuery({
    queryKey: [`/api${API}`, owner.schoolId, owner.actorId],
    queryFn: ({ signal }) =>
      apiRequest("GET", API, undefined, { signal, headers }),
    enabled: !!open && live,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: async ({ action, target, value }) => {
      if (!committed.current)
        throw new Error(
          "School access changed. Reopen categories in the current school.",
        );
      return apiRequest(
        action === "delete" ? "DELETE" : target ? "PATCH" : "POST",
        target ? `${API}/${encodeURIComponent(target.id)}` : API,
        {
          ...(action === "delete" ? {} : { name: value.trim() }),
          ...(target ? { updatedAt: target.updatedAt } : {}),
        },
        { headers },
      );
    },
    onSuccess: async (_result, variables) => {
      const warning = await refreshSupervisionSetup(client, owner.schoolId);
      if (!committed.current) return;
      setDeleting(null);
      setEditing(null);
      setName("");
      setNotice(
        `${variables.action === "delete" ? "Category deleted. Its groups are now Uncategorized." : "Category saved."}${warning ? " Some lists could not refresh. Use Refresh categories." : ""}`,
      );
    },
    onError: () => {
      void query.refetch();
    },
  });
  const error =
    mutation.error?.response?.data?.error || mutation.error?.message;
  return (
    <Dialog
      open={open && live}
      onOpenChange={(value) => {
        if (!mutation.isPending) onOpenChange(value);
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (live && opener.current?.isConnected) opener.current.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (mutation.isPending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Manage categories</DialogTitle>
          <DialogDescription>
            Optional school categories organize groups. They do not change
            students, staff access, or testing schedules.
          </DialogDescription>
        </DialogHeader>
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        {(query.isError || (!deleting && error)) && (
          <p role="alert" className="text-sm text-destructive">
            {error ||
              "Categories could not load. Refresh categories to try again."}
          </p>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={query.isFetching || mutation.isPending}
          onClick={() => query.refetch()}
        >
          Refresh categories
        </Button>
        <fieldset disabled={mutation.isPending} className="space-y-3">
          <label className="block space-y-1 text-sm">
            {editing ? "Rename category" : "New category"}
            <Input
              aria-label={editing ? "Rename category" : "New category"}
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <Button
              disabled={!name.trim() || query.isPending || query.isError}
              onClick={() =>
                mutation.mutate({
                  action: "save",
                  target: editing,
                  value: name,
                })
              }
            >
              {editing ? "Save category" : "Add category"}
            </Button>
            {editing && (
              <Button
                variant="outline"
                onClick={() => {
                  setEditing(null);
                  setName("");
                  mutation.reset();
                }}
              >
                Cancel rename
              </Button>
            )}
          </div>
          {query.isPending ? (
            <p role="status">Loading categories…</p>
          ) : (
            (query.data?.categories || []).map((category) => (
              <div
                key={category.id}
                className="flex flex-wrap items-center justify-between gap-2 border-t py-2 text-sm"
              >
                <span className="min-w-0 break-words">
                  {category.name} · {category.groupCount} groups
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Rename category ${category.name}`}
                    onClick={() => {
                      setEditing(category);
                      setName(category.name);
                      mutation.reset();
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive"
                    aria-label={`Delete category ${category.name}`}
                    onClick={() => {
                      setDeleting(category);
                      mutation.reset();
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))
          )}
        </fieldset>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => onOpenChange(false)}
          >
            Close categories
          </Button>
        </DialogFooter>
        <AlertDialog
          open={!!deleting}
          onOpenChange={(value) => {
            if (!value && !mutation.isPending) setDeleting(null);
          }}
        >
          <AlertDialogContent
            onEscapeKeyDown={(event) => {
              if (mutation.isPending) event.preventDefault();
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Delete category?</AlertDialogTitle>
              <AlertDialogDescription>
                Delete “{deleting?.name}”? Its {deleting?.groupCount || 0} group
                {deleting?.groupCount === 1 ? "" : "s"} will move to
                Uncategorized. Groups, students, staff access, and schedules
                remain.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={mutation.isPending}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={mutation.isPending}
                onClick={(event) => {
                  event.preventDefault();
                  mutation.mutate({ action: "delete", target: deleting });
                }}
              >
                {mutation.isPending ? "Deleting…" : "Delete category"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
