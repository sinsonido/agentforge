import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../src/auth/password.js';

describe('password helpers', () => {
  it('hashPassword returns a bcrypt hash string', async () => {
    const hash = await hashPassword('mysecret');
    assert.equal(typeof hash, 'string');
    assert.ok(hash.startsWith('$2'), 'should be a bcrypt hash');
    assert.notEqual(hash, 'mysecret');
  });

  it('verifyPassword returns true for correct password', async () => {
    const hash = await hashPassword('correct-horse');
    const ok = await verifyPassword('correct-horse', hash);
    assert.equal(ok, true);
  });

  it('verifyPassword returns false for wrong password', async () => {
    const hash = await hashPassword('correct-horse');
    const ok = await verifyPassword('wrong-password', hash);
    assert.equal(ok, false);
  });

  it('two hashes of the same password are different (salted)', async () => {
    const h1 = await hashPassword('samepassword');
    const h2 = await hashPassword('samepassword');
    assert.notEqual(h1, h2);
    // But both verify
    assert.equal(await verifyPassword('samepassword', h1), true);
    assert.equal(await verifyPassword('samepassword', h2), true);
  });
});
