// Page placement is derived from rendered content, never from saved question geometry.
export function createPaperPagination(container, { onLayout } = {}) {
  const sheets = [], observed = new Set(), callbacks = [];
  let groups = [], title = '', frame = null, destroyed = false, running = false, lastPlacement = '';
  const measure = node => {
    const style = getComputedStyle(node);
    return node.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
  };
  const sheet = index => {
    if (sheets[index]) return sheets[index];
    const element = document.createElement('article'); element.className = 'paper paper-page';
    const header = document.createElement('header'); header.className = 'paper-page-header';
    const meta = document.createElement('div'); meta.className = 'paper-meta';
    const brand = document.createElement('span'); brand.textContent = index ? title : '';
    meta.append(brand); header.append(meta);
    if (!index) {
      const heading = document.createElement('h1'); heading.id = 'paper-heading'; heading.textContent = title;
      const rule = document.createElement('div'); rule.className = 'paper-rule'; header.append(heading, rule);
    }
    const body = document.createElement('div'); body.className = 'paper-page-body';
    const note = document.createElement('p'); note.className = 'paper-overflow-note'; note.textContent = '本题较长，编辑时完整显示，导出时自动续页。'; note.hidden = true;
    const footer = document.createElement('footer'); footer.className = 'paper-footer';
    const motto = document.createElement('span'); motto.textContent = '';
    const number = document.createElement('span'); number.className = 'paper-page-number'; footer.append(motto, number);
    element.append(header, body, note, footer); container.append(element);
    const result = { element, header, brand, body, footer, number, note };
    sheets.push(result); return result;
  };
  sheet(0);

  function schedule() {
    if (destroyed || frame !== null) return;
    container.dataset.paginating = 'true';
    frame = requestAnimationFrame(() => { frame = null; layout(); });
  }
  function layout() {
    if (destroyed || running) return;
    // Reparenting a frame during pointer capture would interrupt its layout gesture.
    if (container.querySelector('.layout-dragging')) { container.dataset.paginating = 'false'; return; }
    running = true;
    const width = container.clientWidth, height = width * 297 / 210;
    if (width <= 0) { running = false; container.dataset.paginating = 'false'; return; }
    const reset = page => {
      page.element.classList.remove('paper-page-overflow');
      page.element.style.height = `${height}px`; page.element.style.minHeight = `${height}px`; page.note.hidden = true;
    };
    for (const page of sheets) reset(page);
    const placements = [[]], overflow = new Set();
    let index = 0, used = 0;
    const capacity = () => sheet(index).body.getBoundingClientRect().height;
    const next = () => { index++; used = 0; reset(sheet(index)); placements[index] = []; };
    for (const group of groups) {
      const headingHeight = measure(group.heading);
      let first = true;
      for (const node of group.questions) {
        const questionHeight = measure(node);
        const prefix = first ? headingHeight : 0;
        if (placements[index].length && used + prefix + questionHeight > capacity() + 0.5) {
          next();
        }
        if (first) { placements[index].push(group.heading); used += headingHeight; first = false; }
        placements[index].push(node); used += questionHeight;
        if (used > capacity() + 0.5) overflow.add(index);
      }
    }
    if (!groups.length) {
      let empty = container.querySelector('.paper-empty');
      if (!empty) { empty = document.createElement('div'); empty.className = 'paper-empty'; empty.textContent = '上传截图并识别，或添加题目开始组卷。\n同类题目会归在一起，每类从1开始编号，题目较多时自动续页。'; }
      placements[0].push(empty);
    }
    const signature = `${width.toFixed(2)}:${placements.map((nodes, i) => `${overflow.has(i)}:${nodes.map(n => n.dataset.questionId || n.dataset.category || 'empty').join(',')}`).join(';')}`;
    for (let i = 0; i < placements.length; i++) {
      const page = sheet(i); page.element.dataset.page = String(i + 1);
      page.element.setAttribute('aria-label', `试卷第 ${i + 1} 页`);
      placements[i].forEach((node, position) => { if (page.body.children[position] !== node) page.body.insertBefore(node, page.body.children[position] || null); });
      page.number.textContent = `${i + 1} / ${placements.length}`;
      if (overflow.has(i)) { page.element.classList.add('paper-page-overflow'); page.element.style.height = 'auto'; page.note.hidden = false; }
    }
    const retained = new Set(placements.flat());
    for (const page of sheets) for (const node of [...page.body.children]) if (!retained.has(node)) node.remove();
    while (sheets.length > placements.length) sheets.pop().element.remove();
    container.dataset.pageCount = String(sheets.length); container.dataset.paginating = 'false'; running = false;
    if (lastPlacement !== signature) { lastPlacement = signature; onLayout?.(); }
    for (const callback of callbacks.splice(0)) callback();
  }
  const observer = new ResizeObserver(schedule);
  observer.observe(container);
  const pointerEnd = () => schedule();
  container.addEventListener('pointerup', pointerEnd); container.addEventListener('pointercancel', pointerEnd);
  document.fonts?.ready.then(schedule);
  document.fonts?.addEventListener('loadingdone', schedule);
  return {
    update(nextGroups, nextTitle) {
      groups = nextGroups; title = nextTitle || '未命名试卷';
      const first = sheet(0); first.header.querySelector('h1').textContent = title;
      for (const page of sheets.slice(1)) page.brand.textContent = title;
      const nextObserved = new Set(groups.flatMap(group => [group.heading, ...group.questions]));
      for (const node of observed) if (!nextObserved.has(node)) { observer.unobserve(node); observed.delete(node); }
      for (const node of nextObserved) {
        if (!node.isConnected) first.body.append(node);
        if (!observed.has(node)) { observer.observe(node); observed.add(node); }
      }
      // Preserve synchronous DOM order for editor actions; measure again after queued stages render.
      layout(); schedule();
    },
    schedule,
    afterLayout(callback) { callbacks.push(callback); schedule(); },
    destroy() {
      destroyed = true; if (frame !== null) cancelAnimationFrame(frame); observer.disconnect();
      document.fonts?.removeEventListener('loadingdone', schedule);
      container.removeEventListener('pointerup', pointerEnd); container.removeEventListener('pointercancel', pointerEnd);
    },
  };
}

