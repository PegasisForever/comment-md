import { marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js/lib/common";
import sanitizeHtml from "sanitize-html";

marked.use(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code: string, lang: string) {
      const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    },
  }),
);

marked.setOptions({
  gfm: true,
  breaks: false,
});

const allowedTags = [
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "em", "del", "code", "pre", "blockquote",
  "ul", "ol", "li",
  "a",
  "table", "thead", "tbody", "tr", "th", "td",
  "img",
  "span", "div",
  "input", // for task list checkboxes
];

const sanitizeOpts: sanitizeHtml.IOptions = {
  allowedTags,
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title"],
    code: ["class"],
    pre: ["class"],
    span: ["class"],
    div: ["class"],
    input: ["type", "checked", "disabled"],
    "*": ["id"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  transformTags: {
    a: (tagName, attribs) => ({
      tagName: "a",
      attribs: {
        ...attribs,
        target: "_blank",
        rel: "noopener noreferrer",
      },
    }),
  },
};

export function renderMarkdown(markdown: string): string {
  const rawHtml = marked.parse(markdown, { async: false }) as string;
  return sanitizeHtml(rawHtml, sanitizeOpts);
}
