import sharp from 'sharp';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const base = join(__dirname, '..');

// Android mipmap sizes
const sizes = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192,
};

// Adaptive icon foreground sizes (with padding for safe zone)
const adaptiveSizes = {
  'mipmap-mdpi': 108,
  'mipmap-hdpi': 162,
  'mipmap-xhdpi': 216,
  'mipmap-xxhdpi': 324,
  'mipmap-xxxhdpi': 432,
};

async function generateForApp(appName) {
  const resourceDir = join(base, 'resources', appName);
  const androidRes = join(base, `android-${appName}`, 'app', 'src', 'main', 'res');

  const iconSource = join(resourceDir, 'icon-only.png');
  const fgSource = join(resourceDir, 'icon-foreground.png');
  const bgSource = join(resourceDir, 'icon-background.png');

  for (const [folder, size] of Object.entries(sizes)) {
    const outDir = join(androidRes, folder);
    // Round icon (the full icon with background)
    await sharp(iconSource)
      .resize(size, size)
      .png()
      .toFile(join(outDir, 'ic_launcher.png'));

    // Round variant
    await sharp(iconSource)
      .resize(size, size)
      .png()
      .toFile(join(outDir, 'ic_launcher_round.png'));

    console.log(`${appName}: ${folder} (${size}px)`);
  }

  for (const [folder, size] of Object.entries(adaptiveSizes)) {
    const outDir = join(androidRes, folder);
    // Foreground
    await sharp(fgSource)
      .resize(size, size)
      .png()
      .toFile(join(outDir, 'ic_launcher_foreground.png'));

    // Background
    await sharp(bgSource)
      .resize(size, size)
      .png()
      .toFile(join(outDir, 'ic_launcher_background.png'));
  }

  console.log(`${appName}: adaptive icons done`);
}

async function main() {
  await generateForApp('gopilot');
  await generateForApp('passpilot');
  console.log('All icons generated!');
}

main().catch(console.error);
