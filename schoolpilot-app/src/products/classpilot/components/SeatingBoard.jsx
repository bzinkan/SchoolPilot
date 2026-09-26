import { useEffect, useRef, useState } from 'react';
import { GripVertical, LockKeyhole, Minus, Plus, Scan } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { ROOM_WIDTH, ROOM_HEIGHT, DESK_WIDTH, DESK_HEIGHT, GRID } from '../lib/seatingModel';
import SeatingMeasuredBoard from './SeatingMeasuredBoard';

export default function SeatingBoard(props) {
  return props.layout.version === 2 ? <SeatingMeasuredBoard {...props} /> : <LegacySeatingBoard {...props} />;
}
function LegacySeatingBoard({ layout, roster, selectedSeat, selectedStudent, disabled, onSelectSeat, onAssign, onMove, onRemove }) {
  const viewport = useRef(null);
  const drag = useRef(null);
  const [width, setWidth] = useState(800);
  const [zoom, setZoom] = useState(null);
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    const node = viewport.current;
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  const fit = Math.min(1, Math.max(.1, (width - 4) / ROOM_WIDTH));
  const scale = zoom ?? fit;
  const names = new Map(roster.map(student => [student.id, student.name]));
  const startDrag = (event, seat) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { seat, x: event.clientX, y: event.clientY, pointer: event.pointerId };
    onSelectSeat(seat.id);
  };
  const updateDrag = event => {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    setPreview({ id: active.seat.id, x: active.seat.x + (event.clientX - active.x) / scale, y: active.seat.y + (event.clientY - active.y) / scale });
  };
  const endDrag = event => {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    drag.current = null; setPreview(null);
    onMove(active.seat.id, active.seat.x + (event.clientX - active.x) / scale, active.seat.y + (event.clientY - active.y) / scale);
  };
  const keyboard = (event, seat) => {
    if (disabled) return;
    const shifts = { ArrowUp: [0, -GRID], ArrowDown: [0, GRID], ArrowLeft: [-GRID, 0], ArrowRight: [GRID, 0] };
    if (shifts[event.key]) { event.preventDefault(); const [x, y] = shifts[event.key]; onMove(seat.id, seat.x + x, seat.y + y); }
    if (event.key === 'Delete') { event.preventDefault(); onRemove(seat); }
  };
  return <section className="seating-floor" aria-label="Classroom layout">
    <div className="seating-view-tools"><p>Front of classroom</p><div><Button type="button" variant="ghost" size="icon" aria-label="Zoom out" onClick={() => setZoom(Math.max(.15, scale - .1))}><Minus /></Button><span aria-live="polite">{Math.round(scale * 100)}%</span><Button type="button" variant="ghost" size="icon" aria-label="Zoom in" onClick={() => setZoom(Math.min(1.5, scale + .1))}><Plus /></Button><Button type="button" variant="outline" size="sm" onClick={() => setZoom(null)}><Scan className="size-4" />Fit</Button></div></div>
    <div ref={viewport} className="seating-viewport" tabIndex={0} aria-label="Scrollable seating plan">
      <div style={{ width: ROOM_WIDTH * scale, height: ROOM_HEIGHT * scale }}>
        <div className="seating-room" style={{ width: ROOM_WIDTH, height: ROOM_HEIGHT, transform: `scale(${scale})` }}>
          {layout.seats.map((seat, index) => {
            const shown = preview?.id === seat.id ? preview : seat;
            return <div key={seat.id} className={`seating-desk ${selectedSeat === seat.id ? 'is-selected' : ''} ${seat.locked ? 'is-locked' : ''}`} style={{ left: shown.x, top: shown.y, width: DESK_WIDTH, height: DESK_HEIGHT }}>
              <button type="button" className="seating-seat" aria-label={`Seat ${index + 1}, ${names.get(seat.studentId) || 'empty'}${seat.locked ? ', locked' : ''}`} aria-pressed={selectedSeat === seat.id} onClick={() => { onSelectSeat(seat.id); if (selectedStudent && !disabled) onAssign(seat.id, selectedStudent); }} onKeyDown={event => keyboard(event, seat)} onDragOver={event => { if (!disabled) event.preventDefault(); }} onDrop={event => { event.preventDefault(); const studentId = event.dataTransfer.getData('text/plain'); if (!disabled && names.has(studentId)) onAssign(seat.id, studentId); }}><span className="seating-number">{index + 1}</span><span className="seating-name">{names.get(seat.studentId) || 'Empty'}</span>{seat.locked && <LockKeyhole className="seating-seat-lock" aria-hidden="true" />}</button>
              {!disabled && <button type="button" className="seating-drag-handle" tabIndex={-1} aria-label={`Drag desk ${index + 1}`} onPointerDown={event => startDrag(event, seat)} onPointerMove={updateDrag} onPointerUp={endDrag} onPointerCancel={() => { drag.current = null; setPreview(null); }}><GripVertical aria-hidden="true" /></button>}
            </div>;
          })}
        </div>
      </div>
    </div>
    <p className="seating-hint">Select a student, then a seat. Drag a desk by its handle, or focus a seat and use the arrow keys.</p>
  </section>;
}
