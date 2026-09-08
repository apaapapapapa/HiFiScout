import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { adminLocation, adminViewUrl } from "../frontend/admin-navigation.js";

test("legacy entry links and task links retain their search inputs", () => {
  assert.deepEqual(adminLocation({ hash: "", search: "?q=D-1000" }), {
    view: "catalog",
    search: "?q=D-1000",
  });
  assert.deepEqual(adminLocation({ hash: "#listings", search: "?shopKey=audiounion&scope=all" }), {
    view: "listings",
    search: "?shopKey=audiounion&scope=all",
  });
  assert.equal(adminLocation({ hash: "#duplicates", search: "" }).view, "duplicates");
  assert.equal(adminLocation({ hash: "#csv", search: "" }).view, "csv");
  assert.equal(adminLocation({ hash: "#unknown", search: "" }).view, "catalog");
});

test("task navigation clears domain filters while preserving unrelated URL state", () => {
  const href =
    "https://admin.example.test/?q=amp&shopKey=audiounion&scope=all&manufacturerId=luxman&categoryId=amp&reportId=901&fixture=1#listings";
  assert.equal(adminViewUrl(href, "csv"), "/?fixture=1#csv");
  assert.equal(adminViewUrl(href, "catalog"), "/?fixture=1");
  assert.equal(adminViewUrl(href, "maintenance"), "/?fixture=1#maintenance");
});
