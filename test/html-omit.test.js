import test from "node:test";
import assert from "node:assert/strict";

import { normalizeOmitSelectors, omitHtmlBySelectors } from "../scripts/lib/html-omit.js";

test("normalizeOmitSelectors flattens repeated and comma-separated values", () => {
  assert.deepEqual(normalizeOmitSelectors([
    'div[data-framer-name="Form"]',
    ".hero,.footer",
    "  ",
  ]), [
    'div[data-framer-name="Form"]',
    ".hero",
    ".footer",
  ]);
});

test("omitHtmlBySelectors removes matching subtrees and keeps the rest intact", () => {
  const html = [
    "<!doctype html>",
    '<html><body>',
    '<main><div data-framer-name="Form"><form><input name="email"></form></div></main>',
    '<section class="keep">Still here</section>',
    "</body></html>",
  ].join("");

  const output = omitHtmlBySelectors(html, ['div[data-framer-name="Form"]']);

  assert.ok(!output.includes('data-framer-name="Form"'));
  assert.ok(!output.includes("<form>"));
  assert.ok(output.includes('<section class="keep">Still here</section>'));
});

test("omitHtmlBySelectors supports standard descendant selectors", () => {
  const html = [
    "<html><body>",
    '<section class="hero"><div class="actions"><a class="cta">Buy</a></div></section>',
    '<section class="hero"><div class="content">Read</div></section>',
    "</body></html>",
  ].join("");

  const output = omitHtmlBySelectors(html, [".hero .actions"]);

  assert.ok(!output.includes('class="actions"'));
  assert.ok(output.includes('class="content"'));
});
