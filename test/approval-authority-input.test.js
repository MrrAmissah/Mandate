import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readJson } from '../src/http/utils.js';

function request(body) {
  return Readable.from([Buffer.from(JSON.stringify(body))]);
}

test('credential binding selectors are mutually exclusive before authority resolution', async () => {
  await assert.rejects(
    readJson(request({ bindCurrentCredential: true, credentialId: 'key_other' })),
    (error) => error?.code === 'INVALID_REQUEST'
      && /either bindCurrentCredential or credentialId/.test(error.message)
  );

  await assert.rejects(
    readJson(request({ bindCurrentCredential: false, credentialId: 'key_other' })),
    (error) => error?.code === 'INVALID_REQUEST'
  );

  assert.deepEqual(
    await readJson(request({ bindCurrentCredential: true })),
    { bindCurrentCredential: true }
  );
  assert.deepEqual(
    await readJson(request({ credentialId: 'key_other' })),
    { credentialId: 'key_other' }
  );
});
