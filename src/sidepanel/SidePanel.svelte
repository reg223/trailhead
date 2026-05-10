<script lang="ts">
  import katex from 'katex';
  import 'katex/dist/katex.min.css';
  import { onDestroy, onMount } from 'svelte';
  import {
    DEFAULT_SESSION_ID,
    NOTE_LIMIT,
    SCREENSHOT_MAX_BYTES,
    SCREENSHOT_MAX_DIMENSION,
    dbPromise,
    ensureDefaultSession,
    type TrailheadEntry,
    type TrailheadSession
  } from '../lib/db';

  type EntryDraft = Pick<TrailheadEntry, 'text' | 'url' | 'note' | 'citation'>;

  let sessions: TrailheadSession[] = [];
  let entries: TrailheadEntry[] = [];
  let activeSessionId = DEFAULT_SESSION_ID;
  let newSessionTitle = '';
  let sessionSearchQuery = '';
  let newEntry: EntryDraft = { text: '', url: '', note: '', citation: '' };
  let screenshotDataUrl = '';
  let screenshotMimeType = '';
  let screenshotError = '';
  let editingSessionId = '';
  let editingEntryId = '';
  let addingNoteEntryId = '';
  let editingCitationEntryId = '';
  let exportedCitationEntryId = '';
  let exportedSessionCitations = false;
  let sessionFormOpen = false;
  let manualEntryOpen = false;
  let searchOpen = false;
  let graphOpen = false;
  let sessionRailCollapsed = false;
  let openSessionMenuId = '';
  let openSnippetMenuId = '';
  let viewingEntryId = '';
  let confirmingDeleteEntryId = '';
  let sessionDraft = { title: '' };
  let entryDraft: EntryDraft = { text: '', url: '', note: '', citation: '' };
  let noteDraft = '';
  let citationDraft = '';
  let citationError = '';

  $: activeSession = sessions.find((session) => session.id === activeSessionId);
  $: sessionCitations = entries
    .map((entry) => entry.citation?.trim())
    .filter((citation): citation is string => Boolean(citation));
  $: uniqueSessionCitations = dedupeCitations(sessionCitations);
  $: displayedEntries = searchOpen ? getDisplayedEntries(entries, sessionSearchQuery) : entries;
  $: graph = buildSnippetGraph(entries);

  function hasExtensionStorage() {
    return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);
  }

  async function getStoredActiveSessionId() {
    if (!hasExtensionStorage()) {
      return undefined;
    }

    const { activeSessionId: storedActiveSessionId } = await chrome.storage.local.get('activeSessionId');
    return typeof storedActiveSessionId === 'string' ? storedActiveSessionId : undefined;
  }

  async function storeActiveSessionId(sessionId: string) {
    if (hasExtensionStorage()) {
      await chrome.storage.local.set({ activeSessionId: sessionId });
    }
  }

  function abbreviate(text: string) {
    return text.length > 30 ? `${text.slice(0, 30)}...` : text;
  }

  function entryLabel(entry: TrailheadEntry) {
    return entry.kind === 'screenshot' && !entry.text ? 'Screenshot' : entry.text;
  }

  function clampNote(note: string) {
    return note.slice(0, NOTE_LIMIT);
  }

  function escapeHtml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function renderLatexText(value: string) {
    const parts: string[] = [];
    let remaining = value;
    const pattern = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\$[^$\n]+?\$|\\\([\s\S]+?\\\))/;

    while (remaining) {
      const match = remaining.match(pattern);

      if (!match || match.index === undefined) {
        parts.push(escapeHtml(remaining));
        break;
      }

      parts.push(escapeHtml(remaining.slice(0, match.index)));

      const raw = match[0];
      const displayMode = raw.startsWith('$$') || raw.startsWith('\\[');
      const expression = raw
        .replace(/^\$\$|\$\$$/g, '')
        .replace(/^\\\[|\\\]$/g, '')
        .replace(/^\$|\$$/g, '')
        .replace(/^\\\(|\\\)$/g, '');

      parts.push(katex.renderToString(expression, { displayMode, throwOnError: false }));
      remaining = remaining.slice(match.index + raw.length);
    }

    return parts.join('');
  }

  function normalizeDoi(value: string) {
    return value
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
      .replace(/^doi:\s*/i, '')
      .replace(/[.,;)\]]+$/g, '')
      .trim();
  }

  function extractDoi(value: string) {
    const normalized = normalizeDoi(value);
    return normalized.match(/^10\.\d{4,9}\/[-._;()/:A-Z0-9]+$/i)?.[0] ?? '';
  }

  async function fetchBibtexForDoi(doi: string) {
    const response = await fetch(`https://doi.org/${encodeURI(doi)}`, {
      headers: { Accept: 'application/x-bibtex' },
    });

    if (!response.ok) {
      throw new Error('Could not fetch BibTeX for that DOI.');
    }

    return (await response.text()).trim();
  }

  async function resolveCitationInput(value: string) {
    const citation = value.trim();
    const doi = extractDoi(citation);

    if (!citation || !doi) {
      return citation;
    }

    return fetchBibtexForDoi(doi);
  }

  function dedupeCitations(citations: string[]) {
    const seen = new Set<string>();

    return citations.filter((citation) => {
      const key = citation.replace(/\s+/g, ' ').toLowerCase();

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }

  function countMatches(text: string, term: string) {
    return text.split(term).length - 1;
  }

  function scoreEntry(entry: TrailheadEntry, terms: string[]) {
    const note = (entry.note ?? '').toLowerCase();
    const text = entry.text.toLowerCase();
    const keywords = entry.keywords.join(' ').toLowerCase();

    return terms.reduce((score, term) => {
      const noteScore = countMatches(note, term) * 6;
      const keywordScore = countMatches(keywords, term) * 4;
      const textScore = countMatches(text, term) * 2;
      return score + noteScore + keywordScore + textScore;
    }, 0);
  }

  function tokenizeGraphText(value: string) {
    const stopwords = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'were', 'has', 'have', 'not', 'but', 'you', 'your', 'can', 'will']);
    return value
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2 && !stopwords.has(token));
  }

  function buildSnippetGraph(allEntries: TrailheadEntry[]) {
    const nodes = allEntries.slice(0, 50);
    const documents = nodes.map((entry) => [
      ...tokenizeGraphText(entry.note).flatMap((token) => [token, token, token]),
      ...tokenizeGraphText(entry.keywords.join(' ')).flatMap((token) => [token, token]),
      ...tokenizeGraphText(entry.text),
    ]);
    const documentFrequency = new Map<string, number>();

    for (const tokens of documents) {
      for (const token of new Set(tokens)) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }

    const vectors = documents.map((tokens) => {
      const vector = new Map<string, number>();
      for (const token of tokens) {
        vector.set(token, (vector.get(token) ?? 0) + 1);
      }
      for (const [token, count] of vector) {
        const idf = Math.log((nodes.length + 1) / ((documentFrequency.get(token) ?? 0) + 1)) + 1;
        vector.set(token, count * idf);
      }
      return vector;
    });

    const similarities: { source: number; target: number; score: number }[] = [];
    for (let source = 0; source < vectors.length; source += 1) {
      for (let target = source + 1; target < vectors.length; target += 1) {
        const score = cosineSimilarity(vectors[source], vectors[target]);
        if (score >= 0.12) {
          similarities.push({ source, target, score });
        }
      }
    }

    const edges = similarities
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(12, nodes.length * 3));

    return { nodes, edges };
  }

  function cosineSimilarity(left: Map<string, number>, right: Map<string, number>) {
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;

    for (const value of left.values()) {
      leftNorm += value * value;
    }
    for (const value of right.values()) {
      rightNorm += value * value;
    }
    for (const [token, value] of left) {
      dot += value * (right.get(token) ?? 0);
    }

    return leftNorm && rightNorm ? dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) : 0;
  }

  function graphX(index: number, total: number) {
    return 180 + 135 * Math.cos((index / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2);
  }

  function graphY(index: number, total: number) {
    return 165 + 115 * Math.sin((index / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2);
  }

  function getDisplayedEntries(allEntries: TrailheadEntry[], query: string) {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean);

    if (!terms.length) {
      return allEntries;
    }

    return allEntries
      .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
      .slice(0, 5)
      .map(({ entry }) => entry);
  }

  function dataUrlBytes(dataUrl: string) {
    const base64 = dataUrl.split(',')[1] ?? '';
    return Math.ceil((base64.length * 3) / 4);
  }

  function loadImage(dataUrl: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Could not load screenshot'));
      image.src = dataUrl;
    });
  }

  function readFileAsDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read screenshot'));
      reader.readAsDataURL(file);
    });
  }

  async function compressScreenshot(file: File) {
    if (!file.type.startsWith('image/')) {
      throw new Error('Choose an image file.');
    }

    const originalDataUrl = await readFileAsDataUrl(file);
    const image = await loadImage(originalDataUrl);
    const scale = Math.min(1, SCREENSHOT_MAX_DIMENSION / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Could not process screenshot.');
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    for (const quality of [0.86, 0.72, 0.58]) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (dataUrlBytes(dataUrl) <= SCREENSHOT_MAX_BYTES) {
        return { dataUrl, mimeType: 'image/jpeg' };
      }
    }

    throw new Error('Screenshot is too large. Use an image under 1 MB after compression.');
  }

  async function setScreenshotFromFile(file: File) {
    screenshotError = '';

    try {
      const screenshot = await compressScreenshot(file);
      screenshotDataUrl = screenshot.dataUrl;
      screenshotMimeType = screenshot.mimeType;
    } catch (error) {
      screenshotDataUrl = '';
      screenshotMimeType = '';
      screenshotError = error instanceof Error ? error.message : 'Could not process screenshot.';
      throw error;
    }
  }

  function getClipboardImageFile(event: ClipboardEvent) {
    const item = Array.from(event.clipboardData?.items ?? []).find((clipboardItem) => clipboardItem.type.startsWith('image/'));

    if (item) {
      return item.getAsFile();
    }

    return Array.from(event.clipboardData?.files ?? []).find((file) => file.type.startsWith('image/')) ?? null;
  }

  async function handleScreenshotChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    screenshotError = '';

    if (!file) {
      screenshotDataUrl = '';
      screenshotMimeType = '';
      return;
    }

    try {
      await setScreenshotFromFile(file);
    } catch (error) {
      input.value = '';
    }
  }

  async function handleScreenshotPaste(event: ClipboardEvent) {
    const file = getClipboardImageFile(event);

    if (!file) {
      return;
    }

    event.preventDefault();
    manualEntryOpen = true;

    try {
      await setScreenshotFromFile(file);
    } catch {
      // setScreenshotFromFile already updates the visible error state.
    }
  }

  function clearScreenshot() {
    screenshotDataUrl = '';
    screenshotMimeType = '';
    screenshotError = '';
  }

  async function setActiveSession(sessionId: string) {
    activeSessionId = sessionId;
    await storeActiveSessionId(sessionId);
    await loadEntries();
  }

  async function loadSessions() {
    const db = await dbPromise;
    sessions = await db.getAll('sessions');
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);

    if (!sessions.some((session) => session.id === activeSessionId)) {
      activeSessionId = sessions[0]?.id ?? DEFAULT_SESSION_ID;
      await storeActiveSessionId(activeSessionId);
    }
  }

  async function loadEntries() {
    const db = await dbPromise;
    entries = await db.getAllFromIndex('entries', 'by-session', activeSessionId);
    entries.sort((a, b) => b.timestamp - a.timestamp);
    exportedSessionCitations = false;
  }

  async function refresh() {
    await ensureDefaultSession();

    const storedActiveSessionId = await getStoredActiveSessionId();
    if (storedActiveSessionId) {
      activeSessionId = storedActiveSessionId;
    }

    await loadSessions();
    await loadEntries();
  }

  async function createSession() {
    const title = newSessionTitle.trim();

    if (!title) {
      return;
    }

    const now = Date.now();
    const session: TrailheadSession = {
      id: crypto.randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
    };

    const db = await dbPromise;
    await db.add('sessions', session);
    newSessionTitle = '';
    sessionFormOpen = false;
    await loadSessions();
    await setActiveSession(session.id);
  }

  function startEditSession(session: TrailheadSession) {
    editingSessionId = session.id;
    openSessionMenuId = '';
    sessionDraft = { title: session.title };
  }

  async function saveSessionEdit() {
    const session = sessions.find((item) => item.id === editingSessionId);
    const title = sessionDraft.title.trim();

    if (!session || !title) {
      return;
    }

    const db = await dbPromise;
    await db.put('sessions', {
      ...session,
      title,
      updatedAt: Date.now(),
    });

    editingSessionId = '';
    await loadSessions();
  }

  async function deleteSession(sessionId: string) {
    openSessionMenuId = '';
    const db = await dbPromise;
    const sessionEntries = await db.getAllFromIndex('entries', 'by-session', sessionId);
    const transaction = db.transaction(['sessions', 'entries'], 'readwrite');

    await Promise.all([
      transaction.objectStore('sessions').delete(sessionId),
      ...sessionEntries.map((entry) => transaction.objectStore('entries').delete(entry.id)),
      transaction.done,
    ]);

    await loadSessions();
    await setActiveSession(sessions[0]?.id ?? DEFAULT_SESSION_ID);
  }

  async function createEntry() {
    const text = newEntry.text.trim();
    const note = clampNote(newEntry.note.trim());
    const isScreenshot = Boolean(screenshotDataUrl);

    if (!text && !isScreenshot) {
      screenshotError = 'Add snippet text or choose a screenshot.';
      return;
    }

    if (isScreenshot && !note) {
      screenshotError = 'Screenshots must include a note.';
      return;
    }

    let citation = '';
    try {
      citation = await resolveCitationInput(newEntry.citation);
    } catch (error) {
      citationError = error instanceof Error ? error.message : 'Could not resolve DOI.';
      return;
    }

    const now = Date.now();
    const db = await dbPromise;
    await db.add('entries', {
      id: crypto.randomUUID(),
      sessionId: activeSessionId,
      url: newEntry.url.trim(),
      text,
      note,
      kind: isScreenshot ? 'screenshot' : 'text',
      screenshotDataUrl,
      screenshotMimeType,
      citation,
      needsCitation: false,
      keywords: [],
      timestamp: now,
      updatedAt: now,
    });

    newEntry = { text: '', url: '', note: '', citation: '' };
    citationError = '';
    manualEntryOpen = false;
    clearScreenshot();
    await loadEntries();
  }

  function startEditEntry(entry: TrailheadEntry) {
    editingEntryId = entry.id;
    addingNoteEntryId = '';
    editingCitationEntryId = '';
    openSnippetMenuId = '';
    viewingEntryId = '';
    confirmingDeleteEntryId = '';
    citationError = '';
    entryDraft = {
      text: entry.text,
      url: entry.url,
      note: entry.note ?? '',
      citation: entry.citation ?? '',
    };
  }

  async function saveEntryEdit(entry: TrailheadEntry) {
    const text = entryDraft.text.trim();

    if (!text) {
      return;
    }

    let citation = '';
    try {
      citation = await resolveCitationInput(entryDraft.citation);
    } catch (error) {
      citationError = error instanceof Error ? error.message : 'Could not resolve DOI.';
      return;
    }

    const db = await dbPromise;
    await db.put('entries', {
      ...entry,
      text,
      url: entryDraft.url.trim(),
      note: clampNote(entryDraft.note.trim()),
      citation,
      needsCitation: !citation,
      updatedAt: Date.now(),
    });

    editingEntryId = '';
    citationError = '';
    await loadEntries();
  }

  function startAddNote(entry: TrailheadEntry) {
    addingNoteEntryId = entry.id;
    editingEntryId = '';
    editingCitationEntryId = '';
    openSnippetMenuId = '';
    viewingEntryId = '';
    confirmingDeleteEntryId = '';
    noteDraft = entry.note ?? '';
  }

  async function saveEntryNote(entry: TrailheadEntry) {
    const db = await dbPromise;
    await db.put('entries', {
      ...entry,
      note: clampNote(noteDraft.trim()),
      updatedAt: Date.now(),
    });

    addingNoteEntryId = '';
    noteDraft = '';
    await loadEntries();
  }

  function startCitationEdit(entry: TrailheadEntry) {
    editingCitationEntryId = entry.id;
    editingEntryId = '';
    addingNoteEntryId = '';
    exportedCitationEntryId = '';
    openSnippetMenuId = '';
    viewingEntryId = '';
    confirmingDeleteEntryId = '';
    citationError = '';
    citationDraft = entry.citation ?? '';
  }

  async function saveEntryCitation(entry: TrailheadEntry) {
    let citation = '';
    try {
      citation = await resolveCitationInput(citationDraft);
    } catch (error) {
      citationError = error instanceof Error ? error.message : 'Could not resolve DOI.';
      return;
    }

    const db = await dbPromise;
    await db.put('entries', {
      ...entry,
      citation,
      needsCitation: !citation,
      updatedAt: Date.now(),
    });

    editingCitationEntryId = '';
    citationDraft = '';
    citationError = '';
    await loadEntries();
  }

  async function exportCitation(entry: TrailheadEntry) {
    if (!entry.citation) {
      return;
    }

    await navigator.clipboard.writeText(entry.citation);
    exportedCitationEntryId = entry.id;
    openSnippetMenuId = '';
  }

  async function exportSessionCitations() {
    if (!uniqueSessionCitations.length) {
      return;
    }

    await navigator.clipboard.writeText(uniqueSessionCitations.join('\n\n'));
    exportedSessionCitations = true;
  }

  async function deleteEntry(entryId: string) {
    confirmingDeleteEntryId = '';
    openSnippetMenuId = '';
    const db = await dbPromise;
    await db.delete('entries', entryId);
    await loadEntries();
  }

  function handleRuntimeMessage(message: { type?: string }) {
    if (message.type === 'TRAILHEAD_ENTRY_SAVED') {
      refresh();
    }
  }

  onMount(() => {
    refresh();
    document.addEventListener('paste', handleScreenshotPaste);
    if (typeof chrome !== 'undefined') {
      chrome.runtime?.onMessage.addListener(handleRuntimeMessage);
    }
  });

  onDestroy(() => {
    document.removeEventListener('paste', handleScreenshotPaste);
    if (typeof chrome !== 'undefined') {
      chrome.runtime?.onMessage.removeListener(handleRuntimeMessage);
    }
  });
</script>

<main class:session-collapsed={sessionRailCollapsed} class="trailhead-shell">
  <aside class="session-rail" aria-label="Sessions">
    <header>
      <div>
        <h1>Trailhead</h1>
        <p>{sessions.length} sessions</p>
      </div>
      <button type="button" class="ghost" aria-expanded={sessionFormOpen} onclick={() => sessionFormOpen = !sessionFormOpen}>
        New session
      </button>
    </header>

    {#if sessionFormOpen}
      <form class="session-form" onsubmit={(event) => { event.preventDefault(); createSession(); }}>
        <input bind:value={newSessionTitle} maxlength="40" placeholder="New session" aria-label="New session title" />
        <div class="button-row">
          <button type="submit">Create</button>
          <button type="button" class="ghost" onclick={() => { sessionFormOpen = false; newSessionTitle = ''; }}>Cancel</button>
        </div>
      </form>
    {/if}

    <div class="session-list">
      {#each sessions as session}
        <section class:active={session.id === activeSessionId} class="session-item">
          {#if editingSessionId === session.id}
            <input bind:value={sessionDraft.title} maxlength="40" aria-label="Session title" />
            <div class="button-row">
              <button type="button" onclick={saveSessionEdit}>Save</button>
              <button type="button" class="ghost" onclick={() => editingSessionId = ''}>Cancel</button>
            </div>
          {:else}
            <div class="session-row">
              <button type="button" class="session-pick" onclick={() => setActiveSession(session.id)}>
                <span>{session.title}</span>
              </button>
              <div class="session-actions">
                <button
                  type="button"
                  class="menu-trigger"
                  aria-label={`Actions for ${session.title}`}
                  aria-expanded={openSessionMenuId === session.id}
                  onclick={() => openSessionMenuId = openSessionMenuId === session.id ? '' : session.id}
                >
                  ...
                </button>
                {#if openSessionMenuId === session.id}
                  <div class="session-menu">
                    <button type="button" class="ghost" onclick={() => startEditSession(session)}>Edit</button>
                    <button type="button" class="danger" disabled={sessions.length === 1} onclick={() => deleteSession(session.id)}>Delete</button>
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        </section>
      {/each}
    </div>
  </aside>

  <button
    type="button"
    class="rail-toggle"
    aria-label={sessionRailCollapsed ? 'Expand session menu' : 'Collapse session menu'}
    aria-expanded={!sessionRailCollapsed}
    onclick={() => sessionRailCollapsed = !sessionRailCollapsed}
  >
    {sessionRailCollapsed ? '>' : '<'}
  </button>

  <section class="workspace">
    <header class="workspace-header">
      <div>
        <p class="eyebrow">Current session</p>
        <h2>{activeSession?.title ?? 'Inbox'}</h2>
      </div>
      <div class="workspace-actions">
        <span>{entries.length} snippets</span>
        <div class="workspace-button-row">
          <button
            type="button"
            class="ghost"
            aria-expanded={searchOpen}
            onclick={() => {
              searchOpen = !searchOpen;
              if (!searchOpen) {
                sessionSearchQuery = '';
              }
            }}
          >
            Search
          </button>
          <button
            type="button"
            class="ghost"
            aria-expanded={manualEntryOpen}
            onclick={() => {
              manualEntryOpen = !manualEntryOpen;
              if (!manualEntryOpen) {
                newEntry = { text: '', url: '', note: '', citation: '' };
                citationError = '';
                clearScreenshot();
              }
            }}
          >
            Add snippet
          </button>
          <button type="button" class="ghost" aria-pressed={graphOpen} onclick={() => graphOpen = !graphOpen}>
            Graph
          </button>
          <button type="button" class="ghost" disabled={!uniqueSessionCitations.length} onclick={exportSessionCitations}>
            {exportedSessionCitations ? 'Copied citations' : 'Export citations'}
          </button>
        </div>
      </div>
    </header>

    {#if searchOpen}
      <label class="session-search">
        <span>Search this session</span>
        <input
          bind:value={sessionSearchQuery}
          placeholder="Keywords in notes, snippets, or tags"
          aria-label="Search snippets in this session"
        />
        {#if sessionSearchQuery.trim()}
          <small>Showing top {displayedEntries.length} matches</small>
        {/if}
      </label>
    {/if}

    {#if manualEntryOpen}
      <form class="snippet-form" onsubmit={(event) => { event.preventDefault(); createEntry(); }}>
        <textarea bind:value={newEntry.text} rows="3" placeholder="Add a snippet" aria-label="Snippet text"></textarea>
        <label>
          <span>Screenshot</span>
          <input type="file" accept="image/*" onchange={handleScreenshotChange} aria-label="Screenshot image" />
        </label>
        {#if screenshotDataUrl}
          <div class="screenshot-preview">
            <img src={screenshotDataUrl} alt="Selected screenshot preview" />
            <button type="button" class="ghost" onclick={clearScreenshot}>Remove screenshot</button>
          </div>
        {/if}
        {#if screenshotError}
          <p class="form-error">{screenshotError}</p>
        {/if}
        <input bind:value={newEntry.url} placeholder="Source URL" aria-label="Source URL" />
        <label>
          <span>Note</span>
          <textarea bind:value={newEntry.note} maxlength={NOTE_LIMIT} rows="2" placeholder={screenshotDataUrl ? 'Required for screenshots' : 'Optional note'} aria-label="Snippet note"></textarea>
          <small>{newEntry.note.length}/{NOTE_LIMIT}</small>
        </label>
        <label>
          <span>Citation</span>
          <textarea bind:value={newEntry.citation} rows="3" placeholder="Paste BibTeX citation or DOI" aria-label="New snippet citation"></textarea>
        </label>
        {#if citationError}
          <p class="form-error">{citationError}</p>
        {/if}
        <div class="button-row">
          <button type="submit">Add snippet</button>
          <button
            type="button"
            class="ghost"
            onclick={() => {
              manualEntryOpen = false;
              newEntry = { text: '', url: '', note: '', citation: '' };
              citationError = '';
              clearScreenshot();
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    {/if}

    {#if graphOpen}
      <div class="graph-view">
        {#if graph.nodes.length > 1}
          <svg viewBox="0 0 360 330" role="img" aria-label="Snippet relationship graph">
            {#each graph.edges as edge}
              <line
                x1={graphX(edge.source, graph.nodes.length)}
                y1={graphY(edge.source, graph.nodes.length)}
                x2={graphX(edge.target, graph.nodes.length)}
                y2={graphY(edge.target, graph.nodes.length)}
                stroke-width={Math.max(1, edge.score * 5)}
              />
            {/each}
            {#each graph.nodes as node, index}
              <g>
                <circle cx={graphX(index, graph.nodes.length)} cy={graphY(index, graph.nodes.length)} r="15" />
                <text x={graphX(index, graph.nodes.length)} y={graphY(index, graph.nodes.length) + 4}>{index + 1}</text>
              </g>
            {/each}
          </svg>
          <ol>
            {#each graph.nodes as node, index}
              <li><span>{index + 1}</span>{abbreviate(entryLabel(node))}</li>
            {/each}
          </ol>
        {:else}
          <div class="empty-state">
            <h3>Graph needs more snippets</h3>
            <p>Add at least two snippets to see relationships.</p>
          </div>
        {/if}
      </div>
    {:else}
      <div class="snippet-list">
      {#each displayedEntries as entry}
        <article class="snippet-card">
          {#if editingEntryId === entry.id}
            {#if entry.screenshotDataUrl}
              <div class="snippet-image">
                <img src={entry.screenshotDataUrl} alt="Saved screenshot" />
              </div>
            {/if}
            <textarea bind:value={entryDraft.text} rows="4" aria-label="Edit snippet text"></textarea>
            <input bind:value={entryDraft.url} aria-label="Edit source URL" />
            <label>
              <span>Note</span>
              <textarea bind:value={entryDraft.note} maxlength={NOTE_LIMIT} rows="2" aria-label="Edit snippet note"></textarea>
              <small>{entryDraft.note.length}/{NOTE_LIMIT}</small>
            </label>
            <label>
              <span>Citation</span>
              <textarea bind:value={entryDraft.citation} rows="4" placeholder="Paste BibTeX citation or DOI" aria-label="Edit snippet citation"></textarea>
            </label>
            {#if citationError}
              <p class="form-error">{citationError}</p>
            {/if}
            <div class="button-row">
              <button type="button" onclick={() => saveEntryEdit(entry)}>Save</button>
              <button type="button" class="ghost" onclick={() => editingEntryId = ''}>Cancel</button>
            </div>
          {:else}
            {#if entry.screenshotDataUrl}
              <div class="snippet-image">
                <img src={entry.screenshotDataUrl} alt="Saved screenshot" />
              </div>
            {/if}
            {#if viewingEntryId === entry.id}
              <div class="snippet-text rendered-text">{@html renderLatexText(entryLabel(entry))}</div>
            {:else}
              <p class="snippet-text">"{abbreviate(entryLabel(entry))}"</p>
            {/if}
            {#if entry.note}
              {#if viewingEntryId === entry.id}
                <div class="note rendered-text">{@html renderLatexText(entry.note)}</div>
              {:else}
                <p class="note">{entry.note}</p>
              {/if}
            {:else if addingNoteEntryId === entry.id}
              <label>
                <span>Note</span>
                <textarea bind:value={noteDraft} maxlength={NOTE_LIMIT} rows="2" placeholder="Add note" aria-label="Add snippet note"></textarea>
                <small>{noteDraft.length}/{NOTE_LIMIT}</small>
              </label>
              <div class="button-row">
                <button type="button" onclick={() => saveEntryNote(entry)}>Save note</button>
                <button type="button" class="ghost" onclick={() => addingNoteEntryId = ''}>Cancel</button>
              </div>
            {/if}
            {#if editingCitationEntryId === entry.id}
              <label>
                <span>Citation</span>
                <textarea bind:value={citationDraft} rows="4" placeholder="Paste BibTeX citation or DOI" aria-label="Snippet citation"></textarea>
              </label>
              {#if citationError}
                <p class="form-error">{citationError}</p>
              {/if}
              <div class="button-row">
                <button type="button" onclick={() => saveEntryCitation(entry)}>Save citation</button>
                <button type="button" class="ghost" onclick={() => editingCitationEntryId = ''}>Cancel</button>
              </div>
            {:else if entry.needsCitation}
              <div class="citation-missing">
                <span>Citation needed</span>
              </div>
            {/if}
            {#if entry.keywords.length}
              <div class="keywords">
                {#each entry.keywords as keyword}
                  <span>{keyword}</span>
                {/each}
              </div>
            {/if}
            <div class="snippet-footer">
              {#if entry.url}
                <a href={entry.url} target="_blank" rel="noreferrer">Source</a>
              {:else}
                <span>No source</span>
              {/if}
              <div class="snippet-actions">
                <button
                  type="button"
                  class="ghost"
                  onclick={() => viewingEntryId = viewingEntryId === entry.id ? '' : entry.id}
                >
                  {viewingEntryId === entry.id ? 'Hide' : 'View'}
                </button>
                <div class="snippet-menu-wrap">
                  <button
                    type="button"
                    class="menu-trigger"
                    aria-label="Snippet actions"
                    aria-expanded={openSnippetMenuId === entry.id}
                    onclick={() => {
                      confirmingDeleteEntryId = '';
                      openSnippetMenuId = openSnippetMenuId === entry.id ? '' : entry.id;
                    }}
                  >
                    ...
                  </button>
                  {#if openSnippetMenuId === entry.id}
                    <div class="snippet-menu">
                      {#if !entry.note && addingNoteEntryId !== entry.id}
                        <button type="button" class="ghost" onclick={() => startAddNote(entry)}>Add note</button>
                      {/if}
                      {#if entry.citation}
                        <button type="button" class="ghost" onclick={() => exportCitation(entry)}>
                          {exportedCitationEntryId === entry.id ? 'Copied' : 'Export citation'}
                        </button>
                      {/if}
                      {#if editingCitationEntryId !== entry.id}
                        <button type="button" class="ghost" onclick={() => startCitationEdit(entry)}>
                          {entry.citation ? 'Edit citation' : 'Add citation'}
                        </button>
                      {/if}
                      <button type="button" class="ghost" onclick={() => startEditEntry(entry)}>Edit</button>
                    </div>
                  {/if}
                </div>
                {#if confirmingDeleteEntryId === entry.id}
                  <button type="button" class="danger" onclick={() => deleteEntry(entry.id)}>Confirm</button>
                  <button type="button" class="ghost" onclick={() => confirmingDeleteEntryId = ''}>Cancel</button>
                {:else}
                  <button
                    type="button"
                    class="danger"
                    onclick={() => {
                      openSnippetMenuId = '';
                      confirmingDeleteEntryId = entry.id;
                    }}
                  >
                    Delete
                  </button>
                {/if}
              </div>
            </div>
          {/if}
        </article>
      {:else}
        <div class="empty-state">
          <h3>No snippets yet</h3>
          <p>{searchOpen && sessionSearchQuery.trim() ? 'No matching snippets in this session.' : 'Highlight text on a page and save it, or add one manually here.'}</p>
        </div>
      {/each}
      </div>
    {/if}
  </section>
</main>
