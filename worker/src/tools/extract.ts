import { defineTool } from "@basics/shared";
import { js as harnessJs } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

const FieldsShape = z.record(
  z.string().min(1),
  z.union([
    z.string().min(1), // CSS sub-selector → matched element's textContent
    z.object({
      selector: z.string().min(1),
      attr: z.string().min(1).optional(),
    }),
  ]),
);

export const extract = defineTool({
  name: "extract",
  description:
    "Pull structured data from the page without screenshots. Without `fields`, returns one entry per match with {text, html} from the matched element. With `fields`, each entry is an object whose keys map to inner-selector textContent (or an attribute when {selector, attr} is given).",
  params: z.object({
    selector: z.string().min(1),
    fields: FieldsShape.optional(),
    limit: z.number().int().positive().optional(),
  }),
  mutating: false,
  cost: "low",
  execute: async ({ selector, fields, limit }, ctx: WorkerToolContext) => {
    // Build the in-page extraction expression. JSON-encoded selector is
    // safe inside a JS string literal (handles quotes/backslashes).
    const cap = limit ?? 100;
    const sel = JSON.stringify(selector);
    let expr: string;
    if (!fields) {
      expr = `(() => {
        const els = Array.from(document.querySelectorAll(${sel})).slice(0, ${cap});
        return els.map(el => ({ text: (el.textContent ?? '').trim(), html: el.innerHTML }));
      })()`;
    } else {
      const fieldsLiteral = JSON.stringify(fields);
      expr = `(() => {
        const fields = ${fieldsLiteral};
        const pluck = (root, spec) => {
          const sub = typeof spec === 'string' ? root.querySelector(spec) : root.querySelector(spec.selector);
          if (!sub) return null;
          if (typeof spec === 'string') return (sub.textContent ?? '').trim();
          if (spec.attr) return sub.getAttribute(spec.attr);
          return (sub.textContent ?? '').trim();
        };
        const els = Array.from(document.querySelectorAll(${sel})).slice(0, ${cap});
        return els.map(el => {
          const out = {};
          for (const k of Object.keys(fields)) out[k] = pluck(el, fields[k]);
          return out;
        });
      })()`;
    }
    const rows = await harnessJs(ctx.session, expr);
    return { kind: "json", json: { rows } };
  },
});
