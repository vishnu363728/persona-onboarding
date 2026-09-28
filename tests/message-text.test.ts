import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MessageText } from "../src/components/message-text";

test("chat formatting renders paragraphs, emphasis, lists, and code safely", () => {
  const html = renderToStaticMarkup(
    createElement(MessageText, {
      text: "Try **one thing** first.\n\n- Speak slowly\n- Ask a question\n\n```js\n<script>alert(1)</script>\n```",
    }),
  );
  assert.match(html, /<strong>one thing<\/strong>/);
  assert.match(
    html,
    /<ul><li>Speak slowly<\/li><li>Ask a question<\/li><\/ul>/,
  );
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("model links only create safe HTTP links; HTML remains escaped", () => {
  const html = renderToStaticMarkup(
    createElement(MessageText, {
      text: "[Read](https://example.com) [unsafe](javascript:alert) <img src=x onerror=alert(1)>",
    }),
  );
  assert.match(html, /href="https:\/\/example.com\/"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /<img/);
});

test("indented or unfinished code fences remain readable without stalling", () => {
  const html = renderToStaticMarkup(
    createElement(MessageText, {
      text: "  ```text\nhello\n  ```\n\nAn unfinished block:\n```\nworld",
    }),
  );
  assert.match(html, /<pre><code>hello<\/code><\/pre>/);
  assert.match(html, /<pre><code>world<\/code><\/pre>/);
});

test("snake-case identifiers and plain URLs keep underscores while standalone emphasis renders", () => {
  const html = renderToStaticMarkup(
    createElement(MessageText, {
      text: "user_first_name account__first__name https://example.com/a_b_c and _one thing_",
    }),
  );
  assert.match(
    html,
    /user_first_name account__first__name https:\/\/example.com\/a_b_c/,
  );
  assert.match(html, /<em>one thing<\/em>/);
  assert.equal((html.match(/<em>/g) || []).length, 1);
});

test("dense Unicode grocery bullets render as separate items in the same list", () => {
  const html = renderToStaticMarkup(
    createElement(MessageText, {
      text: "• 300 g rice • 200 g pasta • 2 onions\n• 1 can tomatoes",
    }),
  );
  assert.match(
    html,
    /<ul><li>300 g rice<\/li><li>200 g pasta<\/li><li>2 onions<\/li><li>1 can tomatoes<\/li><\/ul>/,
  );
});

test("dense bullet rendering leaves prose, Markdown items, and fenced code untouched", () => {
  const html = renderToStaticMarkup(
    createElement(MessageText, {
      text: "Choices: rice • pasta • onions\n\n- Keep rice • pasta in this item\n\n```text\n• 300 g rice • 200 g pasta • 2 onions\n```",
    }),
  );
  assert.match(html, /<p>Choices: rice • pasta • onions<\/p>/);
  assert.match(html, /<ul><li>Keep rice • pasta in this item<\/li><\/ul>/);
  assert.match(html, /<pre><code>• 300 g rice • 200 g pasta • 2 onions<\/code><\/pre>/);
});

test("bullet-like text inside inline code and Markdown remains inside its item", () => {
  const html = renderToStaticMarkup(
    createElement(MessageText, {
      text: "• Use `rice • pasta` • **one • two** • [a • b](https://example.com)",
    }),
  );
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.match(html, /<li>Use <code>rice • pasta<\/code><\/li>/);
  assert.match(html, /<li><strong>one • two<\/strong><\/li>/);
  assert.match(html, />a • b<\/a><\/li>/);
});
