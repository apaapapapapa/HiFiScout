/**
 * Stable public bundle entrypoint.
 * Keep `/app.js` as the deployment contract while the UI itself lives in `public-app.tsx`.
 * Keep UI logic out of this file so the public surface has one React application boundary.
 */
import "./product-permalink-navigation.js";
import "./product-correction-report-ui.js";
import { mountPublicApp } from "./public-app.js";

mountPublicApp();
