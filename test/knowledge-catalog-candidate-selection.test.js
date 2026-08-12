import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listPendingKnowledgeCatalogCandidates
} from '../src/db/knowledge-catalog-verification-repository.js';
import {
  claimKnowledgeCatalogCatchupReviewRun
} from '../src/db/knowledge-catalog-review-repository.js';

function queryDb({ results = [], changes = 0, lastRowId = 0 } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...params) {
          calls.push({ sql, params });
          return {
            async all() { return { results }; },
            async run() { return { meta: { changes, last_row_id: lastRowId } }; }
          };
        }
      };
    }
  };
}

test('pending catalog candidates are limited to manufacturers with source adapters', async () => {
  const db = queryDb();
  await listPendingKnowledgeCatalogCandidates(db, 25, ['luxman', 'esoteric', 'luxman']);

  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /manufacturer_id IN \(\?, \?\)/);
  assert.match(db.calls[0].sql, /CASE WHEN last_verification_at IS NULL THEN 0 ELSE 1 END/);
  assert.deepEqual(db.calls[0].params, ['luxman', 'esoteric', 25]);
});

test('candidate selection supports queue batches larger than the old 100-item ceiling', async () => {
  const db = queryDb();
  await listPendingKnowledgeCatalogCandidates(db, 200, ['denon']);
  assert.deepEqual(db.calls[0].params, ['denon', 200]);
});

test('an explicitly empty supported manufacturer set spends no verification budget', async () => {
  const db = queryDb();
  const rows = await listPendingKnowledgeCatalogCandidates(db, 25, []);
  assert.deepEqual(rows, []);
  assert.equal(db.calls.length, 0);
});

test('normal candidate scheduling prefers never-verified rows before retries', async () => {
  const db = queryDb();
  await listPendingKnowledgeCatalogCandidates(db, 25, ['yamaha']);
  const sql = db.calls[0].sql;
  assert.ok(sql.indexOf('CASE WHEN last_verification_at IS NULL THEN 0 ELSE 1 END') < sql.indexOf('priority_score DESC'));
  assert.ok(sql.indexOf("COALESCE(last_verification_at, '')") < sql.indexOf('priority_score DESC'));
});

test('verifier rollout can prefer the most recently failed candidates for a matched cohort', async () => {
  const db = queryDb();
  await listPendingKnowledgeCatalogCandidates(db, 25, ['denon'], { preferRetries: true });
  const sql = db.calls[0].sql;
  assert.match(sql, /CASE WHEN last_verification_at IS NULL THEN 1 ELSE 0 END/);
  assert.match(sql, /COALESCE\(last_verification_at, ''\) DESC/);
  assert.ok(sql.indexOf('COALESCE(last_verification_at, \'\') DESC') < sql.indexOf('priority_score DESC'));
});

test('catch-up review claim is atomic and returns the inserted run id', async () => {
  const db = queryDb({ changes: 1, lastRowId: 2 });
  const runId = await claimKnowledgeCatalogCatchupReviewRun(db, '2026-08-11T14:00:00.000Z');

  assert.equal(runId, 2);
  assert.match(db.calls[0].sql, /COUNT\(\*\) FROM knowledge_catalog_review_runs\) = 1/);
  assert.match(db.calls[0].sql, /verification_unsupported > 0/);
});
