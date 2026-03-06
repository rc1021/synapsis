#!/usr/bin/env node
/**
 * Integration test for multi-workspace architecture.
 * Tests workspace-manager, command-handler, and scheduler components.
 *
 * Usage: node app/scripts/test-multi-workspace.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const wm = require('../bridges/shared/workspace-manager');
const { parseCommand, handleCommand } = require('../bridges/shared/command-handler');
const SessionStore = require('../bridges/discord/src/session-store');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ ${msg}`);
    failed++;
  }
}

// --- Tests ---

console.log('\n=== 1. Workspace Manager: Helpers ===');

assert(wm.sanitizeId('abc123') === 'abc123', 'sanitizeId keeps alphanumeric');
assert(wm.sanitizeId('ab!@#c1$%2^3') === 'abc123', 'sanitizeId strips special chars');
assert(wm.shardPath4('1234567890').replace(/\\/g, '/') === '12/34/56/78', 'shardPath4 correct');
assert(wm.shardPath2('ABCDEF').replace(/\\/g, '/') === 'AB/CD', 'shardPath2 correct');

console.log('\n=== 2. Seed User: Index Lookup ===');

const seedWsPath = wm.resolveWorkspace('discord', '899864862258257951');
assert(!!seedWsPath, `Seed user workspace resolved: ${seedWsPath}`);
assert(fs.existsSync(seedWsPath), 'Seed workspace directory exists');

const seedProfile = wm.readProfile(seedWsPath);
assert(!!seedProfile, 'Seed profile loaded');
assert(seedProfile.bindings.includes('discord:899864862258257951'), 'Seed binding correct');

console.log('\n=== 3. Workspace Creation (test user) ===');

const testBridge = 'test';
const testUserId = 'testuser0001';

// Create a test workspace
const { wsId, wsPath, wsRel } = wm.createWorkspace(testBridge, testUserId);
assert(!!wsId, `Test workspace created: ${wsId}`);
assert(fs.existsSync(wsPath), 'Test workspace directory exists');
assert(fs.existsSync(path.join(wsPath, 'CLAUDE.md')), 'Template CLAUDE.md copied');
assert(fs.existsSync(path.join(wsPath, 'SOUL.md')), 'Template SOUL.md copied');
assert(fs.existsSync(path.join(wsPath, 'USER.md')), 'Template USER.md copied');
assert(fs.existsSync(path.join(wsPath, 'BOOTSTRAP.md')), 'Template BOOTSTRAP.md copied');
assert(fs.existsSync(path.join(wsPath, 'MEMORY.md')), 'Template MEMORY.md copied');
assert(fs.existsSync(path.join(wsPath, 'jobs.json')), 'Empty jobs.json created');
assert(fs.existsSync(path.join(wsPath, 'profile.json')), 'profile.json created');

const testProfile = wm.readProfile(wsPath);
assert(testProfile.bindings[0] === `${testBridge}:${testUserId}`, 'Profile binding correct');

// Verify index lookup
const resolved = wm.resolveWorkspace(testBridge, testUserId);
assert(resolved === wsPath, 'Index lookup returns correct path');

console.log('\n=== 4. Invite System ===');

const inviteCode = wm.createInvite(wsRel);
assert(inviteCode.length >= 12, `Invite code generated: ${inviteCode} (${inviteCode.length} chars)`);

// Consume invite
const inviteData = wm.consumeInvite(inviteCode);
assert(!!inviteData, 'Invite consumed successfully');
assert(inviteData.from === wsRel, 'Invite from correct');

// Double consume should fail
const inviteData2 = wm.consumeInvite(inviteCode);
assert(inviteData2 === null, 'Double consume returns null');

console.log('\n=== 5. Bind Token System ===');

const bindToken = wm.createBindToken(wsRel);
assert(bindToken.length >= 12, `Bind token generated: ${bindToken} (${bindToken.length} chars)`);

// Consume bind token
const bindData = wm.consumeBindToken(bindToken);
assert(!!bindData, 'Bind token consumed successfully');
assert(bindData.workspaceId === wsRel, 'Bind token workspace correct');

// Double consume should fail
const bindData2 = wm.consumeBindToken(bindToken);
assert(bindData2 === null, 'Double consume returns null');

console.log('\n=== 6. Cross-Bridge Binding ===');

const otherBridge = 'telegram';
const otherUserId = 'tg9876543210';
const bindToken2 = wm.createBindToken(wsRel);
const consumed = wm.consumeBindToken(bindToken2);
assert(!!consumed, 'Bind token for cross-bridge consumed');

const bindResult = wm.bindAccount(otherBridge, otherUserId, consumed.workspaceId);
assert(bindResult, 'bindAccount returned true');

const otherResolved = wm.resolveWorkspace(otherBridge, otherUserId);
assert(otherResolved === wsPath, 'Other bridge resolves to same workspace');

const updatedProfile = wm.readProfile(wsPath);
assert(updatedProfile.bindings.includes(`${otherBridge}:${otherUserId}`), 'Profile has new binding');

console.log('\n=== 7. Command Handler ===');

// Parse commands
assert(parseCommand('/new') !== null, 'Parse /new');
assert(parseCommand('/connection ABC123').args[0] === 'ABC123', 'Parse /connection with code');
assert(parseCommand('hello') === null, 'Non-command returns null');

// Handle unregistered user commands
const unregResult = handleCommand('fake', 'nobody', { command: 'share-code', args: [] }, {});
assert(unregResult && unregResult.reply.includes('registered'), 'Unregistered user gets rejection');

// Handle registered user commands
const sessionStore = new SessionStore(60);
const regResult = handleCommand(testBridge, testUserId, { command: 'new', args: [] }, {
  sessions: sessionStore,
  resetSessionKey: () => {},
});
assert(regResult && regResult.reply.includes('New conversation'), '/new for registered user works');

console.log('\n=== 8. Session Store (per-workspace) ===');

const sessStorePath = wm.sessionStorePath(wsPath);
assert(sessStorePath.endsWith('-sessions.json'), 'Session store path format correct');
assert(sessStorePath.includes(wsId), 'Session store path includes workspace ID');

const store = new SessionStore(60, sessStorePath);
const key = 'dm:testuser0001';
const sid = store.getOrCreate(key);
assert(!!sid, `Session created: ${sid.slice(0, 8)}`);
const sid2 = store.getOrCreate(key);
assert(sid === sid2, 'Same session returned for same key');
store.reset(key);
const sid3 = store.get(key);
assert(sid3 === null, 'Session cleared after reset');
store.destroy();

console.log('\n=== 9. SYNC_PROMPT ===');

const syncPrompt = wm.readSyncPrompt();
assert(syncPrompt.length > 0, 'SYNC_PROMPT.md readable');
assert(syncPrompt.includes('isolated workspace'), 'SYNC_PROMPT contains isolation rules');

console.log('\n=== 10. User Jobs ===');

const seedJobsPath = wm.userJobsPath(seedWsPath);
assert(fs.existsSync(seedJobsPath), 'Seed user jobs.json exists');
const seedJobs = JSON.parse(fs.readFileSync(seedJobsPath, 'utf-8'));
assert(seedJobs.jobs.length > 0, `Seed user has ${seedJobs.jobs.length} jobs`);
assert(seedJobs.jobs.every(j => j.type === 'claude'), 'All seed user jobs are claude type');

console.log('\n=== 11. Unregistered User Handling ===');

const unregWs = wm.resolveWorkspace('discord', 'nonexistent999');
assert(unregWs === null, 'Unregistered user returns null');

// --- Cleanup test data ---

console.log('\n=== Cleanup ===');

// Remove test workspace
const testDataDir = path.dirname(wsPath);
fs.rmSync(wsPath, { recursive: true, force: true });
console.log(`  Removed test workspace: ${wsPath}`);

// Remove test index
const testIndexPath = wm.indexPath(testBridge, testUserId);
fs.rmSync(testIndexPath, { force: true });
console.log(`  Removed test index`);

// Remove telegram binding index
const tgIndexPath = wm.indexPath(otherBridge, otherUserId);
fs.rmSync(tgIndexPath, { force: true });
console.log(`  Removed telegram test index`);

// Remove test bridge index dirs (empty)
try {
  fs.rmSync(path.join(wm.INDEX_DIR, testBridge), { recursive: true, force: true });
  fs.rmSync(path.join(wm.INDEX_DIR, otherBridge), { recursive: true, force: true });
} catch {}

// --- Summary ---

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
