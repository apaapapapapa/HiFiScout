import { RESOLUTION_VERSIONS } from "../catalog/resolution-versions.js";
import { TAXONOMY_VERSION } from "../catalog/categories.js";
import type {
  AdminManufacturerCommand,
  AdminManufacturerApplyResult,
  AdminManufacturerPreview,
} from "../api/admin-manufacturer-contracts.js";
import {
  ManufacturerRegistryConflict,
  readManufacturerChange,
  applyManufacturerDraft,
  applyManufacturerRegistry,
  manufacturerMatcher,
  plannedManufacturerAliases,
  manufacturerRevision,
  maxManufacturerListingId,
  readManufacturerRegistry,
  registryVersion,
} from "../db/admin-manufacturer-management.js";
import { readAdminManufacturerAliases } from "../db/admin-manufacturer-registry.js";
import {
  effectiveManufacturerAliases,
  aliasesForShop,
} from "../catalog/manufacturer-alias-scope.js";
import { previewAdminExtraction } from "./extraction-preview.js";
import { scanManufacturerImpact } from "../db/admin-manufacturer-management.js";
import { requestAdminJobs } from "./jobs-client.js";
import type { AdminBackgroundJob } from "../api/admin-csv-contracts.js";
export async function administerManufacturerRegistry(env: Env, command: AdminManufacturerCommand) {
  if (command.action === "get") return readManufacturerRegistry(env.DB, command.manufacturerId);
  if (command.action === "apply" || command.action === "replay") {
    const receipt =
      command.action === "replay"
        ? await readManufacturerChange(env.DB, command.operationId)
        : await applyManufacturerRegistry(
            env.DB,
            command.edit,
            command.revision,
            command.operationId,
          );
    if (!receipt || receipt.status !== "applied")
      throw new ManufacturerRegistryConflict("適用済みの変更が見つかりません。");
    try {
      const created = (await requestAdminJobs(env, {
        action: "create",
        kind: "manufacturer",
        id: receipt.operation_id,
        total: 0,
        label: `メーカー再判定: ${receipt.manufacturer_id}`,
      })) as { job: AdminBackgroundJob };
      if (created.job.status === "uploading")
        await requestAdminJobs(env, { action: "start", id: receipt.operation_id });
      return {
        applied: true,
        operationId: receipt.operation_id,
        replay: "queued",
        message: "辞書を保存しました。既存商品の再判定は処理一覧で確認できます。",
      } satisfies AdminManufacturerApplyResult;
    } catch {
      return {
        applied: true,
        operationId: receipt.operation_id,
        replay: "pending",
        message: "辞書は保存済みです。再判定の受付に失敗しました。同じ操作を再送信してください。",
      } satisfies AdminManufacturerApplyResult;
    }
  }
  const version = await registryVersion(env.DB);
  const before = await readManufacturerRegistry(env.DB, command.edit.manufacturerId);
  const current = await readAdminManufacturerAliases(env.DB);
  const proposed = applyManufacturerDraft(current, command.edit, before);
  const matcher = manufacturerMatcher(before, command.edit);
  const maxId = command.maxId ?? (await maxManufacturerListingId(env.DB));
  const page = await scanManufacturerImpact(env.DB, matcher, command.afterId, maxId);
  const samples = page.ids.length
    ? await previewAdminExtraction(
        env.DB,
        { samples: page.ids.map((listingId) => ({ listingId })) },
        { current, proposed },
      )
    : {
        observedAt: new Date().toISOString(),
        versions: {
          manufacturer: RESOLUTION_VERSIONS.manufacturer,
          model: RESOLUTION_VERSIONS.model,
          taxonomy: TAXONOMY_VERSION,
        },
        items: [],
      };
  const changes = plannedManufacturerAliases(command.edit, before).filter(
    (row) => row.verificationStatus === "verified",
  );
  const collisions: AdminManufacturerPreview["collisions"] = [];
  const seen = new Set<string>();
  // Include every scoped dictionary for global claims; a clash never silently chooses a manufacturer.
  for (const shopKey of new Set(["", ...proposed.map((row) => row.shopKey ?? "")])) {
    const effective = effectiveManufacturerAliases(aliasesForShop(proposed, shopKey), 1);
    for (const row of changes.filter((row) => !row.shopKey || row.shopKey === shopKey)) {
      for (const other of effective.filter(
        (other) =>
          other.manufacturerId !== row.manufacturerId &&
          other.normalizedAlias === row.normalizedAlias &&
          other.verificationStatus === "verified",
      )) {
        const key = `${row.normalizedAlias}\0${shopKey}\0${other.manufacturerId}`;
        if (!seen.has(key)) {
          seen.add(key);
          collisions.push({
            alias: row.alias,
            shopKey,
            manufacturerId: other.manufacturerId,
            name: other.canonicalName,
          });
        }
      }
    }
  }
  return {
    revision: await manufacturerRevision(version, command.edit),
    before,
    edit: command.edit,
    scope: {
      shopKey: matcher.shopKey,
      afterId: command.afterId,
      nextAfterId: page.nextAfterId,
      maxId,
      scanned: page.scanned,
      matched: page.matched,
      hasMore: page.hasMore,
    },
    samples,
    collisions,
  } satisfies AdminManufacturerPreview;
}
