(() => {
  const shopListingUrls = Object.freeze({
    audiounion: "https://www.audiounion.jp/st/new_arrival_used.html",
    ippinkan: "https://ippinkan.jp/shopbrand/U100000/",
    "fujiya-avic": "https://www.fujiya-avic.co.jp/shop/e/ea-usednw_s1/?ps=50",
    hifido: "https://www.hifido.co.jp/?L=50&LNG=J&O=0&OD=0",
    formusic: "https://shop.formusic.jp/",
    "u-audio": "https://www.u-audio.com/",
  });

  function shopKeyFromElement(element) {
    const className = [...element.classList].find((name) => name.startsWith("shop-"));
    return className ? className.slice("shop-".length) : "";
  }

  function decorateManufacturer(card) {
    const maker = card.querySelector(".maker");
    if (!maker || maker.querySelector("[data-manufacturer-filter]")) return;

    const manufacturer = maker.textContent?.trim() || "";
    if (!manufacturer || manufacturer === "メーカー不明") return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "manufacturer-filter-link";
    button.dataset.manufacturerFilter = manufacturer;
    button.textContent = manufacturer;
    button.title = `${manufacturer}の商品に絞り込む`;
    button.setAttribute("aria-label", `${manufacturer}の商品に絞り込む`);
    maker.replaceChildren(button);
  }

  function decorateCard(card) {
    card.querySelector(".actions .shop-link")?.remove();
    decorateManufacturer(card);

    const shop = card.querySelector(".card-top .shop");
    if (!shop || shop.matches("a")) return;

    const shopKey = shopKeyFromElement(shop);
    const href = shopListingUrls[shopKey];
    if (!href) return;

    const link = document.createElement("a");
    link.className = `${shop.className} shop-new-arrivals-link`;
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = shop.textContent;
    link.title = "販売店の新着・中古一覧を開く";
    link.setAttribute("aria-label", `${shop.textContent}の新着・中古一覧を開く`);
    shop.replaceWith(link);
  }

  function decorateProducts(root = document) {
    if (root.matches?.(".card")) decorateCard(root);
    root.querySelectorAll?.(".card").forEach(decorateCard);
  }

  const products = document.getElementById("products");
  if (!products) return;

  products.addEventListener("click", (event) => {
    const button = event.target.closest("[data-manufacturer-filter]");
    if (!button) return;

    const manufacturer = button.dataset.manufacturerFilter?.trim();
    const input = document.getElementById("manufacturer");
    if (!manufacturer || !input) return;

    input.value = manufacturer;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  decorateProducts(products);
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) decorateProducts(node);
      }
    }
  }).observe(products, { childList: true, subtree: true });
})();
