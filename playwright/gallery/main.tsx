import { createElement } from "react";
import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";

interface MountParams {
  story: string;
  props?: Record<string, unknown>;
}

declare global {
  interface Window {
    mount(params: MountParams): Promise<void>;
    unmount(): Promise<void>;
  }
}

const storyModules = import.meta.glob<Record<string, unknown>>("../../frontend/**/*.story.tsx", {
  eager: true,
});
const stories = new Map<string, ComponentType<Record<string, unknown>>>();

for (const [modulePath, storyModule] of Object.entries(storyModules)) {
  const storyPath = modulePath
    .replace(/^\.\.\/\.\.\//u, "")
    .replace(/\.story\.tsx$/u, "");
  for (const [exportName, value] of Object.entries(storyModule)) {
    if (typeof value === "function") {
      stories.set(`${storyPath}/${exportName}`, value as ComponentType<Record<string, unknown>>);
    }
  }
}

const container = document.getElementById("root");
if (!container) throw new Error("Missing component gallery root");
const root = createRoot(container);

function afterRender(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

window.mount = async ({ story, props = {} }) => {
  const Story = stories.get(story);
  if (!Story) throw new Error(`Unknown component story: ${story}`);
  root.render(createElement(Story, props));
  await afterRender();
};

window.unmount = async () => {
  root.render(null);
  await afterRender();
};
