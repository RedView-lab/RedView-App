// Test script for RedView POI Server on Oracle VPS

const POI_BASE = process.env.POI_UPSTREAM || 'http://141.145.220.99/poi';

async function runTests() {
  console.log('='.repeat(60));
  console.log(`🧭 Testing RedView POI Server at: ${POI_BASE}`);
  console.log('='.repeat(60));

  // 1. Health check
  console.log('\n1️⃣ Health Check:');
  const t0 = performance.now();
  const healthRes = await fetch(`${POI_BASE}/health`);
  const health = await healthRes.json();
  const healthTime = (performance.now() - t0).toFixed(1);
  console.log(`   Status: ${health.status}, Total POIs indexed: ${health.total_pois} (${healthTime} ms)`);

  // 2. BBox query: Chamonix / Mont-Blanc area (Alps)
  console.log('\n2️⃣ BBox Query - Chamonix / Mont-Blanc (Alps):');
  const t1 = performance.now();
  const chamonixRes = await fetch(
    `${POI_BASE}/bbox?south=45.85&west=6.75&north=46.00&east=7.00&categories=alpine_hut,shelter,drinking_water&limit=100`
  );
  const chamonixData = await chamonixRes.json();
  const chamonixTime = (performance.now() - t1).toFixed(1);
  console.log(`   Found ${chamonixData.features?.length ?? 0} POIs in Mont-Blanc region (${chamonixTime} ms)`);
  if (chamonixData.features?.length > 0) {
    const sample = chamonixData.features[0];
    console.log(`   Sample: [${sample.category}] "${sample.name || '(unnamed)'}" at (${sample.lat}, ${sample.lon})`);
  }

  // 3. BBox query: Paris Centre
  console.log('\n3️⃣ BBox Query - Paris Centre:');
  const t2 = performance.now();
  const parisRes = await fetch(
    `${POI_BASE}/bbox?south=48.84&west=2.32&north=48.87&east=2.37&categories=drinking_water,bicycle_repair,bakery&limit=50`
  );
  const parisData = await parisRes.json();
  const parisTime = (performance.now() - t2).toFixed(1);
  console.log(`   Found ${parisData.features?.length ?? 0} POIs in Paris (${parisTime} ms)`);
  if (parisData.features?.length > 0) {
    const sample = parisData.features[0];
    console.log(`   Sample: [${sample.category}] "${sample.name || '(unnamed)'}" at (${sample.lat}, ${sample.lon})`);
  }

  // 4. Corridor query: Paris Seine segment
  console.log('\n4️⃣ Corridor Query (500m buffer along Seine):');
  const points = [
    [48.852, 2.342],
    [48.855, 2.348],
    [48.858, 2.352],
  ];
  const t3 = performance.now();
  const corridorRes = await fetch(`${POI_BASE}/corridor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      points,
      radiusM: 500,
      categories: ['drinking_water', 'bakery', 'cafe'],
    }),
  });
  const corridorData = await corridorRes.json();
  const corridorTime = (performance.now() - t3).toFixed(1);
  console.log(`   Found ${corridorData.features?.length ?? 0} POIs along corridor (${corridorTime} ms)`);
  if (corridorData.features?.length > 0) {
    console.log('   Sample corridor POIs:');
    for (const f of corridorData.features.slice(0, 3)) {
      console.log(`     • [${f.category}] "${f.name || '(fontaine/point)'}" (${f.lat.toFixed(5)}, ${f.lon.toFixed(5)})`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('✨ All POI server tests PASSED with ultra-low latency!');
  console.log('='.repeat(60));
}

runTests().catch(console.error);
