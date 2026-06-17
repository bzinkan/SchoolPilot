import { useLicenses } from '../../contexts/LicenseContext';
import { useNative } from '../../contexts/NativeContext';

export function useStudentImportHome() {
  const { hasClassPilot, hasPassPilot, hasGoPilot } = useLicenses();
  const { isNative } = useNative();

  return {
    consolidated: hasClassPilot,
    canLinkToClassPilot: hasClassPilot && !isNative,
    importPath: '/classpilot/students',
    hasPassPilot,
    hasGoPilot,
  };
}
