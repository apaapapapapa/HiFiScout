(() => {
  const source = new URLSearchParams(location.search);
  const params = new URLSearchParams();

  function copyText(key, maxLength) {
    const value = source.get(key);
    if (value == null || !value.trim() || [...value].length > maxLength) return;
    params.set(key, value);
  }

  function copyNumeric(key) {
    const value = source.get(key);
    if (value != null && /^\d{1,12}$/.test(value)) params.set(key, value);
  }

  copyText('q', 100);
  copyText('shop', 80);
  copyText('manufacturer', 100);
  copyText('category', 100);
  copyNumeric('minPrice');
  copyNumeric('maxPrice');

  const sort = source.get('sort');
  if (['priceAsc', 'priceDesc'].includes(sort)) params.set('sort', sort);

  if (source.get('inStock') === 'false') params.set('inStock', 'false');
  if (source.get('newOnly') === 'true') params.set('newOnly', 'true');
  if (source.get('priceDropped') === 'true') params.set('priceDropped', 'true');

  const view = source.get('view');
  if (view === 'cards' || view === 'list') params.set('view', view);

  const nextSearch = params.toString();
  const nextUrl = `${location.pathname}${nextSearch ? `?${nextSearch}` : ''}${location.hash}`;
  const currentUrl = `${location.pathname}${location.search}${location.hash}`;
  if (nextUrl !== currentUrl) history.replaceState(null, '', nextUrl);
})();
