import { useEffect } from 'react';

const ALERT_ICON = '/favicon-unread.svg';
const ALERT_ICON_TYPE = 'image/svg+xml';

function restoreAttribute(node, name, value) {
  if (value === null) node.removeAttribute(name);
  else node.setAttribute(name, value);
}

/** Browser-tab alert for the current authenticated classroom's unread messages. */
export default function useClasspilotMessageAlert(unreadCount) {
  const count = Number.isSafeInteger(unreadCount) && unreadCount > 0 ? unreadCount : 0;

  useEffect(() => {
    if (count === 0) return undefined;

    const originalTitle = document.title;
    const alertTitle = `(${count}) ClassPilot | ${originalTitle}`;
    const existingIcon = document.querySelector('link[rel~="icon"]');
    const icon = existingIcon || document.createElement('link');
    const originalHref = icon.getAttribute('href');
    const originalType = icon.getAttribute('type');

    document.title = alertTitle;
    icon.setAttribute('href', ALERT_ICON);
    icon.setAttribute('type', ALERT_ICON_TYPE);
    if (!existingIcon) {
      icon.setAttribute('rel', 'icon');
      document.head.appendChild(icon);
    }

    return () => {
      // A destination page may already own its metadata by the time this
      // dashboard unmounts. Restore only values this effect still owns.
      if (document.title === alertTitle) document.title = originalTitle;
      if (icon.getAttribute('href') !== ALERT_ICON || icon.getAttribute('type') !== ALERT_ICON_TYPE) return;
      if (!existingIcon) icon.remove();
      else {
        restoreAttribute(icon, 'href', originalHref);
        restoreAttribute(icon, 'type', originalType);
      }
    };
  }, [count]);
}
