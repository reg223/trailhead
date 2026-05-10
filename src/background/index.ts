import { DEFAULT_SESSION_ID, dbPromise, ensureDefaultSession } from '../lib/db';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const SIDE_PANEL_PATH = 'src/sidepanel/index.html';
const ARXIV_HOSTS = ['arxiv.org', 'www.arxiv.org'];
const DOI_HOSTS = ['ieeexplore.ieee.org', 'dl.acm.org', 'pubmed.ncbi.nlm.nih.gov', 'www.ncbi.nlm.nih.gov'];
const DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;

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

function openSidePanelFromGesture(tab?: chrome.tabs.Tab) {
  if (tab?.id) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(console.error);
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }).then(([activeTab]) => {
    if (activeTab?.id) {
      chrome.sidePanel.open({ tabId: activeTab.id }).catch(console.error);
    }
  }).catch(console.error);
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

function isDoiSupportedUrl(url: string) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && DOI_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function isPdfUrl(url: string) {
  try {
    const { pathname } = new URL(url);
    return pathname.toLowerCase().endsWith('.pdf') || pathname.toLowerCase().includes('/pdf/');
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

function normalizeDoi(value: string) {
  return value
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/[.,;)\]]+$/g, '')
    .trim();
}

async function fetchBibtexForDoi(doi: string) {
  if (!doi) {
    return '';
  }

  try {
    const response = await fetch(`https://doi.org/${encodeURI(doi)}`, {
      headers: { Accept: 'application/x-bibtex' },
    });

    if (!response.ok) {
      return '';
    }

    return (await response.text()).trim();
  } catch (error) {
    console.error('Failed to fetch DOI BibTeX citation:', error);
    return '';
  }
}

async function scanDoiFromPage(tabId: number) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const metaSelectors = [
        'meta[name="citation_doi"]',
        'meta[name="dc.Identifier"]',
        'meta[name="DC.Identifier"]',
        'meta[property="citation_doi"]',
      ];
      const metaDoi = metaSelectors
        .map((selector) => document.querySelector<HTMLMetaElement>(selector)?.content)
        .find(Boolean);

      if (metaDoi) {
        return metaDoi;
      }

      const doiLink = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .map((link) => link.href)
        .find((href) => /https?:\/\/(?:dx\.)?doi\.org\/10\./i.test(href));

      if (doiLink) {
        return doiLink;
      }

      return document.body?.innerText.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0] ?? '';
    },
  });

  return typeof result?.result === 'string' ? normalizeDoi(result.result) : '';
}

async function scanDoiFromPdf(url: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return '';
    }

    const data = new Uint8Array(await response.arrayBuffer());
    const pdf = await getDocument({ data, disableWorker: true } as Parameters<typeof getDocument>[0]).promise;
    const pageCount = Math.min(pdf.numPages, 5);
    let text = '';

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      text += ` ${content.items.map((item) => 'str' in item ? item.str : '').join(' ')}`;
      const match = text.match(DOI_PATTERN);
      if (match) {
        return normalizeDoi(match[0]);
      }
    }
  } catch (error) {
    console.error('Failed to scan PDF DOI:', error);
  }

  return '';
}

async function getCitationForTab(tab: chrome.tabs.Tab) {
  if (!tab.url) {
    return { citation: '', needsCitation: false };
  }

  if (isArxivUrl(tab.url)) {
    const arxivId = extractArxivId(tab.url);
    const citation = arxivId ? await fetchArxivBibtex(arxivId) : '';

    return {
      citation,
      needsCitation: !citation,
    };
  }

  if (!isDoiSupportedUrl(tab.url)) {
    return { citation: '', needsCitation: false };
  }

  const doi = isPdfUrl(tab.url)
    ? await scanDoiFromPdf(tab.url)
    : tab.id
      ? await scanDoiFromPage(tab.id)
      : '';
  const citation = doi ? await fetchBibtexForDoi(doi) : '';

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
    kind: 'text',
    screenshotDataUrl: '',
    screenshotMimeType: '',
    citation,
    needsCitation,
    keywords,
    timestamp: now,
    updatedAt: now
  });

  chrome.runtime.sendMessage({ type: 'TRAILHEAD_ENTRY_SAVED' }).catch(() => undefined);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'save-to-trailhead' && tab?.url) {
    openSidePanelFromGesture(tab);

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
