// Builds an MSIX package for the Microsoft Store.
//
//   npm run package:msix               build the app, then package it
//   npm run package:msix -- --no-build package the exe that's already built
//
// Output: src-tauri/target/msix/<identityName>_<version>_x64.msix
// The unpacked folder (src-tauri/target/msix/stage) can be registered for local
// testing with Developer Mode on:  Add-AppxPackage -Register <stage>\AppxManifest.xml
//
// The package is unsigned on purpose: the Store signs it when you submit.

import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = path.join(root, 'src-tauri');
const outDir = path.join(tauriDir, 'target', 'msix');
const stageDir = path.join(outDir, 'stage');
const exePath = path.join(tauriDir, 'target', 'release', 'game-launcher.exe');

const fail = (msg) => { console.error(`\n✖ ${msg}`); process.exit(1); };

// --- 1. Build the release exe (no MSI) --------------------------------------
if (!process.argv.includes('--no-build')) {
  console.log('Building release exe...');
  execFileSync('npx', ['tauri', 'build', '--no-bundle'], { cwd: root, stdio: 'inherit', shell: true });
}
if (!fs.existsSync(exePath)) fail(`Missing ${exePath}. Run without --no-build.`);

// --- 2. Identity + version ---------------------------------------------------
const identity = JSON.parse(fs.readFileSync(path.join(root, 'msix', 'identity.json'), 'utf8'));
const tauriConf = JSON.parse(fs.readFileSync(path.join(tauriDir, 'tauri.conf.json'), 'utf8'));

// Store packages need a four-part version whose last part is 0.
const parts = tauriConf.version.split(/[.+-]/).slice(0, 3).map(Number);
if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 65535)) {
  fail(`tauri.conf.json version "${tauriConf.version}" must be MAJOR.MINOR.PATCH (each 0-65535).`);
}
const version = `${parts.join('.')}.0`;

for (const key of ['identityName', 'publisher', 'publisherDisplayName', 'displayName', 'description']) {
  if (!identity[key]) fail(`msix/identity.json is missing "${key}".`);
}
if (!/^[A-Za-z0-9.-]{3,50}$/.test(identity.identityName)) {
  fail('identityName must be 3-50 characters: letters, digits, "." or "-".');
}
if (!identity.publisher.startsWith('CN=')) fail('publisher must look like "CN=...".');
if (identity.identityName.endsWith('.Dev')) {
  console.warn('⚠ Using placeholder identity from msix/identity.json. Fine for testing; replace before Store upload.');
}

// --- 3. Stage files ----------------------------------------------------------
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(path.join(stageDir, 'Assets'), { recursive: true });
fs.copyFileSync(exePath, path.join(stageDir, 'game-launcher.exe'));

const iconPng = path.join(tauriDir, 'icons', 'icon.png');
const square = (size, name) =>
  sharp(iconPng).resize(size, size).png().toFile(path.join(stageDir, 'Assets', name));
await Promise.all([
  square(44, 'Square44x44Logo.png'),
  square(50, 'StoreLogo.png'),
  square(71, 'Square71x71Logo.png'),
  square(150, 'Square150x150Logo.png'),
  // Wide tile: icon centred on a transparent 310x150 canvas.
  sharp(iconPng).resize(150, 150)
    .extend({ left: 80, right: 80, top: 0, bottom: 0, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toFile(path.join(stageDir, 'Assets', 'Wide310x150Logo.png')),
]);

const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const values = { ...identity, version };
const manifest = fs.readFileSync(path.join(root, 'msix', 'AppxManifest.template.xml'), 'utf8')
  .replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) fail(`Template uses unknown value {{${key}}}.`);
    return xmlEscape(values[key]);
  });
fs.writeFileSync(path.join(stageDir, 'AppxManifest.xml'), manifest);

// --- 4. Pack with makeappx (Windows SDK) -------------------------------------
function findMakeAppx() {
  const kitsBin = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  if (!fs.existsSync(kitsBin)) return null;
  const versions = fs.readdirSync(kitsBin)
    .filter((d) => /^10\.\d+\.\d+\.\d+$/.test(d))
    .sort((a, b) => {
      const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
      for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
      return 0;
    });
  for (const v of versions) {
    const p = path.join(kitsBin, v, 'x64', 'makeappx.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const makeAppx = findMakeAppx();
if (!makeAppx) fail('makeappx.exe not found. Install the free Windows SDK: https://developer.microsoft.com/windows/downloads/windows-sdk/');

const msixPath = path.join(outDir, `${identity.identityName}_${version}_x64.msix`);
console.log(`\nPacking with ${makeAppx}`);
execFileSync(makeAppx, ['pack', '/d', stageDir, '/p', msixPath, '/o'], { stdio: 'inherit' });

console.log(`\n✔ ${msixPath}`);
console.log(`  Test locally (Developer Mode on):  Add-AppxPackage -Register "${path.join(stageDir, 'AppxManifest.xml')}"`);
