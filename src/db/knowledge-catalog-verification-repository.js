import { normalizeCatalogModel } from '../catalog/knowledge-catalog.js';

function boundedLimit(value, fallback = 25) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(1, Math.trunc(parsed))) : fallback;
}

function categoriesFromRow(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function attemptStatement(db, {
  candidateId = null,
  productId = null,
  manufacturerId,
  normalizedModel,
  sourceType = '',
  sourceUrl = '',
  attemptedAt,
  status,
  httpStatus = null,
  contentHash = '',
  message = ''
}) {
  return db.prepare(`
    INSERT INTO knowledge_catalog_verification_attempts (
      candidate_id, product_id, manufacturer_id, normalized_model, source_type, source_url,
      attempted_at, status, http_status, content_hash, message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    candidateId,
    productId,
    manufacturerId,
    normalizedModel,
    sourceType,
    sourceUrl,
    attemptedAt,
    status,
    httpStatus,
    contentHash,
    String(message || '').slice(0, 1000)
  );
}

export async function listPendingKnowledgeCatalogCandidates(db, limit = 25) {
  const result = await db.prepare(`
    SELECT id, manufacturer_id, normalized_model, observed_manufacturer, observed_model, sample_title,
           candidate_category_ids, active_listing_count, shop_count, unclassified_count, priority_score,
           verification_status, last_verification_at
    FROM knowledge_catalog_candidates
    WHERE review_status = 'pending' AND active_listing_count > 0
    ORDER BY priority_score DESC, unclassified_count DESC, shop_count DESC, active_listing_count DESC, id
    LIMIT ?
  `).bind(boundedLimit(limit)).all();
  return (result.results || []).map(row => ({
    id: Number(row.id),
    manufacturerId: row.manufacturer_id,
    normalizedModel: row.normalized_model,
    observedManufacturer: row.observed_manufacturer,
    observedModel: row.observed_model,
    sampleTitle: row.sample_title,
    priorityScore: Number(row.priority_score || 0),
    verificationStatus: row.verification_status,
    lastVerificationAt: row.last_verification_at
  }));
}

export async function recordKnowledgeCatalogCandidateVerification(db, candidate, verification, attemptedAt) {
  const status = verification.status === 'verified' ? 'verified' : verification.status;
  await db.batch([
    db.prepare(`
      UPDATE knowledge_catalog_candidates
      SET verification_status = ?, last_verification_at = ?, verification_message = ?, source_url = ?, updated_at = ?
      WHERE id = ?
    `).bind(
      status,
      attemptedAt,
      String(verification.message || '').slice(0, 1000),
      verification.sourceUrl || '',
      attemptedAt,
      candidate.id
    ),
    attemptStatement(db, {
      candidateId: candidate.id,
      manufacturerId: candidate.manufacturerId,
      normalizedModel: candidate.normalizedModel,
      sourceType: verification.sourceType || '',
      sourceUrl: verification.sourceUrl || '',
      attemptedAt,
      status,
      httpStatus: verification.httpStatus ?? null,
      contentHash: verification.contentHash || '',
      message: verification.message || ''
    })
  ]);
}

export async function promoteVerifiedKnowledgeCatalogCandidate(db, candidate, verification, verifiedAt) {
  const existing = await db.prepare(`
    SELECT id, verification_status
    FROM knowledge_catalog_products
    WHERE manufacturer_id = ? AND normalized_model = ?
    LIMIT 1
  `).bind(candidate.manufacturerId, candidate.normalizedModel).first();

  if (existing?.verification_status === 'rejected') {
    await recordKnowledgeCatalogCandidateVerification(db, candidate, {
      ...verification,
      status: 'ambiguous',
      message: 'catalog_identity_previously_rejected'
    }, verifiedAt);
    return { promoted: false, productId: Number(existing.id), reason: 'rejected_catalog_identity' };
  }

  if (existing?.id) {
    const productId = Number(existing.id);
    await db.batch([
      db.prepare(`
        UPDATE knowledge_catalog_candidates
        SET review_status = 'matched', catalog_product_id = ?, verification_status = 'verified',
            last_verification_at = ?, verification_message = ?, source_url = ?, updated_at = ?
        WHERE id = ?
      `).bind(productId, verifiedAt, verification.message || '', verification.sourceUrl || '', verifiedAt, candidate.id),
      attemptStatement(db, {
        candidateId: candidate.id,
        productId,
        manufacturerId: candidate.manufacturerId,
        normalizedModel: candidate.normalizedModel,
        sourceType: verification.sourceType || '',
        sourceUrl: verification.sourceUrl || '',
        attemptedAt: verifiedAt,
        status: 'verified',
        httpStatus: verification.httpStatus ?? null,
        contentHash: verification.contentHash || '',
        message: 'matched_existing_verified_catalog_product'
      })
    ]);
    return { promoted: false, productId, reason: 'already_exists' };
  }

  const canonicalModel = String(verification.canonicalModel || candidate.observedModel || candidate.normalizedModel).trim();
  const normalizedCanonical = normalizeCatalogModel(canonicalModel);
  if (!canonicalModel || normalizedCanonical !== candidate.normalizedModel) {
    await recordKnowledgeCatalogCandidateVerification(db, candidate, {
      ...verification,
      status: 'ambiguous',
      message: 'official_canonical_model_changes_catalog_identity'
    }, verifiedAt);
    return { promoted: false, productId: null, reason: 'identity_changed' };
  }

  const insert = await db.prepare(`
    INSERT INTO knowledge_catalog_products (
      manufacturer_id, canonical_model, normalized_model, canonical_name, lifecycle_status,
      verification_status, review_status, first_verified_at, last_verified_at, last_reviewed_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'unknown', 'verified', 'current', ?, ?, ?, ?, ?)
  `).bind(
    candidate.manufacturerId,
    canonicalModel,
    candidate.normalizedModel,
    String(verification.canonicalName || `${candidate.observedManufacturer} ${canonicalModel}`).trim(),
    verifiedAt,
    verifiedAt,
    verifiedAt,
    verifiedAt,
    verifiedAt
  ).run();
  const productId = Number(insert?.meta?.last_row_id || 0);
  if (!productId) throw new Error('knowledge_catalog_product_insert_failed');

  const categoryIds = [...new Set(verification.categoryIds || [])];
  if (!categoryIds.length || !categoryIds.includes(verification.primaryCategoryId)) {
    throw new Error('verified_catalog_product_requires_primary_category');
  }

  const statements = categoryIds.map(categoryId => db.prepare(`
    INSERT INTO knowledge_catalog_product_categories(product_id, category_id, is_primary)
    VALUES (?, ?, ?)
  `).bind(productId, categoryId, categoryId === verification.primaryCategoryId ? 1 : 0));
  statements.push(db.prepare(`
    INSERT INTO knowledge_catalog_sources (
      product_id, source_type, source_url, retrieved_at, content_hash, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
  `).bind(
    productId,
    verification.sourceType || 'manufacturer_official',
    verification.sourceUrl || '',
    verifiedAt,
    verification.contentHash || '',
    verifiedAt,
    verifiedAt
  ));
  statements.push(db.prepare(`
    UPDATE knowledge_catalog_candidates
    SET review_status = 'matched', catalog_product_id = ?, verification_status = 'verified',
        last_verification_at = ?, verification_message = ?, source_url = ?, updated_at = ?
    WHERE id = ?
  `).bind(productId, verifiedAt, verification.message || '', verification.sourceUrl || '', verifiedAt, candidate.id));
  statements.push(attemptStatement(db, {
    candidateId: candidate.id,
    productId,
    manufacturerId: candidate.manufacturerId,
    normalizedModel: candidate.normalizedModel,
    sourceType: verification.sourceType || 'manufacturer_official',
    sourceUrl: verification.sourceUrl || '',
    attemptedAt: verifiedAt,
    status: 'verified',
    httpStatus: verification.httpStatus ?? null,
    contentHash: verification.contentHash || '',
    message: verification.message || ''
  }));
  await db.batch(statements);
  return { promoted: true, productId, reason: 'verified' };
}

export async function listDueKnowledgeCatalogProducts(db, limit = 25) {
  const result = await db.prepare(`
    SELECT kp.id, kp.manufacturer_id, kp.canonical_model, kp.normalized_model, kp.canonical_name,
           MAX(CASE WHEN kpc.is_primary = 1 THEN kpc.category_id ELSE '' END) AS primary_category_id,
           GROUP_CONCAT(kpc.category_id) AS category_ids,
           ks.id AS source_id, ks.source_type, ks.source_url
    FROM knowledge_catalog_products kp
    LEFT JOIN knowledge_catalog_product_categories kpc ON kpc.product_id = kp.id
    JOIN knowledge_catalog_sources ks ON ks.id = (
      SELECT source.id
      FROM knowledge_catalog_sources source
      WHERE source.product_id = kp.id
      ORDER BY CASE source.source_type
        WHEN 'manufacturer_official' THEN 1
        WHEN 'official_distributor' THEN 2
        WHEN 'manufacturer_archive' THEN 3
        WHEN 'trusted_catalog' THEN 4
        ELSE 5
      END, source.id
      LIMIT 1
    )
    WHERE kp.verification_status = 'verified' AND kp.review_status = 'due'
    GROUP BY kp.id, ks.id
    ORDER BY COALESCE(kp.last_verified_at, ''), kp.id
    LIMIT ?
  `).bind(boundedLimit(limit)).all();
  return (result.results || []).map(row => ({
    id: Number(row.id),
    manufacturerId: row.manufacturer_id,
    canonicalModel: row.canonical_model,
    normalizedModel: row.normalized_model,
    canonicalName: row.canonical_name,
    primaryCategoryId: row.primary_category_id,
    categoryIds: categoriesFromRow(row.category_ids),
    sourceId: Number(row.source_id),
    sourceType: row.source_type,
    sourceUrl: row.source_url
  }));
}

export async function recordKnowledgeCatalogProductRecheckSuccess(db, product, verification, verifiedAt) {
  await db.batch([
    db.prepare(`
      UPDATE knowledge_catalog_products
      SET review_status = 'current', last_verified_at = ?, last_reviewed_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(verifiedAt, verifiedAt, verifiedAt, product.id),
    db.prepare(`
      UPDATE knowledge_catalog_sources
      SET retrieved_at = ?, content_hash = ?, status = 'active', updated_at = ?
      WHERE id = ?
    `).bind(verifiedAt, verification.contentHash || '', verifiedAt, product.sourceId),
    attemptStatement(db, {
      productId: product.id,
      manufacturerId: product.manufacturerId,
      normalizedModel: product.normalizedModel,
      sourceType: product.sourceType,
      sourceUrl: verification.sourceUrl || product.sourceUrl,
      attemptedAt: verifiedAt,
      status: 'verified',
      httpStatus: verification.httpStatus ?? null,
      contentHash: verification.contentHash || '',
      message: verification.message || 'verified_source_recheck'
    })
  ]);
}

export async function recordKnowledgeCatalogProductRecheckFailure(db, product, verification, attemptedAt) {
  const sourceStatus = verification.status === 'not_found' ? 'missing' : 'error';
  const attemptStatus = ['not_found', 'ambiguous', 'unsupported', 'error'].includes(verification.status)
    ? verification.status
    : 'error';
  await db.batch([
    db.prepare(`
      UPDATE knowledge_catalog_products
      SET last_reviewed_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(attemptedAt, attemptedAt, product.id),
    db.prepare(`
      UPDATE knowledge_catalog_sources
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).bind(sourceStatus, attemptedAt, product.sourceId),
    attemptStatement(db, {
      productId: product.id,
      manufacturerId: product.manufacturerId,
      normalizedModel: product.normalizedModel,
      sourceType: product.sourceType,
      sourceUrl: verification.sourceUrl || product.sourceUrl,
      attemptedAt,
      status: attemptStatus,
      httpStatus: verification.httpStatus ?? null,
      contentHash: verification.contentHash || '',
      message: verification.message || ''
    })
  ]);
}
