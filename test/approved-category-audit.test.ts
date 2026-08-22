import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const correctionMigration = await readFile(
  new URL("../migrations/0031_correct_audited_product_categories.sql", import.meta.url),
  "utf8",
);
const n05xdMigration = await readFile(
  new URL("../migrations/0032_correct_n05xd_category.sql", import.meta.url),
  "utf8",
);

const approvedCorrections = [
  ["Grandioso T1", "turntable"],
  ["D1.5 SACD/CD Transport", "transport"],
  ["Rossini Transport", "transport"],
  ["Grandioso-P1X", "transport"],
  ["Lina Network DAC", "network_player"],
  ["Grandioso G1", "master_clock"],
  ["Madison STREAMER", "network_player"],
  ["S-05 B", "power_amp"],
  ["S-05", "power_amp"],
  ["D-07X", "cd_sacd_player"],
  ["InPol EAR with DAC WH", "headphone_amp"],
  ["M12 SWITCH IE GOLD", "network_switch"],
  ["NT-07", "transport"],
  ["sNH-10G", "network_switch"],
  ["DV-50S", "cd_sacd_player"],
  ["PCM1792A DACカード E7専用", "other_accessory"],
  ["NR1200", "integrated_amp"],
  ["MDS-JE700", "other"],
  ["DN-S1000", "dj_dtm"],
  ["Network Router UEF", "router"],
  ["SILENT SWITCH OCXO", "network_switch"],
  ["FIBER BOX 2", "optical_isolator"],
] as const;

test("approved production audit corrections remain encoded in verified catalog data", () => {
  for (const [model, category] of approvedCorrections) {
    assert.match(correctionMigration, new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(correctionMigration, new RegExp(`'${category}'`));
  }
});

test("user-confirmed ESOTERIC network-player policy is preserved", () => {
  assert.doesNotMatch(correctionMigration, /N-01XD SE/);
  assert.match(n05xdMigration, /'N-05XD'/);
  assert.match(n05xdMigration, /'network_player'/);
});

test("EDISCREATION is the canonical manufacturer spelling", () => {
  assert.match(
    correctionMigration,
    /'ediscreation', 'EDISCREATION', 'verified', 'manual_verified'/,
  );
  assert.match(correctionMigration, /'ediscreation', 'EDISCREATION', 'ediscreation'/);
});
