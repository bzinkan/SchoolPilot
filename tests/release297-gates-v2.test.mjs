// The release harness rejection tests also belong to the normal unit CI lane.
import '../scripts/load/usage/release-gates-v2/contracts.test.mjs';
import '../scripts/load/usage/release-gates-v2/lifecycle-audience.test.mjs';
import '../scripts/load/usage/release-gates-v2/postgres-readiness.test.mjs';
import '../scripts/load/usage/release-gates-v2/operational-fixture.test.mjs';
import '../scripts/load/usage/release-gates-v2/operational-fixture-custody.test.mjs';
import '../scripts/load/usage/release-gates-v2/classroom-bindings-custody.test.mjs';
import '../scripts/load/usage/release-gates-v2/routing.test.mjs';
import '../scripts/load/usage/release-gates-v2/usage-post-verification.test.mjs';
import '../scripts/load/usage/release-gates-v2/distinct-reports.test.mjs';
import '../scripts/load/usage/release-gates-v2/distinct-report-operation.test.mjs';
import '../scripts/load/usage/release-gates-v2/distinct-report-rpc.test.mjs';
import '../scripts/load/usage/release-gates-v2/distinct-report-integration.test.mjs';
import '../scripts/load/usage/release-gates-v2/lower-load.test.mjs';
import '../scripts/load/usage/release-gates-v2/acceptance-successor.test.mjs';
