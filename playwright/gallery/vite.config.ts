import { defineConfig } from "vite-plus";

/** Serve the production catalog styles and logo at their real URLs in UI review captures. */
export default defineConfig({ publicDir: "../../public" });
