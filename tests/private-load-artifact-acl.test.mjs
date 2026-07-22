import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  preparePrivateOutputDirectory,
  writePrivateJson,
} from "../scripts/load/prepare-classpilot-load-test.mjs";

const BUILTIN_USERS_SID = "S-1-5-32-545";

function runWindowsPowerShell(script, ...args) {
  const result = spawnSync("pwsh.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      SCHOOLPILOT_ACL_TEST_ARG_0: args[0] ?? "",
      SCHOOLPILOT_ACL_TEST_ARG_1: args[1] ?? "",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function grantBuiltinUsersRead(path, directory) {
  runWindowsPowerShell(String.raw`
$ErrorActionPreference = "Stop"
$item = Get-Item -LiteralPath ([IO.Path]::GetFullPath([string]$env:SCHOOLPILOT_ACL_TEST_ARG_0))
$directory = [bool]::Parse([string]$env:SCHOOLPILOT_ACL_TEST_ARG_1)
$security = [IO.FileSystemAclExtensions]::GetAccessControl(
  $item,
  [Security.AccessControl.AccessControlSections]::Access
)
$inheritance = if ($directory) {
  [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [Security.AccessControl.InheritanceFlags]::ObjectInherit
} else {
  [Security.AccessControl.InheritanceFlags]::None
}
$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
  [Security.Principal.SecurityIdentifier]::new("S-1-5-32-545"),
  [Security.AccessControl.FileSystemRights]::ReadAndExecute,
  $inheritance,
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow
))
[IO.FileSystemAclExtensions]::SetAccessControl($item, $security)
`, path, String(directory));
}

function readAclSummary(path) {
  return JSON.parse(runWindowsPowerShell(String.raw`
$ErrorActionPreference = "Stop"
$item = Get-Item -LiteralPath ([IO.Path]::GetFullPath([string]$env:SCHOOLPILOT_ACL_TEST_ARG_0))
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$security = [IO.FileSystemAclExtensions]::GetAccessControl(
  $item,
  [Security.AccessControl.AccessControlSections]::Access
)
$rules = @($security.GetAccessRules(
  $true,
  $true,
  [Security.Principal.SecurityIdentifier]
) | ForEach-Object {
  [ordered]@{
    sid = $_.IdentityReference.Value
    type = $_.AccessControlType.ToString()
    inherited = $_.IsInherited
  }
})
[ordered]@{
  protected = $security.AreAccessRulesProtected
  currentSid = $currentSid
  rules = $rules
} | ConvertTo-Json -Depth 5 -Compress
`, path));
}

function assertCurrentOperatorOnly(path) {
  const acl = readAclSummary(path);
  assert.equal(acl.protected, true);
  assert.deepEqual(acl.rules, [{
    sid: acl.currentSid,
    type: "Allow",
    inherited: false,
  }]);
}

describe("private load artifact Windows ACLs", {
  skip: process.platform !== "win32",
}, () => {
  it("removes unrelated explicit allow ACEs from directories and files", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "schoolpilot-private-acl-"));
    try {
      const loadGatesRoot = join(tempRoot, "SchoolPilot", "load-gates");
      const output = preparePrivateOutputDirectory(
        join(loadGatesRoot, "fixture"),
        loadGatesRoot,
      );

      grantBuiltinUsersRead(output, true);
      assert.ok(readAclSummary(output).rules.some(
        (rule) => rule.sid === BUILTIN_USERS_SID,
      ));
      preparePrivateOutputDirectory(output, loadGatesRoot);
      assertCurrentOperatorOnly(output);

      grantBuiltinUsersRead(output, true);
      const inheritedProbe = join(output, "inherited-probe.tmp");
      writeFileSync(inheritedProbe, "probe", "utf8");
      assert.ok(readAclSummary(inheritedProbe).rules.some(
        (rule) => rule.sid === BUILTIN_USERS_SID,
      ));
      rmSync(inheritedProbe, { force: true });

      const artifact = writePrivateJson(output, "artifact.private.json", {
        generation: 1,
      });
      assert.deepEqual(JSON.parse(readFileSync(artifact, "utf8")), {
        generation: 1,
      });
      assertCurrentOperatorOnly(artifact);

      preparePrivateOutputDirectory(output, loadGatesRoot);
      assertCurrentOperatorOnly(output);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
