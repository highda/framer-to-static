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

  const $ = load(html, { decodeEntities: false });
  for (const selector of selectors) {
    $(selector).remove();
  }
  return $.html();
}
