import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolveEcsApiRuntimeIdentity,
  type EcsApiRuntimeIdentity,
} from "../services/ecsRuntimeIdentity.js";

export const STAFF_IDENTITY_REPAIR_ACKNOWLEDGEMENT =
  "staff-identity-repair-v1";
export const STAFF_IDENTITY_REPAIR_PRODUCTION_ADMISSION =
  "controlled-ecs-one-off-v1";

const REPORT_VERSION = "classpilot-staff-identity-repair-v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type StaffIdentityRepairCliOptions = {
  help: boolean;
  execute: boolean;
  explicitDryRun: boolean;
  allSchools: boolean;
  schoolId?: string;
  sourceUserId?: string;
  targetUserId?: string;
  expectedRevision?: string;
  expectedProof?: string;
  superAdminActorId?: string;
  acknowledgement?: string;
};

type RepairExecutionEnvironment = {
  STAFF_IDENTITY_REPAIR_EXECUTION_ADMISSION?: string;
};

export async function assertStaffIdentityRepairExecutionAdmission(options: {
  execute: boolean;
  environment?: RepairExecutionEnvironment;
  resolveRuntimeIdentity?: () => Promise<EcsApiRuntimeIdentity | null>;
}): Promise<void> {
  if (!options.execute) return;
  const environment = options.environment ?? process.env;
  if (
    environment.STAFF_IDENTITY_REPAIR_EXECUTION_ADMISSION
    !== STAFF_IDENTITY_REPAIR_PRODUCTION_ADMISSION
  ) {
    throw Object.assign(new Error("Production repair execution is not admitted."), {
      code: "STAFF_IDENTITY_REPAIR_ECS_ONE_OFF_REQUIRED",
    });
  }
  let identity: EcsApiRuntimeIdentity | null;
  try {
    identity = await (options.resolveRuntimeIdentity ?? resolveEcsApiRuntimeIdentity)();
  } catch {
    throw Object.assign(new Error("Production ECS runtime identity could not be verified."), {
      code: "STAFF_IDENTITY_REPAIR_ECS_ONE_OFF_REQUIRED",
    });
  }
  if (!identity) {
    throw Object.assign(new Error("Production repair execution requires ECS task identity."), {
      code: "STAFF_IDENTITY_REPAIR_ECS_ONE_OFF_REQUIRED",
    });
  }
}

function usage(): string {
  return [
    "Usage:",
    "  npm run repair:classpilot-staff-identity -- --all-schools",
    "  npm run repair:classpilot-staff-identity -- --school-id <uuid> --source-user-id <uuid> --target-user-id <uuid>",
    "",
    "Dry-run is the default. All-school mode is always inventory-only.",
    "",
    "Execution additionally requires:",
    "  --execute",
    "  --revision <dry-run-revision>",
    "  --proof <dry-run-proof>",
    "  --super-admin-actor-id <uuid>",
    `  --acknowledge ${STAFF_IDENTITY_REPAIR_ACKNOWLEDGEMENT}`,
    `  ECS task env: STAFF_IDENTITY_REPAIR_EXECUTION_ADMISSION=${STAFF_IDENTITY_REPAIR_PRODUCTION_ADMISSION}`,
    "",
    "Output contains IDs, revisions, and counts only. It never emits staff,",
    "student, school, or class names or email addresses.",
  ].join("\n");
}

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseStaffIdentityRepairCliArgs(
  args: string[]
): StaffIdentityRepairCliOptions {
  const options: StaffIdentityRepairCliOptions = {
    help: false,
    execute: false,
    explicitDryRun: false,
    allSchools: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--execute") options.execute = true;
    else if (argument === "--dry-run") options.explicitDryRun = true;
    else if (argument === "--all-schools") options.allSchools = true;
    else if (argument === "--school-id") {
      options.schoolId = valueAfter(args, index, argument);
      index += 1;
    } else if (argument === "--source-user-id") {
      options.sourceUserId = valueAfter(args, index, argument);
      index += 1;
    } else if (argument === "--target-user-id") {
      options.targetUserId = valueAfter(args, index, argument);
      index += 1;
    } else if (argument === "--revision") {
      options.expectedRevision = valueAfter(args, index, argument);
      index += 1;
    } else if (argument === "--proof") {
      options.expectedProof = valueAfter(args, index, argument);
      index += 1;
    } else if (argument === "--super-admin-actor-id") {
      options.superAdminActorId = valueAfter(args, index, argument);
      index += 1;
    } else if (argument === "--acknowledge") {
      options.acknowledgement = valueAfter(args, index, argument);
      index += 1;
    } else {
      throw new Error("Unknown staff-identity repair argument.");
    }
  }
  return options;
}

export function validateStaffIdentityRepairCliOptions(
  options: StaffIdentityRepairCliOptions
): void {
  if (options.help) return;
  if (!!options.schoolId === options.allSchools) {
    throw new Error("Select exactly one of --school-id or --all-schools.");
  }
  if (options.execute && options.explicitDryRun) {
    throw new Error("--execute and --dry-run are mutually exclusive.");
  }
  if (options.allSchools && options.execute) {
    throw new Error("All-school mode is inventory-only.");
  }
  for (const [flag, value] of [
    ["--school-id", options.schoolId],
    ["--source-user-id", options.sourceUserId],
    ["--target-user-id", options.targetUserId],
    ["--super-admin-actor-id", options.superAdminActorId],
  ] as const) {
    if (value !== undefined && !UUID_PATTERN.test(value)) {
      throw new Error(`${flag} must be a UUID.`);
    }
  }
  if (options.schoolId) {
    if (!options.sourceUserId || !options.targetUserId) {
      throw new Error("Exact-school mode requires source and target user IDs.");
    }
    if (options.sourceUserId === options.targetUserId) {
      throw new Error("Source and target user IDs must differ.");
    }
  }
  if (options.execute) {
    if (!options.expectedRevision?.startsWith("staff-impact-v2:")) {
      throw new Error("Execution requires the exact dry-run revision.");
    }
    if (!options.expectedProof?.startsWith("staff-repair-proof-v1:")) {
      throw new Error("Execution requires the exact dry-run proof.");
    }
    if (!options.superAdminActorId) {
      throw new Error("Execution requires --super-admin-actor-id.");
    }
    if (options.acknowledgement !== STAFF_IDENTITY_REPAIR_ACKNOWLEDGEMENT) {
      throw new Error("Execution requires the exact acknowledgement.");
    }
  } else if (
    options.expectedRevision !== undefined ||
    options.expectedProof !== undefined ||
    options.superAdminActorId !== undefined ||
    options.acknowledgement !== undefined
  ) {
    throw new Error("Execution-only arguments require --execute.");
  }
}

function emit(value: unknown, error = false): void {
  const serialized = `${JSON.stringify(value)}\n`;
  if (error) process.stderr.write(serialized);
  else process.stdout.write(serialized);
}

function safeFailureCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{3,100}$/.test(code)
    ? code
    : "operation_failed";
}

export function getStaffIdentityInventoryOutcome(input: {
  affectedSchoolCount: number;
  emailCollisionGroupCount: number;
  unscopedIssueCount?: number;
}): { status: "passed" | "blocked"; exitCode: 0 | 3 } {
  const blocked = input.affectedSchoolCount > 0
    || input.emailCollisionGroupCount > 0
    || (input.unscopedIssueCount ?? 0) > 0;
  return blocked
    ? { status: "blocked", exitCode: 3 }
    : { status: "passed", exitCode: 0 };
}

export async function runStaffIdentityRepairCli(args: string[]): Promise<number> {
  let options: StaffIdentityRepairCliOptions;
  try {
    options = parseStaffIdentityRepairCliArgs(args);
    validateStaffIdentityRepairCliOptions(options);
  } catch {
    emit({ version: REPORT_VERSION, status: "failed", failureCode: "invalid_arguments" }, true);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  try {
    await assertStaffIdentityRepairExecutionAdmission({ execute: options.execute });
  } catch (error) {
    emit(
      {
        version: REPORT_VERSION,
        status: "failed",
        failureCode: safeFailureCode(error),
      },
      true
    );
    return 1;
  }

  let databaseModule: typeof import("../db.js") | undefined;
  try {
    const [lifecycle, tenantContext, coreSchema, classpilotSchema, drizzle, dbModule] = await Promise.all([
      import("../services/staffAssignmentLifecycle.js"),
      import("../middleware/tenantContext.js"),
      import("../schema/core.js"),
      import("../schema/classpilot.js"),
      import("drizzle-orm"),
      import("../db.js"),
    ]);
    databaseModule = dbModule;

    if (options.allSchools) {
      const report = await tenantContext.runWithTenantContext({ isSuper: true }, async () => {
        const schoolRows = await dbModule.default
          .select({ id: coreSchema.schools.id })
          .from(coreSchema.schools)
          .where(drizzle.isNull(coreSchema.schools.deletedAt))
          .orderBy(coreSchema.schools.id);
        const collisionResult = await dbModule.default.execute<{
          user_ids: string[];
          member_count: string | number;
        }>(drizzle.sql`
          SELECT
            array_agg(id ORDER BY id) AS user_ids,
            count(*) AS member_count
          FROM users
          GROUP BY lower(btrim(email))
          HAVING count(*) > 1
          ORDER BY min(id)
        `);
        const schools = [];
        for (const school of schoolRows) {
          const integrity = await lifecycle.getStaffAssignmentIntegrityIssues(school.id);
          if (integrity.total > 0) {
            schools.push({
              schoolId: school.id,
              counts: integrity.counts,
              invalidAssignmentCountsByType: integrity.invalidAssignmentCountsByType,
              invalidBlockerCountsByType: integrity.invalidBlockerCountsByType,
              issueIds: {
                invalidPrimaryAssignments: integrity.invalidPrimaryAssignments,
                invalidCoTeacherAssignments: integrity.invalidCoTeacherAssignments,
                invalidClassRelationships: integrity.invalidClassRelationships,
                primaryMirrorMismatches: integrity.primaryMirrorMismatches,
                invalidLiveAssignments: integrity.invalidLiveAssignments,
                invalidLiveBlockers: integrity.invalidLiveBlockers,
                homeroomPrimaryMirrorMismatches:
                  integrity.homeroomPrimaryMirrorMismatches,
                invalidHomeroomRelationships:
                  integrity.invalidHomeroomRelationships,
                invalidTenantScopes: integrity.invalidTenantScopes,
              },
              total: integrity.total,
            });
          }
        }
        const unscopedIntegrity =
          await lifecycle.getUnscopedStaffAssignmentIntegrityIssues();
        const outcome = getStaffIdentityInventoryOutcome({
          affectedSchoolCount: schools.length,
          emailCollisionGroupCount: collisionResult.rows.length,
          unscopedIssueCount: unscopedIntegrity.total,
        });
        return {
          version: REPORT_VERSION,
          status: outcome.status,
          exitCode: outcome.exitCode,
          mode: "inventory",
          schoolCount: schoolRows.length,
          affectedSchoolCount: schools.length,
          emailCollisionGroupCount: collisionResult.rows.length,
          emailCollisionUserCount: collisionResult.rows.reduce(
            (total, row) => total + Number(row.member_count),
            0
          ),
          emailCollisionGroups: collisionResult.rows.map((row) => ({
            userIds: row.user_ids,
            count: Number(row.member_count),
          })),
          unscopedIssueCount: unscopedIntegrity.total,
          unscopedIssues: unscopedIntegrity,
          schools,
        };
      });
      emit(report, report.status === "blocked");
      return report.exitCode;
    }

    const result = await tenantContext.runWithTenantContext(
      { schoolId: options.schoolId! },
      async () => {
        const sourceMembership = await lifecycle.findTransitionMembershipForUser({
          schoolId: options.schoolId!,
          userId: options.sourceUserId!,
          allowInactive: true,
        });
        const targetMembership = await lifecycle.findTransitionMembershipForUser({
          schoolId: options.schoolId!,
          userId: options.targetUserId!,
          allowInactive: false,
        });
        const impact = await lifecycle.getStaffAssignmentImpact(
          options.schoolId!,
          sourceMembership.id,
          { action: "deactivate", forceAll: true }
        );
        const classIds = [
          ...new Set(
            impact.assignments
              .filter((assignment) =>
                assignment.assignmentType === "class_primary" ||
                assignment.assignmentType === "class_co_teacher"
              )
              .map((assignment) => assignment.resourceId)
          ),
        ];
        const loadPreservedCounts = async () => {
          if (classIds.length === 0) {
            return { classCount: 0, rosterMembershipCount: 0, teachingSessionCount: 0 };
          }
          const [classCountRow] = await dbModule.default
            .select({ count: drizzle.count() })
            .from(classpilotSchema.groups)
            .where(
              drizzle.and(
                drizzle.eq(classpilotSchema.groups.schoolId, options.schoolId!),
                drizzle.inArray(classpilotSchema.groups.id, classIds)
              )
            );
          const [rosterCountRow] = await dbModule.default
            .select({ count: drizzle.count() })
            .from(classpilotSchema.groupStudents)
            .where(drizzle.inArray(classpilotSchema.groupStudents.groupId, classIds));
          const [historyCountRow] = await dbModule.default
            .select({ count: drizzle.count() })
            .from(classpilotSchema.teachingSessions)
            .innerJoin(
              classpilotSchema.groups,
              drizzle.eq(classpilotSchema.groups.id, classpilotSchema.teachingSessions.groupId)
            )
            .where(
              drizzle.and(
                drizzle.eq(classpilotSchema.groups.schoolId, options.schoolId!),
                drizzle.inArray(classpilotSchema.teachingSessions.groupId, classIds)
              )
            );
          return {
            classCount: Number(classCountRow?.count ?? 0),
            rosterMembershipCount: Number(rosterCountRow?.count ?? 0),
            teachingSessionCount: Number(historyCountRow?.count ?? 0),
          };
        };
        const preservedBefore = await loadPreservedCounts();
        const proof = lifecycle.createStaffIdentityRepairProof({
          schoolId: options.schoolId!,
          sourceMembershipId: sourceMembership.id,
          targetMembershipId: targetMembership.id,
          impactRevision: impact.revision,
          preservationCounts: preservedBefore,
        });
        const summary = {
          assignmentCount: impact.assignments.length,
          requiredAssignmentCount: impact.assignments.filter((assignment) => assignment.required).length,
          blockerCount: impact.blockers.length,
          assignmentCounts: impact.assignments.reduce<Record<string, number>>((counts, assignment) => {
            counts[assignment.assignmentType] = (counts[assignment.assignmentType] ?? 0) + 1;
            return counts;
          }, {}),
          blockerCounts: impact.blockers.reduce<Record<string, number>>((counts, blocker) => {
            counts[blocker.blockerType] = (counts[blocker.blockerType] ?? 0) + 1;
            return counts;
          }, {}),
          preservedBefore,
          optionalDependencyPolicy: "replace_all_with_exact_target",
        };
        if (!options.execute) {
          return {
            version: REPORT_VERSION,
            status: impact.blockers.length > 0 ? "blocked" : "passed",
            mode: "dry_run",
            schoolId: options.schoolId,
            sourceUserId: options.sourceUserId,
            targetUserId: options.targetUserId,
            revision: impact.revision,
            proof,
            summary,
          };
        }

        const [actor] = await dbModule.default
          .select({ id: coreSchema.users.id, isSuperAdmin: coreSchema.users.isSuperAdmin })
          .from(coreSchema.users)
          .where(drizzle.eq(coreSchema.users.id, options.superAdminActorId!))
          .limit(1);
        if (!actor?.isSuperAdmin) {
          throw Object.assign(new Error("Super administrator required."), {
            code: "SUPER_ADMIN_ACTOR_REQUIRED",
          });
        }
        const repaired = await lifecycle.transitionStaffAssignments({
          schoolId: options.schoolId!,
          membershipId: sourceMembership.id,
          expectedSourceUserId: options.sourceUserId!,
          actorUserId: actor.id,
          actorRole: "super_admin",
          allowInactiveSource: true,
          auditAction: "classpilot.staff_identity.repaired",
          classStateInvariant: {
            classIds,
            expected: preservedBefore,
          },
          repairProof: {
            expectedProof: options.expectedProof!,
            targetMembershipId: targetMembership.id,
          },
          request: {
            expectedRevision: options.expectedRevision!,
            action: "deactivate",
            decisions: impact.assignments.map((assignment) => ({
              assignmentType: assignment.assignmentType,
              assignmentId: assignment.assignmentId,
              operation: "replace",
              replacementMembershipId: targetMembership.id,
            })),
          },
        });
        const preservedAfter = await loadPreservedCounts();
        const postCommitObservationMatchesDryRun =
          JSON.stringify(preservedBefore) === JSON.stringify(preservedAfter);
        return {
          version: REPORT_VERSION,
          status: postCommitObservationMatchesDryRun ? "passed" : "failed",
          ...(postCommitObservationMatchesDryRun
            ? {}
            : { failureCode: "POST_COMMIT_OBSERVATION_MISMATCH" }),
          mode: "execute",
          schoolId: options.schoolId,
          sourceUserId: options.sourceUserId,
          targetUserId: options.targetUserId,
          summary: {
            ...summary,
            transferredCount: repaired.transferred.length,
            transactionalPreservation: repaired.preservation,
            postCommitObservation: preservedAfter,
            postCommitObservationMatchesDryRun,
          },
        };
      }
    );
    emit(result, result.status !== "passed");
    return result.status === "passed" ? 0 : result.status === "blocked" ? 3 : 1;
  } catch (error) {
    emit(
      {
        version: REPORT_VERSION,
        status: "failed",
        failureCode: safeFailureCode(error),
      },
      true
    );
    return 1;
  } finally {
    if (databaseModule) {
      await Promise.allSettled([
        databaseModule.pool.end(),
        databaseModule.sessionPool.end(),
      ]);
    }
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  void runStaffIdentityRepairCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
