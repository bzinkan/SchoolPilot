import assert from 'node:assert/strict';

// Preserve the declared historical transform without executing arbitrary shell
// commands or silently dropping a newly introduced build step.
export function rehearsalBuildSteps(manifest) {
  const build = manifest?.scripts?.build;
  assert.ok(build === 'tsc' || build === 'tsc && tsc-alias',
    'Unsupported rehearsal build command; review its transforms explicitly');
  return [
    { name: 'typescript', entrypoint: 'node_modules/typescript/bin/tsc' },
    ...(build === 'tsc && tsc-alias'
      ? [{ name: 'aliases', entrypoint: 'node_modules/tsc-alias/dist/bin/index.js' }]
      : []),
  ];
}
