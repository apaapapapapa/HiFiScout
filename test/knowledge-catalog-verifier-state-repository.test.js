import test from 'node:test';
import assert from 'node:assert/strict';

import {
  claimKnowledgeCatalogVerifierVersion,
  finishKnowledgeCatalogVerifierVersionSuccess,
  knowledgeCatalogVerifierState
} from '../src/db/knowledge-catalog-verifier-state-repository.js';

function queryDb({ changes = 0, row = null } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...params) {
          calls.push({ sql, params });
          return {
            async run() { return { meta: { changes } }; },
            async first() { return row; }
          };
        },
        async first() { calls.push({ sql, params: [] }); return row; }
      };
    }
  };
}

test('verifier version claim is atomic and one-shot', async () => {
  const db = queryDb({ changes: 1 });
  const claimed = await claimKnowledgeCatalogVerifierVersion(db, 2, '2026-08-11T14:20:00.000Z');
  assert.equal(claimed, true);
  assert.match(db.calls[0].sql, /INSERT OR IGNORE INTO knowledge_catalog_verifier_state/);
  assert.deepEqual(db.calls[0].params, [2, '2026-08-11T14:20:00.000Z']);
});

test('verifier rollout state can be marked successful and read for operational status', async () => {
  const db = queryDb({
    row: {
      version: 2,
      status: 'success',
      started_at: '2026-08-11T14:20:00.000Z',
      finished_at: '2026-08-11T14:21:00.000Z',
      message: 'ok'
    }
  });
  await finishKnowledgeCatalogVerifierVersionSuccess(db, 2, '2026-08-11T14:21:00.000Z', 'ok');
  const state = await knowledgeCatalogVerifierState(db);
  assert.deepEqual(state, {
    version: 2,
    status: 'success',
    startedAt: '2026-08-11T14:20:00.000Z',
    finishedAt: '2026-08-11T14:21:00.000Z',
    message: 'ok'
  });
});
