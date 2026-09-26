import { useRef, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { measuredBounds } from '../lib/seatingMeasuredModel';
import { RoomContents } from './SeatingRoomDrawing';

export default function SeatingMeasuredBoard({ layout, roster, selectedSeat, selectedStudent, selectedItem, disabled, onSelectSeat, onSelectItem, onAssign, onMove, onGeometry, onRemove }) {
  const svg = useRef(null), drag = useRef(null);
  const [zoom, setZoom] = useState(1), [preview, setPreview] = useState(null);
  const bounds = measuredBounds(layout, true);
  const point = event => { const matrix = svg.current?.getScreenCTM(); return matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) : null; };
  const start = (event, item, collection) => {
    if (disabled || event.button !== 0) return;
    const p = point(event); if (!p) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { item, collection, p, pointerId: event.pointerId };
    if (collection === 'seats') onSelectSeat(item.id); else onSelectItem(item.id);
  };
  const update = event => { const active = drag.current, p = point(event); if (!active || !p || active.pointerId !== event.pointerId) return; setPreview({ ...active, x: Math.round((active.item.x + p.x - active.p.x) / 10) * 10, y: Math.round((active.item.y + p.y - active.p.y) / 10) * 10 }); };
  const finish = event => {
    const active = drag.current, p = point(event); drag.current = null; setPreview(null); if (!active || !p) return;
    const x = Math.round((active.item.x + p.x - active.p.x) / 10) * 10, y = Math.round((active.item.y + p.y - active.p.y) / 10) * 10;
    if (active.collection === 'seats') onMove(active.item.id, x, y); else onGeometry(active.collection, active.item.id, { x, y });
  };
  const key = (event, item, collection) => {
    if (disabled) return;
    const shifts = { ArrowUp: [0, -10], ArrowDown: [0, 10], ArrowLeft: [-10, 0], ArrowRight: [10, 0] };
    if (shifts[event.key] && 'x' in item) { event.preventDefault(); const [x, y] = shifts[event.key], step = event.shiftKey ? 10 : 1; if (collection === 'seats') onMove(item.id, item.x + x * step, item.y + y * step); else onGeometry(collection, item.id, { x: item.x + x * step, y: item.y + y * step }); }
    if (event.key === 'Delete' && collection === 'seats') { event.preventDefault(); onRemove(item); }
  };
  let shown = layout;
  if (preview) { shown = structuredClone(layout); const items = preview.collection === 'vertices' ? shown.room.vertices : shown[preview.collection]; Object.assign(items.find(i => i.id === preview.item.id), { x: preview.x, y: preview.y }); }
  return <section className="seating-floor" aria-label="Classroom layout"><div className="seating-view-tools"><p>Measured room · {layout.displayUnit === 'metric' ? 'metres' : 'feet and inches'}</p><div><Button variant="outline" aria-label="Zoom out" onClick={() => setZoom(Math.max(1, zoom - .25))}>−</Button><span>{Math.round(zoom * 100)}%</span><Button variant="outline" aria-label="Zoom in" onClick={() => setZoom(Math.min(4, zoom + .25))}>+</Button><Button variant="outline" onClick={() => setZoom(1)}>Fit</Button></div></div>
    <div className="seating-viewport seating-measured-viewport" tabIndex={0} aria-label="Scrollable seating plan"><svg ref={svg} className="seating-room-svg" style={{ width: `${zoom * 100}%`, maxWidth: 'none' }} viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`} aria-label="Measured classroom floor plan" onPointerMove={update} onPointerUp={finish} onPointerCancel={() => { drag.current = null; setPreview(null); }}>
      <RoomContents layout={shown} roster={roster} selectedSeat={selectedSeat} selectedItem={selectedItem} onSeat={id => { onSelectSeat(id); if (selectedStudent && !disabled) onAssign(id, selectedStudent); }} onItem={onSelectItem} onDrag={disabled ? undefined : start} onKey={key} showCorners={!disabled} />
    </svg></div><p className="seating-hint">Select a desk or fixture. Drag its round handle or use arrow keys (10 mm; Shift: 100 mm). Edit exact dimensions in Room and fixtures.</p>
  </section>;
}
