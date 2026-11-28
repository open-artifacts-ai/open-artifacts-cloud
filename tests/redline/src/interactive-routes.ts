import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { R } from "../../../packages/shared/src/routes.ts";

/**
 * #1204/#1313: the server routes that answer only an interactive sign-in,
 * found by reading apps/server/src. A handler counts when it calls
 * interactiveSession(c) directly or through any chain of helpers that do,
 * in its own file or imported from another (share-notices' browserUser,
 * directory's disconnect). A static read, so it errs loud: a path it can't
 * resolve comes back as `<METHOD> ?<expression>`.
 */

export const SERVER_SRC = join(import.meta.dirname, "../../../apps/server/src");

export interface SourceFile {
  path: string;
  src: string;
}

export function serverSources(dir = SERVER_SRC): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".ts") && !n.endsWith(".d.ts"))
        out.push({ path: relative(dir, p), src: readFileSync(p, "utf8") });
    }
  };
  walk(dir);
  return out;
}

/**
 * The source with comments blanked and string, template and regex literal
 * bodies replaced by spaces (same length), so brackets and names can be
 * counted. Literal text stays readable in `src` at the same offsets.
 */
export function codeMask(src: string): string {
  const out = src.split("");
  const blank = (a: number, b: number) => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  let prev = ""; // last significant code char, for the regex heuristic
  const tpl: number[] = []; // brace depth at each open ${ in a template
  let depth = 0;
  const str = (q: string) => {
    const s = i++;
    while (i < src.length && src[i] !== q) i += src[i] === "\\" ? 2 : 1;
    blank(s + 1, i);
    i++;
    prev = q;
  };
  const template = () => {
    // From just after ` (or after the } closing a ${), to the next ` or ${.
    const s = i;
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") i += 2;
      else if (src[i] === "$" && src[i + 1] === "{") {
        blank(s, i);
        tpl.push(depth);
        depth++;
        i += 2;
        prev = "{";
        return;
      } else i++;
    }
    blank(s, i);
    i++;
    prev = "`";
  };
  while (i < src.length) {
    const ch = src[i] as string;
    const nx = src[i + 1];
    if (ch === "/" && nx === "/") {
      const s = i;
      while (i < src.length && src[i] !== "\n") i++;
      blank(s, i);
    } else if (ch === "/" && nx === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? src.length : e + 2;
      blank(i, end);
      i = end;
    } else if (ch === '"' || ch === "'") str(ch);
    else if (ch === "`") {
      i++;
      template();
    } else if (
      ch === "/" &&
      (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev))
    ) {
      const s = i++;
      let cls = false;
      while (i < src.length && (cls || src[i] !== "/") && src[i] !== "\n") {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") cls = true;
        else if (src[i] === "]") cls = false;
        i++;
      }
      blank(s + 1, i);
      i++;
      prev = "/";
    } else if (ch === "}" && tpl.length && tpl[tpl.length - 1] === depth - 1) {
      tpl.pop();
      depth--;
      i++;
      template();
    } else {
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth--;
      if (!/\s/.test(ch)) prev = ch;
      i++;
    }
  }
  return out.join("");
}

/** Index of the bracket closing the one at `open`, in a masked source. */
function closing(code: string, open: number): number {
  let d = 0;
  for (let k = open; k < code.length; k++) {
    const ch = code[k];
    if (ch === "(" || ch === "{" || ch === "[") d++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      d--;
      if (d === 0) return k;
    }
  }
  return code.length;
}

/** The end of a declaration starting at `start`: its closing } or ; at its own depth. */
function declEnd(code: string, start: number): number {
  let d = 0;
  for (let k = start; k < code.length; k++) {
    const ch = code[k];
    if (ch === "(" || ch === "{" || ch === "[") d++;
    else if (ch === ")" || ch === "]") d--;
    else if (ch === "}") {
      d--;
      if (d === 0) return k + 1;
      if (d < 0) return k;
    } else if (ch === ";" && d === 0) return k;
  }
  return code.length;
}

/** Whether the initializer at `at` (just past `=`) is a function. */
function isFunction(code: string, at: number): boolean {
  const s = code.slice(at).replace(/^\s*(?:async\s+)?/, "");
  if (/^function\b/.test(s) || /^[A-Za-z_$][\w$]*\s*=>/.test(s)) return true;
  if (!s.startsWith("(")) return false;
  const off = code.length - s.length;
  const after = code.slice(closing(code, off) + 1).trimStart();
  if (after.startsWith("=>")) return true;
  // A return type: `(c): Member => ...`.
  return after.startsWith(":") && /^:[^;{]*=>/.test(after);
}

const DECL =
  /\b(?:(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=)/g;

const refers = (text: string, names: Iterable<string>) => {
  for (const n of names)
    if (
      new RegExp(`(?<![\\w$.])${n.replace(/\$/g, "\\$")}(?![\\w$])`).test(text)
    )
      return true;
  return false;
};

/** Split a parameter or argument list at depth-0 commas. */
function splitTopLevel(code: string): [number, number][] {
  const parts: [number, number][] = [];
  let d = 0;
  let s = 0;
  for (let k = 0; k < code.length; k++) {
    const ch = code[k];
    if (ch === "(" || ch === "{" || ch === "[") d++;
    else if (ch === ")" || ch === "}" || ch === "]") d--;
    else if (ch === "," && d === 0) {
      parts.push([s, k]);
      s = k + 1;
    }
  }
  parts.push([s, code.length]);
  return parts;
}

/** Extract leading parameter identifiers for a function declaration or arrow/function initializer. */
function extractParams(
  code: string,
  at: number,
  isFuncDecl: boolean,
): string[] {
  let i = at;
  const skipWs = () => {
    while (i < code.length && /\s/.test(code[i] as string)) i++;
  };
  skipWs();
  if (!isFuncDecl) {
    if (code.startsWith("async", i) && /\s/.test(code[i + 5] ?? "")) {
      i += 5;
      skipWs();
    }
    if (code.startsWith("function", i) && /[\s*(<]/.test(code[i + 8] ?? "")) {
      i += 8;
      skipWs();
      if (code[i] === "*") {
        i++;
        skipWs();
      }
      const nm = /^[A-Za-z_$][\w$]*/.exec(code.slice(i));
      if (nm) {
        i += nm[0].length;
        skipWs();
      }
    }
  }
  // Skip optional generic type parameters `<T, U>` before `(`.
  if (code[i] === "<") {
    let d = 0;
    for (; i < code.length; i++) {
      if (code[i] === "<") d++;
      else if (code[i] === ">") {
        d--;
        if (d === 0) {
          i++;
          break;
        }
      }
    }
    skipWs();
  }
  if (code[i] === "(") {
    const close = closing(code, i);
    const inner = code.slice(i + 1, close);
    return splitTopLevel(inner).map(([a, b]) => {
      const m = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(inner.slice(a, b));
      return m ? (m[1] as string) : "";
    });
  }
  const single = /^([A-Za-z_$][\w$]*)\s*=>/.exec(code.slice(i));
  return single ? [single[1] as string] : [];
}

/**
 * Whether a negated predicate at `[bangIdx, afterEnd)` is conjunction-guarded
 * (`cond && !pred(c)` or `!pred(c) && cond`), returning the guard identifier if
 * the guard is a bare identifier (e.g. a helper's boolean `write` parameter).
 */
function guardOf(
  body: string,
  bangIdx: number,
  afterEnd: number,
): { kind: "unconditional" } | { kind: "and"; ident: string | null } {
  let l = bangIdx - 1;
  while (l >= 0 && /\s/.test(body[l] as string)) l--;
  if (l >= 1 && body[l] === "&" && body[l - 1] === "&") {
    let k = l - 2;
    let d = 0;
    for (; k >= 0; k--) {
      const ch = body[k];
      if (ch === ")" || ch === "}" || ch === "]") d++;
      else if (ch === "(" || ch === "{" || ch === "[") {
        if (d === 0) break;
        d--;
      } else if (d === 0) {
        if (";,?:".includes(ch as string)) break;
        if (
          (ch === "|" && body[k - 1] === "|") ||
          (ch === "&" && body[k - 1] === "&")
        )
          break;
      }
    }
    const lhs = body.slice(k + 1, l - 1).trim();
    return {
      kind: "and",
      ident: /^[A-Za-z_$][\w$]*$/.test(lhs) ? lhs : null,
    };
  }
  let r = afterEnd;
  while (r < body.length && /\s/.test(body[r] as string)) r++;
  if (body[r] === "&" && body[r + 1] === "&") {
    let k = r + 2;
    let d = 0;
    for (; k < body.length; k++) {
      const ch = body[k];
      if (ch === "(" || ch === "{" || ch === "[") d++;
      else if (ch === ")" || ch === "}" || ch === "]") {
        if (d === 0) break;
        d--;
      } else if (d === 0) {
        if (";,?:".includes(ch as string)) break;
        if (
          (ch === "|" && body[k + 1] === "|") ||
          (ch === "&" && body[k + 1] === "&")
        )
          break;
      }
    }
    const rhs = body.slice(r + 2, k).trim();
    return {
      kind: "and",
      ident: /^[A-Za-z_$][\w$]*$/.test(rhs) ? rhs : null,
    };
  }
  return { kind: "unconditional" };
}

/**
 * Classify whether `body` enforces an interactive session unconditionally,
 * conditionally on a boolean parameter (`paramIdx`), or not at all (optional).
 */
function classifyBody(
  body: string,
  params: readonly string[],
  predicates: ReadonlySet<string>,
  enforcers: ReadonlySet<string>,
  paramEnforcers: ReadonlyMap<string, number>,
): { always: boolean; paramIdx: number | null } {
  if (refers(body, enforcers)) return { always: true, paramIdx: null };

  // Local aliases like `const ok = interactiveSession(c); if (!ok) throw ...`.
  const aliases = new Set<string>();
  for (const m of body.matchAll(
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g,
  )) {
    if (predicates.has(m[2] as string)) aliases.add(m[1] as string);
  }

  let paramIdx: number | null = null;
  for (const m of body.matchAll(/!\s*([A-Za-z_$][\w$]*)/g)) {
    const bangIdx = m.index;
    if (bangIdx > 0 && body[bangIdx - 1] === "!") continue;
    const name = m[1] as string;
    const isPred = predicates.has(name);
    const isAlias = aliases.has(name);
    if (!isPred && !isAlias) continue;
    let afterEnd = bangIdx + m[0].length;
    if (isPred) {
      let open = afterEnd;
      while (open < body.length && /\s/.test(body[open] as string)) open++;
      if (body[open] !== "(") continue;
      afterEnd = closing(body, open) + 1;
    }
    const g = guardOf(body, bangIdx, afterEnd);
    if (g.kind === "unconditional") return { always: true, paramIdx: null };
    if (g.ident !== null) {
      const idx = params.indexOf(g.ident);
      if (idx >= 0) paramIdx = idx;
    }
  }

  if (paramEnforcers.size > 0) {
    for (const m of body.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1] as string;
      const reqIdx = paramEnforcers.get(name);
      if (reqIdx === undefined) continue;
      const open = m.index + m[0].length - 1;
      const close = closing(body, open);
      const inner = body.slice(open + 1, close);
      const args = splitTopLevel(inner);
      const span = args[reqIdx];
      const arg = span ? inner.slice(span[0], span[1]).trim() : "";
      if (arg === "false") continue;
      const idx = params.indexOf(arg);
      if (idx >= 0) {
        paramIdx = idx;
        continue;
      }
      return { always: true, paramIdx: null };
    }
  }

  return { always: false, paramIdx };
}

interface Parsed {
  path: string;
  src: string;
  code: string;
  decls: { name: string; params: string[]; body: string; exported: boolean }[];
  imports: Set<string>;
  consts: Map<string, string>;
}

function parse(f: SourceFile): Parsed {
  const code = codeMask(f.src);
  const decls: Parsed["decls"] = [];
  for (const m of code.matchAll(DECL)) {
    const name = (m[1] ?? m[2]) as string;
    const at = m.index + m[0].length;
    // Only functions are helpers: `const user = browserUser(c)` inside a
    // handler is a value, and tainting it would flag every other `user`.
    if (m[2] && !isFunction(code, at)) continue;
    const body = code.slice(at, declEnd(code, at));
    const params = extractParams(code, at, Boolean(m[1]));
    decls.push({ name, params, body, exported: m[0].startsWith("export") });
  }
  const imports = new Set<string>();
  for (const m of code.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}/g))
    for (const part of (m[1] as string).split(",")) {
      const local = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (local && !local.startsWith("type ")) imports.add(local);
    }
  // `const NAME = "..."` / `const NAME = \`...\`` / `const NAME = R.x;`
  const consts = new Map<string, string>();
  for (const m of code.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?=["'`]|R\.\w+\s*;)/g,
  )) {
    const at = m.index + m[0].length;
    let e = at;
    for (let d = 0; e < code.length; e++) {
      const ch = code[e];
      if (ch === "(" || ch === "{" || ch === "[") d++;
      else if (ch === ")" || ch === "}" || ch === "]") d--;
      else if ((ch === ";" || ch === "\n") && d === 0) break;
    }
    consts.set(m[1] as string, f.src.slice(at, e).trim());
  }
  return { ...f, code, decls, imports, consts };
}

/**
 * Resolve a route's path argument (source text) to its Hono pattern: a
 * string literal, R.name, a top-of-file string constant, or a template of
 * those. Anything else is null.
 */
function resolvePath(
  arg: string,
  consts: ReadonlyMap<string, string>,
  seen = 0,
): string | null {
  const a = arg.trim();
  if (seen > 8) return null;
  const lit = /^"([^"]*)"$|^'([^']*)'$/.exec(a);
  if (lit) return (lit[1] ?? lit[2]) as string;
  const ref = (e: string): string | null => {
    const r = /^R\.(\w+)$/.exec(e);
    if (r) {
      const v = (R as Record<string, unknown>)[r[1] as string];
      return typeof v === "string" ? v : null;
    }
    const c = /^[A-Za-z_$][\w$]*$/.test(e) ? consts.get(e) : undefined;
    return c === undefined ? null : resolvePath(c, consts, seen + 1);
  };
  if (a.startsWith("`") && a.endsWith("`")) {
    let ok = true;
    const p = a.slice(1, -1).replace(/\$\{([^}]*)\}/g, (_, e: string) => {
      const v = ref(e.trim());
      if (v === null) ok = false;
      return v ?? "";
    });
    return ok ? p : null;
  }
  return ref(a);
}

const ROUTE =
  /\b(\w*[aA]pp)(?:\.(get|post|put|patch|delete|all|on)|\[(\w+)\])\s*\(/g;

/**
 * Every route whose handler enforces interactiveSession(c) (directly or via an
 * enforcing helper), as "METHOD /path"; optional browser checks (e.g. an extra
 * field gated by `&& interactiveSession(c)`, or `helper(c, false)`) are not
 * flagged. With `all`, every route the scan sees (to prove it misses none).
 */
export function interactiveRoutes(
  files: readonly SourceFile[],
  { all = false } = {},
): string[] {
  const parsed = files.map(parse);
  const predicates = new Map<Parsed, Set<string>>(
    parsed.map((p) => [p, new Set(["interactiveSession"])]),
  );
  const enforcers = new Map<Parsed, Set<string>>(
    parsed.map((p) => [p, new Set()]),
  );
  const paramEnforcers = new Map<Parsed, Map<string, number>>(
    parsed.map((p) => [p, new Map()]),
  );
  // Fixpoint across helpers and cross-file imports:
  // - predicates: wrap interactiveSession(c) without enforcing it on their own
  // - enforcers: unconditionally enforce !interactiveSession(c) (or call an enforcer)
  // - paramEnforcers: enforce !interactiveSession(c) only when parameter #i isn't false
  for (let changed = true; changed; ) {
    changed = false;
    const expPred = new Set<string>();
    const expEnf = new Set<string>();
    const expParam = new Map<string, number>();
    for (const p of parsed) {
      const pr = predicates.get(p) as Set<string>;
      const en = enforcers.get(p) as Set<string>;
      const pe = paramEnforcers.get(p) as Map<string, number>;
      for (const d of p.decls) {
        if (!d.exported) continue;
        if (en.has(d.name)) expEnf.add(d.name);
        else if (pe.has(d.name)) expParam.set(d.name, pe.get(d.name) as number);
        else if (pr.has(d.name)) expPred.add(d.name);
      }
    }
    for (const p of parsed) {
      const pr = predicates.get(p) as Set<string>;
      const en = enforcers.get(p) as Set<string>;
      const pe = paramEnforcers.get(p) as Map<string, number>;
      for (const n of expEnf)
        if (p.imports.has(n) && !en.has(n)) {
          en.add(n);
          pe.delete(n);
          pr.delete(n);
          changed = true;
        }
      for (const [n, idx] of expParam)
        if (p.imports.has(n) && !en.has(n) && pe.get(n) !== idx) {
          pe.set(n, idx);
          pr.delete(n);
          changed = true;
        }
      for (const n of expPred)
        if (p.imports.has(n) && !en.has(n) && !pe.has(n) && !pr.has(n)) {
          pr.add(n);
          changed = true;
        }
      for (const d of p.decls) {
        if (en.has(d.name)) continue;
        const c = classifyBody(d.body, d.params, pr, en, pe);
        if (c.always) {
          en.add(d.name);
          pe.delete(d.name);
          pr.delete(d.name);
          changed = true;
        } else if (c.paramIdx !== null) {
          if (pe.get(d.name) !== c.paramIdx) {
            pe.set(d.name, c.paramIdx);
            pr.delete(d.name);
            changed = true;
          }
        } else if (!pe.has(d.name) && !pr.has(d.name) && refers(d.body, pr)) {
          pr.add(d.name);
          changed = true;
        }
      }
    }
  }
  const found: string[] = [];
  for (const p of parsed) {
    const pr = predicates.get(p) as Set<string>;
    const en = enforcers.get(p) as Set<string>;
    const pe = paramEnforcers.get(p) as Map<string, number>;
    for (const m of p.code.matchAll(ROUTE)) {
      const open = m.index + m[0].length - 1;
      const close = closing(p.code, open);
      const code = p.code.slice(open + 1, close);
      const args = splitTopLevel(code);
      const text = (a: [number, number]) =>
        p.src.slice(open + 1 + a[0], open + 1 + a[1]);
      let methods = [(m[2] ?? "").toUpperCase()];
      let rest = args;
      if (m[3]) {
        // `for (const method of ["put", "delete"] as const) app[method](...)`
        const loop = new RegExp(
          `for\\s*\\(\\s*const\\s+${m[3]}\\s+of\\s+\\[([^\\]]*)\\]`,
        ).exec(p.src.slice(Math.max(0, m.index - 300), m.index));
        methods = loop
          ? [...(loop[1] as string).matchAll(/"(\w+)"/g)].map((x) =>
              (x[1] as string).toUpperCase(),
            )
          : [`?${m[3]}`];
      } else if (m[2] === "on") {
        methods = [
          ...text(args[0] as [number, number]).matchAll(/"(\w+)"/g),
        ].map((x) => x[1] as string);
        rest = args.slice(1);
      }
      const [pathArg, ...handlers] = rest;
      if (!pathArg) continue;
      const handlerCode = handlers.map((a) => code.slice(a[0], a[1])).join(",");
      if (!all && !classifyBody(handlerCode, [], pr, en, pe).always) continue;
      const raw = text(pathArg).trim();
      const path = resolvePath(raw, p.consts) ?? `?${raw}`;
      for (const meth of methods) found.push(`${meth} ${path}`);
    }
  }
  return [...new Set(found)].sort();
}
