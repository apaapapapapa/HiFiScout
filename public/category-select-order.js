(() => {
  const order = ['アンプ', 'デジタル', 'アナログ', 'スピーカー', 'ヘッドホン', 'アクセサリー'];
  const select = document.getElementById('category');
  if (!select) return;

  let applying = false;
  function normalizeOrder() {
    if (applying) return;
    const groups = [...select.querySelectorAll('optgroup')];
    if (!groups.length) return;
    applying = true;
    const allOption = [...select.children].find(node => node.tagName === 'OPTION' && !node.value);
    if (allOption) select.append(allOption);
    for (const label of order) {
      const group = groups.find(node => node.label === label);
      if (group) select.append(group);
    }
    for (const child of [...select.children]) {
      if (child.tagName === 'OPTION' && child !== allOption) select.append(child);
    }
    if (allOption) select.prepend(allOption);
    applying = false;
  }

  const observer = new MutationObserver(() => queueMicrotask(normalizeOrder));
  observer.observe(select, { childList: true });
  normalizeOrder();
})();
