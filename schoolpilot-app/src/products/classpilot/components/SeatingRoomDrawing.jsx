import { FEATURE_LABELS, measuredBounds, rectangleCorners, openingGeometry, isOpening, roomWalls, formatMeasurement } from '../lib/seatingMeasuredModel';

const points = items => items.map(p => `${p.x},${p.y}`).join(' ');
export function RoomContents({ layout, roster = [], selectedSeat, selectedItem, onSeat, onItem, onDrag, onKey, showCorners = false }) {
  const names = new Map(roster.map(student => [student.id, student.name]));
  const bounds = measuredBounds(layout), line = Math.max(12, bounds.width / 600), labelSize = Math.max(70, bounds.width / 95);
  return <>
    <polygon points={points(layout.room.vertices)} fill="var(--seating-room-fill, #faf9f6)" stroke="#666" strokeWidth={line} />
    {roomWalls(layout).map((wall, index) => <g key={wall.id}>
      {wall.id === layout.room.frontWallId && <><line x1={wall.start.x} y1={wall.start.y} x2={wall.end.x} y2={wall.end.y} stroke="#245b64" strokeWidth={line * 3} /><text x={(wall.start.x + wall.end.x) / 2} y={(wall.start.y + wall.end.y) / 2 + labelSize * 1.5} fontSize={labelSize} textAnchor="middle" fill="#245b64">Front</text></>}
      <title>Wall {index + 1}: {formatMeasurement(wall.length, layout.displayUnit)}{layout.displayUnit === 'metric' ? ' m' : ''}</title>
    </g>)}
    {layout.features.map(feature => {
      const label = feature.label || FEATURE_LABELS[feature.kind], active = selectedItem === feature.id;
      const events = onItem ? { role: 'button', tabIndex: 0, 'aria-label': label, 'aria-pressed': active,
        onClick: () => onItem(feature.id), onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onItem(feature.id); } onKey?.(event, feature, 'features'); } } : {};
      if (isOpening(feature)) {
        const geometry = openingGeometry(layout, feature); if (!geometry) return null;
        return <g key={feature.id} {...events} className={onItem ? 'seating-svg-item' : undefined}>
          <title>{label}</title><line x1={geometry.start.x} y1={geometry.start.y} x2={geometry.end.x} y2={geometry.end.y} stroke={active ? '#b0502e' : feature.kind === 'window' ? '#337eb0' : '#fff'} strokeWidth={line * 5} />
          {feature.kind === 'door' ? <><polyline points={points(geometry.arc)} fill="none" stroke="#976c24" strokeWidth={line} strokeDasharray={`${line * 2} ${line * 2}`} /><line x1={geometry.hinge.x} y1={geometry.hinge.y} x2={geometry.arc.at(-1).x} y2={geometry.arc.at(-1).y} stroke="#976c24" strokeWidth={line * 2} /></> : <line x1={geometry.start.x} y1={geometry.start.y} x2={geometry.end.x} y2={geometry.end.y} stroke="#eee" strokeWidth={line} />}
        </g>;
      }
      return <g key={feature.id} {...events} className={onItem ? 'seating-svg-item' : undefined}>
        <polygon points={points(rectangleCorners(feature))} fill={feature.kind === 'interiorWall' ? '#7d8488' : '#ded6c6'} stroke={active ? '#b0502e' : '#6e6658'} strokeWidth={active ? line * 3 : line} />
        <text x={feature.x + feature.width / 2} y={feature.y + feature.height / 2} textAnchor="middle" dominantBaseline="middle" fontSize={Math.max(20, Math.min(labelSize, feature.width / Math.max(6, label.length) * 1.5))}>{label}</text>
        {onDrag && active && <circle className="seating-svg-handle" onClick={event => event.stopPropagation()} cx={feature.x + feature.width / 2} cy={feature.y + feature.height / 2} r={labelSize * .85} fill="#b0502e" aria-label={`Drag ${label}`} onPointerDown={event => onDrag(event, feature, 'features')} />}
      </g>;
    })}
    {layout.seats.map((seat, index) => {
      const label = names.get(seat.studentId) || 'Empty', active = selectedSeat === seat.id;
      const words = label.match(/.{1,12}(?:\s|$)|.{1,12}/g) || [label];
      const longest = Math.max(...words.map(word => word.trim().length));
      const font = Math.max(1, Math.min(110, seat.width * .85 / (longest * .6), seat.height * .62 / (words.length * 1.15)));
      const events = onSeat ? { role: 'button', tabIndex: 0, 'aria-label': `Seat ${index + 1}, ${label.toLowerCase() === 'empty' ? 'empty' : label}${seat.locked ? ', locked' : ''}`, 'aria-pressed': active,
        onClick: () => onSeat(seat.id), onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSeat(seat.id); } onKey?.(event, seat, 'seats'); } } : {};
      return <g key={seat.id} {...events} className={onSeat ? 'seating-svg-item' : undefined} transform={`rotate(${seat.rotation} ${seat.x + seat.width / 2} ${seat.y + seat.height / 2})`}>
        <rect x={seat.x} y={seat.y} width={seat.width} height={seat.height} rx="20" fill={seat.locked ? '#e4efeb' : '#fff'} stroke={active ? '#b0502e' : '#666'} strokeWidth={active ? line * 3 : line} />
        <text x={seat.x + 30} y={seat.y + 70} fontSize={Math.min(60, seat.height / 5)}>{index + 1}{seat.locked ? ' •' : ''}</text>
        <text x={seat.x + seat.width / 2} y={seat.y + seat.height * .32} textAnchor="middle" fontSize={font}>{words.map((word, at) => <tspan key={at} x={seat.x + seat.width / 2} dy={at ? font * 1.15 : 0}>{word.trim()}</tspan>)}</text>
        {onDrag && active && <circle className="seating-svg-handle" onClick={event => event.stopPropagation()} cx={seat.x + seat.width - 55} cy={seat.y + 55} r="55" fill="#b0502e" aria-label={`Drag desk ${index + 1}`} onPointerDown={event => onDrag(event, seat, 'seats')} />}
      </g>;
    })}
    {showCorners && layout.room.vertices.map((vertex, i) => <g key={vertex.id} role="button" tabIndex={0} aria-label={`Room corner ${i + 1}`} aria-pressed={selectedItem === vertex.id} className="seating-svg-item" onClick={() => onItem?.(vertex.id)} onKeyDown={event => { if (event.key === 'Enter') onItem?.(vertex.id); onKey?.(event, vertex, 'vertices'); }}>
      <circle cx={vertex.x} cy={vertex.y} r={labelSize * .7} fill={selectedItem === vertex.id ? '#b0502e' : '#245b64'} onPointerDown={event => onDrag?.(event, vertex, 'vertices')} /><text x={vertex.x} y={vertex.y + labelSize * .25} textAnchor="middle" fontSize={labelSize * .65} fill="white" pointerEvents="none">{i + 1}</text>
    </g>)}
  </>;
}
export default function SeatingRoomDrawing({ layout, roster, ...props }) {
  const bounds = measuredBounds(layout, true);
  return <svg className="seating-room-svg" viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`} role="img" aria-label="Measured classroom floor plan"><RoomContents layout={layout} roster={roster} {...props} /></svg>;
}
