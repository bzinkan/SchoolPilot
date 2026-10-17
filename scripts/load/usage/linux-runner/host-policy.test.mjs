import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scriptPath = fileURLToPath(new URL('./bootstrap.sh', import.meta.url));
const script = readFileSync(scriptPath, 'utf8');
const bash = process.env.USAGE_TEST_BASH ?? (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash');
const bundledPython = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const python = process.env.USAGE_TEST_PYTHON ?? (process.platform === 'win32' && existsSync(bundledPython) ? bundledPython : 'python3');
const validator = script.match(/python3 - "\$config" <<'PY'\r?\n([\s\S]*?)\r?\nPY/)[1];
const policy = script.match(/render_firewall\(\) \{\r?\n  cat <<'SH'\r?\n([\s\S]*?)\r?\nSH/)[1];
const sha = 'a'.repeat(64);

function configuration() {
  const debs = ['docker-ce', 'docker-ce-cli', 'containerd.io', 'iptables', 'openssh-server', 'openssh-sftp-server'].map((packageName) => ({
    url: `https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/${packageName}_1.0_amd64.deb`, sha256: sha, package: packageName, version: '1.0',
  }));
  return {
    schemaVersion: 1, runId: 'unit-test-12345678',
    instance: { instanceId: 'i-1234567890abcdef0', region: 'us-east-1', launchTimeUtc: '2026-10-12T00:00:00Z', deadlineUtc: '2026-10-12T08:00:00Z', dataVolumeId: 'vol-1234567890abcdef0', rootVolumeId: 'vol-abcdef12345678900', rootGiB: 30, dataGiB: 200 },
    executorUser: 'ubuntu', sftpUser: 'usage-transfer',
    sftpAuthorizedKey: `ssh-ed25519 ${Buffer.concat([Buffer.from('0000000b', 'hex'), Buffer.from('ssh-ed25519'), Buffer.from('00000020', 'hex'), Buffer.alloc(32, 7)]).toString('base64')}`,
    returnAgeRecipient: `age1${'q'.repeat(58)}`,
    ssmAgent: { version: '3.3.1.0', snapRevision: '1000' },
    artifacts: {
      node: { url: 'https://nodejs.org/download/release/v22.23.3/node-v22.23.3-linux-x64.tar.xz', version: 'v22.23.3', archiveRoot: 'node-v22.23.3-linux-x64', sha256: sha },
      age: { url: 'https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-amd64.tar.gz', version: 'v1.3.2', archiveRoot: 'age', sha256: sha }, debs,
    },
    controller: { script: '/srv/usage/control/run-campaign.sh', sha256: sha, config: '/srv/usage/control/campaign.json', configSha256: sha },
  };
}

function validate(config) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'usage-host-policy-'));
  const file = path.join(directory, 'config.json');
  writeFileSync(file, JSON.stringify(config), { flag: 'wx' });
  try {
    // Execute the ONE actual bootstrap validator definition, never bootstrap install.
    const result = spawnSync(python, ['-c', validator, file], { encoding: 'utf8' });
    if (result.error) throw result.error;
    return result;
  } finally {
    const resolved = realpathSync(directory);
    assert.equal(path.dirname(resolved), realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^usage-host-policy-/);
    rmSync(resolved, { recursive: true, force: true });
  }
}

test('bootstrap parses in Bash without running installation', () => {
  const result = spawnSync(bash, ['-n', scriptPath], { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
});

test('single actual validator accepts the complete nonsecret bounded interface', () => {
  const result = validate(configuration());
  assert.equal(result.status, 0, result.stderr);
});

test('absolute TTL cannot be renewed by a relative duration or exceed eight hours', () => {
  for (const change of [
    (c) => { c.instance.deadlineUtc = '2026-10-12T08:00:01Z'; },
    (c) => { c.instance.deadlineUtc = c.instance.launchTimeUtc; },
    (c) => { c.instance.deadlineUtc = '2026-10-12T08:00:00-04:00'; },
    (c) => { c.instance.ttlHours = 8; },
  ]) { const c = configuration(); change(c); assert.notEqual(validate(c).status, 0); }
});

test('bootstrap accepts a later launch under the same absolute stop with no renewed TTL', () => {
  const c = configuration(); c.instance.launchTimeUtc = '2026-10-12T01:00:00Z';
  const result = validate(c); assert.equal(result.status, 0, result.stderr);
  assert.equal(c.instance.deadlineUtc, configuration().instance.deadlineUtc);
  c.instance.launchTimeUtc = '2026-10-12T08:00:01Z'; assert.notEqual(validate(c).status, 0);
});

test('unknown secret fields, private keys, substituted identity and unsafe controller paths refuse', () => {
  for (const change of [
    (c) => { c.awsAccessKey = 'must-never-be-accepted'; },
    (c) => { c.returnAgeRecipient = 'AGE-SECRET-KEY-1PRIVATE'; },
    (c) => { c.sftpAuthorizedKey += ' arbitrary-comment'; },
    (c) => { c.instance.dataVolumeId = c.instance.rootVolumeId; },
    (c) => { c.executorUser = 'root'; },
    (c) => { c.controller.script = '/tmp/evil.sh'; },
    (c) => { c.controller.sha256 = '0'.repeat(64); },
  ]) { const c = configuration(); change(c); assert.notEqual(validate(c).status, 0); }
});

test('floating artifacts, unpinned package closure and insecure download URLs refuse', () => {
  for (const change of [
    (c) => { c.artifacts.node.url = 'https://nodejs.org/dist/latest/node.tar.xz'; },
    (c) => { delete c.artifacts.debs[0].sha256; },
    (c) => { c.artifacts.debs[0].url = 'http://download.docker.com/pkg_amd64.deb'; },
    (c) => { c.artifacts.debs[0].url = 'https://download.docker.com.attacker.invalid/pkg_amd64.deb'; },
    (c) => { c.artifacts.debs[0].url += '?token=secret'; },
    (c) => { c.artifacts.debs.pop(); },
    (c) => { c.artifacts.debs.push(c.artifacts.debs[0]); },
  ]) { const c = configuration(); change(c); assert.notEqual(validate(c).status, 0); }
});

test('actual rendered policy blocks host INPUT and routed egress for both families and fails on missing Docker hook', () => {
  const prefix = `calls=()\niptables() { calls+=("v4:$*"); [[ "$*" != *' -C '* && "$*" != '-w -C '* ]]; }\nip6tables() { calls+=("v6:$*"); [[ "$*" != *' -C '* && "$*" != '-w -C '* ]]; }\n`;
  const result = spawnSync(bash, ['-c', `${prefix}\n${policy}\nprintf '%s\\n' "\${calls[@]}"`, 'policy', '--after-docker'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  for (const family of ['v4', 'v6']) {
    assert.match(result.stdout, new RegExp(`${family}:-w -A USAGE_NO_HOST -i docker0 -j DROP`));
    assert.match(result.stdout, new RegExp(`${family}:-w -I INPUT 1 -j USAGE_NO_HOST`));
    assert.match(result.stdout, new RegExp(`${family}:-w -A USAGE_NO_EGRESS -i docker0 -j DROP`));
    assert.match(result.stdout, new RegExp(`${family}:-w -I FORWARD 1 -j USAGE_NO_EGRESS`));
  }
  assert.match(result.stdout, /v4:-w -I DOCKER-USER 1 -i docker0 -j DROP/);
  const reply = result.stdout.indexOf('v4:-w -A USAGE_NO_HOST -i docker0 -p tcp -m conntrack');
  assert.ok(reply >= 0 && reply < result.stdout.indexOf('v4:-w -A USAGE_NO_HOST -i docker0 -j DROP'));
  assert.doesNotMatch(result.stdout, /v6:.*-j ACCEPT/);
  const missingHook = spawnSync(bash, ['-c', `iptables() { [[ "$*" != *'DOCKER-USER'* ]]; }; ip6tables() { return 0; };\n${policy}\necho MUST_NOT_REACH`, 'policy', '--after-docker'], { encoding: 'utf8' });
  assert.notEqual(missingHook.status, 0);
  assert.doesNotMatch(missingHook.stdout, /MUST_NOT_REACH/);
});

test('prepared service cannot auto-start, restart, or skip hash/deadline/network checks', () => {
  const unit = script.match(/cat > \/etc\/systemd\/system\/usage-campaign.service <<'UNIT'\n([\s\S]*?)\nUNIT/)[1];
  assert.match(unit, /User=ubuntu\n/);
  assert.match(unit, /UMask=0077\n/);
  assert.match(unit, /ExecStartPre=\+\/usr\/local\/sbin\/usage-check-controller/);
  assert.match(unit, /Restart=no\n/);
  assert.doesNotMatch(unit, /WantedBy=|RemainAfterExit=|Restart=always/);
  assert.doesNotMatch(script, /systemctl (?:enable|start|restart).*usage-campaign/);
  const check = script.match(/cat > \/usr\/local\/sbin\/usage-check-controller <<'SH'\n([\s\S]*?)\nSH/)[1];
  assert.match(check, /s\.st_uid==0/);
  assert.match(check, /s\.st_gid==grp\.getgrnam\('ubuntu'\)\.gr_gid/);
  assert.match(check, /stat\.S_IMODE\(s\.st_mode\)==mode/);
  assert.match(check, /configSha256'\],0o640/);
  assert.match(check, /hashlib\.file_digest/);
  assert.match(check, /deadline expired/);
  assert.match(check, /usage-absolute-stop.timer/);
  assert.match(check, /DOCKER-USER -i docker0 -j DROP/);
  assert.match(unit, /ExecStartPre=\+\/usr\/local\/sbin\/usage-freeze-host-egress/);
});

test('Docker/containerd/journals stay on data and SFTP cannot expose raw evidence or host socket', () => {
  assert.match(script, /"data-root":"\/srv\/usage\/docker"/);
  assert.match(script, /root = "\/srv\/usage\/containerd"/);
  assert.match(script, /"containerd-snapshotter":true/);
  assert.match(script, /"firewall-backend":"iptables"/);
  assert.match(script, /"userland-proxy":false/);
  assert.match(script, /"dns":\["127\.0\.0\.1"\]/);
  assert.match(script, /\/srv\/usage\/log\/journal \/var\/log\/journal/);
  const ssh = script.match(/cat > \/etc\/ssh\/sshd_config_usage <<'SSH'\n([\s\S]*?)\nSSH/)[1];
  assert.match(ssh, /ListenAddress 127\.0\.0\.1\n/);
  assert.match(ssh, /Port 22\n/);
  assert.doesNotMatch(ssh, /ListenAddress (?:0\.0\.0\.0|::)\n/);
  assert.match(ssh, /ChrootDirectory \/srv\/usage\/transfer/);
  assert.match(ssh, /ForceCommand internal-sftp/);
  assert.match(ssh, /AllowTcpForwarding no/);
  assert.match(ssh, /PasswordAuthentication no/);
  assert.match(ssh, /PermitRootLogin no/);
  assert.ok(script.indexOf('systemctl disable --now ssh.socket ssh.service') < script.indexOf('systemctl enable --now usage-sftp.service'));
  assert.match(script, /systemctl mask ssh.socket ssh.service/);
  assert.doesNotMatch(ssh, /\/srv\/usage\/(?:raw|keys|docker)|docker\.sock/);
  assert.match(script, /age-keygen -o \/srv\/usage\/keys\/input-identity.txt/);
  assert.doesNotMatch(script, /cat \/srv\/usage\/keys\/input-identity/);
  assert.match(script, /chown root:ubuntu \/srv\/usage\nchmod 0710 \/srv\/usage/);
  assert.match(script, /find \/srv\/usage\/tools -type f -exec chmod 0750/);
  assert.doesNotMatch(script, /chown ubuntu:ubuntu \/srv\/usage\/(?:keys|raw|staging)/);
});

test('final host OUTPUT policy allows bounded management and rejects general HTTPS/IPv6', () => {
  const freeze = script.match(/cat > \/usr\/local\/sbin\/usage-freeze-host-egress <<'SH'\n([\s\S]*?)\nSH/)[1];
  assert.match(freeze, /names=\('ssm\.us-east-1\.amazonaws\.com','ssmmessages\.us-east-1\.amazonaws\.com'\)/);
  assert.match(freeze, /-d "\$address" -p tcp --dport 443 -m owner --uid-owner 0 -j ACCEPT/);
  assert.match(freeze, /-d 169\.254\.169\.254 -p tcp --dport 80 -m owner --uid-owner 0 -j ACCEPT/);
  assert.match(freeze, /-d 10\.247\.0\.2 -p "\$protocol" --dport 53/);
  assert.match(freeze, /-d 169\.254\.169\.123 -p udp --dport 123/);
  assert.match(freeze, /iptables -w -A USAGE_HOST_MANAGEMENT -j REJECT/);
  assert.match(freeze, /ip6tables -w -A USAGE_HOST_MANAGEMENT -j REJECT/);
  assert.match(freeze, /-I OUTPUT 1 -j USAGE_HOST_MANAGEMENT/);
  assert.doesNotMatch(freeze, /RELATED|--ctstate ESTABLISHED -j ACCEPT|--dport 443 -j ACCEPT|0\.0\.0\.0\/0/);
  assert.match(freeze, /changedAddressesRequireReadmission/);
  assert.match(freeze, /requiresActualUid1000NativePostgresDnatAndContainerHostInternetImdsDenialProof':True/);
});

test('actual PostgreSQL DNAT exceptions admit only the canonical owner, direction and original tuple', () => {
  const freeze = script.match(/cat > \/usr\/local\/sbin\/usage-freeze-host-egress <<'SH'\n([\s\S]*?)\nSH/)[1];
  const outputRule = freeze.split('\n').find((line) => line.startsWith('iptables -w -A USAGE_HOST_MANAGEMENT -o docker0'));
  const replyRule = policy.split('\n').find((line) => line.trim().startsWith('"$tool" -w -A USAGE_NO_HOST -i docker0 -p tcp'));
  assert.ok(outputRule && replyRule, 'both actual rule definitions required');
  // Read match fields from the installed rules rather than reimplementing their
  // values in a separate allowlist. This is a predicate mock, not a kernel proof.
  function matches(rule, packet) {
    const fields = Object.fromEntries([...rule.matchAll(/(-o|-i|-p|--uid-owner|--ctstate|--ctdir|--ctorigdst|--ctorigdstport) ([^ ]+)/g)].map((m) => [m[1], m[2]]));
    assert.equal(rule.trim().endsWith('-j ACCEPT'), true);
    const mapping = { '-o': 'outputInterface', '-i': 'inputInterface', '-p': 'protocol', '--uid-owner': 'uid', '--ctdir': 'direction', '--ctorigdst': 'originalDestination', '--ctorigdstport': 'originalPort' };
    return Object.entries(fields).every(([key, value]) => key === '--ctstate' ? value.split(',').includes(packet.state) : String(packet[mapping[key]]) === value);
  }
  const query = { outputInterface: 'docker0', protocol: 'tcp', uid: 1000, state: 'NEW', direction: 'ORIGINAL', originalDestination: '127.0.0.1', originalPort: 5437 };
  assert.equal(matches(outputRule, query), true);
  assert.equal(matches(outputRule, { ...query, state: 'ESTABLISHED' }), true);
  for (const change of [
    { uid: 0 }, { uid: 1001 }, { direction: 'REPLY' }, { state: 'RELATED' },
    { originalDestination: '169.254.169.254' }, { originalDestination: '172.31.240.1' },
    { originalDestination: '1.1.1.1' }, { originalPort: 5432 }, { outputInterface: 'eth0' }, { protocol: 'udp' },
  ]) assert.equal(matches(outputRule, { ...query, ...change }), false, JSON.stringify(change));
  const reply = { inputInterface: 'docker0', protocol: 'tcp', state: 'ESTABLISHED', direction: 'REPLY', originalDestination: '127.0.0.1', originalPort: 5437 };
  assert.equal(matches(replyRule, reply), true);
  for (const change of [
    { direction: 'ORIGINAL' }, { state: 'NEW' }, { state: 'RELATED' }, { originalDestination: '172.31.240.1' },
    { originalDestination: '169.254.169.254' }, { originalPort: 5432 }, { inputInterface: 'eth0' }, { protocol: 'udp' },
  ]) assert.equal(matches(replyRule, { ...reply, ...change }), false, JSON.stringify(change));
  assert.ok(freeze.indexOf(outputRule) < freeze.indexOf('iptables -w -A USAGE_HOST_MANAGEMENT -j REJECT'));
  const check = script.match(/cat > \/usr\/local\/sbin\/usage-check-controller <<'SH'\n([\s\S]*?)\nSH/)[1];
  assert.match(check, /daemon\.get\('userland-proxy'\) is False/);
  assert.match(check, /iptables -C USAGE_NO_HOST .*--ctdir REPLY --ctorigdst 127\.0\.0\.1 --ctorigdstport 5437 -j ACCEPT/);
});

test('management finalization is explicit, stops agent before copy/mount, and retains the new-command proof as pending', () => {
  const finalize = script.match(/cat > \/usr\/local\/sbin\/usage-finalize-management <<'SH'\n([\s\S]*?)\nSH/)[1];
  const unit = script.match(/cat > \/etc\/systemd\/system\/usage-management-finalization.service <<'UNIT'\n([\s\S]*?)\nUNIT/)[1];
  assert.ok(finalize.indexOf('systemctl stop "$agent"') < finalize.indexOf('cp -a /var/lib/amazon/ssm/.'));
  assert.ok(finalize.indexOf('cp -a /var/lib/amazon/ssm/.') < finalize.indexOf('mount --bind /srv/usage/management/ssm-state'));
  assert.ok(finalize.indexOf('mount --bind /srv/usage/management/ssm-log') < finalize.indexOf('systemctl start "$agent"'));
  assert.match(finalize, /'independentNewCommandVerified':False/);
  assert.match(finalize, /'capacityAccepted':False/);
  assert.doesNotMatch(unit, /WantedBy=|Restart=always/);
  assert.doesNotMatch(script, /systemctl (?:enable|start|restart).*usage-management-finalization/);
  assert.match(script, /mountpoint -q \/var\/lib\/amazon\/ssm/);
  assert.match(script, /mountpoint -q \/var\/log\/amazon\/ssm/);
});

test('runtime projection is group-readable but cannot replace approved Node path, bytes or version', () => {
  assert.match(script, /chown root:ubuntu \/srv\/usage\/control\/node-runtime.json/);
  assert.match(script, /chmod 0640 \/srv\/usage\/control\/node-runtime.json/);
  const check = script.match(/cat > \/usr\/local\/sbin\/usage-check-controller <<'SH'\n([\s\S]*?)\nSH/)[1];
  assert.match(check, /runtime==installed/);
  assert.match(check, /runtime\['path'\]=='\/srv\/usage\/tools\/node\/'.*archiveRoot/);
  assert.match(check, /hashlib\.file_digest\(p\.open\('rb'\),'sha256'\)\.hexdigest\(\)==runtime\['sha256'\]/);
  assert.match(check, /subprocess\.check_output\(\[str\(p\),'--version'\]/);
  assert.match(check, /stat\.S_IMODE\(s\.st_mode\)==0o750/);
});
