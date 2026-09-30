// Pure School Library rules for Flight Paths and Block Lists. No database or
// request access lives here: storage and routes load rows, and these helpers
// decide who may see, change, publish or copy them and shape what is returned.
import type {
  BlockList,
  FlightPath,
  InsertBlockList,
  InsertFlightPath,
} from "../schema/classpilot.js";
import type { AllowedResource } from "./restrictionResources.js";

export type TeachingResourceVisibility = "private" | "school";

export const TEACHING_RESOURCE_VISIBILITIES: readonly TeachingResourceVisibility[] = ["private", "school"];

/** The publication columns shared by flight_paths and block_lists. */
export type TeachingResourcePublication = {
  teacherId: string | null;
  visibility: string;
  official: boolean;
};

/** The authenticated caller, reduced to what the library rules need. */
export type TeachingResourceViewer = {
  actorId: string;
  /** admin or school_admin in the selected school (super admins included). */
  isAdmin: boolean;
};

/** A viewer that can also be written to the audit log. */
export type TeachingResourceActor = TeachingResourceViewer & {
  userEmail?: string | null;
  userRole?: string | null;
};

export type TeachingResourcePermissions = {
  canEdit: boolean;
  canShare: boolean;
  canMarkOfficial: boolean;
};

/** Listed in the School Library: shared with the school, or made official. */
export function isPublishedTeachingResource(row: TeachingResourcePublication): boolean {
  return row.visibility === "school" || row.official === true;
}

export function isTeachingResourceOwner(row: TeachingResourcePublication, actorId: string): boolean {
  return row.teacherId !== null && row.teacherId === actorId;
}

/**
 * Same-school members may use (apply, preview, copy) their own items and every
 * published item. Callers pass only rows already scoped to the caller's school.
 */
export function canViewSharedResource(row: TeachingResourcePublication, actorId: string): boolean {
  return isTeachingResourceOwner(row, actorId) || isPublishedTeachingResource(row);
}

/**
 * Content edits and deletes. Administrators may change any item in their
 * school (today's contract). An owner may change their own item unless an
 * administrator made it official. Ownerless items (staff offboarding) are
 * administrator-only.
 */
export function canEditSharedResource(row: TeachingResourcePublication, viewer: TeachingResourceViewer): boolean {
  if (viewer.isAdmin) return true;
  return isTeachingResourceOwner(row, viewer.actorId) && row.official !== true;
}

/**
 * Sharing is the owner's decision: an administrator never publishes a
 * teacher's private item. A non-administrator owner cannot change an official
 * item. For an ownerless item an administrator may only stop sharing it.
 */
export function canChangeSharedResourceVisibility(
  row: TeachingResourcePublication,
  viewer: TeachingResourceViewer,
  next: TeachingResourceVisibility,
): boolean {
  if (isTeachingResourceOwner(row, viewer.actorId)) return viewer.isAdmin || row.official !== true;
  return viewer.isAdmin && row.teacherId === null && next === "private";
}

/**
 * Official marking is administrator-only, and only on items the owner already
 * shared with the school or that the acting administrator owns. Removing the
 * official mark is always allowed for an administrator.
 */
export function canMarkSharedResourceOfficial(
  row: TeachingResourcePublication,
  viewer: TeachingResourceViewer,
  next: boolean,
): boolean {
  if (!viewer.isAdmin) return false;
  if (!next) return true;
  return row.visibility === "school" || isTeachingResourceOwner(row, viewer.actorId);
}

export function teachingResourcePermissions(
  row: TeachingResourcePublication,
  viewer: TeachingResourceViewer,
): TeachingResourcePermissions {
  const nextVisibility: TeachingResourceVisibility = row.visibility === "school" ? "private" : "school";
  return {
    canEdit: canEditSharedResource(row, viewer),
    canShare: canChangeSharedResourceVisibility(row, viewer, nextVisibility),
    canMarkOfficial: canMarkSharedResourceOfficial(row, viewer, !row.official),
  };
}

/**
 * PATCH and DELETE of a published item, or of someone else's item, are
 * privileged changes and must be audited before success is reported.
 */
export function teachingResourceChangeRequiresStrictAudit(
  row: TeachingResourcePublication,
  actorId: string,
): boolean {
  return isPublishedTeachingResource(row) || !isTeachingResourceOwner(row, actorId);
}

/**
 * Next publication metadata for a visibility or official change.
 * publishedAt/publishedBy record the most recent act that put the item in the
 * School Library; both clear when it leaves the library.
 */
export function nextTeachingResourcePublication(
  current: TeachingResourcePublication & { publishedAt: Date | null; publishedBy: string | null },
  change: { visibility?: TeachingResourceVisibility; official?: boolean },
  actorId: string,
  now: Date,
): { visibility: TeachingResourceVisibility; official: boolean; publishedAt: Date | null; publishedBy: string | null } {
  const visibility = change.visibility ?? (current.visibility === "school" ? "school" : "private");
  const official = change.official ?? current.official === true;
  if (visibility !== "school" && !official) {
    return { visibility, official, publishedAt: null, publishedBy: null };
  }
  const newlyShared = visibility === "school" && current.visibility !== "school";
  const newlyOfficial = official && current.official !== true;
  if (newlyShared || newlyOfficial) {
    return { visibility, official, publishedAt: now, publishedBy: actorId };
  }
  return { visibility, official, publishedAt: current.publishedAt, publishedBy: current.publishedBy };
}

/** "Name", then "Name (copy)", "Name (copy 2)" … among the new owner's items. */
export function copyNameForTeachingResource(name: string, existingNames: Iterable<string>): string {
  const taken = new Set(existingNames);
  if (!taken.has(name)) return name;
  const first = `${name} (copy)`;
  if (!taken.has(first)) return first;
  for (let index = 2; ; index += 1) {
    const candidate = `${name} (copy ${index})`;
    if (!taken.has(candidate)) return candidate;
  }
}

type CopyOwner = {
  schoolId: string;
  teacherId: string;
  /** Names the new owner already uses for this resource type. */
  existingNames: Iterable<string>;
};

/**
 * A copy is a new private item owned by the copier. It carries the rules and
 * description only: the source's Classroom provenance (course and resource
 * ids) belongs to the original owner and is never copied, and the copy starts
 * unpublished and not official.
 */
export function cloneFlightPathInsert(source: FlightPath, owner: CopyOwner): InsertFlightPath {
  return {
    schoolId: owner.schoolId,
    teacherId: owner.teacherId,
    flightPathName: copyNameForTeachingResource(source.flightPathName, owner.existingNames),
    description: source.description ?? null,
    allowedDomains: [...(source.allowedDomains ?? [])],
    // Precise entries travel with the copy verbatim, whatever the school's
    // rollout state: they are re-validated when the copy is applied.
    resources: [...(source.resources ?? [])],
    blockedDomains: [...(source.blockedDomains ?? [])],
    isDefault: false,
    sourceType: null,
    sourceCourseId: null,
    sourceResourceIds: [],
    sourceUpdatedAt: null,
    visibility: "private",
    official: false,
    publishedAt: null,
    publishedBy: null,
  };
}

export function cloneBlockListInsert(source: BlockList, owner: CopyOwner): InsertBlockList {
  return {
    schoolId: owner.schoolId,
    teacherId: owner.teacherId,
    name: copyNameForTeachingResource(source.name, owner.existingNames),
    description: source.description ?? null,
    blockedDomains: [...(source.blockedDomains ?? [])],
    isDefault: false,
    visibility: "private",
    official: false,
    publishedAt: null,
    publishedBy: null,
  };
}

const PUBLICATION_KEYS = ["visibility", "official", "publishedAt", "publishedBy"] as const;

/**
 * With the School Library off, every response keeps its previous shape: the
 * publication columns are removed so nothing new reaches the client.
 */
export function withoutTeachingResourcePublication<
  Row extends { visibility?: unknown; official?: unknown; publishedAt?: unknown; publishedBy?: unknown },
>(
  row: Row,
): Omit<Row, (typeof PUBLICATION_KEYS)[number]> {
  const {
    visibility: _visibility,
    official: _official,
    publishedAt: _publishedAt,
    publishedBy: _publishedBy,
    ...legacy
  } = row;
  return legacy;
}

/**
 * An item as its owner, or an administrator, sees it: the stored row plus the
 * caller's permissions. published_by (a user id) is never returned.
 */
export function ownedTeachingResourceView<Row extends TeachingResourcePublication & { publishedBy?: string | null }>(
  row: Row,
  viewer: TeachingResourceViewer,
): Omit<Row, "publishedBy"> & TeachingResourcePermissions {
  const { publishedBy: _publishedBy, ...rest } = row;
  return { ...rest, ...teachingResourcePermissions(row, viewer) };
}

export type LibraryFlightPathView = {
  id: string;
  flightPathName: string;
  description: string | null;
  allowedDomains: string[];
  /** Precise section/resource entries; routes omit an empty list while the capability is off. */
  resources: AllowedResource[];
  blockedDomains: string[];
  visibility: TeachingResourceVisibility;
  official: boolean;
  publishedAt: Date | null;
  createdAt: Date;
  ownerName: string | null;
} & TeachingResourcePermissions;

export type LibraryBlockListView = {
  id: string;
  name: string;
  description: string | null;
  blockedDomains: string[];
  visibility: TeachingResourceVisibility;
  official: boolean;
  publishedAt: Date | null;
  createdAt: Date;
  ownerName: string | null;
} & TeachingResourcePermissions;

function visibilityValue(value: string): TeachingResourceVisibility {
  return value === "school" ? "school" : "private";
}

/**
 * An item as another same-school member sees it in the School Library. The
 * owner's Classroom provenance (source_*), owner id and publisher id are left
 * out; ownerName is null unless the owner is an active member of this school.
 */
export function libraryFlightPathView(
  row: FlightPath,
  ownerName: string | null,
  viewer: TeachingResourceViewer,
): LibraryFlightPathView {
  return {
    id: row.id,
    flightPathName: row.flightPathName,
    description: row.description ?? null,
    allowedDomains: [...(row.allowedDomains ?? [])],
    resources: [...(row.resources ?? [])],
    blockedDomains: [...(row.blockedDomains ?? [])],
    visibility: visibilityValue(row.visibility),
    official: row.official === true,
    publishedAt: row.publishedAt ?? null,
    createdAt: row.createdAt,
    ownerName,
    ...teachingResourcePermissions(row, viewer),
  };
}

export function libraryBlockListView(
  row: BlockList,
  ownerName: string | null,
  viewer: TeachingResourceViewer,
): LibraryBlockListView {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    blockedDomains: [...(row.blockedDomains ?? [])],
    visibility: visibilityValue(row.visibility),
    official: row.official === true,
    publishedAt: row.publishedAt ?? null,
    createdAt: row.createdAt,
    ownerName,
    ...teachingResourcePermissions(row, viewer),
  };
}

/** Display name for an owner who is an active member of the school, else null. */
export function teachingResourceOwnerName(owner: {
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
} | null | undefined): string | null {
  if (!owner) return null;
  const name = owner.displayName?.trim()
    || [owner.firstName, owner.lastName].map((part) => part?.trim()).filter(Boolean).join(" ");
  return name || null;
}
