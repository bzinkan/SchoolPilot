import { measuredLayoutProblem, rectangleCorners, footprintInside, convexOverlap, isOpening, roomWalls } from '../../../../../src/shared/mydeskSeatingGeometry.ts';
export { doorSwingWarnings, rectangleCorners, openingGeometry, roomWalls, isOpening } from '../../../../../src/shared/mydeskSeatingGeometry.ts';
const uuid = () => crypto.randomUUID();
export const FEATURE_LABELS = { teacherDesk: 'Teacher desk', cabinet: 'Cabinet', lockers: 'Lockers', interiorWall: 'Interior wall', door: 'Door', window: 'Window' };
export function measuredRoom(width, height, displayUnit = 'imperial', idFactory = uuid) {
  if (![width, height].every(n => Number.isInteger(n) && n >= 100 && n <= 50000)) throw new Error('Enter room dimensions between 100 mm and 50 metres.');
  const vertices = [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => ({ id: idFactory(), wallId: idFactory(), x, y }));
  return { version: 2, units: 'mm', displayUnit, room: { vertices, frontWallId: vertices[0].wallId }, seats: [], features: [] };
}
export function checkMeasured(layout) {
  if (layout.seats.length > 100 || layout.features.length > 100) throw new Error('A room supports at most 100 desks and 100 fixtures.');
  for (const item of [...layout.seats, ...layout.features]) {
    if (!Number.isInteger(item.width) || item.width < 10 || item.width > 50000) throw new Error('Widths must be between 10 mm and 50 metres.');
    if (isOpening(item)) {
      if (!Number.isInteger(item.offset) || item.offset < 0) throw new Error('The opening offset cannot be negative.');
    } else if (![item.x, item.y, item.height].every(Number.isInteger) || item.x < 0 || item.y < 0 || item.height < 10 || item.height > 50000 || !Number.isFinite(item.rotation) || item.rotation < 0 || item.rotation >= 360 || Math.abs(item.rotation * 10 - Math.round(item.rotation * 10)) > 1e-6) {
      throw new Error('Use dimensions of at least 10 mm and a rotation from 0 to 359.9 degrees.');
    }
  }
  const error = measuredLayoutProblem(layout); if (error) throw new Error(error); return layout;
}
export function measuredBounds(layout, includeSwings = false) {
  const points = layout.room.vertices;
  const padding = includeSwings ? Math.max(200, ...layout.features.filter(f => f.kind === 'door' && f.swing === 'out').map(f => f.width)) : 200;
  const x = Math.min(...points.map(p => p.x)) - padding, y = Math.min(...points.map(p => p.y)) - padding;
  return { x, y, width: Math.max(...points.map(p => p.x)) - x + padding, height: Math.max(...points.map(p => p.y)) - y + padding };
}
export function measurementToMm(value, unit) {
  const text = String(value).trim();
  if (unit === 'metric') {
    if (!/^\d+(?:\.\d{1,3})?$/.test(text)) throw new Error('Enter metres, for example 8.5.');
    return Math.round(Number(text) * 1000);
  }
  // Explicit feet and inches, or a decimal feet value. Fractions can be entered as decimal inches.
  const parts = text.match(/^(\d+)\s*(?:ft|')\s*(?:(\d+(?:\.\d+)?)\s*(?:in|"))?$/i);
  if (parts) return Math.round(Number(parts[1]) * 304.8 + Number(parts[2] || 0) * 25.4);
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 304.8);
  throw new Error('Enter feet and inches, for example 12\' 6", or decimal feet.');
}
export function formatMeasurement(mm, unit) {
  if (unit === 'metric') return String(Number((mm / 1000).toFixed(3)));
  const inches = Math.round(mm / 25.4 * 100) / 100, feet = Math.floor(inches / 12);
  return `${feet}' ${Number((inches - feet * 12).toFixed(2))}"`;
}
/** Quantize the same edges once: adjoining legacy desks retain their shared edge after conversion. */
export function convertLegacyRoom(layout, widthMm, displayUnit = 'imperial', idFactory = uuid) {
  if (layout.version !== 1) throw new Error('This room already has measurements.');
  const scale = widthMm / 1200;
  const edge = value => Math.round(value * scale);
  const next = measuredRoom(widthMm, edge(900), displayUnit, idFactory);
  next.seats = layout.seats.map(s => ({ ...s, x: edge(s.x), y: edge(s.y), width: edge(s.x + 100) - edge(s.x), height: edge(s.y + 60) - edge(s.y), rotation: 0 }));
  if (next.seats.some(s => s.width < 10 || s.height < 10)) throw new Error('That room measurement would make a desk smaller than 10 mm. Check the full canvas width.');
  return checkMeasured(next);
}
export function fitsMeasured(layout, rect, existing = layout.seats) {
  const polygon = rectangleCorners(rect);
  return footprintInside(polygon, layout.room.vertices) && ![...existing, ...layout.features.filter(f => !isOpening(f))].some(other => convexOverlap(polygon, rectangleCorners(other)));
}
/** Bounded search: 100 mm placement lattice, plus obstacle edges, at most 251k positions. */
export function findMeasuredSpace(layout, rect, existing = layout.seats) {
  const bounds = measuredBounds(layout), maxX = bounds.x + bounds.width - 200, maxY = bounds.y + bounds.height - 200;
  const xs = new Set([0]), ys = new Set([0]);
  for (let x = 0; x <= maxX - rect.width; x += Math.max(100, rect.width)) xs.add(x);
  for (let y = 0; y <= maxY - rect.height; y += Math.max(100, rect.height)) ys.add(y);
  for (const item of [...existing, ...layout.features.filter(f => !isOpening(f))]) {
    const corners = rectangleCorners(item); xs.add(Math.ceil(Math.max(...corners.map(p => p.x)))); ys.add(Math.ceil(Math.max(...corners.map(p => p.y))));
  }
  for (const y of [...ys].sort((a, b) => a - b)) for (const x of [...xs].sort((a, b) => a - b)) if (fitsMeasured(layout, { ...rect, x, y }, existing)) return { x, y };
  return null;
}
export function arrangeMeasured(layout, preset, count, idFactory = uuid) {
  if (layout.seats.some(s => s.locked)) throw new Error('Unlock all seats before replacing the layout.');
  if (preset === 'blank') return { ...structuredClone(layout), seats: [] };
  if (!['rows', 'pairs', 'groups'].includes(preset) || !Number.isInteger(count) || count < 0 || count > 100) throw new Error('A chart supports at most 100 desks.');
  const next = { ...structuredClone(layout), seats: [] };
  // Pack whole pairs/groups around obstacles rather than silently falling back to rows.
  const groupSize = preset === 'groups' ? 4 : preset === 'pairs' ? 2 : 1;
  for (let index = 0; index < count; index += groupSize) {
    const actual = Math.min(groupSize, count - index), columns = Math.min(2, actual);
    const block = { id: 'placement', width: (preset === 'rows' ? 600 : columns * 600), height: preset === 'groups' && actual > 2 ? 900 : 450, rotation: 0 };
    const position = findMeasuredSpace(next, block);
    if (!position) throw new Error(`This ${preset} arrangement cannot fit all ${count} desks around the room fixtures. Your current layout is unchanged.`);
    for (let seat = 0; seat < actual; seat++) next.seats.push({ id: idFactory(), x: position.x + (seat % columns) * 600, y: position.y + Math.floor(seat / columns) * 450, width: 600, height: 450, rotation: 0, studentId: null, locked: false });
  }
  return checkMeasured(next);
}
export function addRoomFeature(layout, kind, idFactory = uuid) {
  if (layout.features.length >= 100) throw new Error('A room can have at most 100 fixtures.');
  if (!FEATURE_LABELS[kind]) throw new Error('Choose a fixture type.');
  let feature;
  if (kind === 'door' || kind === 'window') {
    for (const wall of roomWalls(layout)) {
      const openings = layout.features.filter(f => isOpening(f) && f.wallId === wall.id).sort((a, b) => a.offset - b.offset);
      let offset = 0;
      for (const open of openings) { if (offset + 900 <= open.offset) break; offset = open.offset + open.width; }
      if (offset + 900 <= wall.length) { feature = { id: idFactory(), kind, wallId: wall.id, offset, width: 900, hinge: 'start', swing: 'in' }; break; }
    }
  } else {
    const shape = { id: idFactory(), kind, width: kind === 'interiorWall' ? 2000 : 1200, height: kind === 'interiorWall' ? 100 : kind === 'lockers' ? 450 : 600, rotation: 0 };
    const position = findMeasuredSpace(layout, shape); if (position) feature = { ...shape, ...position };
  }
  if (!feature) throw new Error('No free space was found for this fixture. Move existing objects first.');
  return checkMeasured({ ...structuredClone(layout), features: [...layout.features, feature] });
}
export function changeRoomItem(layout, collection, id, patch) {
  const next = structuredClone(layout), items = collection === 'vertices' ? next.room.vertices : next[collection];
  const item = items.find(entry => entry.id === id); if (!item) throw new Error('Select a room item first.');
  Object.assign(item, patch); return checkMeasured(next);
}
export function splitRoomWall(layout, wallId, idFactory = uuid) {
  if (layout.room.vertices.length >= 24) throw new Error('A room can have at most 24 corners.');
  const next = structuredClone(layout), index = next.room.vertices.findIndex(v => v.wallId === wallId), a = next.room.vertices[index], b = next.room.vertices[(index + 1) % next.room.vertices.length];
  const vertex = { id: idFactory(), wallId: idFactory(), x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) };
  const splitAt = Math.hypot(vertex.x - a.x, vertex.y - a.y);
  for (const f of next.features.filter(f => isOpening(f) && f.wallId === wallId)) {
    if (f.offset < splitAt && f.offset + f.width > splitAt) throw new Error('Move the opening away from the new corner first.');
    if (f.offset >= splitAt) { f.wallId = vertex.wallId; f.offset = Math.round(f.offset - splitAt); }
  }
  next.room.vertices.splice(index + 1, 0, vertex); return checkMeasured(next);
}
export function removeRoomCorner(layout, id) {
  if (layout.room.vertices.length <= 3) throw new Error('A room needs at least three corners.');
  const next = structuredClone(layout), index = next.room.vertices.findIndex(v => v.id === id), vertex = next.room.vertices[index], previous = next.room.vertices[(index + next.room.vertices.length - 1) % next.room.vertices.length];
  if (next.features.some(f => isOpening(f) && [vertex.wallId, previous.wallId].includes(f.wallId))) throw new Error('Remove or move openings on both adjoining walls before removing this corner.');
  if (next.room.frontWallId === vertex.wallId) next.room.frontWallId = previous.wallId;
  next.room.vertices.splice(index, 1); return checkMeasured(next);
}
