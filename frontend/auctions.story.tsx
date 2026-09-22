import { AuctionSearchApp, AuctionProductSection } from "./auctions.js";
export function Default() {
  return (
    <>
      <link rel="stylesheet" href="/styles.css" />
      <link rel="stylesheet" href="/brand.css" />
      <link rel="stylesheet" href="/design-system.css" />
      <AuctionSearchApp />
    </>
  );
}
export function Product() {
  return (
    <main style={{ maxWidth: 960, margin: "auto", padding: 20 }}>
      <p>ショップの販売価格 ¥698,000</p>
      <AuctionProductSection catalogId={12} />
    </main>
  );
}
