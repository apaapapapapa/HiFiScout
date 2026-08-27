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

type StoryModule = Record<string, unknown>;

const storyModules = import.meta.glob<StoryModule>("../../frontend/**/*.story.tsx");
const storyLoaders = new Map<string, () => Promise<StoryModule>>();

for (const [modulePath, loadStoryModule] of Object.entries(storyModules)) {
  const storyPath = modulePath.replace(/^\.\.\/\.\.\//u, "").replace(/\.story\.tsx$/u, "");
  storyLoaders.set(storyPath, loadStoryModule);
}

const container = document.getElementById("root");
if (!container) throw new Error("Missing component gallery root");
const root = createRoot(container);

function afterRender(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

window.mount = async ({ story, props = {} }) => {
  const separator = story.lastIndexOf("/");
  if (separator <= 0 || separator === story.length - 1) {
    throw new Error(`Invalid component story: ${story}`);
  }

  const storyPath = story.slice(0, separator);
  const exportName = story.slice(separator + 1);
  const loadStoryModule = storyLoaders.get(storyPath);
  if (!loadStoryModule) throw new Error(`Unknown component story module: ${storyPath}`);

  const storyModule = await loadStoryModule();
  const Story = storyModule[exportName];
  if (typeof Story !== "function") throw new Error(`Unknown component story: ${story}`);

  root.render(createElement(Story as ComponentType<Record<string, unknown>>, props));
  await afterRender();
};

window.unmount = async () => {
  root.render(null);
  await afterRender();
};
