import { load } from "cheerio";

export function normalizeOmitSelectors(args) {
  const selectors = [];

  for (const value of args) {
    if (!value) continue;
    for (const selector of value.split(",")) {
      const trimmed = selector.trim();
      if (trimmed) selectors.push(trimmed);
    }
  }

  return selectors;
}

export function omitHtmlBySelectors(html, selectors) {
  if (!selectors.length) {
    return html;
  }

  // Try DOM removal first (works for SSR'd elements).
  const $ = load(html, { decodeEntities: false });
  for (const selector of selectors) {
    $(selector).remove();
  }

  // Framer renders many components client-side, so the SSR HTML may not contain
  // the target node. Inject a <style> rule as a reliable fallback: CSS applies
  // the instant the element is painted, with no JS and no visible flash.
  // Note: the element remains in the DOM; it is simply never displayed.
  const cssRules = selectors.map((s) => `${s}{display:none!important}`).join("");
  $("head").append(`<style data-hide-selectors="">${cssRules}</style>`);

  return $.html();
}
