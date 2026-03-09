/* Synapsis Web Dashboard */
(function () {
  'use strict';

  let currentPath = '';
  let currentFile = null;

  const $ = (s) => document.querySelector(s);
  const $list = $('#file-list');
  const $preview = $('#preview');
  const $breadcrumb = $('#breadcrumb');
  const $uploadZone = $('#upload-zone');
  const $toast = $('#toast');

  // --- API ---

  async function api(method, path, body) {
    const opts = { method, credentials: 'same-origin' };
    if (body) {
      opts.body = body;
    }
    const res = await fetch(path, opts);
    if (res.status === 401) {
      $preview.innerHTML = '<p>Session expired. Ask your AI companion for a new link.</p>';
      $preview.className = 'empty';
      return null;
    }
    return res;
  }

  async function fetchFiles(dirPath) {
    const p = dirPath || '';
    const res = await api('GET', `/api/files?path=${encodeURIComponent(p)}`);
    if (!res) return null;
    return res.json();
  }

  async function fetchFile(filePath) {
    const res = await api('GET', `/api/file?path=${encodeURIComponent(filePath)}`);
    if (!res) return null;
    return res;
  }

  async function uploadFile(dirPath, file) {
    const p = dirPath || '';
    const res = await api('POST', `/api/upload?path=${encodeURIComponent(p)}&name=${encodeURIComponent(file.name)}`, file);
    if (!res) return null;
    return res.json();
  }

  async function deleteFile(filePath) {
    const res = await api('DELETE', `/api/file?path=${encodeURIComponent(filePath)}`);
    if (!res) return null;
    return res.json();
  }

  // --- Rendering ---

  function formatSize(bytes) {
    if (bytes === undefined) return '';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  }

  function fileIcon(entry) {
    if (entry.type === 'dir') return '📁';
    const ext = entry.name.split('.').pop().toLowerCase();
    const icons = {
      md: '📝', txt: '📄', json: '📋', js: '⚡',
      png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼',
      pdf: '📕',
    };
    return icons[ext] || '📄';
  }

  function renderBreadcrumb(dirPath) {
    const parts = dirPath ? dirPath.split('/').filter(Boolean) : [];
    let html = '<span data-path="">~</span>';
    let accumulated = '';
    for (const part of parts) {
      accumulated += (accumulated ? '/' : '') + part;
      html += `<span class="sep">/</span><span data-path="${accumulated}">${part}</span>`;
    }
    $breadcrumb.innerHTML = html;

    // Make last item non-clickable
    const spans = $breadcrumb.querySelectorAll('span[data-path]');
    if (spans.length) {
      const last = spans[spans.length - 1];
      last.classList.add('current');
    }

    // Click handlers
    $breadcrumb.querySelectorAll('span[data-path]').forEach((el) => {
      if (el.classList.contains('current')) return;
      el.addEventListener('click', () => navigateTo(el.dataset.path));
    });
  }

  function renderFileList(data) {
    if (!data || !data.entries) {
      $list.innerHTML = '<div class="file-entry"><span class="file-name">Failed to load</span></div>';
      return;
    }

    // Toolbar
    let html = `<div class="toolbar">
      <button id="btn-upload">⬆ Upload</button>
      ${currentFile ? `<button id="btn-download">⬇ Download</button>` : ''}
      ${currentFile ? `<button id="btn-delete" class="danger">🗑 Delete</button>` : ''}
    </div>`;

    // Parent directory entry
    if (currentPath) {
      html += `<div class="file-entry" data-path=".." data-type="dir">
        <span class="file-icon">⬆</span>
        <span class="file-name">..</span>
      </div>`;
    }

    for (const entry of data.entries) {
      const entryPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
      const isActive = currentFile === entryPath;
      html += `<div class="file-entry${isActive ? ' active' : ''}" data-path="${entryPath}" data-type="${entry.type}">
        <span class="file-icon">${fileIcon(entry)}</span>
        <span class="file-name">${entry.name}</span>
        <span class="file-size">${formatSize(entry.size)}</span>
      </div>`;
    }

    if (!data.entries.length && !currentPath) {
      html += '<div class="file-entry"><span class="file-name" style="color:var(--text2)">Empty workspace</span></div>';
    }

    $list.innerHTML = html;

    // Event handlers
    $list.querySelectorAll('.file-entry[data-path]').forEach((el) => {
      el.addEventListener('click', () => {
        const p = el.dataset.path;
        const type = el.dataset.type;
        if (p === '..') {
          const parent = currentPath.split('/').slice(0, -1).join('/');
          navigateTo(parent);
        } else if (type === 'dir') {
          navigateTo(p);
        } else {
          selectFile(p);
        }
      });
    });

    // Toolbar handlers
    const btnUpload = $('#btn-upload');
    if (btnUpload) btnUpload.addEventListener('click', triggerUpload);

    const btnDownload = $('#btn-download');
    if (btnDownload) btnDownload.addEventListener('click', () => downloadFile(currentFile));

    const btnDelete = $('#btn-delete');
    if (btnDelete) btnDelete.addEventListener('click', () => confirmDelete(currentFile));
  }

  async function renderPreview(filePath) {
    if (!filePath) {
      $preview.innerHTML = '<p>Select a file to preview</p>';
      $preview.className = 'empty';
      return;
    }

    const res = await fetchFile(filePath);
    if (!res) return;

    const contentType = res.headers.get('content-type') || '';
    const ext = filePath.split('.').pop().toLowerCase();

    if (contentType.startsWith('image/')) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      $preview.innerHTML = `<img src="${url}" alt="${filePath}">`;
      $preview.className = '';
      return;
    }

    if (ext === 'pdf') {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      $preview.innerHTML = `<iframe src="${url}" style="width:100%;height:80vh;border:none;border-radius:6px;"></iframe>`;
      $preview.className = '';
      return;
    }

    const text = await res.text();

    if (ext === 'md') {
      $preview.innerHTML = `<div class="markdown">${renderMarkdown(text)}</div>`;
      $preview.className = '';
      return;
    }

    $preview.innerHTML = `<pre>${escapeHtml(text)}</pre>`;
    $preview.className = '';
  }

  // --- Simple markdown renderer ---

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderMarkdown(md) {
    let html = escapeHtml(md);

    // Code blocks
    html = html.replace(/```[\s\S]*?```/g, (match) => {
      const code = match.slice(3, -3).replace(/^\w*\n/, '');
      return `<pre><code>${code}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Bold and italic
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Horizontal rules
    html = html.replace(/^---$/gm, '<hr>');

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    // Line breaks → paragraphs
    html = html.replace(/\n\n/g, '</p><p>');
    html = '<p>' + html + '</p>';

    // Clean up empty paragraphs
    html = html.replace(/<p>\s*<\/p>/g, '');
    html = html.replace(/<p>\s*(<h[123]>)/g, '$1');
    html = html.replace(/(<\/h[123]>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>\s*(<ul>)/g, '$1');
    html = html.replace(/(<\/ul>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>\s*(<pre>)/g, '$1');
    html = html.replace(/(<\/pre>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>\s*(<blockquote>)/g, '$1');
    html = html.replace(/(<\/blockquote>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>\s*(<hr>)/g, '$1');

    return html;
  }

  // --- Navigation ---

  async function navigateTo(dirPath) {
    currentPath = dirPath || '';
    currentFile = null;
    renderBreadcrumb(currentPath);
    const data = await fetchFiles(currentPath);
    renderFileList(data);
    renderPreview(null);
  }

  async function selectFile(filePath) {
    currentFile = filePath;
    // Re-render list to show active state
    const data = await fetchFiles(currentPath);
    renderFileList(data);
    renderPreview(filePath);
  }

  // --- Actions ---

  function triggerUpload() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', async () => {
      for (const file of input.files) {
        try {
          await uploadFile(currentPath, file);
          toast(`Uploaded: ${file.name}`, 'success');
        } catch (err) {
          toast(`Upload failed: ${err.message}`, 'error');
        }
      }
      navigateTo(currentPath);
    });
    input.click();
  }

  function downloadFile(filePath) {
    const a = document.createElement('a');
    a.href = `/api/file?path=${encodeURIComponent(filePath)}`;
    a.download = filePath.split('/').pop();
    a.click();
  }

  function confirmDelete(filePath) {
    const name = filePath.split('/').pop();
    if (!confirm(`Delete "${name}"?`)) return;

    deleteFile(filePath).then((result) => {
      if (result && result.ok) {
        toast(`Deleted: ${name}`, 'success');
        currentFile = null;
        navigateTo(currentPath);
      } else {
        toast('Delete failed', 'error');
      }
    });
  }

  function toast(msg, type) {
    $toast.textContent = msg;
    $toast.className = type || '';
    setTimeout(() => { $toast.className = 'hidden'; }, 3000);
  }

  // --- Drag & drop ---

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    $uploadZone.classList.remove('hidden');
  });

  $uploadZone.addEventListener('dragleave', (e) => {
    if (e.target === $uploadZone || e.target === $uploadZone.firstElementChild) {
      $uploadZone.classList.add('hidden');
    }
  });

  $uploadZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    $uploadZone.classList.add('hidden');

    for (const file of e.dataTransfer.files) {
      try {
        await uploadFile(currentPath, file);
        toast(`Uploaded: ${file.name}`, 'success');
      } catch (err) {
        toast(`Upload failed: ${err.message}`, 'error');
      }
    }
    navigateTo(currentPath);
  });

  // --- Init ---

  // Support deep link via hash: /#path/to/file.md
  const hashPath = decodeURIComponent(location.hash.slice(1));
  if (hashPath) {
    const dir = hashPath.includes('/') ? hashPath.split('/').slice(0, -1).join('/') : '';
    navigateTo(dir).then(() => selectFile(hashPath));
  } else {
    navigateTo('');
  }
})();
