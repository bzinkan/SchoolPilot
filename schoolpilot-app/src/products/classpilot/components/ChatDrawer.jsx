import { Sheet, SheetContent, SheetTitle, SheetDescription } from '../../../components/ui/sheet';
import { useResizablePanelWidth } from '../hooks/useResizablePanelWidth';
import ChatWorkspace from './ChatWorkspace';

export default function ChatDrawer({ open, onClose, ...props }) {
  const { width, onResizeStart } = useResizablePanelWidth({ initial: 640, min: 400, storageKey: 'classpilot-chat-drawer-width' });
  return <Sheet open={open} modal={false} onOpenChange={(next) => { if (!next) onClose(); }}>
    <SheetContent side="right" overlay={false} className="p-0 flex flex-col gap-0 sm:max-w-none" style={{ width, maxWidth: '90vw' }}
      onInteractOutside={(event) => event.preventDefault()} onPointerDownOutside={(event) => event.preventDefault()} onFocusOutside={(event) => event.preventDefault()}>
      <SheetTitle className="sr-only">Messages</SheetTitle><SheetDescription className="sr-only">Class conversations</SheetDescription>
      <div className="absolute left-0 top-0 h-full w-1.5 cursor-col-resize z-10" onMouseDown={onResizeStart} role="separator" aria-orientation="vertical" aria-label="Resize messages panel" />
      <ChatWorkspace {...props} width={width} visible={open} />
    </SheetContent>
  </Sheet>;
}
