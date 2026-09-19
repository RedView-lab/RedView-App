import assert from 'node:assert';
import handler from '../api/weather.ts';

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(key, val) {
      this.headers[key] = val;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    send(data) {
      this.body = data;
      return this;
    },
    end() {
      return this;
    },
  };
}

async function testRoute(url) {
  const req = { method: 'GET', url, query: {} };
  const res = createMockRes();
  await handler(req, res);
  return {
    status: res.statusCode,
    contentType: res.headers['Content-Type'],
    isBuffer: Buffer.isBuffer(res.body),
    length: res.body?.length,
    body: typeof res.body === 'object' && !Buffer.isBuffer(res.body) ? res.body : undefined,
  };
}

async function main() {
  console.log('🧪 Testing Weather Proxy Path & Tile Fix...\n');

  // Test 1: Tile with colons in ISO timestamp
  const tileRes = await testRoute('/api/weather/tiles/temperature_2026-09-19T17:00:00Z.png');
  console.log('1. Tile with colons:', tileRes);
  assert.strictEqual(tileRes.status, 200, 'Tile with colons must return HTTP 200');
  assert.ok(tileRes.isBuffer, 'Tile body must be a Buffer');
  assert.strictEqual(tileRes.contentType, 'image/png', 'Content-Type must be image/png');
  console.log('   ✅ Tile with ISO timestamp colons loaded successfully!\n');

  // Test 2: Tile with URL-encoded colons %3A
  const tileEncodedRes = await testRoute('/api/weather/tiles/temperature_2026-09-19T17%3A00%3A00Z.png');
  console.log('2. Tile with %3A:', tileEncodedRes);
  assert.strictEqual(tileEncodedRes.status, 200, 'Tile with %3A must return HTTP 200');
  assert.ok(tileEncodedRes.isBuffer, 'Tile body must be a Buffer');
  console.log('   ✅ URL-encoded tile loaded successfully!\n');

  // Test 3: meta.json
  const metaRes = await testRoute('/api/weather/meta.json');
  console.log('3. Metadata (meta.json):', { status: metaRes.status, isBuffer: metaRes.isBuffer, length: metaRes.length });
  assert.strictEqual(metaRes.status, 200, 'meta.json must return HTTP 200');
  console.log('   ✅ Metadata loaded successfully!\n');

  // Test 4: Path traversal attempt ..%2F..%2Fetc%2Fpasswd
  const traversalRes = await testRoute('/api/weather/..%2F..%2Fetc%2Fpasswd');
  console.log('4. Path traversal attempt (..%2F):', traversalRes);
  assert.strictEqual(traversalRes.status, 400, 'Path traversal must be rejected with 400');
  console.log('   ✅ Traversal attempt rejected with 400!\n');

  // Test 5: Path traversal attempt tiles/../../../etc/passwd
  const deepTraversalRes = await testRoute('/api/weather/tiles/../../../etc/passwd');
  console.log('5. Deep path traversal attempt (tiles/../):', deepTraversalRes);
  assert.strictEqual(deepTraversalRes.status, 400, 'Deep path traversal must be rejected with 400');
  console.log('   ✅ Deep traversal attempt rejected with 400!\n');

  console.log('🎉 ALL TESTS PASSED SUCCESFULLY!');
}

main().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
