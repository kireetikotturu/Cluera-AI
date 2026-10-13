const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const source = path.resolve('src/renderer/assets/sigmaround-ai.svg');
const pngTarget = path.resolve('resources/icon.png');
const icoTarget = path.resolve('resources/icon.ico');
const svg = fs.readFileSync(source);
const sizes = [16, 24, 32, 48, 64, 128, 256];

async function build() {
  await sharp(svg, { density: 384 }).resize(512, 512, { fit: 'contain' })
    .png({ compressionLevel: 9 }).toFile(pngTarget);
  const images = await Promise.all(sizes.map((size) => sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'contain' }).png().toBuffer()));
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  for (let index = 0; index < images.length; index += 1) {
    const entry = 6 + index * 16;
    directory.writeUInt8(sizes[index] === 256 ? 0 : sizes[index], entry);
    directory.writeUInt8(sizes[index] === 256 ? 0 : sizes[index], entry + 1);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(images[index].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  }
  fs.writeFileSync(icoTarget, Buffer.concat([directory, ...images]));
  console.log(`Generated ${pngTarget} and ${icoTarget}`);
}

build().catch((error) => { console.error(error); process.exit(1); });
