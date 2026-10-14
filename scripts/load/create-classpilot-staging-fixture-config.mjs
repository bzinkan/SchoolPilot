import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { configuredLoadGatesRoot, preparePrivateOutputDirectory, validateConfig, writePrivateJson } from './prepare-classpilot-load-test.mjs';
import { reliabilityProfile } from './classpilot-reliability-profile.mjs';

export function freshStagingFixtureConfig(primaryDevices, identity = randomBytes(5).toString('hex')) {
  reliabilityProfile(primaryDevices);
  assert.match(identity, /^[a-f0-9]{10}$/);
  const fixtureId = `rel-${primaryDevices}-${identity}`, domain = 'classpilot-staging.invalid';
  return {
    version: 1, fixtureId, baseUrl: 'https://staging.school-pilot.net', syntheticStaging: true, reliabilityDeviceCount: primaryDevices,
    ownershipAcknowledgement: 'TOOL_OWNED_MARKED_NON_BILLABLE_SYNTHETIC_TENANTS_ONLY',
    emailDeliveryAcknowledgement: 'ISOLATED_STAGING_INVALID_ADDRESSES_NO_EMAIL_TRANSPORT',
    operatorMailboxEmail: `operator@${domain}`, operatorOwnedAdminEmail: `operator+${fixtureId}-admin@${domain}`,
    allowSchoolCreation: true, cleanupOwnedSchools: false,
    schools: {
      primary: { name: `[SYNTHETIC LOAD TEST - NON-BILLABLE] ${fixtureId} Primary`, domain, adminEmail: `operator+${fixtureId}-admin@${domain}` },
      canary: { name: `[SYNTHETIC LOAD TEST - NON-BILLABLE] ${fixtureId} Canary`, domain, adminEmail: `operator+${fixtureId}-canary@${domain}` },
    },
    aliases: { teacherPrefix: `operator+${fixtureId}-t`, primaryStudentPrefix: `operator+${fixtureId}-s`, canaryStudentPrefix: `operator+${fixtureId}-c` },
    commandUrl: 'https://example.edu/schoolpilot-load-test', registrationRequestsPerMinute: 600, timezone: 'America/New_York',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { devices: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) console.log('Usage: node scripts/load/create-classpilot-staging-fixture-config.mjs --devices <40|500|800> --output <fresh-private-fixture-directory>. Writes no credentials and starts no network requests. Root defaults to %LOCALAPPDATA%/SchoolPilot/load-gates.');
    else {
      assert.ok(values.output && values.devices);
      const directory = preparePrivateOutputDirectory(resolve(values.output), configuredLoadGatesRoot());
      const config = freshStagingFixtureConfig(Number(values.devices));
      validateConfig(config);
      assert.equal(existsSync(join(directory, 'fixture-config.json')), false, 'Fresh config required');
      writePrivateJson(directory, 'fixture-config.json', config);
      console.log(JSON.stringify({ operation: 'staging-fixture-config-created', fixtureId: config.fixtureId, primaryDevices: config.reliabilityDeviceCount,
        syntheticStaging: true, credentialsWritten: false, networkRequests: 0 }));
    }
  } catch { console.error('[staging-fixture-config] Refused invalid profile, path or existing config'); process.exitCode = 1; }
}
