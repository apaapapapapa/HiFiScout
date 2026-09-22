import type { DisplayProduct } from "./types.js";
import { ProductCard, OffersContent } from "./public-components.js";

/** Same-origin image fixture: the offline gallery never contacts a manufacturer. */
export function Preview({ product }: { product: DisplayProduct }) {
  return (
    <>
      <link rel="stylesheet" href="/styles.css" />
      <link rel="stylesheet" href="/brand.css" />
      <link rel="stylesheet" href="/design-system.css" />
      <main>
        <div className="products view-list">
          <ProductCard
            product={product}
            shopName={() => "販売店"}
            onOffers={() => {}}
            favorite={false}
            onFavorite={() => {}}
          />
        </div>
        <section aria-label="写真付きの商品詳細">
          <OffersContent
            state={{ kind: "ready", data: { product, offers: [] } }}
            shopName={() => "販売店"}
            onHistory={() => {}}
          />
        </section>
      </main>
    </>
  );
}
