import sharp from 'sharp';
import { mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const resourcesDir = join(__dirname, '..', 'resources');

// GoPilot icon SVG - purple (#6366f1) with white car icon
const gopilotIconSvg = `
<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="1024" height="1024" rx="192" fill="#6366f1"/>
  <rect x="256" y="320" width="512" height="384" rx="96" fill="#fff"/>
  <path d="M384 512 L416 416 L608 416 L640 512" stroke="#6366f1" stroke-width="40" stroke-linecap="round" fill="none"/>
  <path d="M352 512 L672 512 L672 576 L352 576 Z" fill="none" stroke="#6366f1" stroke-width="40"/>
  <circle cx="432" cy="576" r="40" fill="#6366f1"/>
  <circle cx="592" cy="576" r="40" fill="#6366f1"/>
</svg>`;

// GoPilot foreground (icon only, no background, centered in safe zone)
const gopilotForegroundSvg = `
<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="256" y="320" width="512" height="384" rx="96" fill="#fff"/>
  <path d="M384 512 L416 416 L608 416 L640 512" stroke="#6366f1" stroke-width="40" stroke-linecap="round" fill="none"/>
  <path d="M352 512 L672 512 L672 576 L352 576 Z" fill="none" stroke="#6366f1" stroke-width="40"/>
  <circle cx="432" cy="576" r="40" fill="#6366f1"/>
  <circle cx="592" cy="576" r="40" fill="#6366f1"/>
</svg>`;

// PassPilot icon SVG - blue gradient with white clipboard + checkmark
const passpilotIconSvg = `
<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="ppbg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#60a5fa"/>
      <stop offset="100%" stop-color="#3b5bdb"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="192" fill="url(#ppbg)"/>
  <rect x="320" y="288" width="384" height="512" rx="48" fill="#fff"/>
  <rect x="416" y="224" width="192" height="128" rx="32" fill="#fff"/>
  <rect x="448" y="256" width="128" height="64" rx="16" fill="#3b5bdb"/>
  <path d="M416 544 L480 608 L608 448" stroke="#3b5bdb" stroke-width="48" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;

// PassPilot foreground
const passpilotForegroundSvg = `
<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="320" y="288" width="384" height="512" rx="48" fill="#fff"/>
  <rect x="416" y="224" width="192" height="128" rx="32" fill="#fff"/>
  <rect x="448" y="256" width="128" height="64" rx="16" fill="#3b5bdb"/>
  <path d="M416 544 L480 608 L608 448" stroke="#3b5bdb" stroke-width="48" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;

// Splash screens - centered logo on white background
function makeSplash(iconSvg, size) {
  const iconSize = Math.round(size * 0.25);
  const offset = Math.round((size - iconSize) / 2);
  // Scale the viewBox to fit
  const scaled = iconSvg
    .replace(/width="\d+"/, `width="${iconSize}"`)
    .replace(/height="\d+"/, `height="${iconSize}"`);
  return `
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" fill="#ffffff"/>
  <g transform="translate(${offset}, ${offset})">
    ${scaled}
  </g>
</svg>`;
}

async function generate() {
  // Create directories
  await mkdir(join(resourcesDir, 'gopilot'), { recursive: true });
  await mkdir(join(resourcesDir, 'passpilot'), { recursive: true });

  const tasks = [
    // GoPilot
    { svg: gopilotIconSvg, out: 'gopilot/icon-only.png', size: 1024 },
    { svg: gopilotForegroundSvg, out: 'gopilot/icon-foreground.png', size: 1024 },
    { svg: null, out: 'gopilot/icon-background.png', size: 1024, color: '#6366f1' },
    { svg: makeSplash(gopilotIconSvg, 2732), out: 'gopilot/splash.png', size: 2732 },
    // PassPilot
    { svg: passpilotIconSvg, out: 'passpilot/icon-only.png', size: 1024 },
    { svg: passpilotForegroundSvg, out: 'passpilot/icon-foreground.png', size: 1024 },
    { svg: null, out: 'passpilot/icon-background.png', size: 1024, color: '#3b5bdb' },
    { svg: makeSplash(passpilotIconSvg, 2732), out: 'passpilot/splash.png', size: 2732 },
  ];

  for (const task of tasks) {
    const outPath = join(resourcesDir, task.out);
    if (task.svg) {
      await sharp(Buffer.from(task.svg))
        .resize(task.size, task.size)
        .png()
        .toFile(outPath);
    } else {
      // Solid color background
      await sharp({
        create: {
          width: task.size,
          height: task.size,
          channels: 3,
          background: task.color,
        }
      }).png().toFile(outPath);
    }
    console.log(`Generated: ${task.out}`);
  }

  // Also copy icon-only as icon.png for convenience
  for (const app of ['gopilot', 'passpilot']) {
    await sharp(join(resourcesDir, app, 'icon-only.png'))
      .toFile(join(resourcesDir, app, 'icon.png'));
    console.log(`Copied: ${app}/icon.png`);
  }

  console.log('Done!');
}

generate().catch(console.error);
