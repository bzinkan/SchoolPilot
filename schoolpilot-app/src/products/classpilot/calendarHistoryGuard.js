const calendarHistoryGuard = {
  allowNextPop: false,
  currentEntry: null,
  enabled: false,
  ignoreNextPop: false,
  onBlocked: null,
  onRestored: null,
  owner: null,
};

function handleCalendarHistoryPop(event) {
  if (calendarHistoryGuard.allowNextPop) {
    calendarHistoryGuard.allowNextPop = false;
    return;
  }
  if (calendarHistoryGuard.ignoreNextPop) {
    calendarHistoryGuard.ignoreNextPop = false;
    calendarHistoryGuard.onRestored?.();
    return;
  }
  if (!calendarHistoryGuard.enabled) return;

  const currentEntry = calendarHistoryGuard.currentEntry;
  const targetIndex = event.state?.idx;
  if (
    !Number.isInteger(currentEntry?.index)
    || !Number.isInteger(targetIndex)
    || targetIndex === currentEntry.index
  ) {
    // React Router owns same-document entries with integer `idx` values. An
    // unknown entry cannot be bounced without risking history corruption, so
    // leave it to the browser (and the document-level beforeunload guard).
    return;
  }

  const targetUrl = new URL(window.location.href);
  const targetPath = `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
  event.stopImmediatePropagation();
  const delta = targetIndex - currentEntry.index;
  calendarHistoryGuard.ignoreNextPop = true;
  calendarHistoryGuard.onBlocked?.({
    kind: "history",
    delta,
    targetPath,
    restored: false,
  });
  window.history.go(-delta);
}

if (typeof window !== "undefined") {
  // This module is imported by App before BrowserRouter mounts, ensuring the
  // guard observes POP events before React Router's listener in every browser.
  window.addEventListener("popstate", handleCalendarHistoryPop);
}

export function updateCalendarHistoryGuard({ enabled, currentEntry, onBlocked, onRestored, owner }) {
  calendarHistoryGuard.owner = owner;
  calendarHistoryGuard.enabled = enabled;
  calendarHistoryGuard.currentEntry = currentEntry;
  calendarHistoryGuard.onBlocked = onBlocked;
  calendarHistoryGuard.onRestored = onRestored;
}

export function disableCalendarHistoryGuard(owner) {
  if (owner && calendarHistoryGuard.owner !== owner) return;
  calendarHistoryGuard.enabled = false;
  calendarHistoryGuard.currentEntry = null;
  calendarHistoryGuard.onBlocked = null;
  calendarHistoryGuard.onRestored = null;
  calendarHistoryGuard.owner = null;
}

export function continueCalendarHistoryNavigation(pending) {
  if (!pending || pending.delta === null) return false;
  calendarHistoryGuard.allowNextPop = true;
  calendarHistoryGuard.enabled = false;
  window.history.go(pending.delta);
  return true;
}
