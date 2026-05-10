import nlp from 'compromise';

self.onmessage = async (e) => {
  if (e.data.type === 'PROCESS_TEXT') {
    const text = typeof e.data.payload === 'string' ? e.data.payload : e.data.payload?.text;

    if (!text) {
      self.postMessage({ success: false, error: 'No text provided' });
      return;
    }
    
    // Compromise.js entity extraction
    const doc = nlp(text);
    const people = doc.people().out('array');
    const places = doc.places().out('array');
    const topics = doc.nouns().out('array').slice(0, 5); 
    
    // De-duplicate keywords
    const keywords = [...new Set([...people, ...places, ...topics])];
    
    self.postMessage({ success: true, keywords });
  }
};
