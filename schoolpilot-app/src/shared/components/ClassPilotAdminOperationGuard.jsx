import { useAdminNavigationBlocker, useAdminShell } from "../../products/classpilot/hooks/useAdminNavigation";

function RegisteredOperation(props) {
  useAdminNavigationBlocker(props);
  return null;
}

// Shared controls also run in other products. Register only in the Admin shell.
export default function ClassPilotAdminOperationGuard(props) {
  const shell = useAdminShell();
  return shell ? <RegisteredOperation {...props} /> : null;
}
