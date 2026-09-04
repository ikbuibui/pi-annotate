(function() {
  'use strict';

  /* ===== Configuration & State ===== */
  const ANNOTATE_DATA = window.ANNOTATE_DATA || { sessionToken: '', mode: 'annotate', sourceInfo: null, gate: false, startedAt: Date.now() };

  const MODE = ANNOTATE_DATA.mode || 'annotate';
  const SOURCE_INFO = ANNOTATE_DATA.sourceInfo || null;
  const IS_GATE = !!ANNOTATE_DATA.gate;
  const STARTED_AT = ANNOTATE_DATA.startedAt || Date.now();

  let annotations = [];
  let planData = null;
  let nextAnnId = 0;
  let healthTimer = null;
  let feedbackFormatId = 'detailed';
  let customFeedbackFormats = [];
  let editingFeedbackFormatId = null;
  let formatPreviewTimer = null;
  let formatPreviewRequest = 0;

  /* ===== Utility Functions ===== */
  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function generateId() {
    return 'ann-' + Date.now().toString(36) + '-' + (nextAnnId++).toString(36) + Math.random().toString(36).slice(2, 5);
  }

  function getTypeIcon(type) {
    var icons = {
      comment: '<svg class="type-icon comment" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"/></svg> ',
      suggestion: '<svg class="type-icon suggestion" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg> ',
      issue: '<svg class="type-icon issue" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/></svg> ',
      praise: '<svg class="type-icon praise" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"/></svg> '
    };
    return icons[type] || '';
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' +
           pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ===== Text Selection & Annotation Creation ===== */

  let pendingRange = null; // { documentId, startOffset, endOffset, textPreview, selRect? }

  function nodeElement(node) {
    return node && (node.nodeType === 1 ? node : node.parentElement);
  }

  function annotationDocument(id) {
    return planData?.documents?.find(function(document) { return document.id === id; });
  }

  function documentSection(id) {
    return annotationDocument(id)?.element || null;
  }

  function handleTextSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    const range = sel.getRangeAt(0);
    if (!range) return;

    const startDocument = nodeElement(range.startContainer)?.closest('.annotation-document');
    const endDocument = nodeElement(range.endContainer)?.closest('.annotation-document');
    if (!startDocument || startDocument !== endDocument) return;
    const documentId = startDocument.dataset.documentId;
    const source = annotationDocument(documentId);
    if (!documentId || !source) return;

    let startBlock = nodeElement(range.startContainer)?.closest('.md-block');
    let endBlock = nodeElement(range.endContainer)?.closest('.md-block');
    if (!!startBlock !== !!endBlock) return;
    if (!startBlock) {
      const diff = window.AnnotationDiffViewer.resolveRange(range, startDocument.querySelector('.diff-viewer'));
      if (!diff) return;
      const rect = range.getBoundingClientRect();
      pendingRange = { documentId, startOffset: 0, endOffset: 0, textPreview: sel.toString().trim(), diff: Object.assign(diff, { documentId }),
        selRect: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width } };
      showFloatingToolbar(range);
      return;
    }

    const startOffset = parseInt(startBlock.dataset.offsetStart);
    const endOffset = parseInt(endBlock.dataset.offsetEnd);
    const selectedText = sel.toString().trim();
    let origStart = source.markdown.indexOf(selectedText, startOffset);
    let origEnd = origStart >= 0 ? origStart + selectedText.length : endOffset;
    if (origStart < 0) { origStart = startOffset; origEnd = endOffset; }
    const rect = range.getBoundingClientRect();
    pendingRange = { documentId, startOffset: origStart, endOffset: origEnd,
      textPreview: selectedText.length > 80 ? selectedText.slice(0, 80) + '…' : selectedText,
      selRect: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width } };
    showFloatingToolbar(range);
  }

  /* ===== Floating Toolbar ===== */

  function showFloatingToolbar(range) {
    var rect = range.getBoundingClientRect();
    var toolbar = document.getElementById('floatingToolbar');
    // Show first to measure width, then position and clamp
    toolbar.classList.add('active');
    var tw = toolbar.offsetWidth;
    var center = rect.left + rect.width / 2;
    var left = center - tw / 2;
    var pad = 8;
    if (left < pad) left = pad;
    if (left + tw > window.innerWidth - pad) left = window.innerWidth - tw - pad;
    toolbar.style.top = (rect.top - 48) + 'px';
    toolbar.style.left = left + 'px';
    toolbar.style.transform = 'none';
  }

  function hideFloatingToolbar() {
    document.getElementById('floatingToolbar').classList.remove('active');
  }

  /* ===== Annotation Management ===== */

  function addAnnotation(type, text, range, documentId) {
    const ann = {
      id: generateId(),
      type: type,
      scope: range ? 'selection' : 'overall',
      documentId: range ? range.documentId : documentId,
      text: text.trim(),
      originalText: range ? range.textPreview : '',
      range: range ? {
        startOffset: range.startOffset,
        endOffset: range.endOffset,
        textPreview: range.textPreview,
        diff: range.diff
      } : null,
      createdAt: Date.now()
    };
    annotations.unshift(ann);
    sortAnnotations();
    updateAll();
    return ann;
  }

  function sortAnnotations() {
    annotations.sort((a, b) => (a.range ? a.range.startOffset : -1) - (b.range ? b.range.startOffset : -1));
  }

  function updateAnnotation(id, newText) {
    const ann = annotations.find(a => a.id === id);
    if (ann) {
      ann.text = newText.trim();
      updateAll();
    }
  }

  function deleteAnnotation(id) {
    annotations = annotations.filter(a => a.id !== id);
    updateAll();
  }

  function highlightAnnotations() {
    const blocks = document.querySelectorAll('.md-block');
    // Remove existing highlights
    blocks.forEach(b => {
      b.className = b.className.replace(/\b(highlight-\w+|tooltip-below)\b/g, '').trim();
      b.removeAttribute('data-tooltip');
      (b.querySelectorAll('[style]') || []).forEach(el => {
        // Keep only visual inline styles, don't strip
      });
    });

    if (annotations.length === 0) return;

    const typeColorMap = {
      comment: 'comment',
      suggestion: 'suggestion',
      issue: 'issue',
      praise: 'praise'
    };

    annotations.forEach(ann => {
      if (!ann.range) return;
      const section = documentSection(ann.documentId);
      if (!section) return;
      const cls = 'highlight-' + (typeColorMap[ann.type] || 'comment');
      section.querySelectorAll('.md-block').forEach(block => {
        const blockStart = parseInt(block.dataset.offsetStart);
        const blockEnd = parseInt(block.dataset.offsetEnd);
        if (blockStart >= ann.range.startOffset && blockStart < ann.range.endOffset) {
          block.classList.add(cls);
          const existing = block.getAttribute('data-tooltip') || '';
          const tip = '[' + ann.type.toUpperCase() + '] ' + ann.text;
          block.setAttribute('data-tooltip', existing ? existing + '\n---\n' + tip : tip);
        } else if (blockEnd > ann.range.startOffset && blockEnd <= ann.range.endOffset) {
          block.classList.add(cls);
          const existing = block.getAttribute('data-tooltip') || '';
          const tip = '[' + ann.type.toUpperCase() + '] ' + ann.text;
          block.setAttribute('data-tooltip', existing ? existing + '\n---\n' + tip : tip);
        } else if (blockStart <= ann.range.startOffset && blockEnd >= ann.range.endOffset) {
          // Block fully contains the annotation range
          block.classList.add(cls);
          const existing = block.getAttribute('data-tooltip') || '';
          const tip = '[' + ann.type.toUpperCase() + '] ' + ann.text;
          block.setAttribute('data-tooltip', existing ? existing + '\n---\n' + tip : tip);
        }
      });
    });
  }

  function scrollToAnnotation(id) {
    const ann = annotations.find(a => a.id === id);
    if (!ann || !ann.range) return;
    const section = documentSection(ann.documentId);
    if (!section) return;
    if (ann.range.diff) {
      const diff = ann.range.diff;
      const lineKey = diff.side === 'original' ? 'diffOriginalLine' : 'diffCurrentLine';
      const row = Array.from(section.querySelectorAll('.diff-viewer tr[data-diff-path]')).find(function(candidate) {
        const line = Number(candidate.dataset[lineKey]);
        return candidate.dataset.diffPath === diff.path && line >= diff.startLine && line <= diff.endLine;
      });
      if (!row) return;
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.style.outline = '2px solid var(--accent)';
      setTimeout(function() { row.style.outline = ''; }, 2000);
      return;
    }
    const blocks = section.querySelectorAll('.md-block');
    for (const block of blocks) {
      const blockStart = parseInt(block.dataset.offsetStart);
      const blockEnd = parseInt(block.dataset.offsetEnd);
      if (blockStart < ann.range.endOffset && blockEnd > ann.range.startOffset) {
        block.scrollIntoView({ behavior: 'smooth', block: 'center' });
        block.style.outline = '2px solid var(--accent)';
        setTimeout(() => { block.style.outline = ''; }, 2000);
        return;
      }
    }
  }

  /* ===== UI Update ===== */

  function updateAll() {
    renderAnnotationList();
    updateBadge();
    highlightAnnotations();
    updateButtons();
    if (document.getElementById('formatOverlay').classList.contains('active')) scheduleFormatPreview();
  }

  function updateBadge() {
    document.getElementById('annCount').textContent = annotations.length;
  }

  function updateButtons() {
    document.getElementById('btnFeedback').disabled = annotations.length === 0;
  }

  function renderAnnotationList() {
    const container = document.getElementById('annList');
    if (annotations.length === 0) {
      container.innerHTML =
        '<div class="empty-state">' +
        '<div class="icon">📝</div>' +
        '<div>No annotations yet</div>' +
        '<div style="font-size:11px;">Select text or add an overall comment</div>' +
        '</div>';
      return;
    }

    const editingId = container.dataset.editingId || null;

    let html = '';
    annotations.forEach(ann => {
      const isEditing = editingId === ann.id;
      html += '<div class="ann-card" data-ann-id="' + ann.id + '">';
      html += '<div class="ann-card-header">';
      html += '<span class="ann-type-tag ' + ann.type + '">' + getTypeIcon(ann.type) + ann.type + '</span>';
      html += '<div class="ann-card-actions">';
      if (!isEditing) {
        html += '<button class="ann-btn edit" data-action="edit" data-id="' + ann.id + '" title="Edit annotation"><svg class="ann-btn-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg></button>';
        html += '<button class="ann-btn delete" data-action="delete" data-id="' + ann.id + '" title="Delete annotation"><svg class="ann-btn-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg></button>';
      }
      html += '</div></div>';

      if (isEditing) {
        html += '<textarea class="ann-edit-textarea" data-edit-id="' + ann.id + '" rows="3">' + escapeHtml(ann.text) + '</textarea>';
        html += '<div class="ann-edit-actions">';
        html += '<button class="ann-edit-btn cancel" data-action="cancelEdit" data-id="' + ann.id + '">Cancel</button>';
        html += '<button class="ann-edit-btn save" data-action="saveEdit" data-id="' + ann.id + '">Save</button>';
        html += '</div>';
      } else {
        html += '<div class="ann-card-text">' + (ann.text ? escapeHtml(ann.text) : '<span class="empty-text">(empty)</span>') + '</div>';
      }

      const documentTitle = ann.documentId === null ? 'Full review' : (annotationDocument(ann.documentId)?.title || 'Source section');
      html += ann.scope === 'overall'
        ? '<div class="ann-card-original">' + escapeHtml(documentTitle) + '</div>'
        : '<div class="ann-card-original" title="' + escapeHtml(documentTitle + ': ' + ann.originalText) + '">' + escapeHtml(documentTitle + ': ' + ann.originalText) + '</div>';
      html += '<div class="ann-card-time">' + formatTime(ann.createdAt) + '</div>';
      html += '</div>';
    });

    container.innerHTML = html;

    // Re-bind event listeners for card actions
    container.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        const action = this.dataset.action;
        const id = this.dataset.id;
        if (action === 'edit') startEditing(id);
        else if (action === 'delete') confirmDelete(id);
        else if (action === 'saveEdit') saveEditing(id);
        else if (action === 'cancelEdit') cancelEditing(id);
      });
    });

    // Card click to scroll
    container.querySelectorAll('.ann-card').forEach(card => {
      card.addEventListener('click', function(e) {
        if (e.target.closest('.ann-btn, .ann-edit-btn, .ann-edit-textarea')) return;
        const id = this.dataset.annId;
        if (id) scrollToAnnotation(id);
      });
    });
  }

  /* ===== Edit Mode ===== */

  function startEditing(id) {
    const container = document.getElementById('annList');
    container.dataset.editingId = id;
    renderAnnotationList();
  }

  function cancelEditing(id) {
    const container = document.getElementById('annList');
    container.dataset.editingId = '';
    renderAnnotationList();
  }

  function saveEditing(id) {
    const textarea = document.querySelector('[data-edit-id="' + id + '"]');
    if (textarea) {
      updateAnnotation(id, textarea.value);
    }
    const container = document.getElementById('annList');
    container.dataset.editingId = '';
    renderAnnotationList();
  }

  /* ===== Confirm Dialog ===== */

  let confirmCallback = null;

  function showConfirm(title, message, onOk) {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').textContent = message;
    document.getElementById('confirmOverlay').classList.add('active');
    confirmCallback = onOk;
  }

  function hideConfirm() {
    document.getElementById('confirmOverlay').classList.remove('active');
    confirmCallback = null;
  }

  document.getElementById('confirmOk').addEventListener('click', function() {
    if (confirmCallback) confirmCallback();
    hideConfirm();
  });

  document.getElementById('confirmCancel').addEventListener('click', hideConfirm);

  function confirmDelete(id) {
    showConfirm('Delete Annotation', 'Are you sure you want to delete this annotation?', function() {
      deleteAnnotation(id);
    });
  }

  /* ===== Creation Popup ===== */

  let selectedType = 'comment';
  let popupRange = null;
  let popupDocumentId = null;
  let popupActive = false;

  function showCreationPopup(type, range, documentId) {
    hideFloatingToolbar();
    selectedType = type;
    popupRange = range || null;
    popupDocumentId = range ? range.documentId : documentId;
    popupActive = true;

    const labels = { comment: 'Comment', suggestion: 'Suggestion', issue: 'Issue' };
    const label = labels[type] || 'Annotation';
    const original = document.getElementById('popupOriginal');
    original.style.display = popupRange ? 'block' : 'none';
    original.textContent = popupRange ? popupRange.textPreview : '';
    document.getElementById('creationTitle').textContent = 'Add ' + label;

    const textInput = document.getElementById('annTextInput');
    textInput.value = '';
    textInput.placeholder = 'Enter ' + label.toLowerCase() + '...';
    document.getElementById('popupConfirm').textContent = 'Add ' + label;
    document.getElementById('popupConfirm').disabled = true;

    var popup = document.getElementById('creationPopup');
    var popupWidth = 320;
    var popupHeight = 200;
    var left, top;
    var rect = popupRange && popupRange.selRect;

    if (rect) {
      left = rect.left + (rect.width / 2) - (popupWidth / 2);
      top = rect.bottom + 4;
      if (top + popupHeight > window.innerHeight - 10) top = rect.top - popupHeight - 4;
    } else {
      left = (window.innerWidth - popupWidth) / 2;
      top = (window.innerHeight - popupHeight) / 2;
    }

    if (left < 10) left = 10;
    if (left + popupWidth > window.innerWidth - 10) left = window.innerWidth - popupWidth - 10;
    if (top < 10) top = 10;

    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    popup.style.display = 'block';
    textInput.focus();
  }

  function hideCreationPopup() {
    document.getElementById('creationPopup').style.display = 'none';
    document.getElementById('creationOverlay').classList.remove('active');
    popupActive = false;
    popupRange = null;
    popupDocumentId = null;
    pendingRange = null;
  }

  function confirmCreation() {
    const text = document.getElementById('annTextInput').value.trim();
    if (!text) return;

    addAnnotation(selectedType, text, popupRange, popupDocumentId);
    hideCreationPopup();
  }

  // Text input enabling confirm
  document.getElementById('annTextInput').addEventListener('input', function() {
    document.getElementById('popupConfirm').disabled = this.value.trim().length === 0;
  });

  // Popup buttons
  document.getElementById('popupConfirm').addEventListener('click', confirmCreation);
  document.getElementById('popupCancel').addEventListener('click', hideCreationPopup);

  // Hide comment popup when clicking outside
  document.addEventListener('mousedown', function(e) {
    if (e.target.closest('#creationPopup') || e.target.closest('.floating-toolbar') || e.target.closest('.md-viewer')) return;
    if (document.getElementById('creationPopup').style.display === 'block') {
      hideCreationPopup();
    }
  });

  /* ===== Floating Toolbar Actions ===== */

  document.getElementById('btnFullReviewComment').addEventListener('click', function() {
    showCreationPopup('comment', null, null);
  });

  document.getElementById('tbComment').addEventListener('click', function() {
    if (pendingRange) showCreationPopup('comment', pendingRange);
  });

  document.getElementById('tbSuggestion').addEventListener('click', function() {
    if (pendingRange) showCreationPopup('suggestion', pendingRange);
  });

  document.getElementById('tbIssue').addEventListener('click', function() {
    if (pendingRange) showCreationPopup('issue', pendingRange);
  });

  document.getElementById('tbClose').addEventListener('click', function() {
    pendingRange = null;
    hideFloatingToolbar();
  });

  /* ===== Quick Label Popover ===== */

  var qlLabels = [
    { id: 'delete', type: 'suggestion', text: 'Suggest removing this section' },
    { id: 'praise', type: 'praise', text: 'Looks good' },
    { id: 'clarify', type: 'suggestion', text: 'Needs Clarification' },
    { id: 'missing', type: 'suggestion', text: 'Missing Details' },
    { id: 'assumption', type: 'suggestion', text: 'Verify Assumption' },
    { id: 'example', type: 'suggestion', text: 'Missing Example' },
    { id: 'tradeoff', type: 'suggestion', text: 'Trade-off Analysis' },
    { id: 'over-eng', type: 'suggestion', text: 'Over-engineered' },
    { id: 'scope', type: 'suggestion', text: 'Out of Scope' },
    { id: 'edge-case', type: 'suggestion', text: 'Edge Case Missing' },
    { id: 'structure', type: 'suggestion', text: 'Well-structured' }
  ];

  document.getElementById('tbQuickLabel').addEventListener('click', function(e) {
    var popover = document.getElementById('qlPopover');
    if (popover.classList.contains('active')) {
      popover.classList.remove('active');
      return;
    }
    var btnRect = this.getBoundingClientRect();
    popover.classList.add('active');
    // Dynamic positioning: show above by default, below if not enough space
    var spaceAbove = btnRect.top;
    var popoverHeight = popover.offsetHeight;
    if (spaceAbove > popoverHeight) {
      popover.style.top = (btnRect.top - 4) + 'px';
      popover.style.transform = 'translateY(-100%)';
    } else {
      popover.style.top = (btnRect.bottom + 4) + 'px';
      popover.style.transform = 'none';
    }
    popover.style.left = (btnRect.left - 4) + 'px';
  });

  document.querySelectorAll('.ql-item').forEach(function(item) {
    item.addEventListener('click', function() {
      var id = this.dataset.ql;
      var found = qlLabels.find(function(l) { return l.id === id; });
      if (pendingRange && found) {
        addAnnotation(found.type, found.text, pendingRange);
        pendingRange = null;
      }
      document.getElementById('qlPopover').classList.remove('active');
      hideFloatingToolbar();
    });
  });

  document.addEventListener('mousedown', function(e) {
    if (e.target.closest('#qlPopover') || e.target.closest('#tbQuickLabel')) return;
    document.getElementById('qlPopover').classList.remove('active');
  });

  // Hide floating toolbar on outside click
  document.addEventListener('mousedown', function(e) {
    if (e.target.closest('.floating-toolbar')) return;
    if (document.getElementById('floatingToolbar').classList.contains('active')) {
      hideFloatingToolbar();
    }
  });

  /* ===== Text Selection Listener ===== */

  let selectionTimeout = null;

  document.getElementById('mdViewer').addEventListener('mouseup', function(e) {
    // Delay to let the browser finalize selection
    if (selectionTimeout) clearTimeout(selectionTimeout);
    selectionTimeout = setTimeout(function() {
      if (popupActive) return;
      // Check if click was inside creation popup
      const popup = document.getElementById('creationPopup');
      if (popup.style.display === 'block') return;

      handleTextSelection();
    }, 50);
  });

  // Also listen for keyboard-based selection (Shift+Arrow)
  document.addEventListener('keyup', function(e) {
    if (e.key === 'Shift' || e.key.startsWith('Arrow')) {
      if (selectionTimeout) clearTimeout(selectionTimeout);
      selectionTimeout = setTimeout(function() {
        if (popupActive) return;
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim()) {
          handleTextSelection();
        }
      }, 100);
    }
  });

  /* ===== API Client ===== */

  async function postJson(url, data) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const text = await res.text();
      let msg = text;
      try { msg = JSON.parse(text).error || text; } catch(e) {}
      throw new Error('Request failed: ' + msg);
    }
    return res.json();
  }

  async function fetchPlan() {
    const res = await fetch('/api/plan');
    if (!res.ok) throw new Error('Server returned ' + res.status);
    return res.json();
  }

  function showReviewEnded() {
    if (healthTimer === null) return;
    clearInterval(healthTimer);
    healthTimer = null;
    document.title = 'Review ended — Annotation Review';
    document.getElementById('reviewEnded').classList.add('active');
  }

  function monitorReview() {
    healthTimer = setInterval(async function() {
      try {
        const response = await fetch('/api/health');
        if (!response.ok) showReviewEnded();
      } catch {
        showReviewEnded();
      }
    }, 1000);
  }

  async function submitFeedback() {
    const body = {
      formatId: feedbackFormatId,
      annotations: annotations.map(a => ({
        id: a.id,
        type: a.type,
        scope: a.scope,
        documentId: a.documentId,
        text: a.text,
        originalText: a.originalText,
        range: a.range,
        createdAt: a.createdAt
      }))
    };
    await postJson('/api/feedback', body);
  }

  async function submitApprove() {
    await postJson('/api/approve', {});
  }

  async function submitExit() {
    await postJson('/api/exit', {});
  }

  /* ===== Feedback Formats ===== */

  function builtInFeedbackFormats() {
    return (Array.isArray(ANNOTATE_DATA.feedbackFormats) ? ANNOTATE_DATA.feedbackFormats : []).filter(function(format) {
      return format && typeof format.id === 'string' && typeof format.name === 'string' && typeof format.template === 'string';
    });
  }

  function allFeedbackFormats() {
    return builtInFeedbackFormats().concat(customFeedbackFormats);
  }

  function populateFeedbackFormats() {
    const select = document.getElementById('feedbackFormatSelect');
    select.replaceChildren();
    [['Built in', builtInFeedbackFormats()], ['Your formats', customFeedbackFormats]].forEach(function(group) {
      if (!group[1].length) return;
      const options = document.createElement('optgroup');
      options.label = group[0];
      group[1].forEach(function(format) {
        const option = document.createElement('option');
        option.value = format.id;
        option.textContent = format.name;
        option.title = format.description || '';
        options.appendChild(option);
      });
      select.appendChild(options);
    });
    if (!allFeedbackFormats().some(function(format) { return format.id === feedbackFormatId; })) feedbackFormatId = 'detailed';
    select.value = feedbackFormatId;
  }

  async function saveFeedbackPreferences(update) {
    const response = await fetch('/api/preferences', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update)
    });
    const saved = await response.json();
    if (!response.ok) throw new Error(saved.error || 'Could not save feedback format');
    customFeedbackFormats = saved.feedbackFormats;
    feedbackFormatId = saved.feedbackFormat;
    populateFeedbackFormats();
  }

  function previewAnnotations() {
    if (annotations.length) return annotations;
    const source = planData && planData.documents && planData.documents[0];
    const selectedText = source && source.markdown && source.markdown.split(/\r?\n/).find(function(line) { return line.trim(); });
    const previewText = selectedText ? selectedText.trim().slice(0, 80) : 'The system handles the request.';
    const previewStart = source && source.markdown ? Math.max(0, source.markdown.indexOf(previewText)) : 0;
    return [{
      id: 'preview-suggestion', type: 'suggestion', scope: 'selection', documentId: source ? source.id : null,
      text: 'Add a concrete example.', originalText: previewText,
      range: { startOffset: previewStart, endOffset: previewStart + previewText.length, textPreview: previewText }, createdAt: Date.now()
    }, {
      id: 'preview-comment', type: 'comment', scope: 'overall', documentId: null,
      text: 'Keep the revision concise.', originalText: '', range: null, createdAt: Date.now()
    }];
  }

  function scheduleFormatPreview() {
    clearTimeout(formatPreviewTimer);
    const request = ++formatPreviewRequest;
    formatPreviewTimer = setTimeout(async function() {
      const preview = document.getElementById('formatPreview');
      preview.classList.remove('error');
      preview.textContent = 'Formatting…';
      try {
        const response = await postJson('/api/feedback-preview', {
          annotations: previewAnnotations(),
          template: document.getElementById('formatTemplate').value,
          contextLines: Number(document.getElementById('formatContextLines').value)
        });
        if (request === formatPreviewRequest) preview.textContent = response.feedback;
      } catch (err) {
        if (request === formatPreviewRequest) {
          preview.classList.add('error');
          preview.textContent = err.message;
        }
      }
    }, 150);
  }

  function openFormatDialog() {
    const format = allFeedbackFormats().find(function(candidate) { return candidate.id === feedbackFormatId; }) || builtInFeedbackFormats()[0];
    if (!format) return;
    const custom = customFeedbackFormats.some(function(candidate) { return candidate.id === format.id; });
    editingFeedbackFormatId = custom ? format.id : null;
    document.getElementById('formatName').value = custom ? format.name : format.name + ' copy';
    document.getElementById('formatContextLines').value = format.contextLines || 0;
    document.getElementById('formatTemplate').value = format.template;
    document.getElementById('formatDelete').style.visibility = custom ? 'visible' : 'hidden';
    document.getElementById('formatSave').textContent = custom ? 'Save format' : 'Save copy';
    document.getElementById('formatOverlay').classList.add('active');
    document.getElementById('formatName').focus();
    scheduleFormatPreview();
  }

  function closeFormatDialog() {
    document.getElementById('formatOverlay').classList.remove('active');
    clearTimeout(formatPreviewTimer);
    formatPreviewRequest++;
  }

  async function saveFormatDialog() {
    const name = document.getElementById('formatName').value.trim();
    const template = document.getElementById('formatTemplate').value;
    const contextLines = Number(document.getElementById('formatContextLines').value);
    if (!name || !template.trim()) return alert('A name and template are required.');
    if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 100) return alert('Context lines must be between 0 and 100.');
    const id = editingFeedbackFormatId || 'custom:' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36));
    const next = customFeedbackFormats.filter(function(format) { return format.id !== id; }).concat([{ id: id, name: name, template: template, contextLines: contextLines }]);
    try {
      await saveFeedbackPreferences({ feedbackFormats: next, feedbackFormat: id });
      closeFormatDialog();
    } catch (err) { alert(err.message); }
  }

  async function deleteFormatDialog() {
    if (!editingFeedbackFormatId || !window.confirm('Delete this saved feedback format?')) return;
    try {
      await saveFeedbackPreferences({
        feedbackFormats: customFeedbackFormats.filter(function(format) { return format.id !== editingFeedbackFormatId; }),
        feedbackFormat: 'detailed'
      });
      closeFormatDialog();
    } catch (err) { alert(err.message); }
  }

  async function initFeedbackFormats() {
    try {
      const response = await fetch('/api/preferences');
      const saved = await response.json();
      if (response.ok) {
        customFeedbackFormats = Array.isArray(saved.feedbackFormats) ? saved.feedbackFormats : [];
        feedbackFormatId = typeof saved.feedbackFormat === 'string' ? saved.feedbackFormat : 'detailed';
      }
    } catch {}
    populateFeedbackFormats();
  }

  document.getElementById('feedbackFormatSelect').addEventListener('change', async function() {
    const previous = feedbackFormatId;
    feedbackFormatId = this.value;
    try { await saveFeedbackPreferences({ feedbackFormat: feedbackFormatId }); }
    catch (err) { feedbackFormatId = previous; populateFeedbackFormats(); alert(err.message); }
  });
  document.getElementById('btnFeedbackFormats').addEventListener('click', openFormatDialog);
  document.getElementById('formatTemplate').addEventListener('input', scheduleFormatPreview);
  document.getElementById('formatContextLines').addEventListener('input', scheduleFormatPreview);
  document.getElementById('formatCancel').addEventListener('click', closeFormatDialog);
  document.getElementById('formatSave').addEventListener('click', saveFormatDialog);
  document.getElementById('formatDelete').addEventListener('click', deleteFormatDialog);
  document.getElementById('formatOverlay').addEventListener('mousedown', function(event) {
    if (event.target === this) closeFormatDialog();
  });
  document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape' && document.getElementById('formatOverlay').classList.contains('active')) closeFormatDialog();
  });

  /* ===== Bottom Toolbar Actions ===== */

  document.getElementById('btnFeedback').addEventListener('click', async function() {
    if (annotations.length === 0) return;
    this.disabled = true;
    this.textContent = 'Submitting...';
    try {
      await submitFeedback();
      showSubmittedState('Feedback submitted');
    } catch (err) {
      alert('Failed to submit feedback: ' + err.message);
      this.disabled = false;
      this.textContent = 'Send Feedback';
    }
  });

  document.getElementById('btnApprove').addEventListener('click', async function() {
    this.disabled = true;
    this.textContent = 'Approving...';
    try {
      await submitApprove();
      showSubmittedState('Approved');
    } catch (err) {
      alert('Failed to approve: ' + err.message);
      this.disabled = false;
      this.textContent = 'Approve without feedback';
    }
  });

  function showSubmittedState(label) {
    clearInterval(healthTimer);
    healthTimer = null;
    const banner = document.getElementById('submittedBanner');
    banner.textContent = '✓ ' + label;
    banner.classList.add('active');

    // Disable all toolbar buttons
    document.querySelectorAll('.toolbar-right button').forEach(b => b.disabled = true);
    document.getElementById('btnFeedback').textContent = 'Submitted';
    document.getElementById('btnApprove').textContent = 'Approved';

    // Notify the server, then ask the browser to close this tab.
    setTimeout(function() {
      fetch('/api/exit', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(function(){});
      try { window.close(); } catch {}
    }, 800);
  }

  /* ===== Keyboard Shortcuts ===== */

  // Flip tooltips near the viewport top to avoid clipping.
  // Use a hidden element to measure their rendered height.
  var _tooltipMeasure = document.createElement('div');
  _tooltipMeasure.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;' +
    'max-width:280px;padding:6px 10px;border:1px solid transparent;' +
    'font-size:12px;line-height:1.4;white-space:pre-wrap;';
  document.body.appendChild(_tooltipMeasure);
  function _tooltipHeight(content) {
    _tooltipMeasure.textContent = content || '';
    return _tooltipMeasure.offsetHeight + 4;  // gap between block and tooltip
  }
  // Remove the measurement element when the page unloads
  window.addEventListener('pagehide', function() {
    if (_tooltipMeasure && _tooltipMeasure.parentNode) {
      _tooltipMeasure.parentNode.removeChild(_tooltipMeasure);
    }
    _tooltipMeasure = null;
  });

  var _tooltipHeightCached = 0;
  var _hoveredBlock = null;
  document.addEventListener('mouseover', function(e) {
    var block = e.target.closest('.md-block[data-tooltip]');
    if (block) {
      if (block === _hoveredBlock) return;  // Skip recalculation within the same block
      _hoveredBlock = block;
      _tooltipHeightCached = _tooltipHeight(block.getAttribute('data-tooltip'));
      var rect = block.getBoundingClientRect();
      block.classList.toggle('tooltip-below', rect.top < _tooltipHeightCached);
    }
  });
  document.addEventListener('mouseout', function(e) {
    // Match '.md-block' so the class can still be removed if
    // highlightAnnotations() removes data-tooltip.
    var block = e.target.closest('.md-block');
    if (block && !block.contains(e.relatedTarget)) {
      block.classList.remove('tooltip-below');
      if (_hoveredBlock === block) {
        _hoveredBlock = null;
        _tooltipHeightCached = 0;
      }
    }
  });
  // Recalculate the position when scrolling during hover
  document.addEventListener('scroll', function() {
    if (_hoveredBlock && _hoveredBlock.hasAttribute('data-tooltip')) {
      var rect = _hoveredBlock.getBoundingClientRect();
      _hoveredBlock.classList.toggle('tooltip-below', rect.top < _tooltipHeightCached);
    }
  }, { passive: true });

  /* ===== Init ===== */

  async function init() {
    // Show source info
    const sourceEl = document.getElementById('sourceInfo');
    if (SOURCE_INFO) {
      sourceEl.textContent = SOURCE_INFO;
    } else {
      sourceEl.textContent = MODE === 'annotate-last' ? 'Last message' : 'Annotation';
    }

    const sourceNavigation = document.getElementById('sourceNavigation');
    const sourceMenu = document.getElementById('sourceMenu');
    function closeSourceMenu(focusButton) {
      if (sourceMenu.hidden) return;
      sourceMenu.hidden = true;
      sourceEl.setAttribute('aria-expanded', 'false');
      if (focusButton) sourceEl.focus();
    }
    function renderSourceMenu() {
      sourceMenu.replaceChildren();
      planData.documents.forEach(function(annotationSource) {
        const item = document.createElement('button');
        const badge = document.createElement('span');
        const title = document.createElement('span');
        item.type = 'button';
        item.className = 'source-menu-item';
        badge.className = 'source-badge source-badge--' + annotationSource.kind;
        badge.textContent = annotationSource.kind === 'message' ? 'Message' : 'File';
        title.className = 'source-menu-title';
        title.textContent = annotationSource.title;
        item.append(badge, title);
        item.addEventListener('click', function() {
          closeSourceMenu(true);
          annotationSource.element.scrollIntoView({ behavior: 'smooth', block: 'start' });
          annotationSource.element.classList.add('is-source-target');
          window.setTimeout(function() { annotationSource.element.classList.remove('is-source-target'); }, 1200);
        });
        sourceMenu.appendChild(item);
      });
    }
    sourceEl.addEventListener('click', function() {
      const open = sourceMenu.hidden;
      sourceMenu.hidden = !open;
      sourceEl.setAttribute('aria-expanded', String(open));
      if (open) sourceMenu.querySelector('button')?.focus();
    });
    document.addEventListener('click', function(event) {
      if (!sourceNavigation.contains(event.target)) closeSourceMenu(false);
    });
    document.addEventListener('keydown', function(event) {
      if (event.key === 'Escape' && !sourceMenu.hidden) {
        event.preventDefault();
        closeSourceMenu(true);
      }
    });

    // Show gate tag if applicable
    if (IS_GATE) {
      document.getElementById('gateTag').style.display = 'inline-flex';
    }

    // Theme selector: built-ins plus validated user palettes from the server.
    (function initTheme() {
      var customThemes = new Map((Array.isArray(ANNOTATE_DATA.themes) ? ANNOTATE_DATA.themes : [])
        .filter(function(theme) { return theme && typeof theme.name === 'string' && theme.colors && typeof theme.colors === 'object'; })
        .map(function(theme) { return [theme.name, theme.colors]; }));
      var names = ['dark', 'light'].concat(Array.from(customThemes.keys()));
      var colorKeys = ['bg-primary', 'bg-secondary', 'bg-tertiary', 'bg-hover', 'text-primary', 'text-secondary', 'text-muted', 'border', 'border-light', 'accent', 'accent-hover', 'success', 'danger', 'warning', 'type-comment', 'type-comment-bg', 'type-comment-border', 'type-suggestion', 'type-suggestion-bg', 'type-suggestion-border', 'type-issue', 'type-issue-bg', 'type-issue-border', 'type-praise', 'type-praise-bg', 'type-praise-border'];
      var select = document.getElementById('themeSelect');
      names.forEach(function(name) {
        var option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
      });

      function applyTheme(name) {
        if (names.indexOf(name) < 0) name = 'dark';
        var root = document.documentElement;
        colorKeys.forEach(function(key) { root.style.removeProperty('--' + key); });
        root.classList.toggle('light-mode', name === 'light');
        var colors = customThemes.get(name);
        if (colors) Object.keys(colors).forEach(function(key) { root.style.setProperty('--' + key, colors[key]); });
        select.value = name;
        localStorage.setItem('pi-annotate-theme', name);
      }

      applyTheme(localStorage.getItem('pi-annotate-theme') || 'dark');
      select.addEventListener('change', function() { applyTheme(select.value); });
    })();

    // Approve button: disabled when annotations exist
    function updateApproveButton() {
      var btn = document.getElementById('btnApprove');
      btn.disabled = annotations.length > 0;
      btn.title = annotations.length > 0 ? 'Remove annotations first to approve without feedback' : 'Approve without feedback';
    }
    // Patch updateAll to call updateApproveButton
    var _origUpdateAll = updateAll;
    updateAll = function() {
      _origUpdateAll();
      updateApproveButton();
    };

    try {
      planData = await fetchPlan();
    } catch (err) {
      // Fallback to demo content when server unavailable
      document.getElementById('loadingState').style.display = 'none';
      const demoPlan = '# Demo Plan\n\nThis is a demonstration of the annotation UI. ' +
        'The server was not reachable, so demo content is shown.\n\n' +
        '## Section 1\n\nSelect any text to create an annotation. ' +
        'Annotations appear in the right panel with different types:\n\n' +
        '- **Comment** (blue) - General feedback\n' +
        '- **Suggestion** (green) - Improvement ideas\n' +
        '- **Issue** (red) - Problems to fix\n' +
        '- **Praise** (yellow) - Positive feedback\n\n' +
        '## Section 2\n\n' +
        'Code block example:\n\n' +
        '```javascript\n' +
        'function hello() {\n' +
        '  console.log(\"Hello, World!\");\n' +
        '}\n' +
        '```\n\n' +
        '> Blockquote: This is a quoted text for annotation testing.\n\n' +
        '### Nested Lists\n\n' +
        '1. First item\n' +
        '2. Second item\n' +
        '    - Sublist A\n' +
        '    - Sublist B\n' +
        '3. Third item\n\n' +
        'Use the **Send Feedback** button at the bottom to submit your annotations to the server. ' +
        'Or use **Exit** to close without submitting.';
      planData = { documents: [{ id: 'demo', kind: 'file', title: '(Demo Mode)', sourceInfo: '(Demo Mode)', markdown: demoPlan,
        html: '<pre class="md-block" data-offset-start="0" data-offset-end="' + demoPlan.length + '"><code>' + escapeHtml(demoPlan) + '</code></pre>', hasChanges: false }] };
    }

    await initFeedbackFormats();

    _hoveredBlock = null;
    const documentsDiv = document.getElementById('documents');
    document.getElementById('loadingState').style.display = 'none';
    documentsDiv.style.display = 'block';
    const singleDocument = planData.documents.length === 1;
    document.getElementById('btnFullReviewComment').style.display = singleDocument ? 'none' : '';
    planData.documents.forEach(function(annotationSource) {
      const section = document.createElement('section');
      const isMessage = annotationSource.kind === 'message';
      section.className = 'annotation-document annotation-document--' + annotationSource.kind;
      section.dataset.documentId = annotationSource.id;
      const kindLabel = isMessage ? 'Message' : 'File';
      section.innerHTML = '<div class="document-header"><div class="document-title">' +
        '<button class="document-collapse-toggle" type="button" aria-expanded="true" aria-label="Collapse ' + escapeHtml(annotationSource.title) + '"><span aria-hidden="true">▸</span></button><span class="source-badge source-badge--' + annotationSource.kind + '">' + kindLabel + '</span>' +
        '<h2>' + escapeHtml(annotationSource.title) + '</h2></div>' +
        '<button class="btn-toolbar btn-overall-comment" type="button">' + (singleDocument ? 'Overall comment' : 'Overall comment for this section') + '</button></div>' +
        '<div class="document-body"><div class="document-content">' + (annotationSource.html || '<p class="md-block" data-offset-start="0" data-offset-end="0" style="color:var(--text-muted)">(empty content)</p>') + '</div><div class="diff-viewer"></div></div>';
      if (annotationSource.language) {
        const languageSelect = document.createElement('select');
        languageSelect.className = 'language-select';
        languageSelect.setAttribute('aria-label', 'Syntax language for ' + annotationSource.title);
        languageSelect.title = 'Syntax language; auto-selected from file extension.';
        (planData.languages || ['unknown']).forEach(function(language) {
          const option = document.createElement('option');
          option.value = language;
          option.textContent = language;
          option.selected = language === annotationSource.language;
          languageSelect.appendChild(option);
        });
        languageSelect.addEventListener('change', async function() {
          const previousLanguage = annotationSource.language;
          languageSelect.disabled = true;
          try {
            const response = await fetch('/api/render-code?documentId=' + encodeURIComponent(annotationSource.id) + '&language=' + encodeURIComponent(languageSelect.value));
            if (!response.ok) throw new Error('Could not render code');
            const rendered = await response.json();
            section.querySelector('.document-content').innerHTML = rendered.html;
            annotationSource.language = rendered.language;
            highlightAnnotations();
          } catch {
            languageSelect.value = previousLanguage;
          } finally {
            languageSelect.disabled = false;
          }
        });
        section.querySelector('.document-title').appendChild(languageSelect);
      }
      section.querySelector('.btn-overall-comment').addEventListener('click', function() { showCreationPopup('comment', null, annotationSource.id); });
      const collapseToggle = section.querySelector('.document-collapse-toggle');
      if (collapseToggle) collapseToggle.addEventListener('click', function() {
        const body = section.querySelector('.document-body');
        body.hidden = !body.hidden;
        collapseToggle.setAttribute('aria-expanded', String(!body.hidden));
        collapseToggle.setAttribute('aria-label', (body.hidden ? 'Expand ' : 'Collapse ') + annotationSource.title);
      });
      annotationSource.element = section;
      documentsDiv.append(section);
    });

    // Add subtle scroll margin to blocks for smooth scrolling
    const style = document.createElement('style');
    style.textContent = '.md-block { scroll-margin-top: 100px; }';
    document.head.appendChild(style);

    sourceEl.textContent = planData.documents.length === 1 ? planData.documents[0].title : planData.documents.length + ' sources ▾';
    renderSourceMenu();

    updateBadge();
    updateButtons();
    window.AnnotationDiffViewer.install(function() { return planData.documents; });
    window.AnnotationDiffViewer.mount(planData.documents);
    monitorReview();

    // Notify server when window is closed (reliable using fetch + keepalive)
    function notifyExit() {
      try {
        fetch('/api/exit', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: '{}' });
      } catch {}
    }
    window.addEventListener('beforeunload', notifyExit);
    window.addEventListener('pagehide', notifyExit);
  }

  init();

})();
