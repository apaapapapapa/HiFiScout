import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  ADMIN_VIEWS,
  ADMIN_WORKSPACES,
  adminWorkspace,
  adminLocation,
  adminViewUrl,
} from "../frontend/admin-navigation.js";

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
  assert.equal(adminViewUrl(href, "jobs"), "/?fixture=1#jobs");
});

test("retired offer replay links open jobs without losing a saved job or unrelated state", () => {
  assert.deepEqual(adminLocation({ hash: "#maintenance", search: "?jobId=saved&fixture=1" }), {
    view: "jobs",
    search: "?jobId=saved&fixture=1",
  });
});

test("each task belongs to exactly one workspace with a reachable default", () => {
  const members = ADMIN_WORKSPACES.flatMap((workspace) => [...workspace.views]);
  assert.equal(new Set(members).size, members.length);
  assert.deepEqual([...members].sort(), ADMIN_VIEWS.map((view) => view.id).sort());
  for (const workspace of ADMIN_WORKSPACES) {
    assert.equal(adminWorkspace(workspace.views[0]), workspace);
    for (const view of workspace.views) assert.equal(adminWorkspace(view), workspace);
  }
});
