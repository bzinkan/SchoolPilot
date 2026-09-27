import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { guardPrivateWorkspaceHistory } from "../lib/privateWorkspaceNavigation";
import { useAdminNavigation, useAdminNavigationBlocker, useAdminShell } from "./useAdminNavigation";

export function useStudentInformationDraftGuard(dirty, { busy = false, id = "student-information", onDiscard } = {}) {
  const [destination, setDestination] = useState(null),
    [leaving, setLeaving] = useState(false);
  const navigate = useNavigate();
  const shell = useAdminShell();
  const navigation = useAdminNavigation();
  const afterCommit = useAdminNavigationBlocker({ id, dirty, busy, onDiscard });
  useEffect(() => {
    if (shell || (!dirty && !busy) || leaving) return;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const link = (event) => {
      const anchor = event.target.closest?.("a[href]");
      if (
        !anchor ||
        anchor.target === "_blank" ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        anchor.hasAttribute("download")
      )
        return;
      const url = new URL(anchor.href);
      if (
        url.origin !== window.location.origin ||
        url.href === window.location.href
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setDestination(url.pathname + url.search + url.hash);
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", link, true);
    const release = guardPrivateWorkspaceHistory((path) =>
      setDestination(path),
    );
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", link, true);
      release();
    };
  }, [dirty, busy, leaving, shell]);
  useEffect(() => {
    if (leaving && destination) navigate(destination);
  }, [leaving, destination, navigate]);
  return {
    destination: shell ? null : destination,
    stay: () => setDestination(null),
    leave: () => setLeaving(true),
    ...navigation,
    ...afterCommit,
  };
}
