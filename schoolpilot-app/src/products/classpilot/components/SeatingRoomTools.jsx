import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { FEATURE_LABELS, measurementToMm, formatMeasurement, convertLegacyRoom, addRoomFeature, changeRoomItem, splitRoomWall, removeRoomCorner, roomWalls, isOpening, doorSwingWarnings, checkMeasured } from '../lib/seatingMeasuredModel';
import SeatingRoomDrawing from './SeatingRoomDrawing';

function LengthField({ label, name, value, unit }) {
  return <label>{label}<input name={name} aria-label={label} defaultValue={formatMeasurement(value, unit)} required autoComplete="off" /></label>;
}
export default function SeatingRoomTools({ layout, roster, selectedSeat, selectedItem, onSelectItem, disabled, onChange }) {
  const [convert, setConvert] = useState(false), [unit, setUnit] = useState('imperial'), [width, setWidth] = useState(''), [preview, setPreview] = useState(null);
  const [kind, setKind] = useState('teacherDesk'), [outline, setOutline] = useState(false), [error, setError] = useState('');
  const attempt = fn => { try { fn(); setError(''); } catch (failure) { setError(failure.message); } };
  if (layout.version === 1) return <section className="seating-room-tools"><h2>Room and fixtures</h2><p>This older chart has no real-world scale. Add a measured room to place walls and furniture.</p><Button variant="outline" disabled={disabled} onClick={() => { setConvert(true); setPreview(null); }}>Set room measurements</Button>
    <Dialog open={convert} onOpenChange={setConvert}><DialogContent className="seating-room-dialog"><DialogHeader><DialogTitle>Measure this room</DialogTitle><DialogDescription>Enter the actual width represented by the full old canvas. The preview scales its 4:3 room and every desk uniformly, retaining students, seat IDs and locks. No chart changes until you apply and save.</DialogDescription></DialogHeader>
      <label>Units<select aria-label="Conversion units" value={unit} onChange={e => { setUnit(e.target.value); setWidth(''); setPreview(null); }}><option value="imperial">Feet and inches</option><option value="metric">Metres</option></select></label><label>Measured room width<input aria-label="Measured room width" value={width} placeholder={unit === 'metric' ? '9.144' : '30\' 0"'} onChange={e => { setWidth(e.target.value); setPreview(null); }} /></label>
      <Button variant="outline" disabled={disabled || !width.trim()} onClick={() => attempt(() => setPreview(convertLegacyRoom(layout, measurementToMm(width, unit), unit)))}>Preview measurements</Button>
      {error && <p role="alert">{error}</p>}{preview && <><SeatingRoomDrawing layout={preview} roster={roster} /><p>Room height: {formatMeasurement(preview.room.vertices[2].y, unit)}{unit === 'metric' ? ' m' : ''}. Desk edges round to the nearest millimetre without overlapping adjoining desks.</p><Button disabled={disabled} onClick={() => { onChange(() => preview); setConvert(false); }}>Apply measured room</Button></>}
    </DialogContent></Dialog></section>;
  const item = layout.features.find(f => f.id === selectedItem) || layout.seats.find(s => s.id === selectedSeat);
  const collection = layout.features.some(f => f.id === item?.id) ? 'features' : 'seats';
  const walls = roomWalls(layout), opening = item && isOpening(item), warnings = doorSwingWarnings(layout);
  const submitItem = event => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    attempt(() => {
      const patch = opening ? { wallId: String(data.get('wallId')), offset: measurementToMm(data.get('offset'), layout.displayUnit), width: measurementToMm(data.get('width'), layout.displayUnit), hinge: String(data.get('hinge')), swing: String(data.get('swing')) }
        : { x: measurementToMm(data.get('x'), layout.displayUnit), y: measurementToMm(data.get('y'), layout.displayUnit), width: measurementToMm(data.get('width'), layout.displayUnit), height: measurementToMm(data.get('height'), layout.displayUnit), rotation: Number(data.get('rotation')) };
      if (collection === 'features') patch.label = String(data.get('label') || '').trim();
      const next = changeRoomItem(layout, collection, item.id, patch); onChange(() => next);
    });
  };
  return <section className="seating-room-tools"><h2>Room and fixtures</h2><label>Display units<select aria-label="Display units" disabled={disabled} value={layout.displayUnit} onChange={e => onChange(old => ({ ...old, displayUnit: e.target.value }))}><option value="imperial">Feet and inches</option><option value="metric">Metres</option></select></label>
    <label>Classroom front<select aria-label="Classroom front" disabled={disabled} value={layout.room.frontWallId} onChange={e => onChange(old => ({ ...old, room: { ...old.room, frontWallId: e.target.value } }))}>{walls.map((wall, i) => <option key={wall.id} value={wall.id}>Wall {i + 1}</option>)}</select></label>
    <Button variant="outline" disabled={disabled} onClick={() => setOutline(true)}>Edit room outline</Button>
    <label>Fixture type<select aria-label="Fixture type" disabled={disabled} value={kind} onChange={e => setKind(e.target.value)}>{Object.entries(FEATURE_LABELS).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>
    <Button variant="outline" disabled={disabled || layout.features.length >= 100} onClick={() => attempt(() => { const next = addRoomFeature(layout, kind); onChange(() => next); onSelectItem(next.features.at(-1).id); })}>Add fixture</Button>
    <label>Selected fixture<select aria-label="Selected fixture" value={layout.features.some(f => f.id === selectedItem) ? selectedItem : ''} onChange={e => onSelectItem(e.target.value || null)}><option value="">Choose a fixture</option>{layout.features.map((f, i) => <option key={f.id} value={f.id}>{i + 1}. {f.label || FEATURE_LABELS[f.kind]}</option>)}</select></label>
    {item && <form key={JSON.stringify(item) + layout.displayUnit} onSubmit={submitItem} className="seating-geometry-form"><h3>{collection === 'seats' ? 'Desk dimensions' : FEATURE_LABELS[item.kind]}</h3><p>{layout.displayUnit === 'metric' ? 'Lengths in metres.' : 'Lengths in feet and inches (for example 2\' 6").'}</p><fieldset disabled={disabled}>
      {collection === 'features' && <label>Fixture label<input name="label" aria-label="Fixture label" maxLength={60} defaultValue={item.label || ''} /></label>}
      {opening ? <><label>Opening wall<select name="wallId" aria-label="Opening wall" defaultValue={item.wallId}>{walls.map((w, i) => <option key={w.id} value={w.id}>Wall {i + 1} ({formatMeasurement(w.length, layout.displayUnit)})</option>)}</select></label><LengthField name="offset" label="Offset from wall start" value={item.offset} unit={layout.displayUnit} /></> : <><LengthField name="x" label="Object X" value={item.x} unit={layout.displayUnit} /><LengthField name="y" label="Object Y" value={item.y} unit={layout.displayUnit} /></>}
      <LengthField name="width" label="Object width" value={item.width} unit={layout.displayUnit} />
      {opening ? <><label>Hinge<select name="hinge" aria-label="Hinge" defaultValue={item.hinge}><option value="start">Wall start side</option><option value="end">Wall end side</option></select></label><label>Swing<select name="swing" aria-label="Swing" defaultValue={item.swing}><option value="in">Into the room</option><option value="out">Out of the room</option></select></label></> : <><LengthField name="height" label="Object depth" value={item.height} unit={layout.displayUnit} /><label>Rotation (degrees)<input name="rotation" aria-label="Rotation (degrees)" type="number" min="0" max="359.9" step="0.1" defaultValue={item.rotation} required /></label></>}
      <Button type="submit" variant="outline">Apply dimensions</Button>{collection === 'features' && <Button type="button" variant="ghost" onClick={() => { onChange(old => ({ ...old, features: old.features.filter(f => f.id !== item.id) })); onSelectItem(null); }}>Remove fixture</Button>}
    </fieldset></form>}
    {error && <p role="alert" className="seating-error">{error}</p>}{warnings.length > 0 && <div role="status" className="seating-swing-warning"><strong>Check door clearance</strong><p>{warnings.length} door swing{warnings.length > 1 ? 's meet' : ' meets'} a desk, fixture or another room edge. Saving is allowed; review the dashed swing area.</p></div>}
    <Dialog open={outline} onOpenChange={setOutline}><DialogContent className="seating-room-dialog"><DialogHeader><DialogTitle>Edit room outline</DialogTitle><DialogDescription>One closed room, including angled walls. Corners follow the room perimeter in order. The full room and all furniture must fit within 50 metres in each direction. Add a corner on a wall, then set its measured coordinates.</DialogDescription></DialogHeader>
      <SeatingRoomDrawing layout={layout} roster={[]} showCorners onItem={onSelectItem} selectedItem={selectedItem} />
      <form key={JSON.stringify(layout.room) + layout.displayUnit} onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); attempt(() => { const vertices = layout.room.vertices.map(v => ({ ...v, x: measurementToMm(data.get(`${v.id}-x`), layout.displayUnit), y: measurementToMm(data.get(`${v.id}-y`), layout.displayUnit) })); const next = checkMeasured({ ...layout, room: { ...layout.room, vertices } }); onChange(() => next); }); }}>
        <fieldset disabled={disabled}><div className="seating-corner-list">{layout.room.vertices.map((v, i) => <div key={v.id} className="seating-corner-row"><span>Corner {i + 1}</span><LengthField name={`${v.id}-x`} label={`Corner ${i + 1} X`} value={v.x} unit={layout.displayUnit} /><LengthField name={`${v.id}-y`} label={`Corner ${i + 1} Y`} value={v.y} unit={layout.displayUnit} /><Button type="button" variant="ghost" disabled={layout.room.vertices.length <= 3} onClick={() => attempt(() => onChange(() => removeRoomCorner(layout, v.id)))}>Remove corner {i + 1}</Button><Button type="button" variant="outline" disabled={layout.room.vertices.length >= 24} onClick={() => attempt(() => onChange(() => splitRoomWall(layout, v.wallId)))}>Split wall {i + 1}</Button></div>)}</div><Button type="submit">Apply outline</Button></fieldset>
      </form>{error && <p role="alert" className="seating-error">{error}</p>}<Button variant="outline" onClick={() => setOutline(false)}>Done</Button>
    </DialogContent></Dialog>
  </section>;
}
