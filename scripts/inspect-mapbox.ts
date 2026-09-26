import fs from 'node:fs';

const bundle = fs.readFileSync('node_modules/mapbox-gl/dist/mapbox-gl.js', 'utf8');

// Search for 'none' === s or 'none' === elevationType
let pos = 0;
while ((pos = bundle.indexOf('"none"===', pos)) !== -1) {
  console.log(bundle.slice(Math.max(0, pos - 50), pos + 150));
  pos += 10;
}
