import { randomBytes, X509Certificate } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tls from 'node:tls';

function checkedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/api/passpilot/indicators/state' || (url.port && url.port !== '443')) {
    throw new Error('Use an HTTPS /api/passpilot/indicators/state endpoint on port 443, without credentials or query parameters.');
  }
  return url;
}

export function buildConfiguration(input, pairing, ca, key = randomBytes(32), suffix = randomBytes(4).toString('hex')) {
  const url = checkedUrl(input.apiUrl || 'https://school-pilot.net/api/passpilot/indicators/state');
  for (const field of ['wifiSsid', 'wifiPassword']) {
    if (typeof input[field] !== 'string' || /[\x00-\x1f\x7f]/.test(input[field])) throw new Error(`Invalid ${field}.`);
  }
  if (!input.wifiSsid || Buffer.byteLength(input.wifiSsid) > 32 || Buffer.byteLength(input.wifiPassword) > 63) {
    throw new Error('Use a WiFi SSID up to 32 bytes and a personal-network password up to 63 bytes.');
  }
  if (!/^ppi_[A-Za-z0-9_-]{43}$/.test(pairing.token || '') || !/^[0-9a-f-]{36}$/i.test(pairing.pairingId || '')
      || !Number.isFinite(Date.parse(pairing.expiresAt)) || Date.parse(pairing.expiresAt) <= Date.now()) {
    throw new Error('Pairing file is invalid or expired. Create a new pairing in PassPilot.');
  }
  const category = input.categoryBit ?? 1;
  if (![1, 2, 4].includes(category) || key.length !== 32 || !/^[a-zA-Z0-9]{1,8}$/.test(suffix)) throw new Error('Invalid light identity/category.');
  if (!/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(ca) || ca.includes(')PP_CA"')) throw new Error('A PEM root CA certificate is required.');
  const values = {
    PP_WIFI_SSID: input.wifiSsid, PP_WIFI_PASSWORD: input.wifiPassword,
    PP_API_URL: url.toString(), PP_API_TOKEN: pairing.token,
    PP_LIGHT_NAME: `PP-Light-${suffix}`, PP_BLE_KEY_HEX: key.toString('hex'),
  };
  return {
    light: `# Private configuration. Do not upload or share.\nPP_LIGHT_KEY_HEX = "${key.toString('hex')}"\nPP_LIGHT_SUFFIX = "${suffix}"\nPP_LIGHT_CATEGORY_BIT = ${category}\n`,
    gateway: '#pragma once\n// Private configuration. Do not upload or share.\n'
      + Object.entries(values).map(([name, value]) => `constexpr const char* ${name} = ${JSON.stringify(value)};\n`).join('')
      + `constexpr const char* PP_ROOT_CA_PEM = R"PP_CA(${ca.trim()}\n)PP_CA";\n`,
    manifest: { version: 1, pairingId: pairing.pairingId, expiresAt: pairing.expiresAt, lightName: values.PP_LIGHT_NAME, categoryBit: category, apiUrl: url.toString() },
  };
}

// Obtain the public root from a normally verified TLS connection. No bearer is
// sent here, and certificate/hostname errors are never bypassed.
export function fetchVerifiedRoot(apiUrl) {
  const url = checkedUrl(apiUrl);
  return new Promise((accept, reject) => {
    const socket = tls.connect({ host: url.hostname, port: 443, servername: url.hostname, rejectUnauthorized: true });
    socket.setTimeout(15000, () => socket.destroy(new Error('Certificate connection timed out.')));
    socket.on('error', reject);
    socket.once('secureConnect', () => {
      try {
        let cert = socket.getPeerCertificate(true);
        const seen = new Set();
        while (cert.issuerCertificate && cert.issuerCertificate.fingerprint256 !== cert.fingerprint256) {
          if (seen.has(cert.fingerprint256)) throw new Error('Certificate chain is cyclic.');
          seen.add(cert.fingerprint256);
          cert = cert.issuerCertificate;
        }
        const root = new X509Certificate(cert.raw);
        if (!root.ca || !root.checkIssued(root)) throw new Error('Verified chain did not expose its root. Supply an IT-approved root CA file.');
        accept(root.toString());
      } catch (error) { reject(error); }
      finally { socket.end(); }
    });
  });
}

async function main(args) {
  if (args.length < 2 || args.length > 3) throw new Error('Usage: node configure.mjs setup.local.json pairing.json [root-ca.pem]');
  const input = JSON.parse(await readFile(resolve(args[0]), 'utf8'));
  const pairing = JSON.parse(await readFile(resolve(args[1]), 'utf8'));
  const apiUrl = input.apiUrl || 'https://school-pilot.net/api/passpilot/indicators/state';
  const ca = args[2] ? await readFile(resolve(args[2]), 'utf8') : await fetchVerifiedRoot(apiUrl);
  const cert = new X509Certificate(ca);
  if (!cert.ca || Date.parse(cert.validTo) <= Date.now()) throw new Error('Root certificate is invalid or expired.');
  const result = buildConfiguration(input, pairing, ca);
  const output = resolve(dirname(fileURLToPath(import.meta.url)), 'provisioned');
  // Refuse to replace an earlier key: replacing one side would require reflashing both.
  await mkdir(output, { mode: 0o700 });
  await mkdir(resolve(output, 'light'));
  await mkdir(resolve(output, 'gateway'));
  await writeFile(resolve(output, 'light/settings.toml'), result.light, { mode: 0o600, flag: 'wx' });
  await writeFile(resolve(output, 'gateway/config.h'), result.gateway, { mode: 0o600, flag: 'wx' });
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(result.manifest, null, 2), { mode: 0o600, flag: 'wx' });
  process.stdout.write('Created private configuration in firmware/passpilot-indicator/provisioned.\nCopy settings.toml to the light and config.h to gateway/include before building.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    // Do not echo JSON/parser/TLS errors that could contain private input.
    process.stderr.write('Configuration failed. Check the setup/pairing files, HTTPS certificate, and that provisioned does not already exist. No private values are printed.\n');
    process.exitCode = 1;
  });
}
