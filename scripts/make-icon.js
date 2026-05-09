const fs = require('node:fs');
const path = require('node:path');
const pngToIco = require('png-to-ico');

const src = path.join(__dirname, '..', 'assets', 'icon.png');
const out = path.join(__dirname, '..', 'build', 'icon.ico');

(async () => {
  if (!fs.existsSync(src)) {
    console.error('Missing source PNG:', src);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const buf = await pngToIco(src);
  fs.writeFileSync(out, buf);
  console.log('Wrote', out, `(${buf.length} bytes)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
