// The infrastructure lane discovers this entry point under tests/. Keep these
// workload safety/oracle suites in required backend CI without starting a DB.
import '../scripts/load/usage/local-usage-scale.test.mjs';
import '../scripts/load/usage/school-day-profile.test.mjs';
import '../scripts/load/usage/school-day-ai-profile.test.mjs';
import '../scripts/load/usage/fixture-rls-contract.test.mjs';
import '../scripts/load/usage/open-loop-heartbeats.test.mjs';
import '../scripts/load/usage/cold-open-loop-profile.test.mjs';
import '../scripts/load/usage/release-enabled-profile.test.mjs';
import '../scripts/load/usage/release-enabled-focus-protocol.test.mjs';
import '../scripts/load/usage/release-enabled-drain.test.mjs';
import '../scripts/load/usage/roles/suite.mjs';
