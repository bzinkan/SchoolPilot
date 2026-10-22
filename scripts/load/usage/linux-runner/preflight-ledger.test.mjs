import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('both source bindings admit only the reviewed numeric ledger count and retain expand/129-table guards', () => {
  // Execute the real module in an isolated VM. Synthetic dependencies stop at the
  // first schema read, after the admission guard; no source/native proof is claimed.
  const source = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { SourceTextModule, SyntheticModule } from 'node:vm';
    const file = ${JSON.stringify(new URL('./preflight.mjs', import.meta.url).href)};
    const sources = { candidate: 'a'.repeat(40), baseline: 'b'.repeat(40), harness: 'c'.repeat(40) };
    const hash = 'd'.repeat(64), ref = path => ({ path, sha256: hash });
    const afterAdmission = new Error('SYNTHETIC_SCHEMA_BOUNDARY');
    let active;
    const unused = () => { throw new Error('UNEXPECTED_SYNTHETIC_DEPENDENCY'); };
    const relocation = {
      FREEZE_SHA256: hash, SOURCES: sources,
      guard: (ok, code) => { if (!ok) throw new Error(code); },
      assertSha: value => { assert.match(value, /^[a-f0-9]{64}$/); return value; },
      verifyRelocation: async () => ({ inputRoot: '/synthetic', ref: value => value, resolve: value => value }),
      readReference: async value => {
        if (value.path === 'freeze') return active.freeze;
        if (value.path === 'archives') return active.archives;
        if (value.path === 'candidate-schema-receipt') throw afterAdmission;
        throw new Error('UNEXPECTED_SYNTHETIC_REFERENCE:' + value.path);
      },
      isMain: () => false,
      ...Object.fromEntries(['sha256', 'hashFile', 'safePath', 'verifyReference', 'writeNewJson', 'readCliRequest', 'cliFailure'].map(key => [key, unused])),
    };
    const checkout = {
      verifyCheckout: async () => ({}),
      loadSourceRestoration: async () => ({
        roleFor: key => key,
        receipt: { roles: Object.fromEntries(['source', 'baseline-source', 'harness-source'].map(key => [key, { path: '/' + key }])) },
      }),
    };
    const module = new SourceTextModule(readFileSync(new URL(file), 'utf8'), { identifier: file });
    await module.link(async specifier => {
      const values = specifier === './relocation.mjs' ? relocation
        : specifier === './source-checkout.mjs' ? checkout : await import(specifier);
      return new SyntheticModule(Object.keys(values), function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      });
    });
    await module.evaluate();
    function fixture(expectedLedgerEntries = 56) {
      const freeze = {
        applicationSource: sources.candidate, baselineSource: sources.baseline, harnessSource: sources.harness,
        sourceDirectory: '/source', baselineSourceDirectory: '/baseline-source', harnessDirectory: '/harness-source',
        schemaFile: '/candidate-schema', baselineSchema: { file: '/baseline-schema', receipt: ref('baseline-schema-receipt') },
        observedEnvironment: ref('environment'), candidateImage: ref('candidate-image'), baselineImage: ref('baseline-image'),
        helpers: {}, preparations: {}, harnessFiles: {}, profiles: {}, expectedLedgerEntries,
        references: { 'complete-source-archives.json': ref('archives'), 'schema/lineage/schema-receipt.json': ref('candidate-schema-receipt') },
      };
      for (const prefix of ['usageSource', 'baselineUsageSource'])
        for (const suffix of ['BindingFile', 'BindingSha256', 'ReviewFile', 'ReviewSha256'])
          freeze[prefix + suffix] = suffix.endsWith('Sha256') ? hash : prefix + suffix;
      const binding = () => ({ migrationStage: 'expand', expectedMigrations: Array(56).fill(null), rlsTables: Array(129).fill(null) });
      return {
        freeze, candidate: { binding: binding() }, baseline: { binding: binding() },
        archives: { archives: Object.fromEntries([['source', sources.candidate], ['baseline-source', sources.baseline], ['harness-source', sources.harness]].map(([key, source]) => [key, { source, path: '/' + key, sha256: hash }])) },
      };
    }
    async function check(value, accepted) {
      active = value;
      const canonical = {
        loadUsageSourceBinding: options => options.usageSourceBindingFile.startsWith('baseline') ? active.baseline : active.candidate,
        assertUsageSourceCheckout: () => {},
      };
      await assert.rejects(module.namespace.verifyFrozenInputs({ endpoint: 'unix:///synthetic/docker.sock', relocation: ref('relocation'), freeze: ref('freeze'), sourceRestoration: {} },
        { platform: 'linux', uid: 1000, canonicalLoader: async () => canonical }),
        error => accepted ? error === afterAdmission : error.message === 'FROZEN_EXPAND_ADMISSION');
    }
    let cases = 0;
    for (const count of [53, 56]) {
      const value = fixture(count);
      for (const role of ['candidate', 'baseline']) value[role].binding.expectedMigrations = Array(count).fill(null);
      await check(value, true); cases++;
    }
    for (const role of ['candidate', 'baseline']) {
      for (const count of [55, 57]) {
        const value = fixture(); value[role].binding.expectedMigrations = Array(count).fill(null);
        await check(value, false); cases++;
      }
      const wrongStage = fixture(); wrongStage[role].binding.migrationStage = 'post-expand';
      await check(wrongStage, false); cases++;
      for (const count of [128, 130]) {
        const value = fixture(); value[role].binding.rlsTables = Array(count).fill(null);
        await check(value, false); cases++;
      }
    }
    for (const count of ['56', undefined, null]) {
      const value = fixture(); value.freeze.expectedLedgerEntries = count;
      await check(value, false); cases++;
    }
    process.stdout.write(JSON.stringify({ cases, synthetic: true, AWSCalls: 0 }) + '\\n');
  `;
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { cases: 15, synthetic: true, AWSCalls: 0 });
});
