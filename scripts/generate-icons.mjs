import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const iconsDir = path.join(__dirname, '..', 'src-tauri', 'icons');

// Ensure icons directory exists
fs.mkdirSync(iconsDir, { recursive: true });

// SVG icon for the launcher — a stylized game cabinet
const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#6366f1"/>
      <stop offset="100%" style="stop-color:#4f46e5"/>
    </linearGradient>
    <linearGradient id="screen" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:#1e1b4b"/>
      <stop offset="100%" style="stop-color:#312e81"/>
    </linearGradient>
  </defs>
  <rect x="96" y="48" width="320" height="416" rx="24" fill="url(#bg)"/>
  <rect x="128" y="88" width="256" height="180" rx="12" fill="url(#screen)"/>
  <g opacity="0.6">
    <rect x="148" y="108" width="48" height="48" rx="6" fill="#818cf8"/>
    <rect x="208" y="108" width="48" height="48" rx="6" fill="#a78bfa"/>
    <rect x="268" y="108" width="48" height="48" rx="6" fill="#c4b5fd"/>
    <rect x="148" y="168" width="48" height="48" rx="6" fill="#818cf8"/>
    <rect x="208" y="168" width="48" height="48" rx="6" fill="#a78bfa"/>
    <rect x="268" y="168" width="48" height="48" rx="6" fill="#c4b5fd"/>
  </g>
  <g>
    <rect x="148" y="316" width="96" height="28" rx="6" fill="#312e81"/>
    <rect x="180" y="284" width="28" height="96" rx="6" fill="#312e81"/>
    <circle cx="194" cy="316" r="16" fill="#4f46e5"/>
  </g>
  <circle cx="330" cy="300" r="20" fill="#818cf8"/>
  <circle cx="362" cy="332" r="20" fill="#a78bfa"/>
  <circle cx="330" cy="364" r="20" fill="#c4b5fd"/>
  <circle cx="256" y="440" r="8" fill="#22c55e"/>
</svg>`;

async function generateIcons() {
  const svgBuffer = Buffer.from(svgIcon);

  // Generate PNG at different sizes
  const sizes = [
    { name: '32x32.png', size: 32 },
    { name: '128x128.png', size: 128 },
    { name: '128x128@2x.png', size: 256 },
    { name: 'icon.png', size: 512 },
  ];

  for (const { name, size } of sizes) {
    await sharp(svgBuffer).resize(size, size).png().toFile(path.join(iconsDir, name));
    console.log(`Generated ${name}`);
  }

  // Generate ICO file with multiple sizes
  const icoSizes = [16, 32, 48, 64, 128, 256];
  const icoBuffers = await Promise.all(
    icoSizes.map(size => sharp(svgBuffer).resize(size, size).png().toBuffer())
  );

  const icoHeader = Buffer.alloc(6);
  icoHeader.writeUInt16LE(0, 0);
  icoHeader.writeUInt16LE(1, 2);
  icoHeader.writeUInt16LE(icoSizes.length, 4);

  const imageDataSize = icoBuffers.reduce((sum, buf) => sum + buf.length, 0);
  const directorySize = 16 * icoSizes.length;
  const totalSize = 6 + directorySize + imageDataSize;

  const icoData = Buffer.alloc(totalSize);
  icoHeader.copy(icoData, 0);

  for (let i = 0; i < icoSizes.length; i++) {
    const size = icoSizes[i];
    const buf = icoBuffers[i];
    const entryOffset = 6 + i * 16;
    icoData.writeUInt8(size === 256 ? 0 : size, entryOffset);
    icoData.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
    icoData.writeUInt8(0, entryOffset + 2);
    icoData.writeUInt8(0, entryOffset + 3);
    icoData.writeUInt16LE(1, entryOffset + 4);
    icoData.writeUInt16LE(32, entryOffset + 6);
    icoData.writeUInt32LE(buf.length, entryOffset + 8);
    icoData.writeUInt32LE(6 + directorySize + icoBuffers.slice(0, i).reduce((s, b) => s + b.length, 0), entryOffset + 12);
  }

  let dataOffset = 6 + directorySize;
  for (let i = 0; i < icoSizes.length; i++) {
    icoBuffers[i].copy(icoData, dataOffset);
    dataOffset += icoBuffers[i].length;
  }

  fs.writeFileSync(path.join(iconsDir, 'icon.ico'), icoData);
  console.log('Generated icon.ico');

  // Generate ICNS (simplified - write PNG data)
  const pngBuffer = await sharp(svgBuffer).resize(512, 512).png().toBuffer();
  fs.writeFileSync(path.join(iconsDir, 'icon.icns'), pngBuffer);
  console.log('Generated icon.icns');

  // Generate store icons
  const storeIcons = {
    steam: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="#1b78b8"/><text x="50" y="62" font-family="Arial,sans-serif" font-size="36" font-weight="bold" fill="white" text-anchor="middle">S</text></svg>`,
    epic: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="#2a2a2a"/><text x="50" y="62" font-family="Arial,sans-serif" font-size="36" font-weight="bold" fill="white" text-anchor="middle">E</text></svg>`,
    gog: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="#a8541b"/><text x="50" y="62" font-family="Arial,sans-serif" font-size="36" font-weight="bold" fill="white" text-anchor="middle">G</text></svg>`,
    xbox: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="#107c10"/><text x="50" y="62" font-family="Arial,sans-serif" font-size="36" font-weight="bold" fill="white" text-anchor="middle">X</text></svg>`,
    battlenet: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="#00aeff"/><text x="50" y="62" font-family="Arial,sans-serif" font-size="36" font-weight="bold" fill="white" text-anchor="middle">B</text></svg>`,
    custom: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="#7a2f5e"/><text x="50" y="62" font-family="Arial,sans-serif" font-size="36" font-weight="bold" fill="white" text-anchor="middle">+</text></svg>`,
  };

  for (const [name, svg] of Object.entries(storeIcons)) {
    await sharp(Buffer.from(svg)).resize(64, 64).png().toFile(path.join(iconsDir, `store-${name}.png`));
    console.log(`Generated store-${name}.png`);
  }

  console.log('\nAll icons generated successfully!');
}

generateIcons().catch(console.error);
