import { replaceOnce } from '../roles/patch-coordinator.mjs';

// Compose AFTER the protocol owner's current generated overlays. These opt-in
// adapters leave the historical initialize/phase/reportWaves/verify untouched.
export function patchDistinctGeneratorRpc(source) {
  let text = source.replaceAll('\r\n', '\n');
  text = replaceOnce(text, "import assert from 'node:assert/strict';", "import assert from 'node:assert/strict';\nimport { createDistinctGeneratorRpc } from './release-gates-v2/distinct-report-rpc.mjs';");
  text = replaceOnce(text, 'let fixture, base, schools;', `let fixture, base, schools;
const distinctGeneratorRpc = createDistinctGeneratorRpc({ run: process.env.USAGE_SCALE_CONTAINER.slice(-12), source: process.env.USAGE_SOURCE_REVISION,
  getFixture: () => fixture, getSchools: () => schools, staffRequest: (...args) => staffRequest(...args) });`);
  text = replaceOnce(text, "    } else if (rpc.operation === 'correctness') {", `    } else if (rpc.operation === 'prepareDistinctReports') {
      value = await distinctGeneratorRpc.prepare(rpc.value);
    } else if (rpc.operation === 'distinctReports') {
      value = await distinctGeneratorRpc.reports(rpc.value);
    } else if (rpc.operation === 'correctness') {`);
  return text;
}
export function patchDistinctObserverRpc(source) {
  let text = source.replaceAll('\r\n', '\n');
  text = replaceOnce(text, "import assert from 'node:assert/strict';", "import assert from 'node:assert/strict';\nimport { createDistinctObserverRpc } from './distinct-report-rpc.mjs';");
  text = replaceOnce(text, 'let fixture;', `let fixture;
const distinctObserverRpc = createDistinctObserverRpc({ pool, run: process.env.USAGE_SCALE_CONTAINER.slice(-12),
  source: process.env.USAGE_SOURCE_REVISION, getFixture: () => fixture });`);
  text = replaceOnce(text, "    } else if (request.operation === 'correctness') {", `    } else if (request.operation === 'distinctOracle') {
      value = await distinctObserverRpc.oracle(request.value);
    } else if (request.operation === 'distinctAudit') {
      value = await distinctObserverRpc.audit(request.value);
    } else if (request.operation === 'correctness') {`);
  text = replaceOnce(text, '      value = { passed: true, catalog, migrations, restrictedRole: true, crossSchool: true, resetScope: true };', `      const heavyRows = (await pool.query(\`SELECT school.id AS school_id,COUNT(h.id)::int AS count
        FROM schools school LEFT JOIN heartbeats h ON h.school_id=school.id
          AND h.timestamp >= (($2::date::timestamp AT TIME ZONE school.school_timezone) AT TIME ZONE 'UTC')
          AND h.timestamp < ((($2::date+1)::timestamp AT TIME ZONE school.school_timezone) AT TIME ZONE 'UTC')
        WHERE school.id=ANY($1::text[]) GROUP BY school.id ORDER BY school.id\`,
        [fixture.schools.map(school=>school.id),fixture.heavyDate])).rows;
      assert.equal(heavyRows.length,2);
      const distinctHeavyRows=fixture.schools.map(school=>({schoolIndex:school.index,count:heavyRows.find(row=>row.school_id===school.id)?.count}));
      assert.ok(distinctHeavyRows.every(row=>row.count===1_000_000));
      value = { passed: true, catalog, migrations, restrictedRole: true, crossSchool: true, resetScope: true, distinctHeavyRows };`);
  return text;
}
export function patchDistinctRoleEntryRpc(source) {
  return replaceOnce(source.replaceAll('\r\n', '\n'), "'queryPlans'", "'queryPlans', 'distinctOracle', 'distinctAudit', 'prepareDistinctReports', 'distinctReports'");
}
