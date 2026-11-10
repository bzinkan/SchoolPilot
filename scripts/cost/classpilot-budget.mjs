import { pathToFileURL } from 'node:url';

// US East / US viewers, verified November 9, 2026. This is a workload estimate,
// not an AWS quote or a fleet-capacity result. No AWS calls or credentials.
export const RATES = Object.freeze({
  cloudfrontRequestsPerMillion: 1, wafRequestsPerMillion: 0.6,
  cloudfrontToOriginPerGiB: 0.02, cloudfrontToViewerPerGiB: 0.085,
  albProcessedPerGiB: 0.008, redisCrossAzPerGiB: 0.01,
  cloudfrontFreeRequests: 10_000_000, cloudfrontFreeViewerGiB: 1024,
  proMonthly: 15, proRequests: 10_000_000, proTransferGiB: 50 * 1024,
});
const GIB = 1024 ** 3;
const has = (o, k) => Object.hasOwn(o, k) && o[k] !== undefined;

export function estimateClasspilotBudget(input = {}) {
  const o = {
    students: 2000, hoursPerDay: 6, schoolDays: 22, observedFraction: 1,
    unchangedFraction: 0, screenshotBytes: 22342, teacherCopies: 1,
    heartbeatRequestBytes: 0, heartbeatResponseBytes: 0,
    screenshotMetadataBytes: 512, teacherMetadataBytesPerStudent: 0,
    classSize: 30, teacherPollSeconds: 5, transport: 'http',
    fallbackFraction: 0, edgePlan: 'payg', proCompatibilityConfirmed: false,
    monthlyBaseline: 233, replacedBaselineEdgeCost: 0,
    connectionsPerDeviceDay: 1, extraHttpRequests: 0,
    additionalComputeCost: 0, storageGrowthCost: 0, monitoringGrowthCost: 0,
    otherGrowthCost: 0, redisCrossAzFraction: 0, budget: 300, ...input,
  };
  for (const key of ['students', 'hoursPerDay', 'schoolDays', 'screenshotBytes',
    'teacherCopies', 'heartbeatRequestBytes', 'heartbeatResponseBytes',
    'screenshotMetadataBytes', 'teacherMetadataBytesPerStudent', 'classSize',
    'teacherPollSeconds', 'monthlyBaseline', 'replacedBaselineEdgeCost',
    'connectionsPerDeviceDay', 'extraHttpRequests', 'additionalComputeCost',
    'storageGrowthCost', 'monitoringGrowthCost', 'otherGrowthCost', 'budget']) {
    if (!Number.isFinite(o[key]) || o[key] < 0) throw new Error(`Invalid ${key}`);
  }
  for (const key of ['observedFraction', 'unchangedFraction', 'fallbackFraction', 'redisCrossAzFraction']) {
    if (!Number.isFinite(o[key]) || o[key] < 0 || o[key] > 1) throw new Error(`Invalid ${key}`);
  }
  if (!Number.isInteger(o.students) || o.hoursPerDay > 24 || o.schoolDays > 31
    || o.classSize === 0 || o.teacherPollSeconds === 0
    || !['http', 'websocket'].includes(o.transport) || !['payg', 'pro'].includes(o.edgePlan)
    || o.replacedBaselineEdgeCost > o.monthlyBaseline) throw new Error('Invalid workload options');

  const seconds = o.hoursPerDay * 3600 * o.schoolDays;
  const heartbeats = o.students * seconds / 10;
  const screenshots = o.students * seconds * ((1 - o.observedFraction) / 30 + o.observedFraction / 5);
  const fullImageUploads = screenshots * (1 - o.unchangedFraction);
  const referenceUploads = screenshots - fullImageUploads;
  const deviceOperations = heartbeats + screenshots;
  const deviceHttpRequests = deviceOperations * (o.transport === 'http' ? 1 : o.fallbackFraction);
  const teacherHttpRequests = Math.ceil(o.students / o.classSize) * seconds / o.teacherPollSeconds * o.teacherCopies;
  // Existing sockets still have upgrade requests. Normal protocol keepalives
  // are frames, not recurring HTTP requests.
  const connections = o.students * o.schoolDays * o.connectionsPerDeviceDay;
  const edgeRequests = deviceHttpRequests + teacherHttpRequests + connections + o.extraHttpRequests;
  const imageUpload = fullImageUploads * o.screenshotBytes;
  const imageDownload = imageUpload * o.teacherCopies;
  const heartbeatUpload = heartbeats * o.heartbeatRequestBytes;
  const heartbeatDownload = heartbeats * o.heartbeatResponseBytes;
  const screenshotMetadata = screenshots * o.screenshotMetadataBytes;
  const teacherMetadata = o.students * seconds / o.teacherPollSeconds * o.teacherCopies * o.teacherMetadataBytesPerStudent;
  const originUpload = imageUpload + heartbeatUpload + screenshotMetadata;
  const viewerDownload = imageDownload + heartbeatDownload + teacherMetadata;
  const albProcessed = originUpload + viewerDownload;
  // Image references avoid rewriting/re-reading unchanged blobs. This estimate
  // counts one full blob write plus each viewer read; metadata and heartbeat
  // Redis commands are additional unmeasured overhead.
  const redisImageCrossAz = (imageUpload + imageDownload) * o.redisCrossAzFraction;
  const pro = o.edgePlan === 'pro';
  const costs = {
    baseline: o.monthlyBaseline - o.replacedBaselineEdgeCost,
    cloudfrontPlan: pro ? RATES.proMonthly : 0,
    cloudfrontRequests: pro ? 0 : Math.max(0, edgeRequests - RATES.cloudfrontFreeRequests) / 1e6 * RATES.cloudfrontRequestsPerMillion,
    wafRequests: pro ? 0 : edgeRequests / 1e6 * RATES.wafRequestsPerMillion,
    cloudfrontOriginTransfer: pro ? 0 : originUpload / GIB * RATES.cloudfrontToOriginPerGiB,
    cloudfrontViewerTransfer: pro ? 0 : Math.max(0, viewerDownload / GIB - RATES.cloudfrontFreeViewerGiB) * RATES.cloudfrontToViewerPerGiB,
    albBytes: albProcessed / GIB * RATES.albProcessedPerGiB,
    redisImageCrossAz: redisImageCrossAz / GIB * RATES.redisCrossAzPerGiB,
    additionalCompute: o.additionalComputeCost, storageGrowth: o.storageGrowthCost,
    monitoringGrowth: o.monitoringGrowthCost, otherGrowth: o.otherGrowthCost,
  };
  const total = Object.values(costs).reduce((sum, v) => sum + v, 0);
  const unknowns = [];
  if (!has(input, 'heartbeatRequestBytes') || !has(input, 'heartbeatResponseBytes')) unknowns.push('Actual heartbeat bytes are unmeasured.');
  if (!has(input, 'teacherMetadataBytesPerStudent')) unknowns.push('Teacher metadata bytes are unmeasured.');
  if (!has(input, 'redisCrossAzFraction')) unknowns.push('Redis cross-AZ placement and metadata traffic are unmeasured.');
  for (const [key, label] of [['storageGrowthCost', 'Storage/backup growth'], ['monitoringGrowthCost', 'Monitoring growth'],
    ['additionalComputeCost', 'Additional compute requirements'], ['otherGrowthCost', 'Other variable AWS charges']]) {
    if (!has(input, key)) unknowns.push(`${label} remains unverified.`);
  }
  if (pro && !o.proCompatibilityConfirmed) unknowns.push('CloudFront Pro compatibility and eligibility are not confirmed.');
  if (pro && edgeRequests > RATES.proRequests) unknowns.push('The modeled workload exceeds the Pro 10 million request allowance; do not assume sustained use is admitted.');
  if (pro && (originUpload + viewerDownload) / GIB > RATES.proTransferGiB) unknowns.push('The modeled workload exceeds the Pro transfer allowance.');
  return {
    assumptions: o,
    counts: { heartbeats, screenshots, fullImageUploads, referenceUploads, deviceOperations,
      deviceHttpRequests, teacherHttpRequests, connections, edgeRequests },
    bytes: { imageUpload, imageDownload, heartbeatUpload, heartbeatDownload, screenshotMetadata,
      teacherMetadata, originUpload, viewerDownload, albProcessed, redisImageCrossAz },
    costs, total, remainingBudget: o.budget - total, unknowns,
    budgetStatus: total > o.budget ? 'over-target' : unknowns.length ? 'unverified' : 'within-modeled-target',
    capacityAccepted: false,
    limitations: [
      'The baseline includes some existing variable charges; subtract only verified replaced charges.',
      'ALB bytes are a planning contribution, not additive LCU dimensions; another dimension can dominate.',
      'Screenshot string size excludes envelope overhead and may differ from compressed wire size.',
      'Unchanged-image savings depend on real recaptures; animated pages may save zero bytes.',
      'This model never establishes production capacity or an actual monthly bill.',
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const raw = process.argv.slice(2);
    if (raw.includes('--help')) {
      console.log('Usage: node scripts/cost/classpilot-budget.mjs [--json] [--options=JSON]\nNo network calls. Options override documented workload assumptions.');
    } else {
      const argument = raw.find(x => x.startsWith('--options='));
      const result = estimateClasspilotBudget(argument ? JSON.parse(argument.slice(10)) : {});
      if (raw.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`Modeled total: $${result.total.toFixed(2)}/month (${result.budgetStatus})`);
        console.log(`Heartbeats: ${result.counts.heartbeats.toLocaleString('en-US')}; screenshots: ${result.counts.screenshots.toLocaleString('en-US')}; edge HTTP requests: ${result.counts.edgeRequests.toLocaleString('en-US')}`);
        console.log('Production fleet acceptance: pending');
        for (const unknown of result.unknowns) console.log(`Unverified: ${unknown}`);
      }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
