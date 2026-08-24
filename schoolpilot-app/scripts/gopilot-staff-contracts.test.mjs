import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8');

test('retired GoPilot parent URLs render an unavailable surface without parent page imports', async () => {
  const app = await read('src/App.jsx');
  const denied = await read('src/products/gopilot/pages/GoPilotAccessDenied.jsx');
  assert.doesNotMatch(app, /import\(['"]\.\/products\/gopilot\/pages\/(?:ParentApp|ParentOnboarding|JoinSchool|LinkChild)['"]\)/);
  for (const route of ['/gopilot/parent', '/gopilot/onboarding', '/gopilot/link']) {
    assert.match(app, new RegExp(`path=["']${route.replace('/', '\\/')}["'][^>]+GPAccessDenied`));
  }
  assert.match(app, /\/gopilot\/join\/:schoolSlug[^>]+GPAccessDenied/);
  assert.match(app, /hasGoPilotStaffAccess/);
  assert.match(app, /path="\/gopilot\/unavailable"[^>]+GPAccessDenied/);
  assert.match(denied, /await logout\(\)/);
  assert.match(denied, /navigate\('\/login', \{ replace: true \}\)/);
  assert.match(denied, /GoPilot staff access is unavailable/);
});

test('GoPilot native login is staff-only', async () => {
  const [login, callback] = await Promise.all([
    read('src/pages/Login.jsx'),
    read('src/pages/AuthCallback.jsx'),
  ]);
  assert.doesNotMatch(login, /New parent|Create an account|schoolSlug:|GoPilot native app registration/);
  assert.match(login, /Staff access is provisioned by your school administrator/);
  assert.match(login, /if \(isGoPilotApp\)[\s\S]+Google sign-in is not available/);
  assert.match(callback, /isNative && product === 'gopilot'/);
  assert.match(callback, /native_oauth_disabled/);
});

test('dismissal intake uses only normalized staff arrival sources', async () => {
  const dashboard = await read('src/products/gopilot/pages/DismissalDashboard.jsx');
  assert.match(dashboard, /\/gopilot\/dismissal\/sessions\/\$\{session\.id\}\/arrival-candidates/);
  assert.match(dashboard, /source:\s*['"]staff_car_number['"]/);
  assert.match(dashboard, /source:\s*['"]staff_search['"]/);
  assert.match(dashboard, /studentIds:\s*Array\.from\(selectedArrivalStudents\)/);
  assert.doesNotMatch(dashboard, /html5-qrcode|Scan Parent QR|change:requested|\/changes\//);
});

test('settings use the revisioned GoPilot contract and retain failed edits', async () => {
  const settings = await read('src/products/gopilot/pages/setup/SchoolSettingsTab.jsx');
  assert.match(settings, /api\.get\(['"]\/gopilot\/settings['"]\)/);
  assert.match(settings, /api\.patch\(['"]\/gopilot\/settings['"]/);
  assert.match(settings, /expectedRevision:\s*savedSettings\.revision/);
  for (const field of ['dismissalTime', 'schoolTimezone', 'autoStartEnabled', 'pickupZones', 'revision']) {
    assert.match(settings, new RegExp(field));
  }
  assert.match(settings, /response\?\.status === 409/);
  assert.match(settings, /beforeunload/);
  assert.match(settings, /if \(!hasLoaded\)/);
  assert.match(settings, /Retry loading settings/);
  assert.match(settings, /disabled=\{draft\.pickupZones\.length === 1\}/);
  assert.match(settings, /apiBasePath=["']\/gopilot\/instructional-calendar["']/);
  assert.match(settings, /Instructional calendar/);
  assert.doesNotMatch(settings, /checkInMethod|enableQrCodes|parentDigest|changeRequestWarning/);
  const setup = await read('src/products/gopilot/pages/SetupWizard.jsx');
  assert.match(setup, /Discard unsaved GoPilot settings or instructional calendar changes/);
  assert.match(setup, /onDirtyChange=\{setSettingsDirty\}/);
});

test('dashboard pickup-zone edits use the revision captured when the modal opened', async () => {
  const dashboard = await read('src/products/gopilot/pages/DismissalDashboard.jsx');
  const zoneIds = await read('src/products/gopilot/utils/pickupZones.js');
  const save = dashboard.slice(
    dashboard.indexOf('const handleSaveZones'),
    dashboard.indexOf('const formatCheckInResult')
  );
  assert.match(save, /expectedRevision:\s*openingRevision/);
  assert.doesNotMatch(save, /api\.get\(['"]\/gopilot\/settings/);
  assert.match(save, /setZoneManagerSnapshot\(null\)[\s\S]*?await loadData\(\{ silent: true \}\)/);
  assert.match(dashboard, /setZoneManagerSnapshot\(\{[\s\S]*?zones:\s*pickupZones\.map[\s\S]*?revision:\s*settingsRevision/);
  assert.match(dashboard, /zones=\{zoneManagerSnapshot\.zones\}/);
  assert.match(dashboard, /revision=\{zoneManagerSnapshot\.revision\}/);
  assert.match(dashboard, /onSave\(editZones, revision\)/);
  assert.match(dashboard, /nextPickupZoneId\(editZones\)/);
  assert.match(zoneIds, /const candidate = `zone_\$\{index\}`/);
  assert.doesNotMatch(dashboard, /substring\(0, 50\)/);
});

test('GoPilot views consume only the narrow role-aware student DTO', async () => {
  const sources = await Promise.all([
    read('src/products/gopilot/pages/SetupWizard.jsx'),
    read('src/products/gopilot/pages/TeacherView.jsx'),
    read('src/products/gopilot/pages/DismissalDashboard.jsx'),
    read('src/products/gopilot/pages/setup/AuthorizedPickupsTab.jsx'),
    read('src/products/gopilot/pages/setup/DismissalConfig.jsx'),
  ]);
  const activeGoPilot = sources.join('\n');
  assert.match(activeGoPilot, /api\.get\(['"]\/gopilot\/students['"]/);
  assert.doesNotMatch(activeGoPilot, /api\.get\([^\n]*\/schools\/[^\n]*\/students/);
  const studentMutationLines = activeGoPilot.split(/\r?\n/)
    .filter((line) => /api\.(?:post|put|patch|delete)\(/.test(line) && /\/students(?:\/|['"`])/.test(line));
  assert.ok(studentMutationLines.length > 0);
  studentMutationLines.forEach((line) => assert.match(line, /\/gopilot\/students(?:\/|['"`])/));
  assert.match(activeGoPilot, /api\.post\(['"]\/gopilot\/students['"]/);
  assert.match(activeGoPilot, /api\.patch\(`\/gopilot\/students\/\$\{id\}`/);
  assert.match(activeGoPilot, /api\.delete\(`\/gopilot\/students\/\$\{id\}`/);
  assert.match(activeGoPilot, /api\.post\(['"]\/gopilot\/students\/import['"]/);
  assert.match(activeGoPilot, /api\.patch\(['"]\/gopilot\/students\/bulk['"]/);
});

test('teachers can observe dismissal overrides but cannot mutate them', async () => {
  const teacher = await read('src/products/gopilot/pages/TeacherView.jsx');
  assert.match(teacher, /socket\.on\(['"]dismissal:override['"]/);
  assert.match(teacher, /isOverridden && <span/);
  assert.doesNotMatch(teacher, /Change Dismissal for Today|handleOverrideSubmit|handleRevertOverride/);
  assert.doesNotMatch(teacher, /api\.(?:post|delete)\(`\/sessions\/\$\{session\.id\}\/override/);
});

test('native credentials fail closed in registered secure storage', async () => {
  const [storage, auth, login, generatedSettings, generatedBuild, gradle, manifest] = await Promise.all([
    read('src/native/storage.js'),
    read('src/contexts/AuthContext.jsx'),
    read('src/pages/Login.jsx'),
    read('android-gopilot/capacitor.settings.gradle'),
    read('android-gopilot/app/capacitor.build.gradle'),
    read('android-gopilot/app/build.gradle'),
    read('android-gopilot/app/src/main/AndroidManifest.xml'),
  ]);
  assert.match(storage, /SecureStoragePlugin/);
  assert.match(storage, /NATIVE_SECURE_STORAGE_UNAVAILABLE/);
  assert.doesNotMatch(storage, /@capacitor\/preferences|localStorage|SharedPreferences/);
  assert.match(auth, /await saveToken\(nextToken\)[\s\S]+publishToken\(nextToken\)/);
  assert.match(auth, /const stored = await loadToken\(\);/);
  assert.doesNotMatch(auth, /loadToken\(\)\.catch\(\(\) => null\)/);
  assert.match(auth, /setUser\(null\);[\s\S]+catch \(storageError\)[\s\S]+NATIVE_SECURE_STORAGE_UNAVAILABLE/);
  assert.match(login, /Secure storage is unavailable/);
  assert.match(login, /Sign-in is disabled/);
  assert.doesNotMatch(login, /appUrlOpen|com\.schoolpilot\.gopilot:\/\/auth|Browser\.open/);
  assert.match(generatedSettings, /capacitor-secure-storage-plugin/);
  assert.match(generatedBuild, /capacitor-secure-storage-plugin/);
  assert.doesNotMatch(generatedSettings, /capacitor-preferences/);
  assert.doesNotMatch(generatedBuild, /capacitor-preferences/);
  assert.match(gradle, /GOPILOT_KEYSTORE_PASSWORD/);
  assert.match(gradle, /versionCode 5/);
  assert.match(gradle, /versionName ["']2\.0\.0["']/);
  assert.doesNotMatch(gradle, /storePassword\s+["'][^"']+["']|keyPassword\s+["'][^"']+["']/);
  assert.doesNotMatch(manifest, /android\.permission\.CAMERA/);
  assert.doesNotMatch(manifest, /android\.intent\.category\.BROWSABLE|com\.schoolpilot\.gopilot/);
});

test('GoPilot sockets require an effective staff role', async () => {
  const socket = await read('src/contexts/SocketContext.jsx');
  assert.match(socket, /import \{ hasGoPilotRole \} from ['"]\.\.\/shared\/utils\/schoolRoles['"]/);
  assert.match(
    socket,
    /hasGoPilotRole\(\s*activeMembership,\s*'admin',\s*'school_admin',\s*'office_staff',\s*'teacher',?\s*\)/s,
  );
  assert.match(socket, /!hasGoPilotStaffRole/);
});

test('queue views use only the narrow pickup group label', async () => {
  const queueViews = `${await read('src/products/gopilot/pages/DismissalDashboard.jsx')}\n${await read('src/products/gopilot/pages/TeacherView.jsx')}`;
  assert.match(queueViews, /pickupGroupLabel/);
  assert.doesNotMatch(queueViews, /guardianName|guardian_name|guardianId|guardian_id|\.guardian\b/);
});

test('the GoPilot source and active setup have no parent, QR, or digest surface', async () => {
  const [setup, roster, carNumbers, manifest] = await Promise.all([
    read('src/products/gopilot/pages/SetupWizard.jsx'),
    read('src/products/gopilot/pages/setup/StudentRoster.jsx'),
    read('src/products/gopilot/pages/setup/CarNumbersTab.jsx'),
    read('package.json'),
  ]);
  const activeSurface = `${setup}\n${roster}\n${carNumbers}`;
  assert.match(setup, /AuthorizedPickupsTab/);
  assert.doesNotMatch(activeSurface, /Parent Invite|Print QR|QRCodeSVG|checkInMethod/);
  assert.doesNotMatch(manifest, /html5-qrcode|qrcode\.react|@capacitor\/preferences/);
});

test('authorized-pickup revocation remains visible as retained history', async () => {
  const pickups = await read('src/products/gopilot/pages/setup/AuthorizedPickupsTab.jsx');
  assert.match(pickups, /status: 'revoked'/);
  assert.match(pickups, /pickup\.status !== 'revoked'/);
  assert.doesNotMatch(pickups, /filter\(\(item\) => item\.id !== pickup\.id\)/);
});

test('GoPilot staff setup keeps membership IDs distinct from user IDs', async () => {
  const [constants, setup, manager] = await Promise.all([
    read('src/products/gopilot/pages/setup/constants.jsx'),
    read('src/products/gopilot/pages/SetupWizard.jsx'),
    read('src/products/gopilot/pages/setup/StaffManager.jsx'),
  ]);
  assert.match(constants, /const membership = source\.membership \|\| source/);
  assert.match(constants, /const membershipId = source\.membershipId \|\| membership\.membershipId \|\| membership\.id/);
  assert.match(constants, /id: membershipId/);
  assert.doesNotMatch(constants, /id:\s*s\.userId \|\| s\.id/);
  assert.match(setup, /const created = normalizeStaff\(res\.data\)/);
  assert.match(setup, /staff\/\$\{membershipId\}/);
  assert.match(setup, /toArray\(res\.data, 'staff'\)\.map\(normalizeStaff\)/);
  assert.match(manager, /onUpdate\(s\.id, payload\)/);
  assert.match(manager, /onRemove\(request\.staff\.id, \{ transitionComplete: true \}\)/);
  assert.match(manager, /apiBasePath=\{`\/schools\/\$\{schoolId\}\/staff`\}/);
  assert.match(manager, /newGopilotRole: 'office_staff'/);
  assert.match(manager, /payload\.gopilotRole = s\.role === 'teacher' \? null : 'teacher'/);
  assert.match(manager, /aria-label=\{`Edit \$\{staffName\}`\}/);
  assert.match(manager, /aria-label=\{`Remove school access for \$\{staffName\} — \$\{s\.email\}`\}/);
});
