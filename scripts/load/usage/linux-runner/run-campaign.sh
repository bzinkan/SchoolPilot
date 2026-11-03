#!/usr/bin/env bash
# Root-owned fixed durable entrypoint; execution remains UID1000 and has no cloud credentials.
set -Eeuo pipefail
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin
for inherited_git_name in ${!GIT_@}; do unset "$inherited_git_name"; done
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1
export GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0
[[ $# == 1 && $1 == /srv/usage/control/campaign.json && $(id -u) == 1000 ]] || { printf '%s\n' 'USAGE_LINUX_WRAPPER_ARGUMENTS' >&2; exit 1; }

# The privileged bootstrap checker separately verifies this projection against the
# root-private bootstrap config. Never give UID1000 access to the input identity.
mapfile -t launch < <(/usr/bin/python3 - <<'PY'
import hashlib,json,os,pathlib,re,stat
def private_path(value,uid,mode):
    p=pathlib.Path(value)
    assert p.is_absolute() and '..' not in p.parts
    for parent in [*reversed(p.parents),p]: assert not parent.is_symlink()
    s=p.lstat(); assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==uid and stat.S_IMODE(s.st_mode)==mode
    return p
def read(p): return json.loads(p.read_bytes())
def digest(p):
    with p.open('rb') as f: return hashlib.file_digest(f,'sha256').hexdigest()
try:
    config=read(private_path('/srv/usage/control/campaign.json',0,0o640))
    assert set(config)=={'requestPath','admissionRecordPath'}
    assert config['requestPath']=='/srv/usage/work/active-request.json'
    assert config['admissionRecordPath']=='/srv/usage/control/launch-admission.json'
    admission=read(private_path(config['admissionRecordPath'],0,0o640))
    assert set(admission)=={'schemaVersion','kind','requestPath','requestSha256'}
    assert admission['schemaVersion']==1 and admission['kind']=='usage_linux_controller_admission'
    assert admission['requestPath']==config['requestPath']
    assert re.fullmatch(r'[a-f0-9]{64}',admission['requestSha256'])
    requested=pathlib.Path(config['requestPath'])
    assert requested.is_relative_to('/srv/usage/work') and requested.suffix=='.json'
    request=private_path(str(requested),1000,0o600); assert digest(request)==admission['requestSha256']
    body=read(request); assert body['schemaVersion']==1 and body['kind']=='usage_linux_campaign_request'
    intent_ref=body['campaignIntent']; intent_path=private_path(intent_ref['path'],1000,0o600)
    assert digest(intent_path)==intent_ref['sha256']==body['campaignIntentSha256']
    intent=read(intent_path); assert intent['kind']=='usage_linux_campaign_intent'
    runner=pathlib.Path('/srv/usage/work/runner/scripts/load/usage/linux-runner')
    for name in ('relocation','preflight','run-campaign','source-checkout'):
        p=private_path(str(runner/(name+'.mjs')),1000,0o600)
        assert digest(p)==intent['toolSha256'][name]
    runtime=read(private_path('/srv/usage/control/node-runtime.json',0,0o640))
    assert set(runtime)=={'schemaVersion','kind','path','sha256','version'}
    assert runtime['schemaVersion']==1 and runtime['kind']=='usage_linux_node_runtime'
    assert re.fullmatch(r'/srv/usage/tools/node/node-v22\.\d+\.\d+-linux-x64/bin/node',runtime['path'])
    assert re.fullmatch(r'[a-f0-9]{64}',runtime['sha256']) and re.fullmatch(r'v22\.\d+\.\d+',runtime['version'])
    node=pathlib.Path(runtime['path']); assert not node.is_symlink()
    for parent in node.parents: assert not parent.is_symlink()
    s=node.lstat(); assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022
    assert digest(node)==runtime['sha256']
    print(node); print(request); print(admission['requestSha256']); print(runtime['version'])
except Exception:
    print('USAGE_LINUX_WRAPPER_BINDING_REFUSED',file=__import__('sys').stderr)
    raise SystemExit(1)
PY
)
[[ ${#launch[@]} == 4 ]] || { printf '%s\n' 'USAGE_LINUX_WRAPPER_BINDING_REFUSED' >&2; exit 1; }
[[ $("${launch[0]}" --version) == "${launch[3]}" ]] || { printf '%s\n' 'USAGE_LINUX_NODE_VERSION_DRIFT' >&2; exit 1; }
exec "${launch[0]}" /srv/usage/work/runner/scripts/load/usage/linux-runner/run-campaign.mjs execute "${launch[1]}" --request-sha256 "${launch[2]}"
