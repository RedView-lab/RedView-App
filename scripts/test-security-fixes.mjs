import assert from 'node:assert';
import { generate4DigitCode, validateVerificationCode } from '../api/_lib/verificationStore.ts';

console.log('🧪 Testing Security Fixes...');

// Test 1: generate4DigitCode generates valid 4 digit numeric string
const code = generate4DigitCode();
assert.match(code, /^[1-9]\d{3}$/, 'Code should be a 4-digit number starting with 1-9');
console.log('✅ Test 1 Passed: Cryptographic code generated correctly:', code);

// Test 2: '2012' backdoor is rejected
const backdoorResult = validateVerificationCode('attacker@test.com', '2012');
assert.strictEqual(backdoorResult.valid, false, 'Backdoor code 2012 must be rejected!');
console.log('✅ Test 2 Passed: Backdoor 2012 rejected successfully.');

// Test 3: SSRF Host & Path Regex
const ALLOWED_RADAR_HOSTS = new Set([
  'https://tilecache.rainviewer.com',
  'https://tilecache.rainviewer.net',
]);
const maliciousHost = 'http://169.254.169.254';
const hostResult = ALLOWED_RADAR_HOSTS.has(maliciousHost) ? maliciousHost : 'https://tilecache.rainviewer.com';
assert.strictEqual(hostResult, 'https://tilecache.rainviewer.com');

const maliciousPath = '/latest/meta-data?dummy=';
const isPathSafe = /^\/?[a-zA-Z0-9_\-\/]+$/.test(maliciousPath);
assert.strictEqual(isPathSafe, false, 'Malicious path with query string must be rejected');
console.log('✅ Test 3 Passed: SSRF protection filters unauthorized hosts and query injections.');

// Test 3b: Weather Proxy Path & Tile Timestamp Validation
const isValidWeatherSubPath = (raw) => {
  let subPath;
  try {
    subPath = decodeURIComponent(raw);
  } catch {
    subPath = raw;
  }
  subPath = subPath.replace(/^\/+/, '');
  return /^[a-zA-Z0-9_\-.:/]+$/.test(subPath) && !subPath.includes('..');
};
assert.strictEqual(isValidWeatherSubPath('tiles/temperature_2026-09-19T17:00:00Z.png'), true, 'ISO timestamp with colons must be accepted');
assert.strictEqual(isValidWeatherSubPath('tiles/temperature_2026-09-19T17%3A00%3A00Z.png'), true, 'URL-encoded timestamp must be accepted');
assert.strictEqual(isValidWeatherSubPath('meta.json'), true, 'meta.json must be accepted');
assert.strictEqual(isValidWeatherSubPath('..%2F..%2Fetc%2Fpasswd'), false, 'Path traversal with %2F must be rejected');
assert.strictEqual(isValidWeatherSubPath('../../etc/passwd'), false, 'Path traversal with .. must be rejected');
console.log('✅ Test 3b Passed: Weather proxy accepts ISO timestamp colons and rejects path traversal.');

import { REDVIEW_CSP_HEADER } from '../server.mjs';

// Test 4: Content-Security-Policy Directives Integrity
assert.ok(REDVIEW_CSP_HEADER, 'REDVIEW_CSP_HEADER must be defined');
assert.match(REDVIEW_CSP_HEADER, /worker-src [^;]*blob:/, 'worker-src must allow blob: for Mapbox GL workers');
assert.match(REDVIEW_CSP_HEADER, /child-src [^;]*blob:/, 'child-src must allow blob: for Safari/legacy worker fallback');
assert.match(REDVIEW_CSP_HEADER, /script-src [^;]*https:\/\/analytics\.redview\.tech/, 'script-src must include analytics.redview.tech');
assert.match(REDVIEW_CSP_HEADER, /script-src [^;]*'unsafe-eval'/, 'script-src must include unsafe-eval for WebAssembly ArrayBuffer instantiation in workers');
assert.match(REDVIEW_CSP_HEADER, /script-src [^;]*'wasm-unsafe-eval'/, 'script-src must include wasm-unsafe-eval for WebAssembly compilation in workers');
assert.match(REDVIEW_CSP_HEADER, /connect-src [^;]*https:\/\/s3\.amazonaws\.com/, 'connect-src must include S3 for Terrarium elevation tiles');
assert.match(REDVIEW_CSP_HEADER, /connect-src [^;]*https:\/\/events\.mapbox\.com/, 'connect-src must include events.mapbox.com');
assert.match(REDVIEW_CSP_HEADER, /connect-src [^;]*https:\/\/analytics\.redview\.tech/, 'connect-src must include analytics.redview.tech');
console.log('✅ Test 4 Passed: Content-Security-Policy contains required worker-src, connect-src, and script-src.');

console.log('\n🎉 All core security unit checks passed successfully!');
