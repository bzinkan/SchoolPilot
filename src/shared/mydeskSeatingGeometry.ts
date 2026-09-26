/** Pure geometry shared by the API and browser. All measured coordinates are integer millimetres. */
export type Point = { x: number; y: number };
export type RoomVertex = Point & { id: string; wallId: string };
export type MeasuredRect = Point & { id: string; width: number; height: number; rotation: number };
export type LegacySeat = Point & { id: string; studentId: string | null; locked: boolean };
export type MeasuredSeat = MeasuredRect & { studentId: string | null; locked: boolean };
export type SolidFeature = MeasuredRect & { kind: "teacherDesk" | "cabinet" | "lockers" | "interiorWall"; label?: string };
export type WallOpening = { id: string; kind: "door" | "window"; wallId: string; offset: number; width: number; hinge: "start" | "end"; swing: "in" | "out"; label?: string };
export type MeasuredLayout = { version: 2; units: "mm"; displayUnit: "imperial" | "metric";
  room: { vertices: RoomVertex[]; frontWallId: string }; seats: MeasuredSeat[]; features: (SolidFeature | WallOpening)[] };
export type SeatingLayoutGeometry = { version: 1; seats: LegacySeat[] } | MeasuredLayout;
const EPS = 1e-7;
export const isOpening = (feature: SolidFeature | WallOpening): feature is WallOpening => feature.kind === "door" || feature.kind === "window";
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const onSegment = (p: Point, a: Point, b: Point) => Math.abs(cross(a, b, p)) < EPS && p.x >= Math.min(a.x, b.x) - EPS && p.x <= Math.max(a.x, b.x) + EPS && p.y >= Math.min(a.y, b.y) - EPS && p.y <= Math.max(a.y, b.y) + EPS;
export function signedArea(points: Point[]) { return points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]!; return sum + p.x * q.y - q.x * p.y; }, 0) / 2; }
export function pointInPolygon(point: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!;
    if (onSegment(point, a, b)) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function intersects(a: Point, b: Point, c: Point, d: Point) {
  const ac = cross(a, b, c), ad = cross(a, b, d), ca = cross(c, d, a), cb = cross(c, d, b);
  return (ac * ad < -EPS && ca * cb < -EPS) || onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b);
}
export function polygonProblem(points: Point[]): string | null {
  if (points.length < 3 || points.length > 24) return "A room needs 3 to 24 corners.";
  if (points.some(p => !Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 0 || p.y < 0 || p.x > 50000 || p.y > 50000)) return "Room corners must be within a 50 metre footprint.";
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!, before = points[(i + points.length - 1) % points.length]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 10) return "Each wall must be at least 10 mm long.";
    if (Math.abs(cross(before, a, b)) < EPS && ((a.x - before.x) * (b.x - a.x) + (a.y - before.y) * (b.y - a.y)) < 0) return "Walls cannot double back.";
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      if (intersects(a, b, points[j]!, points[(j + 1) % points.length]!)) return "Room walls cannot cross or touch another corner.";
    }
  }
  return Math.abs(signedArea(points)) < 10000 ? "The room must enclose at least 0.01 square metres." : null;
}
export function rectangleCorners(rect: MeasuredRect): Point[] {
  const radians = rect.rotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const x = sx! * rect.width / 2, y = sy! * rect.height / 2;
    return { x: rect.x + rect.width / 2 + x * cos - y * sin, y: rect.y + rect.height / 2 + x * sin + y * cos };
  });
}
/** SAT for convex footprints: touching edges are allowed, positive-area overlap is not. */
export function convexOverlap(a: Point[], b: Point[]) {
  for (const polygon of [a, b]) for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i]!, q = polygon[(i + 1) % polygon.length]!, axis = { x: p.y - q.y, y: q.x - p.x };
    const ap = a.map(v => v.x * axis.x + v.y * axis.y), bp = b.map(v => v.x * axis.x + v.y * axis.y);
    if (Math.max(...ap) <= Math.min(...bp) + EPS || Math.max(...bp) <= Math.min(...ap) + EPS) return false;
  }
  return true;
}
/** Splitting every footprint edge at boundary crossings catches concave notches even when all corners are inside. */
export function footprintInside(footprint: Point[], room: Point[]) {
  if (!footprint.every(p => pointInPolygon(p, room))) return false;
  for (let i = 0; i < footprint.length; i++) {
    const a = footprint[i]!, b = footprint[(i + 1) % footprint.length]!, dx = b.x - a.x, dy = b.y - a.y;
    const cuts = [0, 1];
    for (let j = 0; j < room.length; j++) {
      const c = room[j]!, d = room[(j + 1) % room.length]!, ex = d.x - c.x, ey = d.y - c.y;
      const denominator = dx * ey - dy * ex;
      if (Math.abs(denominator) > EPS) {
        const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / denominator;
        const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / denominator;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
      } else {
        for (const p of [c, d]) if (onSegment(p, a, b)) cuts.push(Math.abs(dx) > Math.abs(dy) ? (p.x - a.x) / dx : (p.y - a.y) / dy);
      }
    }
    cuts.sort((x, y) => x - y);
    for (let j = 1; j < cuts.length; j++) {
      const t = (cuts[j - 1]! + cuts[j]!) / 2;
      if (!pointInPolygon({ x: a.x + dx * t, y: a.y + dy * t }, room)) return false;
    }
  }
  return true;
}
export function roomWalls(layout: MeasuredLayout) {
  return layout.room.vertices.map((start, i) => { const end = layout.room.vertices[(i + 1) % layout.room.vertices.length]!; return { id: start.wallId, start, end, length: Math.hypot(end.x - start.x, end.y - start.y) }; });
}
export function openingGeometry(layout: MeasuredLayout, opening: WallOpening) {
  const wall = roomWalls(layout).find(item => item.id === opening.wallId);
  if (!wall) return null;
  const ux = (wall.end.x - wall.start.x) / wall.length, uy = (wall.end.y - wall.start.y) / wall.length;
  const start = { x: wall.start.x + ux * opening.offset, y: wall.start.y + uy * opening.offset };
  const end = { x: start.x + ux * opening.width, y: start.y + uy * opening.width };
  const hinge = opening.hinge === "start" ? start : end, closed = opening.hinge === "start" ? end : start;
  const direction = (signedArea(layout.room.vertices) > 0 ? 1 : -1) * (opening.swing === "in" ? 1 : -1) * (opening.hinge === "start" ? 1 : -1);
  const initial = Math.atan2(closed.y - hinge.y, closed.x - hinge.x);
  const arc = Array.from({ length: 25 }, (_, i) => ({ x: hinge.x + Math.cos(initial + direction * Math.PI / 2 * i / 24) * opening.width, y: hinge.y + Math.sin(initial + direction * Math.PI / 2 * i / 24) * opening.width }));
  return { start, end, hinge, arc, sweep: [hinge, ...arc] };
}
export function measuredLayoutProblem(layout: MeasuredLayout): string | null {
  const polygonError = polygonProblem(layout.room.vertices); if (polygonError) return polygonError;
  const allIds = [...layout.room.vertices.flatMap(v => [v.id, v.wallId]), ...layout.seats.map(s => s.id), ...layout.features.map(f => f.id)];
  if (new Set(allIds).size !== allIds.length) return "Every corner, wall, desk and fixture needs a unique ID.";
  const walls = roomWalls(layout);
  if (!walls.some(w => w.id === layout.room.frontWallId)) return "Choose a classroom front wall.";
  const solids = [...layout.seats, ...layout.features.filter((f): f is SolidFeature => !isOpening(f))];
  const footprints = solids.map(rectangleCorners);
  for (let i = 0; i < solids.length; i++) {
    if (!footprintInside(footprints[i]!, layout.room.vertices)) return "Keep the whole desk or fixture inside the room.";
    if (footprints.slice(0, i).some(other => convexOverlap(other, footprints[i]!))) return "Desks and solid fixtures cannot overlap.";
  }
  const openings = layout.features.filter(isOpening);
  for (let i = 0; i < openings.length; i++) {
    const item = openings[i]!, wall = walls.find(w => w.id === item.wallId);
    if (!wall || item.offset + item.width > wall.length + EPS) return "Doors and windows must fit completely on their selected wall.";
    if (openings.slice(0, i).some(other => other.wallId === item.wallId && item.offset < other.offset + other.width && item.offset + item.width > other.offset)) return "Wall openings cannot overlap.";
  }
  return null;
}
export function doorSwingWarnings(layout: MeasuredLayout) {
  const solids = [...layout.seats, ...layout.features.filter((f): f is SolidFeature => !isOpening(f))];
  return layout.features.filter(isOpening).filter(f => f.kind === "door").flatMap(door => {
    const geometry = openingGeometry(layout, door); if (!geometry) return [];
    const blocked = solids.filter(s => convexOverlap(geometry.sweep, rectangleCorners(s))).map(s => s.id);
    const crossesRoom = door.swing === "in" && !footprintInside(geometry.sweep, layout.room.vertices);
    return blocked.length || crossesRoom ? [{ doorId: door.id, obstacleIds: blocked, crossesRoom }] : [];
  });
}
export function copySeatingGeometry<T extends SeatingLayoutGeometry>(layout: T, newId: () => string, clearStudents = false): T {
  const copy = structuredClone(layout);
  copy.seats = copy.seats.map(seat => ({ ...seat, id: newId(), ...(clearStudents ? { studentId: null, locked: false } : {}) }));
  if (copy.version === 2) {
    const walls = new Map(copy.room.vertices.map(v => [v.wallId, newId()]));
    copy.room.vertices = copy.room.vertices.map(v => ({ ...v, id: newId(), wallId: walls.get(v.wallId)! }));
    copy.room.frontWallId = walls.get(copy.room.frontWallId)!;
    copy.features = copy.features.map(f => ({ ...f, id: newId(), ...(isOpening(f) ? { wallId: walls.get(f.wallId)! } : {}) }));
  }
  return copy;
}
