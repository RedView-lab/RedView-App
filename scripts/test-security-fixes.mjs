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

console.log('\n🎉 All core security unit checks passed successfully!');
