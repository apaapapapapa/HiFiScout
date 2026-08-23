/**
 * Stable public bundle entrypoint.
 * Keep `/app.js` as the deployment contract while the UI itself lives in `public-app.tsx`.
 * Keep UI logic out of this file so the public surface has one React application boundary.
 */
import "./public-app.js";
