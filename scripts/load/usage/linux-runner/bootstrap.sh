#!/usr/bin/env bash
# Reviewed runner preparation only. Never starts a campaign, changes AWS, or accepts a gate.
# Nonsecret config schema is validated below. Install mode is intentionally one-shot.
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

die() { printf '%s\n' "usage runner bootstrap: $1" >&2; exit 1; }
mode=${1:-}
config=${2:-}
[[ -n "$config" && -f "$config" && ! -L "$config" ]] || die 'regular config file required'
[[ "$mode" == --validate-config || "$mode" == --render-policy || "$mode" == --install ]] || die 'mode must be --validate-config, --render-policy, or --install'

# This path is also used by local tests. It performs no privileged operation.
python3 - "$config" <<'PY'
import base64, datetime, json, re, sys, urllib.parse
def need(ok, label):
    if not ok: raise ValueError(label)
def keys(value, expected, label):
    need(isinstance(value, dict) and set(value) == set(expected.split()), label)
def text(value, pattern, label):
    need(isinstance(value, str) and re.fullmatch(pattern, value), label)
def digest(value): text(value, r'[0-9a-f]{64}', 'sha256'); need(value != '0'*64, 'zero sha256')
def instant(value):
    text(value, r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', 'UTC timestamp')
    return datetime.datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
try:
    with open(sys.argv[1], encoding='utf-8') as f: c = json.load(f)
    keys(c, 'schemaVersion runId instance executorUser sftpUser sftpAuthorizedKey returnAgeRecipient ssmAgent artifacts controller', 'config keys')
    need(type(c['schemaVersion']) is int and c['schemaVersion'] == 1, 'schemaVersion')
    text(c['runId'], r'[a-z0-9][a-z0-9-]{7,63}', 'runId')
    keys(c['instance'], 'instanceId region launchTimeUtc deadlineUtc dataVolumeId rootVolumeId rootGiB dataGiB', 'instance keys')
    i = c['instance']; text(i['instanceId'], r'i-[0-9a-f]{17}', 'instanceId')
    need(i['region'] == 'us-east-1', 'region')
    for k in ('dataVolumeId', 'rootVolumeId'): text(i[k], r'vol-[0-9a-f]{17}', k)
    need(i['dataVolumeId'] != i['rootVolumeId'], 'distinct volumes')
    need(type(i['rootGiB']) is int and i['rootGiB'] == 30 and type(i['dataGiB']) is int and i['dataGiB'] == 200, 'volume budgets')
    launch, end = instant(i['launchTimeUtc']), instant(i['deadlineUtc'])
    need(datetime.timedelta(0) < end-launch <= datetime.timedelta(hours=8), 'absolute eight-hour deadline')
    need(c['executorUser'] == 'ubuntu' and c['sftpUser'] == 'usage-transfer', 'fixed users')
    text(c['sftpAuthorizedKey'], r'ssh-ed25519 [A-Za-z0-9+/]{68}', 'public ed25519 key only')
    key = base64.b64decode(c['sftpAuthorizedKey'].split()[1], validate=True)
    need(len(key) == 51 and key[:19] == bytes.fromhex('0000000b')+b'ssh-ed25519'+bytes.fromhex('00000020'), 'ed25519 encoding')
    text(c['returnAgeRecipient'], r'age1[023456789acdefghjklmnpqrstuvwxyz]{58}', 'public age recipient only')
    keys(c['ssmAgent'], 'version snapRevision', 'agent keys')
    text(c['ssmAgent']['version'], r'\d+\.\d+\.\d+\.\d+', 'agent version')
    text(c['ssmAgent']['snapRevision'], r'[1-9][0-9]*', 'snap revision')
    keys(c['artifacts'], 'node age debs', 'artifacts keys')
    for name in ('node', 'age'):
        a = c['artifacts'][name]; keys(a, 'url sha256 version archiveRoot', name+' keys'); digest(a['sha256'])
        if name == 'node':
            text(a['version'], r'v22\.\d+\.\d+', 'host Node version')
            need(a['archiveRoot'] == 'node-'+a['version']+'-linux-x64', 'Node archive root')
            need(a['url'] == 'https://nodejs.org/download/release/'+a['version']+'/'+a['archiveRoot']+'.tar.xz', 'Node pinned URL')
        else:
            text(a['version'], r'v\d+\.\d+\.\d+', 'age version'); need(a['archiveRoot'] == 'age', 'age archive root')
            need(a['url'] == 'https://github.com/FiloSottile/age/releases/download/'+a['version']+'/age-'+a['version']+'-linux-amd64.tar.gz', 'age pinned URL')
    need(isinstance(c['artifacts']['debs'], list) and 5 <= len(c['artifacts']['debs']) <= 80, 'pinned deb closure')
    packages = set()
    for a in c['artifacts']['debs']:
        keys(a, 'url sha256 package version', 'deb keys'); digest(a['sha256'])
        text(a['package'], r'[a-z0-9][a-z0-9+.-]*', 'deb package'); text(a['version'], r'[A-Za-z0-9:~+._-]+', 'deb version')
        need(a['package'] not in packages, 'duplicate deb'); packages.add(a['package'])
        u = urllib.parse.urlsplit(a['url'])
        need(u.scheme == 'https' and not u.query and not u.fragment and not u.username and not u.password, 'deb HTTPS URL')
        need(u.hostname in ('download.docker.com', 'archive.ubuntu.com', 'security.ubuntu.com') and (u.path.endswith('_amd64.deb') or u.path.endswith('_all.deb')) and '..' not in u.path, 'deb official amd64/all URL')
        need('/latest/' not in u.path and '/current/' not in u.path, 'moving URL')
    need({'docker-ce', 'docker-ce-cli', 'containerd.io', 'iptables', 'openssh-server', 'openssh-sftp-server'} <= packages, 'required packages')
    keys(c['controller'], 'script sha256 config configSha256', 'controller keys')
    need(c['controller']['script'] == '/srv/usage/control/run-campaign.sh' and c['controller']['config'] == '/srv/usage/control/campaign.json', 'fixed controller paths')
    digest(c['controller']['sha256']); digest(c['controller']['configSha256'])
except (ValueError, TypeError, KeyError, json.JSONDecodeError) as e:
    print('usage runner config refused: '+str(e), file=sys.stderr); sys.exit(1)
PY

[[ "$mode" != --validate-config ]] || { printf '%s\n' 'config-valid; preparation-only; no resources changed'; exit 0; }

# Root INPUT blocks the bridge gateway/host; early FORWARD blocks routed Internet,
# IMDS and link-local endpoints. DOCKER-USER is additionally required after startup.
# Canonical roles communicate over loopback in the PG owner's namespace. The
# host UID1000 restore client alone needs Docker's published 127.0.0.1:5437 DNAT.
render_firewall() {
  cat <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
for tool in iptables ip6tables; do
  "$tool" -w -N USAGE_NO_HOST 2>/dev/null || "$tool" -w -F USAGE_NO_HOST
  if [[ "$tool" == iptables ]]; then
    "$tool" -w -A USAGE_NO_HOST -i docker0 -p tcp -m conntrack --ctstate ESTABLISHED --ctdir REPLY --ctorigdst 127.0.0.1 --ctorigdstport 5437 -j ACCEPT
  fi
  "$tool" -w -A USAGE_NO_HOST -i docker0 -j DROP
  "$tool" -w -C INPUT -j USAGE_NO_HOST 2>/dev/null || "$tool" -w -I INPUT 1 -j USAGE_NO_HOST
  "$tool" -w -N USAGE_NO_EGRESS 2>/dev/null || "$tool" -w -F USAGE_NO_EGRESS
  "$tool" -w -A USAGE_NO_EGRESS -i docker0 -j DROP
  "$tool" -w -C FORWARD -j USAGE_NO_EGRESS 2>/dev/null || "$tool" -w -I FORWARD 1 -j USAGE_NO_EGRESS
done
if [[ "${1:-}" == --after-docker ]]; then
  iptables -w -S DOCKER-USER >/dev/null
  iptables -w -C DOCKER-USER -i docker0 -j DROP 2>/dev/null || iptables -w -I DOCKER-USER 1 -i docker0 -j DROP
fi
SH
}
[[ "$mode" != --render-policy ]] || { render_firewall; exit 0; }

[[ "$EUID" == 0 ]] || die 'install requires root on the new owned Ubuntu runner'
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || die 'Linux x86-64 required'
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || die 'Ubuntu Noble 24.04 required'
[[ $(id -u ubuntu) == 1000 ]] || die 'existing ubuntu UID1000 required'
[[ $(stat -c '%u:%a' "$config") == 0:600 ]] || die 'config must be root-owned mode0600'
[[ ! -e /srv/usage ]] || die 'one-shot bootstrap: existing data mount/state preserved'
cfg() { python3 - "$config" "$1" <<'PY'
import json, sys
v=json.load(open(sys.argv[1]))
for k in sys.argv[2].split('.'): v=v[k]
print(v)
PY
}
deadline=$(cfg instance.deadlineUtc)
(( $(date -u +%s) < $(date -u -d "$deadline" +%s) )) || die 'deadline expired'

# A separately installed user-data stop timer is required before this preparation.
# Replace neither its absolute deadline nor its stop (never terminate/delete) policy.
systemctl is-active --quiet usage-absolute-stop.timer || die 'initial absolute stop timer absent'
[[ $(cat /etc/usage-runner-deadline-utc) == "$deadline" ]] || die 'initial deadline differs'

# Bind the exact Nitro EBS device; never format an existing filesystem or the root.
volume=$(cfg instance.dataVolumeId)
device=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${volume//-/}
for unused in {1..60}; do [[ -b "$device" ]] && break; sleep 1; done
[[ -b "$device" ]] || die 'exact data volume device absent'
device=$(readlink -f "$device")
[[ $(blockdev --getsize64 "$device") == 214748364800 ]] || die 'data volume size differs'
[[ -z $(lsblk -nr -o MOUNTPOINTS "$device" | tr -d '[:space:]') ]] || die 'data device already mounted'
[[ -z $(lsblk -nr -o FSTYPE "$device" | tr -d '[:space:]') ]] || die 'data filesystem exists; preserve it'
[[ $(lsblk -nr -o TYPE "$device" | wc -l) == 1 ]] || die 'partitioned device refused'
mkfs.ext4 -q -L usage-evidence "$device"
uuid=$(blkid -s UUID -o value "$device")
mkdir -m 0700 /srv/usage
printf 'UUID=%s /srv/usage ext4 defaults,nodev,nosuid 0 2\n' "$uuid" >> /etc/fstab
mount /srv/usage
mountpoint -q /srv/usage || die 'data mount failed'
mkdir -m 0700 /srv/usage/{host,downloads,keys,staging,raw,docker,containerd,log,tools,work}
chown root:ubuntu /srv/usage/tools
chmod 0750 /srv/usage/tools
mkdir -m 0750 /srv/usage/control
chown ubuntu:ubuntu /srv/usage/work
chgrp ubuntu /srv/usage/control
chown root:ubuntu /srv/usage
chmod 0710 /srv/usage
cp "$config" /srv/usage/host/bootstrap-config.json
cp "$0" /srv/usage/host/bootstrap.sh
exec > >(tee -a /srv/usage/host/bootstrap.log) 2>&1
trap 's=$?; printf "bootstrap failed exit=%s at line=%s; evidence retained; workload never started\n" "$s" "$LINENO"; exit "$s"' ERR

# Record only bounded instance identity; neither credentials nor an IMDS token is logged.
token=$(curl --silent --show-error --fail --max-time 5 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)
actual_id=$(curl --silent --show-error --fail --max-time 5 -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/instance-id)
unset token
[[ "$actual_id" == "$(cfg instance.instanceId)" ]] || die 'instance identity differs'

# No asynchronous package/snap installs during acceptance. The AMI agent is accepted
# only at its reviewed installed version/revision; bootstrap never refreshes it.
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer
systemctl stop apt-daily.service apt-daily-upgrade.service unattended-upgrades.service
systemctl mask apt-daily.service apt-daily-upgrade.service unattended-upgrades.service
snap list amazon-ssm-agent > /srv/usage/host/ssm-snap.txt
read -r snap_version snap_revision < <(awk 'NR==2 {print $2, $3}' /srv/usage/host/ssm-snap.txt)
[[ "$snap_version" == "$(cfg ssmAgent.version)" && "$snap_revision" == "$(cfg ssmAgent.snapRevision)" ]] || die 'installed SSM agent pin differs'
snap refresh --hold=24h

# All packages, including dependency closure, are hash bound. No apt latest, curl
# pipe-to-shell, --fix-broken install, or remote execution occurs here.
python3 - "$config" /srv/usage/downloads <<'PY'
import hashlib, json, pathlib, urllib.request, sys
c=json.load(open(sys.argv[1])); dest=pathlib.Path(sys.argv[2])
items=[(k,c['artifacts'][k]) for k in ('node','age')]
items += [(a['package']+'.deb',a) for a in c['artifacts']['debs']]
for name,a in items:
    p=dest/name
    with urllib.request.urlopen(a['url'], timeout=60) as response, p.open('xb') as out:
        if not response.geturl().startswith('https://'): raise ValueError('insecure redirect')
        while block:=response.read(1024*1024): out.write(block)
    if hashlib.file_digest(p.open('rb'), 'sha256').hexdigest()!=a['sha256']: raise ValueError('artifact hash mismatch: '+name)
PY
[[ ! -e /usr/sbin/policy-rc.d ]] || die 'pre-existing service install policy refused'
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
chmod 0755 /usr/sbin/policy-rc.d
for package in /srv/usage/downloads/*.deb; do
  actual_package=$(dpkg-deb -f "$package" Package)
  actual_version=$(dpkg-deb -f "$package" Version)
  actual_arch=$(dpkg-deb -f "$package" Architecture)
  [[ "$actual_arch" == amd64 || "$actual_arch" == all ]] || die 'deb architecture differs'
  python3 - "$config" "$actual_package" "$actual_version" <<'PY'
import json,sys
assert any(a['package']==sys.argv[2] and a['version']==sys.argv[3] for a in json.load(open(sys.argv[1]))['artifacts']['debs']), 'deb metadata differs'
PY
done
dpkg -i /srv/usage/downloads/*.deb
dpkg --audit | tee /srv/usage/host/dpkg-audit.txt
[[ ! -s /srv/usage/host/dpkg-audit.txt ]] || die 'incomplete pinned package closure'
rm /usr/sbin/policy-rc.d

python3 - "$config" <<'PY'
import json,pathlib,posixpath,tarfile
c=json.load(open(__import__('sys').argv[1]))
for name in ('node','age'):
    root=c['artifacts'][name]['archiveRoot']; dest=pathlib.Path('/srv/usage/tools')/name; dest.mkdir(mode=0o755)
    with tarfile.open('/srv/usage/downloads/'+name) as archive:
        members=archive.getmembers()
        for m in members:
            p=pathlib.PurePosixPath(m.name)
            if p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0]!=root or not (m.isfile() or m.isdir() or m.issym()): raise ValueError('unsafe archive member')
            if m.issym():
                target=posixpath.normpath(posixpath.join(str(p.parent),m.linkname))
                if m.linkname.startswith('/') or not target.startswith(root+'/'): raise ValueError('unsafe archive link')
        archive.extractall(dest, members=members, filter='data')
PY
chown -R root:ubuntu /srv/usage/tools
find /srv/usage/tools -type d -exec chmod 0750 {} +
find /srv/usage/tools -type f -exec chmod 0750 {} +
ln -s "/srv/usage/tools/node/$(cfg artifacts.node.archiveRoot)/bin/node" /usr/local/bin/node
ln -s "/srv/usage/tools/node/$(cfg artifacts.node.archiveRoot)/bin/npm" /usr/local/bin/npm
ln -s "/srv/usage/tools/node/$(cfg artifacts.node.archiveRoot)/bin/npx" /usr/local/bin/npx
ln -s /srv/usage/tools/age/age/age /usr/local/bin/age
ln -s /srv/usage/tools/age/age/age-keygen /usr/local/bin/age-keygen
[[ $(/usr/local/bin/node --version) == "$(cfg artifacts.node.version)" ]] || die 'Node version differs'
[[ $(/usr/local/bin/age --version) == "$(cfg artifacts.age.version)" ]] || die 'age version differs'
python3 - "$config" <<'PY'
import hashlib,json,os,pathlib,subprocess
c=json.load(open(__import__('sys').argv[1]))
p='/srv/usage/tools/node/'+c['artifacts']['node']['archiveRoot']+'/bin/node'
record={'schemaVersion':1,'kind':'usage_linux_node_runtime','path':p,'sha256':hashlib.file_digest(open(p,'rb'),'sha256').hexdigest(),'version':subprocess.check_output([p,'--version'],text=True).strip()}
with pathlib.Path('/srv/usage/host/node-binary.json').open('x') as f: json.dump(record,f)
with pathlib.Path('/srv/usage/control/node-runtime.json').open('x') as f: json.dump(record,f)
PY
chown root:ubuntu /srv/usage/control/node-runtime.json
chmod 0640 /srv/usage/control/node-runtime.json
# Syntax/checksum validation by the pinned implementation. This empty encrypted
# canary is not a claim that the operator possesses the return private key.
/usr/local/bin/age -r "$(cfg returnAgeRecipient)" -o /srv/usage/host/recipient-syntax-canary.age /dev/null
/usr/local/bin/age-keygen -o /srv/usage/keys/input-identity.txt 2>/srv/usage/host/age-keygen.log
/usr/local/bin/age-keygen -y /srv/usage/keys/input-identity.txt > /srv/usage/host/input-recipient.txt
printf '%s\n' "$(cfg returnAgeRecipient)" > /srv/usage/host/return-recipient.txt

# Persistent host journals and both Docker storage paths live on the retained data.
systemctl stop docker.socket docker.service containerd.service
[[ ! -d /var/lib/docker || -z $(ls -A /var/lib/docker) ]] || die 'existing Docker data refused'
[[ ! -d /var/lib/containerd || -z $(ls -A /var/lib/containerd) ]] || die 'existing containerd data refused'
mkdir -p /etc/docker /etc/containerd /etc/systemd/journald.conf.d
cat > /etc/docker/daemon.json <<'JSON'
{"data-root":"/srv/usage/docker","features":{"containerd-snapshotter":true,"lazy-pull":false},"firewall-backend":"iptables","iptables":true,"ip6tables":true,"ipv6":false,"dns":["127.0.0.1"],"bip":"172.31.240.1/24","userland-proxy":false,"live-restore":false,"log-driver":"json-file"}
JSON
printf 'version = 2\nroot = "/srv/usage/containerd"\nstate = "/run/containerd"\n' > /etc/containerd/config.toml
mkdir -p /srv/usage/log/journal /var/log/journal
mount --bind /srv/usage/log/journal /var/log/journal
printf '/srv/usage/log/journal /var/log/journal none bind 0 0\n' >> /etc/fstab
printf '[Journal]\nStorage=persistent\n' > /etc/systemd/journald.conf.d/usage.conf
systemctl restart systemd-journald
journalctl --flush
# Finalization is a separate, explicitly invoked asynchronous unit AFTER bootstrap
# has returned. Never stop the agent delivering this bootstrap command. The delay
# lets the later unit-start command return; its outcome is retained independently.
# A successful NEW pinned SSM command after this restart is still an admission gate.
cat > /usr/local/sbin/usage-finalize-management <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ ! -e /srv/usage/host/management-finalization.json ]]
mountpoint -q /srv/usage
systemctl is-active --quiet usage-absolute-stop.timer
agent=snap.amazon-ssm-agent.amazon-ssm-agent.service
systemctl is-active --quiet "$agent"
mkdir -m 0700 /srv/usage/management
mkdir -m 0700 /srv/usage/management/{ssm-state,ssm-log}
[[ -d /var/lib/amazon/ssm && ! -L /var/lib/amazon/ssm ]]
[[ -d /var/log/amazon/ssm && ! -L /var/log/amazon/ssm ]]
systemctl stop "$agent"
[[ $(systemctl is-active "$agent" || true) == inactive ]]
cp -a /var/lib/amazon/ssm/. /srv/usage/management/ssm-state/
cp -a /var/log/amazon/ssm/. /srv/usage/management/ssm-log/
sync -f /srv/usage
mount --bind /srv/usage/management/ssm-state /var/lib/amazon/ssm
mount --bind /srv/usage/management/ssm-log /var/log/amazon/ssm
mountpoint -q /var/lib/amazon/ssm
mountpoint -q /var/log/amazon/ssm
[[ $(stat -c '%d' /srv/usage) == "$(stat -c '%d' /var/lib/amazon/ssm)" ]]
[[ $(stat -c '%d' /srv/usage) == "$(stat -c '%d' /var/log/amazon/ssm)" ]]
printf '/srv/usage/management/ssm-state /var/lib/amazon/ssm none bind 0 0\n/srv/usage/management/ssm-log /var/log/amazon/ssm none bind 0 0\n' >> /etc/fstab
systemctl start "$agent"
systemctl is-active --quiet "$agent"
python3 - <<'PY'
import datetime,json,pathlib
with pathlib.Path('/srv/usage/host/management-finalization.json').open('x') as f:
    json.dump({'schemaVersion':1,'finalizedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'localStateAndLogsMounted':True,'agentRestarted':True,'independentNewCommandVerified':False,'capacityAccepted':False},f)
PY
SH
chmod 0700 /usr/local/sbin/usage-finalize-management
cat > /etc/systemd/system/usage-management-finalization.service <<'UNIT'
[Unit]
Description=Explicit finalization of retained SSM local state and logs
RequiresMountsFor=/srv/usage
[Service]
Type=oneshot
ExecStartPre=/usr/bin/sleep 15
ExecStart=/usr/local/sbin/usage-finalize-management
Restart=no
StandardOutput=append:/srv/usage/log/management-finalization.stdout.log
StandardError=append:/srv/usage/log/management-finalization.stderr.log
UNIT

render_firewall > /usr/local/sbin/usage-container-policy
chmod 0700 /usr/local/sbin/usage-container-policy
# Management egress is frozen only at explicit campaign start, after offline
# staging. DNS endpoint changes are a hold/re-admission boundary, never a reason
# to open arbitrary HTTPS. No IPv6 outside loopback is admitted.
cat > /usr/local/sbin/usage-freeze-host-egress <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ ! -e /srv/usage/host/host-egress-frozen.json ]]
ip -4 route show | grep -Eq '^10\.247\.0\.0/24 .* scope link '
python3 - <<'PY'
import datetime,ipaddress,json,pathlib,socket
names=('ssm.us-east-1.amazonaws.com','ssmmessages.us-east-1.amazonaws.com')
addresses={n:sorted({item[4][0] for item in socket.getaddrinfo(n,443,socket.AF_INET,socket.SOCK_STREAM)}) for n in names}
assert all(1<=len(v)<=32 for v in addresses.values()), 'bounded SSM address set'
assert all(ipaddress.ip_address(a).is_global for v in addresses.values() for a in v), 'public SSM addresses required'
with pathlib.Path('/srv/usage/host/management-egress.json').open('x') as f:
    json.dump({'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'names':addresses,'dnsResolver':'10.247.0.2','ntp':'169.254.169.123','rootOnlyImds':'169.254.169.254','changedAddressesRequireReadmission':True},f)
PY
iptables -w -N USAGE_HOST_MANAGEMENT
iptables -w -A USAGE_HOST_MANAGEMENT -o lo -j ACCEPT
# Docker's OUTPUT DNAT precedes this filter. Match the immutable original tuple,
# owner and direction; do not allow container-initiated or general bridge egress.
iptables -w -A USAGE_HOST_MANAGEMENT -o docker0 -p tcp -m owner --uid-owner 1000 -m conntrack --ctstate NEW,ESTABLISHED --ctdir ORIGINAL --ctorigdst 127.0.0.1 --ctorigdstport 5437 -j ACCEPT
for protocol in udp tcp; do
  iptables -w -A USAGE_HOST_MANAGEMENT -d 10.247.0.2 -p "$protocol" --dport 53 -j ACCEPT
done
while read -r address; do
  iptables -w -A USAGE_HOST_MANAGEMENT -d "$address" -p tcp --dport 443 -m owner --uid-owner 0 -j ACCEPT
done < <(python3 -c "import json; c=json.load(open('/srv/usage/host/management-egress.json')); print('\\n'.join(sorted({a for v in c['names'].values() for a in v})))")
iptables -w -A USAGE_HOST_MANAGEMENT -d 169.254.169.254 -p tcp --dport 80 -m owner --uid-owner 0 -j ACCEPT
iptables -w -A USAGE_HOST_MANAGEMENT -d 169.254.169.123 -p udp --dport 123 -j ACCEPT
iptables -w -A USAGE_HOST_MANAGEMENT -j REJECT
iptables -w -I OUTPUT 1 -j USAGE_HOST_MANAGEMENT
ip6tables -w -N USAGE_HOST_MANAGEMENT
ip6tables -w -A USAGE_HOST_MANAGEMENT -o lo -j ACCEPT
ip6tables -w -A USAGE_HOST_MANAGEMENT -j REJECT
ip6tables -w -I OUTPUT 1 -j USAGE_HOST_MANAGEMENT
iptables -w -S USAGE_HOST_MANAGEMENT > /srv/usage/host/host-egress-v4.txt
ip6tables -w -S USAGE_HOST_MANAGEMENT > /srv/usage/host/host-egress-v6.txt
python3 - <<'PY'
import datetime,json,pathlib
with pathlib.Path('/srv/usage/host/host-egress-frozen.json').open('x') as f:
    json.dump({'frozenAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'capacityAccepted':False,'requiresActualEndpointDnsNtpAndContainerNegativeProbesBeforeMeasurement':True,'requiresActualUid1000NativePostgresDnatAndContainerHostInternetImdsDenialProof':True},f)
PY
SH
chmod 0700 /usr/local/sbin/usage-freeze-host-egress
printf 'net.ipv6.conf.all.disable_ipv6=1\nnet.ipv6.conf.default.disable_ipv6=1\nnet.bridge.bridge-nf-call-iptables=1\nnet.bridge.bridge-nf-call-ip6tables=1\n' > /etc/sysctl.d/90-usage-runner.conf
modprobe br_netfilter
sysctl --system > /srv/usage/host/sysctl.txt
cat > /etc/systemd/system/usage-container-policy.service <<'UNIT'
[Unit]
Description=Fail closed for canonical container egress before Docker
Before=docker.service
RequiresMountsFor=/srv/usage
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/usage-container-policy
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
mkdir -p /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/usage.conf <<'UNIT'
[Unit]
Requires=usage-container-policy.service
After=usage-container-policy.service
RequiresMountsFor=/srv/usage
[Service]
ExecStartPost=/usr/local/sbin/usage-container-policy --after-docker
UNIT
usermod -a -G docker ubuntu
systemctl daemon-reload
systemctl enable usage-container-policy.service docker.service containerd.service
systemctl start usage-container-policy.service containerd.service docker.service
docker info --format '{{json .DriverStatus}}' > /srv/usage/host/docker-store.json
grep -q 'io.containerd.snapshotter.v1' /srv/usage/host/docker-store.json || die 'containerd image store absent'
[[ $(docker info --format '{{.DockerRootDir}}') == /srv/usage/docker ]] || die 'Docker data root differs'
[[ -z $(docker ps -aq) ]] || die 'bootstrap requires empty Docker container inventory'
iptables -S INPUT > /srv/usage/host/iptables-input.txt
iptables -S FORWARD > /srv/usage/host/iptables-forward.txt
iptables -S DOCKER-USER > /srv/usage/host/iptables-docker-user.txt

# Transfer account sees ciphertext only. Never give it Docker, raw evidence, input
# identity, controller, a shell, a PTY or network forwarding. SSM forwards localhost.
[[ ! $(getent passwd usage-transfer) ]] || die 'pre-existing transfer user refused'
useradd --no-create-home --home-dir /incoming --shell /usr/sbin/nologin usage-transfer
# Unlock only the account state for public-key authentication; no usable password
# is disclosed, and both password authentication and empty passwords stay disabled.
usermod --password "$(openssl rand -hex 32 | openssl passwd -6 -stdin)" usage-transfer
mkdir -p /srv/usage/transfer/{incoming,outgoing} /etc/ssh/usage-authorized-keys
chmod 0755 /srv/usage/transfer
chown usage-transfer:usage-transfer /srv/usage/transfer/{incoming,outgoing}
chmod 0700 /srv/usage/transfer/{incoming,outgoing}
printf '%s\n' "$(cfg sftpAuthorizedKey)" > /etc/ssh/usage-authorized-keys/usage-transfer
chmod 0644 /etc/ssh/usage-authorized-keys/usage-transfer
ssh-keygen -A
cat > /etc/ssh/sshd_config_usage <<'SSH'
Port 22
ListenAddress 127.0.0.1
HostKey /etc/ssh/ssh_host_ed25519_key
PidFile /run/sshd-usage.pid
AuthorizedKeysFile /etc/ssh/usage-authorized-keys/%u
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PermitEmptyPasswords no
AllowUsers usage-transfer
UsePAM no
AllowTcpForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
PermitTTY no
Subsystem sftp internal-sftp
Match User usage-transfer
    ChrootDirectory /srv/usage/transfer
    ForceCommand internal-sftp -d /incoming -u 0077
SSH
mkdir -p /run/sshd
/usr/sbin/sshd -t -f /etc/ssh/sshd_config_usage
systemctl disable --now ssh.socket ssh.service
systemctl mask ssh.socket ssh.service
cp /etc/ssh/ssh_host_ed25519_key.pub /srv/usage/host/sftp-host-public-key.txt
ssh-keygen -lf /srv/usage/host/sftp-host-public-key.txt -E sha256 > /srv/usage/host/sftp-host-fingerprint.txt
cat > /etc/systemd/system/usage-sftp.service <<'UNIT'
[Unit]
Description=Loopback SFTP for encrypted runner inputs and returns
RequiresMountsFor=/srv/usage
[Service]
Type=simple
ExecStart=/usr/sbin/sshd -D -e -f /etc/ssh/sshd_config_usage
Restart=no
StandardOutput=append:/srv/usage/log/sftp.log
StandardError=append:/srv/usage/log/sftp.log
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now usage-sftp.service

# Hash checking occurs again at EVERY explicit start, after ciphertext admission.
# Missing files remain a start refusal. No campaign service is enabled or started.
cat > /usr/local/sbin/usage-check-controller <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
python3 - <<'PY'
import datetime,grp,hashlib,json,os,pathlib,stat,subprocess
c=json.load(open('/srv/usage/host/bootstrap-config.json'))
assert datetime.datetime.now(datetime.timezone.utc) < datetime.datetime.fromisoformat(c['instance']['deadlineUtc'].replace('Z','+00:00')), 'deadline expired'
for p,h,mode in ((c['controller']['script'],c['controller']['sha256'],0o750),(c['controller']['config'],c['controller']['configSha256'],0o640)):
    p=pathlib.Path(p); s=p.lstat()
    assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_gid==grp.getgrnam('ubuntu').gr_gid and stat.S_IMODE(s.st_mode)==mode, 'controller ownership/mode'
    assert hashlib.file_digest(p.open('rb'),'sha256').hexdigest()==h, 'controller hash'
r=pathlib.Path('/srv/usage/control/node-runtime.json'); s=r.lstat()
assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_gid==grp.getgrnam('ubuntu').gr_gid and stat.S_IMODE(s.st_mode)==0o640, 'runtime projection ownership/mode'
runtime=json.load(r.open()); installed=json.load(open('/srv/usage/host/node-binary.json'))
assert runtime==installed and set(runtime)=={'schemaVersion','kind','path','sha256','version'}, 'runtime projection identity'
assert runtime['schemaVersion']==1 and runtime['kind']=='usage_linux_node_runtime', 'runtime schema'
assert runtime['path']=='/srv/usage/tools/node/'+c['artifacts']['node']['archiveRoot']+'/bin/node', 'runtime path'
assert runtime['version']==c['artifacts']['node']['version'], 'runtime version'
p=pathlib.Path(runtime['path']); s=p.lstat()
assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_gid==grp.getgrnam('ubuntu').gr_gid and stat.S_IMODE(s.st_mode)==0o750, 'Node binary ownership/mode'
assert hashlib.file_digest(p.open('rb'),'sha256').hexdigest()==runtime['sha256'], 'Node binary hash'
assert subprocess.check_output([str(p),'--version'],text=True).strip()==runtime['version'], 'actual Node version'
finalized=json.load(open('/srv/usage/host/management-finalization.json'))
assert finalized['localStateAndLogsMounted'] is True and finalized['agentRestarted'] is True, 'management finalization required'
daemon=json.load(open('/etc/docker/daemon.json'))
assert daemon.get('userland-proxy') is False, 'canonical host PostgreSQL requires direct DNAT'
PY
mountpoint -q /srv/usage
mountpoint -q /var/lib/amazon/ssm
mountpoint -q /var/log/amazon/ssm
systemctl is-active --quiet snap.amazon-ssm-agent.amazon-ssm-agent.service
systemctl is-active --quiet usage-absolute-stop.timer
iptables -C INPUT -j USAGE_NO_HOST
iptables -C USAGE_NO_HOST -i docker0 -p tcp -m conntrack --ctstate ESTABLISHED --ctdir REPLY --ctorigdst 127.0.0.1 --ctorigdstport 5437 -j ACCEPT
iptables -C FORWARD -j USAGE_NO_EGRESS
iptables -C DOCKER-USER -i docker0 -j DROP
[[ -z $(docker ps -aq) ]]
SH
chmod 0700 /usr/local/sbin/usage-check-controller
cat > /etc/systemd/system/usage-campaign.service <<'UNIT'
[Unit]
Description=Explicitly admitted canonical synthetic Usage campaign
Requires=docker.service usage-container-policy.service usage-absolute-stop.timer
After=docker.service usage-container-policy.service
RequiresMountsFor=/srv/usage
[Service]
Type=exec
User=ubuntu
Group=ubuntu
SupplementaryGroups=docker
WorkingDirectory=/srv/usage/work
Environment=PATH=/usr/local/bin:/usr/bin:/bin
UMask=0077
ExecStartPre=+/usr/local/sbin/usage-check-controller
ExecStartPre=+/usr/local/sbin/usage-freeze-host-egress
ExecStart=/bin/bash /srv/usage/control/run-campaign.sh /srv/usage/control/campaign.json
Restart=no
KillMode=control-group
TimeoutStopSec=120
StandardOutput=append:/srv/usage/raw/controller.stdout.log
StandardError=append:/srv/usage/raw/controller.stderr.log
UNIT
systemctl daemon-reload
printf '%s\n' 'host-prepared; capacityAccepted=false; productionReady=false; campaign not started' > /srv/usage/host/bootstrap-result.txt
printf '%s\n' 'Public input recipient:'
cat /srv/usage/host/input-recipient.txt
printf '%s\n' 'Public loopback SFTP host key (pin before transfer):'
cat /srv/usage/host/sftp-host-public-key.txt
