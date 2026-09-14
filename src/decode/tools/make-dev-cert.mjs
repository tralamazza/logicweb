// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
//
// Generate a self-signed TLS pair for `npm run dev:lan`.
//
// WebUSB only exists in a secure context. localhost is one, so plain-HTTP dev serving
// is fine on the machine itself, but a phone reaching a bare LAN IP over HTTP is not,
// and `navigator.usb` is simply absent there. HTTPS with this cert gives the phone a
// secure context once it accepts the certificate warning, so the responsive UI and a
// logic analyser plugged into the phone are both testable over Wi-Fi.
//
// The certificate lists every non-internal IPv4 address of this host in its SAN, plus
// localhost, so whichever LAN address the phone uses is covered. Re-run after the LAN
// address changes. Pass --force to overwrite an existing pair.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dir = resolve(root, 'certs');
const key = resolve(dir, 'dev-key.pem');
const cert = resolve(dir, 'dev-cert.pem');
const force = process.argv.includes('--force');

if (!force && existsSync(key) && existsSync(cert)) {
  console.log('certs/dev-{key,cert}.pem already exist. Pass --force to regenerate.');
  process.exit(0);
}

const ips = new Set(['127.0.0.1']);
for (const addrs of Object.values(networkInterfaces())) {
  for (const a of addrs ?? []) {
    if (a.family === 'IPv4' && !a.internal) ips.add(a.address);
  }
}
const san = ['DNS:localhost', ...[...ips].map((ip) => `IP:${ip}`)].join(',');

mkdirSync(dir, { recursive: true });
try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '825',
    '-subj', '/CN=logicweb-dev',
    '-addext', `subjectAltName=${san}`,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
} catch (e) {
  console.error('openssl failed to generate the certificate:', e.message);
  console.error('Install openssl, or drop your own pair at certs/dev-{key,cert}.pem.');
  process.exit(1);
}

console.log(`Wrote certs/dev-key.pem and certs/dev-cert.pem`);
console.log(`  valid for: ${san}`);
console.log(`\nStart LAN serving with:  npm run dev:lan`);
console.log(`Then on the phone open:  https://<one-of-the-IPs-above>:5173`);
console.log(`(accept the certificate warning once — it is self-signed)`);
