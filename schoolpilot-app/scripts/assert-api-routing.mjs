import assert from 'node:assert/strict';
import {
  assertSafeWebApiRequest,
  getApiBaseURL,
  resolveApiRequestUrl,
} from '../src/shared/utils/api.js';

assert.equal(
  getApiBaseURL({ isNative: false, origin: 'https://school-pilot.net' }),
  'https://school-pilot.net/api'
);

assert.equal(
  getApiBaseURL({ isNative: false, origin: 'http://localhost:5173' }),
  'http://localhost:5173/api'
);

assert.equal(
  getApiBaseURL({ isNative: true, origin: 'http://localhost:5173' }),
  'https://school-pilot.net/api'
);

assert.equal(
  resolveApiRequestUrl('/super-admin/soc2/readiness', 'https://school-pilot.net/api', 'https://school-pilot.net'),
  'https://school-pilot.net/api/super-admin/soc2/readiness'
);

assert.equal(
  resolveApiRequestUrl('super-admin/soc2/readiness', 'https://school-pilot.net/api', 'https://school-pilot.net'),
  'https://school-pilot.net/api/super-admin/soc2/readiness'
);

assert.equal(
  assertSafeWebApiRequest('/super-admin/soc2/readiness', 'https://school-pilot.net/api', 'https://school-pilot.net'),
  true
);

assert.throws(
  () => assertSafeWebApiRequest(
    'https://schoolpilot-production-api-alb-123.us-east-1.elb.amazonaws.com/api/super-admin/soc2/readiness',
    'https://school-pilot.net/api',
    'https://school-pilot.net'
  ),
  /Blocked cross-origin web API request/
);

console.log('API routing assertions passed.');
