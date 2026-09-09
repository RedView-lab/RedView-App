// Test script for RedView Weather System on Oracle VPS or local proxy
// Usage:
//   node scripts/test-weather-vps.mjs
//   node scripts/test-weather-vps.mjs --base-url http://141.145.220.99/weather
//   node scripts/test-weather-vps.mjs --base-url http://localhost:5173/api/weather

const DEFAULT_ENDPOINT = process.env.WEATHER_UPSTREAM || 'http://141.145.220.99/weather';

function parseArgs(argv) {
  let baseUrl = DEFAULT_ENDPOINT;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--base-url' && argv[i + 1]) {
      baseUrl = argv[i + 1].trim();
      i++;
    }
  }
  return baseUrl.replace(/\/+$/, '');
}

async function runWeatherTests() {
  const baseUrl = parseArgs(process.argv);
  console.log('='.repeat(70));
  console.log(`🌦️ Testing RedView Weather Service at: ${baseUrl}`);
  console.log('='.repeat(70));

  // 1. Fetch meta.json
  console.log('\n1️⃣ Fetching Metadata (meta.json):');
  const t0 = performance.now();
  const metaUrl = baseUrl.endsWith('.json') ? baseUrl : `${baseUrl}/meta.json`;
  let metaRes;
  try {
    metaRes = await fetch(metaUrl);
  } catch (err) {
    console.error(`   ❌ Failed to connect to ${metaUrl}: ${err.message}`);
    console.log('   ℹ️ If testing locally before VPS deployment, ensure dev server or server.py is running.');
    return;
  }

  const metaTime = (performance.now() - t0).toFixed(1);
  if (!metaRes.ok) {
    console.error(`   ❌ HTTP ${metaRes.status}: ${metaRes.statusText}`);
    return;
  }

  const meta = await metaRes.json();
  console.log(`   Status: HTTP ${metaRes.status} (${metaTime} ms)`);
  console.log(`   Model: ${meta.model || 'N/A'}`);
  console.log(`   Updated: ${meta.updatedAt}`);
  console.log(`   Forecast Hours: ${meta.hours?.length ?? 0} hours (Coverage: +${(meta.hours?.length ?? 0)}h)`);
  const gw = meta.gridSize?.width || meta.grid?.width;
  const gh = meta.gridSize?.height || meta.grid?.height;
  const resDeg = meta.resolutionDeg || meta.grid?.lonStep || '0.25';
  console.log(`   Grid Dimensions: ${gw}x${gh} (~${resDeg}° res)`);
  console.log(`   Domain BBox: [West: ${meta.bbox?.west}, South: ${meta.bbox?.south}, East: ${meta.bbox?.east}, North: ${meta.bbox?.north}]`);

  if (!meta.hours?.length) {
    console.error('   ❌ No forecast hours available in metadata!');
    return;
  }

  // 2. Fetch Sample Tiles for All Variables
  console.log('\n2️⃣ Testing 2D Raster Tiles for First Hour:');
  const firstHour = meta.hours[0];
  const variables = Object.keys(meta.variables || { temperature: {}, rain: {} });

  for (const variable of variables) {
    const template = meta.variables?.[variable]?.tileTemplate || `${variable}_{hour}.png`;
    const tileUrl = `${baseUrl}/tiles/${template.replace('{hour}', firstHour)}`;
    const tStart = performance.now();
    const tileRes = await fetch(tileUrl);
    const tileTime = (performance.now() - tStart).toFixed(1);

    if (tileRes.ok) {
      const buf = await tileRes.arrayBuffer();
      const kb = (buf.byteLength / 1024).toFixed(1);
      console.log(`   • [${variable.padEnd(12)}] ${kb.padStart(5)} KB in ${tileTime.padStart(5)} ms (${tileRes.headers.get('content-type') || 'binary'})`);
    } else {
      console.log(`   • [${variable.padEnd(12)}] ⚠️ HTTP ${tileRes.status} (${tileRes.statusText})`);
    }
  }

  // 3. Test Multi-Hour Scrubbing Latency (Simulating time slider)
  console.log('\n3️⃣ Testing Time-Scrubbing Latency (Next 6 Hours Temperature):');
  const testHours = meta.hours.slice(0, 6);
  for (let i = 0; i < testHours.length; i++) {
    const hour = testHours[i];
    const template = meta.variables?.temperature?.tileTemplate || 'temperature_{hour}.png';
    const tileUrl = `${baseUrl}/tiles/${template.replace('{hour}', hour)}`;
    const tStart = performance.now();
    const res = await fetch(tileUrl);
    const timeMs = (performance.now() - tStart).toFixed(1);

    if (res.ok) {
      const buf = await res.arrayBuffer();
      const kb = (buf.byteLength / 1024).toFixed(1);
      const hourLabel = hour.split('T')[1]?.slice(0, 5) ?? hour;
      console.log(`   • Hour +${i}h (${hourLabel} UTC): ${kb} KB in ${timeMs} ms`);
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('✨ Weather service validation complete!');
  console.log('='.repeat(70));
}

runWeatherTests().catch(console.error);
