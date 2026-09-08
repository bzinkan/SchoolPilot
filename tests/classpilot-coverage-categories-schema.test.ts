import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { classpilotCoverageGroupCategories, classpilotCoverageScopeGroups } from "../src/schema/classpilot.js";

test("a fresh schema creates the category tenant key before the group foreign key", () => {
  const category = getTableConfig(classpilotCoverageGroupCategories);
  const group = getTableConfig(classpilotCoverageScopeGroups);
  // drizzle-kit creates foreign keys before secondary indexes. The referenced
  // tenant key must therefore be a table constraint, not only a unique index.
  const key = category.uniqueConstraints.find((constraint) =>
    constraint.name === "classpilot_coverage_categories_school_id_unique"
  );
  assert.ok(key);
  assert.deepEqual(key.columns.map((column) => column.name), ["school_id", "id"]);
  const relation = group.foreignKeys.find((foreignKey) =>
    foreignKey.getName() === "classpilot_coverage_groups_category_school_fk"
  );
  assert.ok(relation);
  const reference = relation.reference();
  assert.deepEqual(reference.columns.map((column) => column.name), ["school_id", "category_id"]);
  assert.deepEqual(reference.foreignColumns.map((column) => column.name), ["school_id", "id"]);
  assert.equal(reference.foreignTable, classpilotCoverageGroupCategories);
});
