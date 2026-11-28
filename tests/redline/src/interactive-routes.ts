import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import ts from "typescript";
import { R } from "../../../packages/shared/src/routes.ts";

/**
 * #1204/#1313: the server routes that require an interactive browser session,
 * found by parsing apps/server/src into TypeScript ASTs and abstractly
 * evaluating each route handler twice: once with `interactiveSession(c) = true`
 * (browser) and once with `interactiveSession(c) = false` (token / hook).
 *
 * A route is interactive-only iff a browser can reach a non-refusal return
 * while every path for a non-interactive caller throws or returns a refusal
 * status (401/403/404). Handlers that consult `interactiveSession(c)` only for
 * response data (e.g. `readOnly: !interactiveSession(c)` or an optional field)
 * succeed in both runs and stay ordinary probed routes.
 *
 * A path expression that can't be resolved statically comes back as
 * `<METHOD> ?<expression>`.
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

// ------------------------------------------------------- abstract values

type Val =
  | { kind: "bool"; v: boolean }
  | { kind: "num"; v: number }
  | { kind: "str"; v: string }
  | { kind: "nullish" }
  | { kind: "resp"; ok: boolean; refuse: boolean }
  | { kind: "obj"; props: Map<string, Val> }
  | { kind: "fn"; fn: FnDef; env: Env }
  | { kind: "unknown" };

const UNKNOWN: Val = { kind: "unknown" };
const TRUE_VAL: Val = { kind: "bool", v: true };
const FALSE_VAL: Val = { kind: "bool", v: false };
const NULLISH_VAL: Val = { kind: "nullish" };
const RESP_OK: Val = { kind: "resp", ok: true, refuse: false };
const RESP_REFUSE: Val = { kind: "resp", ok: false, refuse: true };
const RESP_MAYBE: Val = { kind: "resp", ok: true, refuse: true };

type Env = Map<string, Val>;

interface ExprResult {
  mustThrow: boolean;
  val: Val;
}

interface Flow {
  /** Can execution reach the statement following this one? */
  fallthrough: boolean;
  /** Can execution return a non-refusal value / response? */
  canSucceed: boolean;
  /** Abstract value returned on any return path (null when only throwing/falling through). */
  ret: Val | null;
  /** Variable bindings on the fallthrough path. */
  env: Env;
}

interface FnDef {
  file: ParsedFile;
  node: ts.FunctionLikeDeclarationBase;
  params: { name: string | null; init?: ts.Expression }[];
  body: ts.ConciseBody;
  scope: Scope;
}

interface ImportRef {
  spec: string;
  imported: string;
}

interface Scope {
  parent?: Scope;
  fns: Map<string, FnDef>;
  consts: Map<string, ts.Expression>;
}

interface ParsedFile {
  path: string;
  sf: ts.SourceFile;
  rootScope: Scope;
  exports: Map<string, FnDef>;
  exportConsts: Map<string, ts.Expression>;
  imports: Map<string, ImportRef>;
}

const isRefusalStatus = (n: number) => n === 401 || n === 403 || n === 404;

const isDefiniteRefusal = (v: Val) => v.kind === "resp" && !v.ok && v.refuse;

function truthiness(v: Val): "true" | "false" | "unknown" {
  switch (v.kind) {
    case "bool":
      return v.v ? "true" : "false";
    case "num":
      return v.v !== 0 && !Number.isNaN(v.v) ? "true" : "false";
    case "str":
      return v.v.length > 0 ? "true" : "false";
    case "nullish":
      return "false";
    case "resp":
    case "obj":
    case "fn":
      return "true";
    case "unknown":
      return "unknown";
  }
}

function joinVal(a: Val, b: Val): Val {
  if (a === b) return a;
  if (a.kind === "unknown" || b.kind === "unknown") return UNKNOWN;
  if (a.kind === b.kind) {
    switch (a.kind) {
      case "bool":
        return a.v === (b as { kind: "bool"; v: boolean }).v ? a : UNKNOWN;
      case "num":
        return a.v === (b as { kind: "num"; v: number }).v ? a : UNKNOWN;
      case "str":
        return a.v === (b as { kind: "str"; v: string }).v ? a : UNKNOWN;
      case "nullish":
        return NULLISH_VAL;
      case "resp": {
        const br = b as { kind: "resp"; ok: boolean; refuse: boolean };
        return {
          kind: "resp",
          ok: a.ok || br.ok,
          refuse: a.refuse || br.refuse,
        };
      }
      case "obj": {
        const bp = (b as { kind: "obj"; props: Map<string, Val> }).props;
        const props = new Map<string, Val>();
        for (const [k, v] of a.props) {
          const bv = bp.get(k);
          if (bv !== undefined) props.set(k, joinVal(v, bv));
        }
        return props.size === a.props.size && props.size === bp.size
          ? { kind: "obj", props }
          : UNKNOWN;
      }
      case "fn":
        return a.fn === (b as { kind: "fn"; fn: FnDef }).fn ? a : UNKNOWN;
    }
  }
  return UNKNOWN;
}

const mergeRet = (a: Val | null, b: Val | null): Val | null =>
  a === null ? b : b === null ? a : joinVal(a, b);

function joinEnv(a: Env, b: Env): Env {
  const out: Env = new Map();
  for (const [k, v] of a) {
    const bv = b.get(k);
    if (bv !== undefined) out.set(k, joinVal(v, bv));
  }
  return out;
}

function unwrapExpr(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (ts.isAsExpression(cur)) cur = cur.expression;
    else if (ts.isSatisfiesExpression(cur)) cur = cur.expression;
    else if (ts.isNonNullExpression(cur)) cur = cur.expression;
    else if (ts.isTypeAssertionExpression(cur)) cur = cur.expression;
    else if (ts.isAwaitExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return (
    ts
      .getModifiers(node)
      ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
  );
}

function paramsOf(
  fn: ts.FunctionLikeDeclarationBase,
): { name: string | null; init?: ts.Expression }[] {
  return fn.parameters.map((p) => ({
    name: ts.isIdentifier(p.name) ? p.name.text : null,
    init: p.initializer,
  }));
}

function collectScopeDecls(
  stmts: readonly ts.Statement[],
  file: ParsedFile,
  scope: Scope,
  isRoot: boolean,
): void {
  for (const st of stmts) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) {
      const def: FnDef = {
        file,
        node: st,
        params: paramsOf(st),
        body: st.body,
        scope,
      };
      scope.fns.set(st.name.text, def);
      if (isRoot && hasExportModifier(st)) file.exports.set(st.name.text, def);
    } else if (ts.isVariableStatement(st)) {
      const exp = isRoot && hasExportModifier(st);
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const init = unwrapExpr(d.initializer);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          const def: FnDef = {
            file,
            node: init,
            params: paramsOf(init),
            body: init.body,
            scope,
          };
          scope.fns.set(d.name.text, def);
          if (exp) file.exports.set(d.name.text, def);
        } else {
          scope.consts.set(d.name.text, init);
          if (exp) file.exportConsts.set(d.name.text, init);
        }
      }
    }
  }
}

function parseFile(f: SourceFile): ParsedFile {
  const sf = ts.createSourceFile(
    f.path,
    f.src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const rootScope: Scope = { fns: new Map(), consts: new Map() };
  const pf: ParsedFile = {
    path: f.path.replaceAll("\\", "/"),
    sf,
    rootScope,
    exports: new Map(),
    exportConsts: new Map(),
    imports: new Map(),
  };
  for (const st of sf.statements) {
    if (
      ts.isImportDeclaration(st) &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      st.importClause?.namedBindings &&
      ts.isNamedImports(st.importClause.namedBindings)
    ) {
      const spec = st.moduleSpecifier.text;
      for (const el of st.importClause.namedBindings.elements) {
        if (el.isTypeOnly) continue;
        const local = el.name.text;
        const imported = (el.propertyName ?? el.name).text;
        pf.imports.set(local, { spec, imported });
      }
    }
  }
  collectScopeDecls(sf.statements, pf, rootScope, true);
  return pf;
}

// ------------------------------------------------------- cross-file lookup

/** Pre-filter files for `all === false`: interactive files, their importers, and local error helpers they import. */
function relevantSources(files: readonly SourceFile[]): SourceFile[] {
  const norm = (p: string) => p.replaceAll("\\", "/");
  const byPath = new Map(files.map((f) => [norm(f.path), f]));
  const importSpecs = new Map<SourceFile, string[]>();
  for (const f of files) {
    const specs: string[] = [];
    for (const m of f.src.matchAll(
      /\b(?:import|export)\b[^"']*?\bfrom\s*["']([^"']+)["']/g,
    )) {
      specs.push(m[1] as string);
    }
    importSpecs.set(f, specs);
  }
  const resolveSpec = (from: SourceFile, spec: string): SourceFile | null => {
    if (!spec.startsWith(".")) return null;
    const base = posix.normalize(posix.join(dirname(norm(from.path)), spec));
    const stem = base.replace(/\.(?:[cm]?js|[cm]?ts)$/, "");
    for (const cand of [base, `${stem}.ts`, `${stem}/index.ts`]) {
      const hit = byPath.get(cand);
      if (hit) return hit;
    }
    return null;
  };

  // Seed with every file mentioning interactiveSession, plus its transitive importers.
  const keep = new Set<SourceFile>();
  for (const f of files) if (f.src.includes("interactiveSession")) keep.add(f);
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of files) {
      if (keep.has(f)) continue;
      for (const spec of importSpecs.get(f) ?? []) {
        const target = resolveSpec(f, spec);
        if (target && keep.has(target)) {
          keep.add(f);
          changed = true;
          break;
        }
      }
    }
  }
  // Also keep direct relative imports of kept files that can throw or return a Response
  // (e.g. http/errors.ts `errorJson` / `notFound`), so cross-file refusal helpers resolve.
  for (const f of [...keep]) {
    for (const spec of importSpecs.get(f) ?? []) {
      const target = resolveSpec(f, spec);
      if (
        target &&
        !keep.has(target) &&
        /\b(?:throw|Response|ApiError|401|403|404)\b/.test(target.src)
      ) {
        keep.add(target);
      }
    }
  }
  return files.filter((f) => keep.has(f));
}

class Program {
  readonly files: ParsedFile[];
  readonly interactiveFiles: Set<ParsedFile>;
  private readonly byPath: Map<string, ParsedFile>;
  private readonly exportedFns: Map<string, FnDef[]>;
  private readonly exportedConsts: Map<
    string,
    { file: ParsedFile; expr: ts.Expression }[]
  >;
  private readonly callMemo = new Map<string, Flow>();
  private readonly fnIds = new Map<FnDef, number>();

  constructor(files: readonly SourceFile[], all: boolean) {
    // When `all` is false, skip parsing files that can never reach
    // `interactiveSession` and are not imported by one that can.
    const toParse = all ? files : relevantSources(files);
    this.files = toParse.map(parseFile);
    this.byPath = new Map(this.files.map((f) => [f.path, f]));
    this.exportedFns = new Map();
    this.exportedConsts = new Map();
    for (const f of this.files) {
      for (const [name, def] of f.exports) {
        const list = this.exportedFns.get(name) ?? [];
        list.push(def);
        this.exportedFns.set(name, list);
      }
      for (const [name, expr] of f.exportConsts) {
        const list = this.exportedConsts.get(name) ?? [];
        list.push({ file: f, expr });
        this.exportedConsts.set(name, list);
      }
    }
    this.interactiveFiles = this.computeInteractiveFiles();
  }

  private computeInteractiveFiles(): Set<ParsedFile> {
    const reach = new Set<ParsedFile>();
    for (const f of this.files) {
      if (f.sf.text.includes("interactiveSession")) reach.add(f);
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (const f of this.files) {
        if (reach.has(f)) continue;
        for (const imp of f.imports.values()) {
          const target = this.resolveModule(f, imp.spec);
          if (target && reach.has(target)) {
            reach.add(f);
            changed = true;
            break;
          }
          if (!target) {
            const cands = this.exportedFns.get(imp.imported);
            if (cands?.some((d) => reach.has(d.file))) {
              reach.add(f);
              changed = true;
              break;
            }
          }
        }
      }
    }
    return reach;
  }

  fnId(fn: FnDef): number {
    let id = this.fnIds.get(fn);
    if (id === undefined) {
      id = this.fnIds.size;
      this.fnIds.set(fn, id);
    }
    return id;
  }

  getMemo(key: string): Flow | undefined {
    return this.callMemo.get(key);
  }

  setMemo(key: string, flow: Flow): void {
    this.callMemo.set(key, flow);
  }

  private resolveModule(from: ParsedFile, spec: string): ParsedFile | null {
    if (!spec.startsWith(".")) return null;
    const base = posix.normalize(
      posix.join(dirname(from.path).replaceAll("\\", "/"), spec),
    );
    const stem = base.replace(/\.(?:[cm]?js|[cm]?ts)$/, "");
    for (const cand of [base, `${stem}.ts`, `${stem}/index.ts`]) {
      const hit = this.byPath.get(cand);
      if (hit) return hit;
    }
    return null;
  }

  isInteractiveSessionRef(
    file: ParsedFile,
    scope: Scope,
    name: string,
  ): boolean {
    if (name === "interactiveSession") return true;
    // Shadowed by a local declaration?
    for (let s: Scope | undefined = scope; s; s = s.parent)
      if (s.fns.has(name) || s.consts.has(name)) return false;
    const imp = file.imports.get(name);
    return imp?.imported === "interactiveSession";
  }

  lookupFn(file: ParsedFile, scope: Scope, name: string): FnDef | null {
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      const local = s.fns.get(name);
      if (local) return local;
    }
    const imp = file.imports.get(name);
    if (!imp) return null;
    const target = this.resolveModule(file, imp.spec);
    if (target) return target.exports.get(imp.imported) ?? null;
    const candidates = this.exportedFns.get(imp.imported);
    return candidates?.length === 1 ? (candidates[0] ?? null) : null;
  }

  lookupConst(
    file: ParsedFile,
    scope: Scope,
    name: string,
  ): { file: ParsedFile; scope: Scope; expr: ts.Expression } | null {
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      const local = s.consts.get(name);
      if (local) return { file, scope: s, expr: local };
    }
    const imp = file.imports.get(name);
    if (!imp) return null;
    const target = this.resolveModule(file, imp.spec);
    if (target) {
      const expr = target.exportConsts.get(imp.imported);
      return expr ? { file: target, scope: target.rootScope, expr } : null;
    }
    const candidates = this.exportedConsts.get(imp.imported);
    if (candidates?.length === 1 && candidates[0]) {
      return {
        file: candidates[0].file,
        scope: candidates[0].file.rootScope,
        expr: candidates[0].expr,
      };
    }
    return null;
  }
}

// ------------------------------------------------------- path resolution

function resolvePathExpr(
  prog: Program,
  file: ParsedFile,
  scope: Scope,
  expr: ts.Expression,
  depth = 0,
): string | null {
  if (depth > 8) return null;
  const e = unwrapExpr(expr);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))
    return e.text;
  if (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "R"
  ) {
    const v = (R as Record<string, unknown>)[e.name.text];
    return typeof v === "string" ? v : null;
  }
  if (ts.isIdentifier(e)) {
    const c = prog.lookupConst(file, scope, e.text);
    return c ? resolvePathExpr(prog, c.file, c.scope, c.expr, depth + 1) : null;
  }
  if (ts.isTemplateExpression(e)) {
    let out = e.head.text;
    for (const sp of e.templateSpans) {
      const part = resolvePathExpr(prog, file, scope, sp.expression, depth + 1);
      if (part === null) return null;
      out += part + sp.literal.text;
    }
    return out;
  }
  if (
    ts.isBinaryExpression(e) &&
    e.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const l = resolvePathExpr(prog, file, scope, e.left, depth + 1);
    const r = resolvePathExpr(prog, file, scope, e.right, depth + 1);
    return l !== null && r !== null ? l + r : null;
  }
  return null;
}

// ------------------------------------------------------- abstract evaluator

const MAX_CALL_DEPTH = 12;
const STATUS_KEY = "__hono_status__";
const RESPONSE_METHODS = new Set([
  "json",
  "text",
  "html",
  "body",
  "newResponse",
]);

function statusFromVal(v: Val | undefined): number | null {
  if (!v) return null;
  if (v.kind === "num") return v.v;
  if (v.kind === "obj") {
    const s = v.props.get("status");
    if (s?.kind === "num") return s.v;
  }
  return null;
}

function responseForStatus(statusArg: Val | undefined, env: Env): Val {
  if (statusArg !== undefined) {
    const n = statusFromVal(statusArg);
    if (n !== null) return isRefusalStatus(n) ? RESP_REFUSE : RESP_OK;
    if (statusArg.kind === "unknown") return RESP_MAYBE;
    if (statusArg.kind === "obj") {
      const s = statusArg.props.get("status");
      if (!s) return RESP_OK;
      return s.kind === "num"
        ? isRefusalStatus(s.v)
          ? RESP_REFUSE
          : RESP_OK
        : RESP_MAYBE;
    }
    return RESP_OK;
  }
  const preset = env.get(STATUS_KEY);
  if (preset) {
    const n = statusFromVal(preset);
    if (n !== null) return isRefusalStatus(n) ? RESP_REFUSE : RESP_OK;
    return RESP_MAYBE;
  }
  return RESP_OK;
}

function evalExpr(
  prog: Program,
  file: ParsedFile,
  scope: Scope,
  env: Env,
  expr: ts.Expression,
  interactive: boolean,
  depth: number,
  nextCb?: () => Flow,
): ExprResult {
  const e = unwrapExpr(expr);

  if (e.kind === ts.SyntaxKind.TrueKeyword)
    return { mustThrow: false, val: TRUE_VAL };
  if (e.kind === ts.SyntaxKind.FalseKeyword)
    return { mustThrow: false, val: FALSE_VAL };
  if (e.kind === ts.SyntaxKind.NullKeyword)
    return { mustThrow: false, val: NULLISH_VAL };
  if (ts.isNumericLiteral(e))
    return { mustThrow: false, val: { kind: "num", v: Number(e.text) } };
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))
    return { mustThrow: false, val: { kind: "str", v: e.text } };

  if (ts.isIdentifier(e)) {
    if (e.text === "undefined") return { mustThrow: false, val: NULLISH_VAL };
    const bound = env.get(e.text);
    if (bound !== undefined) return { mustThrow: false, val: bound };
    const fn = prog.lookupFn(file, scope, e.text);
    if (fn)
      return { mustThrow: false, val: { kind: "fn", fn, env: new Map() } };
    const c = prog.lookupConst(file, scope, e.text);
    if (c && depth < MAX_CALL_DEPTH)
      return evalExpr(
        prog,
        c.file,
        c.scope,
        new Map(),
        c.expr,
        interactive,
        depth + 1,
      );
    return { mustThrow: false, val: UNKNOWN };
  }

  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
    const fn: FnDef = {
      file,
      node: e,
      params: paramsOf(e),
      body: e.body,
      scope,
    };
    return { mustThrow: false, val: { kind: "fn", fn, env: new Map(env) } };
  }

  if (ts.isPrefixUnaryExpression(e)) {
    const r = evalExpr(
      prog,
      file,
      scope,
      env,
      e.operand,
      interactive,
      depth,
      nextCb,
    );
    if (r.mustThrow) return r;
    if (e.operator === ts.SyntaxKind.ExclamationToken) {
      const t = truthiness(r.val);
      return {
        mustThrow: false,
        val: t === "unknown" ? UNKNOWN : t === "true" ? FALSE_VAL : TRUE_VAL,
      };
    }
    if (e.operator === ts.SyntaxKind.MinusToken && r.val.kind === "num")
      return { mustThrow: false, val: { kind: "num", v: -r.val.v } };
    return { mustThrow: false, val: UNKNOWN };
  }

  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsToken) {
      const rhs = evalExpr(
        prog,
        file,
        scope,
        env,
        e.right,
        interactive,
        depth,
        nextCb,
      );
      if (rhs.mustThrow) return rhs;
      if (ts.isIdentifier(e.left)) env.set(e.left.text, rhs.val);
      return rhs;
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      const l = evalExpr(
        prog,
        file,
        scope,
        env,
        e.left,
        interactive,
        depth,
        nextCb,
      );
      if (l.mustThrow) return l;
      const lt = truthiness(l.val);
      if (lt === "false") return l;
      const r = evalExpr(
        prog,
        file,
        scope,
        env,
        e.right,
        interactive,
        depth,
        nextCb,
      );
      if (lt === "true") return r;
      return {
        mustThrow: false,
        val:
          !r.mustThrow && truthiness(r.val) === "false" ? FALSE_VAL : UNKNOWN,
      };
    }
    if (op === ts.SyntaxKind.BarBarToken) {
      const l = evalExpr(
        prog,
        file,
        scope,
        env,
        e.left,
        interactive,
        depth,
        nextCb,
      );
      if (l.mustThrow) return l;
      const lt = truthiness(l.val);
      if (lt === "true") return l;
      const r = evalExpr(
        prog,
        file,
        scope,
        env,
        e.right,
        interactive,
        depth,
        nextCb,
      );
      if (lt === "false") return r;
      return {
        mustThrow: false,
        val: !r.mustThrow && truthiness(r.val) === "true" ? TRUE_VAL : UNKNOWN,
      };
    }
    if (op === ts.SyntaxKind.QuestionQuestionToken) {
      const l = evalExpr(
        prog,
        file,
        scope,
        env,
        e.left,
        interactive,
        depth,
        nextCb,
      );
      if (l.mustThrow) return l;
      if (l.val.kind === "nullish")
        return evalExpr(
          prog,
          file,
          scope,
          env,
          e.right,
          interactive,
          depth,
          nextCb,
        );
      if (l.val.kind !== "unknown") return l;
      evalExpr(prog, file, scope, env, e.right, interactive, depth, nextCb);
      return { mustThrow: false, val: UNKNOWN };
    }
    const l = evalExpr(
      prog,
      file,
      scope,
      env,
      e.left,
      interactive,
      depth,
      nextCb,
    );
    if (l.mustThrow) return l;
    const r = evalExpr(
      prog,
      file,
      scope,
      env,
      e.right,
      interactive,
      depth,
      nextCb,
    );
    if (r.mustThrow) return r;
    if (op === ts.SyntaxKind.InKeyword) {
      if (l.val.kind === "str" && r.val.kind === "obj") {
        return {
          mustThrow: false,
          val: r.val.props.has(l.val.v) ? TRUE_VAL : FALSE_VAL,
        };
      }
      return { mustThrow: false, val: UNKNOWN };
    }
    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken
    ) {
      const neg =
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken;
      if (
        (l.val.kind === "bool" && r.val.kind === "bool") ||
        (l.val.kind === "num" && r.val.kind === "num") ||
        (l.val.kind === "str" && r.val.kind === "str")
      ) {
        const eq = l.val.v === r.val.v;
        return {
          mustThrow: false,
          val: (neg ? !eq : eq) ? TRUE_VAL : FALSE_VAL,
        };
      }
      return { mustThrow: false, val: UNKNOWN };
    }
    return { mustThrow: false, val: UNKNOWN };
  }

  if (ts.isConditionalExpression(e)) {
    const cond = evalExpr(
      prog,
      file,
      scope,
      env,
      e.condition,
      interactive,
      depth,
      nextCb,
    );
    if (cond.mustThrow) return cond;
    const ct = truthiness(cond.val);
    if (ct === "true")
      return evalExpr(
        prog,
        file,
        scope,
        env,
        e.whenTrue,
        interactive,
        depth,
        nextCb,
      );
    if (ct === "false")
      return evalExpr(
        prog,
        file,
        scope,
        env,
        e.whenFalse,
        interactive,
        depth,
        nextCb,
      );
    const a = evalExpr(
      prog,
      file,
      scope,
      new Map(env),
      e.whenTrue,
      interactive,
      depth,
      nextCb,
    );
    const b = evalExpr(
      prog,
      file,
      scope,
      new Map(env),
      e.whenFalse,
      interactive,
      depth,
      nextCb,
    );
    if (a.mustThrow && b.mustThrow) return { mustThrow: true, val: UNKNOWN };
    if (a.mustThrow) return b;
    if (b.mustThrow) return a;
    return { mustThrow: false, val: joinVal(a.val, b.val) };
  }

  if (ts.isObjectLiteralExpression(e)) {
    const props = new Map<string, Val>();
    for (const p of e.properties) {
      if (ts.isPropertyAssignment(p)) {
        const v = evalExpr(
          prog,
          file,
          scope,
          env,
          p.initializer,
          interactive,
          depth,
          nextCb,
        );
        if (v.mustThrow) return v;
        const k =
          ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)
            ? p.name.text
            : null;
        if (k !== null) props.set(k, v.val);
      } else if (ts.isShorthandPropertyAssignment(p)) {
        const v = evalExpr(
          prog,
          file,
          scope,
          env,
          p.name,
          interactive,
          depth,
          nextCb,
        );
        if (v.mustThrow) return v;
        props.set(p.name.text, v.val);
      } else if (ts.isSpreadAssignment(p)) {
        const v = evalExpr(
          prog,
          file,
          scope,
          env,
          p.expression,
          interactive,
          depth,
          nextCb,
        );
        if (v.mustThrow) return v;
        if (v.val.kind === "obj") {
          for (const [k, sv] of v.val.props) props.set(k, sv);
        }
      }
    }
    return { mustThrow: false, val: { kind: "obj", props } };
  }

  if (ts.isArrayLiteralExpression(e)) {
    for (const el of e.elements) {
      const r = evalExpr(
        prog,
        file,
        scope,
        env,
        el,
        interactive,
        depth,
        nextCb,
      );
      if (r.mustThrow) return r;
    }
    return { mustThrow: false, val: UNKNOWN };
  }

  if (ts.isTemplateExpression(e)) {
    for (const sp of e.templateSpans) {
      const r = evalExpr(
        prog,
        file,
        scope,
        env,
        sp.expression,
        interactive,
        depth,
        nextCb,
      );
      if (r.mustThrow) return r;
    }
    return { mustThrow: false, val: UNKNOWN };
  }

  if (ts.isPropertyAccessExpression(e)) {
    const obj = evalExpr(
      prog,
      file,
      scope,
      env,
      e.expression,
      interactive,
      depth,
      nextCb,
    );
    if (obj.mustThrow) return obj;
    if (obj.val.kind === "obj") {
      const hit = obj.val.props.get(e.name.text);
      if (hit !== undefined) return { mustThrow: false, val: hit };
    }
    return { mustThrow: false, val: UNKNOWN };
  }

  if (ts.isNewExpression(e)) {
    const argVals: Val[] = [];
    for (const a of e.arguments ?? []) {
      const r = evalExpr(prog, file, scope, env, a, interactive, depth, nextCb);
      if (r.mustThrow) return r;
      argVals.push(r.val);
    }
    if (ts.isIdentifier(e.expression) && e.expression.text === "Response") {
      return {
        mustThrow: false,
        val: responseForStatus(argVals[1], new Map()),
      };
    }
    return { mustThrow: false, val: UNKNOWN };
  }

  if (ts.isCallExpression(e)) {
    const argVals: Val[] = [];
    for (const a of e.arguments) {
      const r = evalExpr(prog, file, scope, env, a, interactive, depth, nextCb);
      if (r.mustThrow) return r;
      argVals.push(r.val);
    }
    const callee = unwrapExpr(e.expression);

    // Middleware `next()` invocation.
    if (ts.isIdentifier(callee) && callee.text === "next" && nextCb) {
      const f = nextCb();
      if (!f.fallthrough && !f.canSucceed && f.ret === null)
        return { mustThrow: true, val: UNKNOWN };
      return {
        mustThrow: false,
        val: f.ret ?? (f.canSucceed || f.fallthrough ? RESP_OK : RESP_REFUSE),
      };
    }

    // `interactiveSession(c)` (direct or aliased import).
    if (
      ts.isIdentifier(callee) &&
      prog.isInteractiveSessionRef(file, scope, callee.text)
    ) {
      return { mustThrow: false, val: interactive ? TRUE_VAL : FALSE_VAL };
    }

    // Hono context response helpers (`c.json`, `c.text`, `c.html`, `c.body`, `c.status`, `c.redirect`)
    // and `Response.json`.
    if (ts.isPropertyAccessExpression(callee)) {
      const meth = callee.name.text;
      if (
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Response" &&
        meth === "json"
      ) {
        return {
          mustThrow: false,
          val: responseForStatus(argVals[1], new Map()),
        };
      }
      if (meth === "status" && argVals[0]) {
        env.set(STATUS_KEY, argVals[0]);
        return { mustThrow: false, val: UNKNOWN };
      }
      if (meth === "redirect") return { mustThrow: false, val: RESP_OK };
      if (RESPONSE_METHODS.has(meth)) {
        return { mustThrow: false, val: responseForStatus(argVals[1], env) };
      }
      // Evaluate receiver for side effects/throws.
      const recv = evalExpr(
        prog,
        file,
        scope,
        env,
        callee.expression,
        interactive,
        depth,
        nextCb,
      );
      if (recv.mustThrow) return recv;
      return { mustThrow: false, val: UNKNOWN };
    }

    // User-defined helper function call (direct, closure, or imported).
    if (depth < MAX_CALL_DEPTH) {
      let target: { fn: FnDef; closureEnv: Env } | null = null;
      if (ts.isIdentifier(callee)) {
        const bound = env.get(callee.text);
        if (bound?.kind === "fn") {
          target = { fn: bound.fn, closureEnv: bound.env };
        } else {
          const def = prog.lookupFn(file, scope, callee.text);
          if (def) target = { fn: def, closureEnv: new Map() };
        }
      } else {
        const cv = evalExpr(
          prog,
          file,
          scope,
          env,
          callee,
          interactive,
          depth + 1,
          nextCb,
        );
        if (cv.mustThrow) return cv;
        if (cv.val.kind === "fn")
          target = { fn: cv.val.fn, closureEnv: cv.val.env };
      }
      if (target) {
        const flow = callFn(
          prog,
          target.fn,
          target.closureEnv,
          argVals,
          interactive,
          depth + 1,
        );
        if (!flow.fallthrough && !flow.canSucceed && flow.ret === null)
          return { mustThrow: true, val: UNKNOWN };
        return { mustThrow: false, val: flow.ret ?? UNKNOWN };
      }
    }

    return { mustThrow: false, val: UNKNOWN };
  }

  return { mustThrow: false, val: UNKNOWN };
}

function memoKey(
  prog: Program,
  fn: FnDef,
  args: readonly Val[],
  interactive: boolean,
): string | null {
  const parts = [String(prog.fnId(fn)), interactive ? "1" : "0"];
  for (let i = 0; i < fn.params.length; i++) {
    const v = args[i];
    if (!v || v.kind === "unknown") parts.push("u");
    else if (v.kind === "bool") parts.push(v.v ? "T" : "F");
    else if (v.kind === "num") parts.push(`n${v.v}`);
    else if (v.kind === "str") parts.push(`s${v.v}`);
    else if (v.kind === "nullish") parts.push("0");
    else return null;
  }
  return parts.join("|");
}

function callFn(
  prog: Program,
  fn: FnDef,
  closureEnv: Env,
  args: readonly Val[],
  interactive: boolean,
  depth: number,
  nextCb?: () => Flow,
): Flow {
  const key =
    !nextCb && closureEnv.size === 0
      ? memoKey(prog, fn, args, interactive)
      : null;
  if (key !== null) {
    const hit = prog.getMemo(key);
    if (hit) return hit;
  }
  const localEnv: Env = new Map(closureEnv);
  for (let i = 0; i < fn.params.length; i++) {
    const p = fn.params[i];
    if (!p?.name) continue;
    let v = args[i];
    if (v === undefined && p.init) {
      const r = evalExpr(
        prog,
        fn.file,
        fn.scope,
        localEnv,
        p.init,
        interactive,
        depth,
      );
      if (r.mustThrow) {
        const res = {
          fallthrough: false,
          canSucceed: false,
          ret: null,
          env: localEnv,
        };
        if (key !== null) prog.setMemo(key, res);
        return res;
      }
      v = r.val;
    }
    localEnv.set(p.name, v ?? UNKNOWN);
  }
  let res: Flow;
  if (ts.isBlock(fn.body)) {
    const childScope: Scope = {
      parent: fn.scope,
      fns: new Map(),
      consts: new Map(),
    };
    collectScopeDecls(fn.body.statements, fn.file, childScope, false);
    res = execBlock(
      prog,
      fn.file,
      childScope,
      localEnv,
      fn.body.statements,
      interactive,
      depth,
      nextCb,
    );
  } else {
    const r = evalExpr(
      prog,
      fn.file,
      fn.scope,
      localEnv,
      fn.body,
      interactive,
      depth,
      nextCb,
    );
    res = r.mustThrow
      ? { fallthrough: false, canSucceed: false, ret: null, env: localEnv }
      : {
          fallthrough: false,
          canSucceed: !isDefiniteRefusal(r.val),
          ret: r.val,
          env: localEnv,
        };
  }
  if (key !== null) prog.setMemo(key, res);
  return res;
}

function execBlock(
  prog: Program,
  file: ParsedFile,
  scope: Scope,
  env: Env,
  stmts: readonly ts.Statement[],
  interactive: boolean,
  depth: number,
  nextCb?: () => Flow,
): Flow {
  let curEnv: Env = new Map(env);
  let canSucceed = false;
  let ret: Val | null = null;
  for (const st of stmts) {
    const f = execStmt(
      prog,
      file,
      scope,
      curEnv,
      st,
      interactive,
      depth,
      nextCb,
    );
    canSucceed = canSucceed || f.canSucceed;
    ret = mergeRet(ret, f.ret);
    if (!f.fallthrough) {
      return { fallthrough: false, canSucceed, ret, env: f.env };
    }
    curEnv = f.env;
  }
  return { fallthrough: true, canSucceed, ret, env: curEnv };
}

function execStmt(
  prog: Program,
  file: ParsedFile,
  scope: Scope,
  env: Env,
  stmt: ts.Statement,
  interactive: boolean,
  depth: number,
  nextCb?: () => Flow,
): Flow {
  if (ts.isBlock(stmt)) {
    const child: Scope = { parent: scope, fns: new Map(), consts: new Map() };
    collectScopeDecls(stmt.statements, file, child, false);
    return execBlock(
      prog,
      file,
      child,
      env,
      stmt.statements,
      interactive,
      depth,
      nextCb,
    );
  }

  if (ts.isEmptyStatement(stmt) || ts.isFunctionDeclaration(stmt)) {
    return { fallthrough: true, canSucceed: false, ret: null, env };
  }

  if (ts.isThrowStatement(stmt)) {
    return { fallthrough: false, canSucceed: false, ret: null, env };
  }

  if (ts.isReturnStatement(stmt)) {
    if (!stmt.expression) {
      return { fallthrough: false, canSucceed: true, ret: NULLISH_VAL, env };
    }
    const r = evalExpr(
      prog,
      file,
      scope,
      env,
      stmt.expression,
      interactive,
      depth,
      nextCb,
    );
    if (r.mustThrow) {
      return { fallthrough: false, canSucceed: false, ret: null, env };
    }
    return {
      fallthrough: false,
      canSucceed: !isDefiniteRefusal(r.val),
      ret: r.val,
      env,
    };
  }

  if (ts.isVariableStatement(stmt)) {
    const nextEnv: Env = new Map(env);
    for (const d of stmt.declarationList.declarations) {
      if (!d.initializer) continue;
      const r = evalExpr(
        prog,
        file,
        scope,
        nextEnv,
        d.initializer,
        interactive,
        depth,
        nextCb,
      );
      if (r.mustThrow) {
        return {
          fallthrough: false,
          canSucceed: false,
          ret: null,
          env: nextEnv,
        };
      }
      if (ts.isIdentifier(d.name)) {
        nextEnv.set(d.name.text, r.val);
      } else if (ts.isObjectBindingPattern(d.name) && r.val.kind === "obj") {
        for (const el of d.name.elements) {
          if (!ts.isIdentifier(el.name)) continue;
          const prop =
            el.propertyName && ts.isIdentifier(el.propertyName)
              ? el.propertyName.text
              : el.name.text;
          nextEnv.set(el.name.text, r.val.props.get(prop) ?? UNKNOWN);
        }
      }
    }
    return { fallthrough: true, canSucceed: false, ret: null, env: nextEnv };
  }

  if (ts.isExpressionStatement(stmt)) {
    const nextEnv: Env = new Map(env);
    const r = evalExpr(
      prog,
      file,
      scope,
      nextEnv,
      stmt.expression,
      interactive,
      depth,
      nextCb,
    );
    if (r.mustThrow) {
      return { fallthrough: false, canSucceed: false, ret: null, env: nextEnv };
    }
    return { fallthrough: true, canSucceed: false, ret: null, env: nextEnv };
  }

  if (ts.isIfStatement(stmt)) {
    const nextEnv: Env = new Map(env);
    const cond = evalExpr(
      prog,
      file,
      scope,
      nextEnv,
      stmt.expression,
      interactive,
      depth,
      nextCb,
    );
    if (cond.mustThrow) {
      return { fallthrough: false, canSucceed: false, ret: null, env: nextEnv };
    }
    const ct = truthiness(cond.val);
    if (ct === "true") {
      return execStmt(
        prog,
        file,
        scope,
        nextEnv,
        stmt.thenStatement,
        interactive,
        depth,
        nextCb,
      );
    }
    if (ct === "false") {
      return stmt.elseStatement
        ? execStmt(
            prog,
            file,
            scope,
            nextEnv,
            stmt.elseStatement,
            interactive,
            depth,
            nextCb,
          )
        : { fallthrough: true, canSucceed: false, ret: null, env: nextEnv };
    }
    const a = execStmt(
      prog,
      file,
      scope,
      new Map(nextEnv),
      stmt.thenStatement,
      interactive,
      depth,
      nextCb,
    );
    const b: Flow = stmt.elseStatement
      ? execStmt(
          prog,
          file,
          scope,
          new Map(nextEnv),
          stmt.elseStatement,
          interactive,
          depth,
          nextCb,
        )
      : {
          fallthrough: true,
          canSucceed: false,
          ret: null,
          env: new Map(nextEnv),
        };
    const mergedEnv =
      a.fallthrough && b.fallthrough
        ? joinEnv(a.env, b.env)
        : a.fallthrough
          ? a.env
          : b.env;
    return {
      fallthrough: a.fallthrough || b.fallthrough,
      canSucceed: a.canSucceed || b.canSucceed,
      ret: mergeRet(a.ret, b.ret),
      env: mergedEnv,
    };
  }

  if (ts.isTryStatement(stmt)) {
    const t = execStmt(
      prog,
      file,
      scope,
      new Map(env),
      stmt.tryBlock,
      interactive,
      depth,
      nextCb,
    );
    let combined = t;
    if (stmt.catchClause) {
      const c = execStmt(
        prog,
        file,
        scope,
        new Map(env),
        stmt.catchClause.block,
        interactive,
        depth,
        nextCb,
      );
      if (!t.fallthrough && !t.canSucceed && t.ret === null) {
        // try block definitely threw -> catch runs.
        combined = c;
      } else {
        combined = {
          fallthrough: t.fallthrough || c.fallthrough,
          canSucceed: t.canSucceed || c.canSucceed,
          ret: mergeRet(t.ret, c.ret),
          env:
            t.fallthrough && c.fallthrough
              ? joinEnv(t.env, c.env)
              : t.fallthrough
                ? t.env
                : c.env,
        };
      }
    }
    if (stmt.finallyBlock) {
      const fin = execStmt(
        prog,
        file,
        scope,
        new Map(combined.env),
        stmt.finallyBlock,
        interactive,
        depth,
        nextCb,
      );
      if (!fin.fallthrough) return fin;
      return {
        fallthrough: combined.fallthrough,
        canSucceed: combined.canSucceed || fin.canSucceed,
        ret: mergeRet(combined.ret, fin.ret),
        env: fin.env,
      };
    }
    return combined;
  }

  if (ts.isSwitchStatement(stmt)) {
    const disc = evalExpr(
      prog,
      file,
      scope,
      new Map(env),
      stmt.expression,
      interactive,
      depth,
      nextCb,
    );
    if (disc.mustThrow)
      return { fallthrough: false, canSucceed: false, ret: null, env };
    let fallthrough = false;
    let canSucceed = false;
    let ret: Val | null = null;
    let hasDefault = false;
    for (const cl of stmt.caseBlock.clauses) {
      if (ts.isDefaultClause(cl)) hasDefault = true;
      const f = execBlock(
        prog,
        file,
        scope,
        new Map(env),
        cl.statements,
        interactive,
        depth,
        nextCb,
      );
      fallthrough = fallthrough || f.fallthrough;
      canSucceed = canSucceed || f.canSucceed;
      ret = mergeRet(ret, f.ret);
    }
    return {
      fallthrough: fallthrough || !hasDefault,
      canSucceed,
      ret,
      env,
    };
  }

  if (
    ts.isForStatement(stmt) ||
    ts.isForOfStatement(stmt) ||
    ts.isForInStatement(stmt) ||
    ts.isWhileStatement(stmt) ||
    ts.isDoStatement(stmt)
  ) {
    const bodyFlow = execStmt(
      prog,
      file,
      scope,
      new Map(env),
      stmt.statement,
      interactive,
      depth,
      nextCb,
    );
    return {
      fallthrough: true,
      canSucceed: bodyFlow.canSucceed,
      ret: bodyFlow.ret,
      env,
    };
  }

  return { fallthrough: true, canSucceed: false, ret: null, env };
}

function evalHandlerChain(
  prog: Program,
  file: ParsedFile,
  scope: Scope,
  handlers: readonly ts.Expression[],
  interactive: boolean,
): Flow {
  if (handlers.length === 0)
    return { fallthrough: true, canSucceed: false, ret: null, env: new Map() };
  const [first, ...rest] = handlers;
  if (!first)
    return { fallthrough: true, canSucceed: false, ret: null, env: new Map() };
  const resolved = evalExpr(
    prog,
    file,
    scope,
    new Map(),
    first,
    interactive,
    0,
  );
  if (resolved.mustThrow)
    return { fallthrough: false, canSucceed: false, ret: null, env: new Map() };
  if (resolved.val.kind !== "fn") {
    return rest.length > 0
      ? evalHandlerChain(prog, file, scope, rest, interactive)
      : { fallthrough: false, canSucceed: true, ret: UNKNOWN, env: new Map() };
  }
  const runNext = () => evalHandlerChain(prog, file, scope, rest, interactive);
  const flow = callFn(
    prog,
    resolved.val.fn,
    resolved.val.env,
    [UNKNOWN, UNKNOWN],
    interactive,
    0,
    rest.length > 0 ? runNext : undefined,
  );
  if (rest.length > 0 && flow.fallthrough) {
    const tail = runNext();
    return {
      fallthrough: tail.fallthrough,
      canSucceed: flow.canSucceed || tail.canSucceed,
      ret: mergeRet(flow.ret, tail.ret),
      env: tail.env,
    };
  }
  return flow;
}

function handlerRequiresInteractive(
  prog: Program,
  file: ParsedFile,
  scope: Scope,
  handlers: readonly ts.Expression[],
): boolean {
  const browser = evalHandlerChain(prog, file, scope, handlers, true);
  const browserOk = browser.canSucceed || browser.fallthrough;
  if (!browserOk) return false;
  const nonBrowser = evalHandlerChain(prog, file, scope, handlers, false);
  const nonBrowserOk = nonBrowser.canSucceed || nonBrowser.fallthrough;
  return !nonBrowserOk;
}

// ------------------------------------------------------- route walker

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "all",
  "on",
]);

function stringArrayLiteral(expr: ts.Expression): string[] | null {
  const e = unwrapExpr(expr);
  if (!ts.isArrayLiteralExpression(e)) return null;
  const out: string[] = [];
  for (const el of e.elements) {
    const u = unwrapExpr(el);
    if (!ts.isStringLiteral(u)) return null;
    out.push(u.text.toUpperCase());
  }
  return out;
}

/**
 * Every route whose handler requires an interactive browser session
 * (`interactiveSession(c) === true` can succeed while `false` always throws or
 * returns 401/403/404), as `"METHOD /path"`. With `all`, every route the scan
 * sees (to prove it misses none).
 */
export function interactiveRoutes(
  files: readonly SourceFile[],
  { all = false } = {},
): string[] {
  const prog = new Program(files, all);
  const found: string[] = [];

  for (const file of prog.files) {
    if (!all && !prog.interactiveFiles.has(file)) continue;
    const walk = (
      node: ts.Node,
      scope: Scope,
      loopVars: ReadonlyMap<string, string[]>,
    ) => {
      if (ts.isBlock(node)) {
        const child: Scope = {
          parent: scope,
          fns: new Map(),
          consts: new Map(),
        };
        collectScopeDecls(node.statements, file, child, false);
        for (const st of node.statements) walk(st, child, loopVars);
        return;
      }

      if (ts.isForOfStatement(node)) {
        let nextLoopVars = loopVars;
        if (ts.isVariableDeclarationList(node.initializer)) {
          const d = node.initializer.declarations[0];
          const methods = stringArrayLiteral(node.expression);
          if (d && ts.isIdentifier(d.name) && methods) {
            const m = new Map(loopVars);
            m.set(d.name.text, methods);
            nextLoopVars = m;
          }
        }
        walk(node.statement, scope, nextLoopVars);
        return;
      }

      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        let methods: string[] | null = null;
        let rest: readonly ts.Expression[] = node.arguments;

        if (
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          /^\w*[aA]pp$/.test(callee.expression.text) &&
          HTTP_METHODS.has(callee.name.text)
        ) {
          if (callee.name.text === "on") {
            const first = node.arguments[0];
            if (first) {
              const arr = stringArrayLiteral(first);
              const u = unwrapExpr(first);
              methods = arr
                ? arr
                : ts.isStringLiteral(u)
                  ? [u.text.toUpperCase()]
                  : null;
              rest = node.arguments.slice(1);
            }
          } else {
            methods = [callee.name.text.toUpperCase()];
          }
        } else if (
          ts.isElementAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          /^\w*[aA]pp$/.test(callee.expression.text) &&
          ts.isIdentifier(callee.argumentExpression)
        ) {
          const varName = callee.argumentExpression.text;
          methods = loopVars.get(varName) ?? [`?${varName}`];
        }

        if (methods && rest.length >= 1) {
          const [pathExpr, ...handlers] = rest;
          if (
            pathExpr &&
            (all || handlerRequiresInteractive(prog, file, scope, handlers))
          ) {
            const path =
              resolvePathExpr(prog, file, scope, pathExpr) ??
              `?${pathExpr.getText(file.sf).trim()}`;
            for (const meth of methods) found.push(`${meth} ${path}`);
          }
          return;
        }
      }

      ts.forEachChild(node, (child) => walk(child, scope, loopVars));
    };

    for (const st of file.sf.statements) walk(st, file.rootScope, new Map());
  }

  return [...new Set(found)].sort();
}
