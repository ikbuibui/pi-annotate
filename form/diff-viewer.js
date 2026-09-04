window.AnnotationDiffViewer = (() => {
  let requestId = 0;
  let diffStyle = 'side-by-side';
  let ignoreWhitespace = true;
  let preferencesLoaded = false;
  const collapsedFiles = new Map();

  function collapseKey(documentId, path) {
    return documentId + ':' + path;
  }

  function line(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
  }

  function resolveSelectionRows(rows) {
    const selected = [...rows].map((row) => ({
      path: row.path || row.dataset?.diffPath,
      originalLine: line(row.originalLine || row.dataset?.diffOriginalLine),
      currentLine: line(row.currentLine || row.dataset?.diffCurrentLine),
    })).filter((row) => row.path && (row.originalLine || row.currentLine));
    if (!selected.length || new Set(selected.map((row) => row.path)).size !== 1) return null;
    const sides = new Set(selected.flatMap((row) => row.originalLine && !row.currentLine ? ['original'] : row.currentLine && !row.originalLine ? ['current'] : []));
    if (sides.size > 1) return null;
    const side = sides.values().next().value || 'current';
    const lines = selected.map((row) => side === 'original' ? row.originalLine : row.currentLine);
    if (lines.some((value) => !value)) return null;
    return { path: selected[0].path, side, startLine: Math.min(...lines), endLine: Math.max(...lines) };
  }

  function decorate(container, documentId, path, style) {
    container.querySelectorAll('.d2h-file-wrapper').forEach((file) => {
      file.dataset.diffPath = path;
      const header = file.querySelector('.d2h-file-header');
      const body = file.querySelector(':scope > .d2h-file-diff, :scope > .d2h-files-diff');
      if (header && body) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'diff-collapse-toggle';
        toggle.innerHTML = '<span aria-hidden="true">▸</span>';
        header.prepend(toggle);
        const key = collapseKey(documentId, path);
        const setCollapsed = (collapsed) => {
          collapsedFiles.set(key, collapsed);
          file.classList.toggle('is-collapsed', collapsed);
          toggle.setAttribute('aria-expanded', String(!collapsed));
          toggle.setAttribute('aria-label', (collapsed ? 'Expand ' : 'Collapse ') + path);
        };
        setCollapsed(collapsedFiles.get(key) ?? false);
        const toggleFile = () => setCollapsed(!file.classList.contains('is-collapsed'));
        toggle.addEventListener('click', (event) => { event.stopPropagation(); toggleFile(); });
        header.addEventListener('click', (event) => {
          if (event.target.closest('a, button, input, label') || !window.getSelection()?.isCollapsed) return;
          toggleFile();
        });
      }
      const sideDiffs = [...file.querySelectorAll('.d2h-file-side-diff')];
      file.querySelectorAll('tr').forEach((row) => {
        const numberCell = row.querySelector('.d2h-code-linenumber, .d2h-code-side-linenumber');
        if (!numberCell) return;
        let originalLine;
        let currentLine;
        if (style === 'side-by-side') {
          const side = sideDiffs.indexOf(row.closest('.d2h-file-side-diff'));
          const value = line(numberCell.textContent.trim());
          originalLine = side === 0 ? value : null;
          currentLine = side === 1 ? value : null;
        } else {
          originalLine = line(numberCell.querySelector('.line-num1')?.textContent.trim());
          currentLine = line(numberCell.querySelector('.line-num2')?.textContent.trim());
        }
        if (!originalLine && !currentLine) return;
        row.dataset.diffPath = path;
        if (originalLine) row.dataset.diffOriginalLine = String(originalLine);
        if (currentLine) row.dataset.diffCurrentLine = String(currentLine);
      });
    });
  }

  function resolveRange(range, viewer) {
    const rows = [...viewer.querySelectorAll('tr[data-diff-path]')].filter((row) => {
      try { return range.intersectsNode(row); } catch { return false; }
    });
    return resolveSelectionRows(rows);
  }

  async function loadPreferences() {
    if (preferencesLoaded) return;
    preferencesLoaded = true;
    try {
      const response = await fetch('/api/preferences');
      const { diffStyle: savedStyle, ignoreWhitespace: savedIgnoreWhitespace } = await response.json();
      if (response.ok && (savedStyle === 'unified' || savedStyle === 'side-by-side')) diffStyle = savedStyle;
      if (response.ok && typeof savedIgnoreWhitespace === 'boolean') ignoreWhitespace = savedIgnoreWhitespace;
    } catch { }
  }

  async function savePreferences(preferences) {
    const response = await fetch('/api/preferences', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(preferences),
    });
    if (response.ok) {
      const saved = await response.json();
      if (saved.diffStyle === 'unified' || saved.diffStyle === 'side-by-side') diffStyle = saved.diffStyle;
      if (typeof saved.ignoreWhitespace === 'boolean') ignoreWhitespace = saved.ignoreWhitespace;
    }
  }

  async function mount(documents) {
    await loadPreferences();
    const controls = document.getElementById('diffControls');
    const style = diffStyle;
    const ignore = ignoreWhitespace;
    const currentRequest = ++requestId;
    const withChanges = documents.filter((annotationDocument) => annotationDocument.hasChanges);
    controls.style.display = withChanges.length ? 'flex' : 'none';
    document.getElementById('diffUnified').classList.toggle('active', style === 'unified');
    document.getElementById('diffUnified').setAttribute('aria-pressed', String(style === 'unified'));
    document.getElementById('diffSideBySide').classList.toggle('active', style === 'side-by-side');
    document.getElementById('diffSideBySide').setAttribute('aria-pressed', String(style === 'side-by-side'));
    document.getElementById('diffIgnoreWhitespace').checked = ignore;
    await Promise.all(withChanges.map(async (annotationDocument) => {
      const viewer = annotationDocument.element.querySelector('.diff-viewer');
      const response = await fetch('/api/diffs?documentId=' + encodeURIComponent(annotationDocument.id) + '&style=' + style + '&ignoreWhitespace=' + ignore);
      const data = await response.json();
      if (currentRequest !== requestId || !data.changes) return;
      viewer.replaceChildren(Object.assign(document.createElement('h3'), { textContent: 'Files changed' }));
      data.files.forEach(({ path, html }) => {
        const file = document.createElement('div');
        file.className = 'diff-file';
        file.innerHTML = html;
        viewer.append(file);
        decorate(file, annotationDocument.id, path, style);
      });
      if (window.Diff2HtmlUI) new window.Diff2HtmlUI(viewer).highlightCode();
      viewer.style.display = 'block';
    }));
  }

  function install(getDocuments) {
    document.getElementById('diffUnified').onclick = async () => { await savePreferences({ diffStyle: 'unified' }); mount(getDocuments()); };
    document.getElementById('diffSideBySide').onclick = async () => { await savePreferences({ diffStyle: 'side-by-side' }); mount(getDocuments()); };
    document.getElementById('diffIgnoreWhitespace').onchange = async (event) => { await savePreferences({ ignoreWhitespace: event.target.checked }); mount(getDocuments()); };
  }
  return { install, mount, resolveRange, resolveSelectionRows, collapseKey };
})();
