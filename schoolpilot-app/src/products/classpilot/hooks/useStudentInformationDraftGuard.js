import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { guardPrivateWorkspaceHistory } from "../lib/privateWorkspaceNavigation";

export function useStudentInformationDraftGuard(dirty) {
  const [destination, setDestination] = useState(null),
    [leaving, setLeaving] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    if (!dirty || leaving) return;
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
  }, [dirty, leaving]);
  useEffect(() => {
    if (leaving && destination) navigate(destination);
  }, [leaving, destination, navigate]);
  return {
    destination,
    stay: () => setDestination(null),
    leave: () => setLeaving(true),
  };
}
