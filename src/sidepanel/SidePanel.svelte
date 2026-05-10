<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    DEFAULT_SESSION_ID,
    NOTE_LIMIT,
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
  let editingSessionId = '';
  let editingEntryId = '';
  let addingNoteEntryId = '';
  let editingCitationEntryId = '';
  let exportedCitationEntryId = '';
  let exportedSessionCitations = false;
  let searchOpen = false;
  let openSessionMenuId = '';
  let openSnippetMenuId = '';
  let viewingEntryId = '';
  let confirmingDeleteEntryId = '';
  let sessionDraft = { title: '' };
  let entryDraft: EntryDraft = { text: '', url: '', note: '', citation: '' };
  let noteDraft = '';
  let citationDraft = '';

  $: activeSession = sessions.find((session) => session.id === activeSessionId);
  $: sessionCitations = entries
    .map((entry) => entry.citation?.trim())
    .filter((citation): citation is string => Boolean(citation));
  $: uniqueSessionCitations = dedupeCitations(sessionCitations);
  $: displayedEntries = searchOpen ? getDisplayedEntries(entries, sessionSearchQuery) : entries;

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

  function clampNote(note: string) {
    return note.slice(0, NOTE_LIMIT);
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

    if (!text) {
      return;
    }

    const now = Date.now();
    const db = await dbPromise;
    await db.add('entries', {
      id: crypto.randomUUID(),
      sessionId: activeSessionId,
      url: newEntry.url.trim(),
      text,
      note: clampNote(newEntry.note.trim()),
      citation: newEntry.citation.trim(),
      needsCitation: false,
      keywords: [],
      timestamp: now,
      updatedAt: now,
    });

    newEntry = { text: '', url: '', note: '', citation: '' };
    await loadEntries();
  }

  function startEditEntry(entry: TrailheadEntry) {
    editingEntryId = entry.id;
    addingNoteEntryId = '';
    editingCitationEntryId = '';
    openSnippetMenuId = '';
    viewingEntryId = '';
    confirmingDeleteEntryId = '';
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

    const db = await dbPromise;
    await db.put('entries', {
      ...entry,
      text,
      url: entryDraft.url.trim(),
      note: clampNote(entryDraft.note.trim()),
      citation: entryDraft.citation.trim(),
      needsCitation: !entryDraft.citation.trim(),
      updatedAt: Date.now(),
    });

    editingEntryId = '';
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
    citationDraft = entry.citation ?? '';
  }

  async function saveEntryCitation(entry: TrailheadEntry) {
    const citation = citationDraft.trim();
    const db = await dbPromise;
    await db.put('entries', {
      ...entry,
      citation,
      needsCitation: !citation,
      updatedAt: Date.now(),
    });

    editingCitationEntryId = '';
    citationDraft = '';
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
    if (typeof chrome !== 'undefined') {
      chrome.runtime?.onMessage.addListener(handleRuntimeMessage);
    }
  });

  onDestroy(() => {
    if (typeof chrome !== 'undefined') {
      chrome.runtime?.onMessage.removeListener(handleRuntimeMessage);
    }
  });
</script>

<main class="trailhead-shell">
  <aside class="session-rail" aria-label="Sessions">
    <header>
      <h1>Trailhead</h1>
      <p>{sessions.length} sessions</p>
    </header>

    <form class="session-form" onsubmit={(event) => { event.preventDefault(); createSession(); }}>
      <input bind:value={newSessionTitle} maxlength="40" placeholder="New session" aria-label="New session title" />
      <button type="submit">Create</button>
    </form>

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

    <form class="snippet-form" onsubmit={(event) => { event.preventDefault(); createEntry(); }}>
      <textarea bind:value={newEntry.text} rows="3" placeholder="Add a snippet" aria-label="Snippet text"></textarea>
      <input bind:value={newEntry.url} placeholder="Source URL" aria-label="Source URL" />
      <label>
        <span>Note</span>
        <textarea bind:value={newEntry.note} maxlength={NOTE_LIMIT} rows="2" placeholder="Optional note" aria-label="Snippet note"></textarea>
        <small>{newEntry.note.length}/{NOTE_LIMIT}</small>
      </label>
      <button type="submit">Add snippet</button>
    </form>

    <div class="snippet-list">
      {#each displayedEntries as entry}
        <article class="snippet-card">
          {#if editingEntryId === entry.id}
            <textarea bind:value={entryDraft.text} rows="4" aria-label="Edit snippet text"></textarea>
            <input bind:value={entryDraft.url} aria-label="Edit source URL" />
            <label>
              <span>Note</span>
              <textarea bind:value={entryDraft.note} maxlength={NOTE_LIMIT} rows="2" aria-label="Edit snippet note"></textarea>
              <small>{entryDraft.note.length}/{NOTE_LIMIT}</small>
            </label>
            <label>
              <span>Citation</span>
              <textarea bind:value={entryDraft.citation} rows="4" placeholder="Paste BibTeX citation" aria-label="Edit snippet citation"></textarea>
            </label>
            <div class="button-row">
              <button type="button" onclick={() => saveEntryEdit(entry)}>Save</button>
              <button type="button" class="ghost" onclick={() => editingEntryId = ''}>Cancel</button>
            </div>
          {:else}
            <p class="snippet-text">"{viewingEntryId === entry.id ? entry.text : abbreviate(entry.text)}"</p>
            {#if entry.note}
              <p class="note">{entry.note}</p>
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
                <textarea bind:value={citationDraft} rows="4" placeholder="Paste BibTeX citation" aria-label="Snippet citation"></textarea>
              </label>
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
  </section>
</main>
