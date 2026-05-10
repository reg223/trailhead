import { DEFAULT_SESSION_ID, dbPromise, ensureDefaultSession } from '../lib/db';

const SIDE_PANEL_PATH = 'src/sidepanel/index.html';
const ARXIV_HOSTS = ['arxiv.org', 'www.arxiv.org'];

async function enableSidePanel(tabId?: number) {
  await chrome.sidePanel.setOptions({
    ...(tabId ? { tabId } : {}),
    path: SIDE_PANEL_PATH,
    enabled: true,
  });
}

async function openSidePanel(tab?: chrome.tabs.Tab) {
  await enableSidePanel(tab?.id);

  if (tab?.id) {
    await chrome.sidePanel.open({ tabId: tab.id });
    return;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id) {
    await enableSidePanel(activeTab.id);
    await chrome.sidePanel.open({ tabId: activeTab.id });
  }
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onInstalled.addListener(() => {
  enableSidePanel().catch(console.error);

  chrome.contextMenus.create({
    id: 'save-to-trailhead',
    title: 'Save to Trailhead',
    contexts: ['selection', 'page']
  });
});

chrome.runtime.onStartup.addListener(() => {
  enableSidePanel().catch(console.error);
});

chrome.action.onClicked.addListener((tab) => {
  openSidePanel(tab).catch(console.error);
});

async function getActiveSessionId() {
  await ensureDefaultSession();

  const db = await dbPromise;
  const { activeSessionId } = await chrome.storage.local.get('activeSessionId');

  if (typeof activeSessionId === 'string' && await db.get('sessions', activeSessionId)) {
    return activeSessionId;
  }

  await chrome.storage.local.set({ activeSessionId: DEFAULT_SESSION_ID });
  return DEFAULT_SESSION_ID;
}

function isArxivUrl(url: string) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && ARXIV_HOSTS.includes(hostname);
  } catch {
    return false;
  }
}

function extractArxivId(url: string) {
  try {
    const { pathname } = new URL(url);
    const id = pathname
      .replace(/^\/(?:abs|pdf|html)\//, '')
      .replace(/\.pdf$/i, '')
      .replace(/v\d+$/i, '')
      .trim();

    return id && id !== pathname ? id : '';
  } catch {
    return '';
  }
}

async function fetchArxivBibtex(arxivId: string) {
  const encodedId = arxivId.split('/').map(encodeURIComponent).join('/');

  try {
    const response = await fetch(`https://arxiv.org/bibtex/${encodedId}`);

    if (!response.ok) {
      return '';
    }

    return (await response.text()).trim();
  } catch (error) {
    console.error('Failed to fetch arXiv BibTeX citation:', error);
    return '';
  }
}

async function getCitationForTab(tab: chrome.tabs.Tab) {
  if (!tab.url || !isArxivUrl(tab.url)) {
    return { citation: '', needsCitation: false };
  }

  const arxivId = extractArxivId(tab.url);
  const citation = arxivId ? await fetchArxivBibtex(arxivId) : '';

  return {
    citation,
    needsCitation: !citation,
  };
}

async function saveEntry(tab: chrome.tabs.Tab, text: string, keywords: string[] = []) {
  if (!tab.url) {
    return;
  }

  const db = await dbPromise;
  const sessionId = await getActiveSessionId();
  const { citation, needsCitation } = await getCitationForTab(tab);
  const now = Date.now();

  await db.add('entries', {
    id: crypto.randomUUID(),
    sessionId,
    url: tab.url,
    text,
    note: '',
    citation,
    needsCitation,
    keywords,
    timestamp: now,
    updatedAt: now
  });

  chrome.runtime.sendMessage({ type: 'TRAILHEAD_ENTRY_SAVED' }).catch(() => undefined);
  await openSidePanel(tab);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'save-to-trailhead' && tab?.url) {
    const text = info.selectionText || "Full page captured";

    if (typeof Worker === 'undefined') {
      await saveEntry(tab, text);
      return;
    }
    
    // Spawn Web Worker for NLP and Search Indexing off the main thread
    let worker: Worker;
    try {
      worker = new Worker(new URL('./nlp.worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      console.error('Trailhead NLP worker failed to start:', error);
      await saveEntry(tab, text);
      return;
    }
    
    worker.postMessage({ type: 'PROCESS_TEXT', payload: text });
    
    worker.onmessage = async (e) => {
      const { success, keywords, error } = e.data;

      if (!success) {
        console.error('Failed to process Trailhead snippet:', error);
        await saveEntry(tab, text);
        worker.terminate();
        return;
      }

      await saveEntry(tab, text, keywords);
      worker.terminate();
    };

    worker.onerror = async (error) => {
      console.error('Trailhead NLP worker failed:', error.message);
      await saveEntry(tab, text);
      worker.terminate();
    };
  }
});
