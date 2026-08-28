// Manifest V3 service workers have no XMLHttpRequest at all (only fetch),
// but the Firebase SDK still reaches for it internally in a few places —
// Firestore's long-polling transport, and Storage's uploader — which
// otherwise throws "XMLHttpRequest is not defined" and, for Firestore,
// silently fails every request as if offline. This is a known, still-open
// gap in the Firebase JS SDK for service worker environments; the
// community-tested fix is exactly this: a minimal XHR shim backed by
// fetch(), installed before any Firebase module runs (this must stay the
// very first import in background.js for that ordering to hold).
if (typeof self.XMLHttpRequest === 'undefined') {
  class XMLHttpRequestShim extends EventTarget {
    constructor() {
      super();
      this.requestHeaders = {};
      this.status = 0;
      this.responseText = '';
      this.response = '';
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(key, value) {
      this.requestHeaders[key] = value;
    }
    send(body) {
      this.controller = new AbortController();
      this.controller.signal.addEventListener('abort', () => this.dispatchEvent(new Event('abort')));
      fetch(this.url, {
        method: this.method,
        headers: this.requestHeaders,
        body,
        signal: this.controller.signal
      })
        .then((response) => {
          this.status = response.status;
          this.responseHeaders = response.headers;
          return response.text();
        })
        .then((responseText) => {
          this.response = responseText;
          this.responseText = responseText;
          this.dispatchEvent(new Event('load'));
        })
        .catch(() => this.dispatchEvent(new Event('error')));
    }
    abort() {
      if (this.controller) this.controller.abort();
    }
    getResponseHeader(key) {
      return this.responseHeaders ? this.responseHeaders.get(key) : null;
    }
  }
  self.XMLHttpRequest = XMLHttpRequestShim;
}
