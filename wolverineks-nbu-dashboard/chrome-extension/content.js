(function () {
  const originalFetch = window.fetch.bind(window);

  window.fetch = async function (...args) {
    const response = await originalFetch(...args);
    try {
      const clone = response.clone();
      const contentType = clone.headers.get("content-type") || "";
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      const looksLikeExport =
        contentType.includes("xml") ||
        contentType.includes("csv") ||
        contentType.includes("text/plain") ||
        /\.xml|\.csv|greenbutton|usage|readinghistory/i.test(url);

      if (looksLikeExport) {
        const text = await clone.text();
        if (/xmlns="http:\/\/naesb.org\/espi"|^Meter #,|^Date\/Time,/i.test(text)) {
          const filename = guessFilename(url, text);
          chrome.runtime.sendMessage({ type: "nbu-export", filename, content: text });
        }
      }
    } catch (_error) {
      // Ignore parse failures on unrelated fetch calls.
    }
    return response;
  };

  function guessFilename(url, text) {
    const fromUrl = url.split("/").pop()?.split("?")[0];
    if (fromUrl && /\.(xml|csv)$/i.test(fromUrl)) return fromUrl;
    if (text.includes("naesb.org/espi")) return "nbu-export.xml";
    if (/^Date\/Time,/i.test(text)) return "nbu-hourly_usage.csv";
    if (/^Meter #,/i.test(text)) return "nbu-ReadingHistory.csv";
    return "nbu-export.csv";
  }
})();