import { PublicApp } from "./public-app.js";

export function Default() {
  return (
    <>
      <link rel="stylesheet" href="/styles.css" />
      <link rel="stylesheet" href="/price-index.css" />
      <link rel="stylesheet" href="/brand.css" />
      <link rel="stylesheet" href="/design-system.css" />
      <PublicApp />
    </>
  );
}
