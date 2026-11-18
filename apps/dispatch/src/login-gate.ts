// LoginGate: an install's only way to ask the platform to change its own login
// domains (open-artifacts#2520 slice 3), built like BillingGate and for the
// same reason. oa-<p>-dispatch holds the LOGIN binding (provisioning's
// LoginChangeGate entrypoint, never its internet fetch) and hands each install
// a stub of this class in ctx.props.LOGIN, valid for that one request.
//
// The gate is the identity: it sets x-oa-gate-install to its own install; the
// body names no install. It forwards one fixed route, POST /login-domains, and
// only the content type and the install's Ed25519 assertion headers.
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  boundedText,
  GATE_HEADER,
  GATE_MAX_BODY,
  type GateRefusal,
} from "@oa/broker-core/gate";
import { GATE_INSTALL_HEADER } from "@oa/broker-core/gate-header";

export interface LoginGateProps {
  installId: string;
}

export interface LoginGateEnv {
  LOGIN: Fetcher;
  /**
   * As provisioning's (#2520): "1" marks every install LOGIN_EDITABLE;
   * otherwise only the installs whose slug LOGIN_CHANGE_SLUGS lists. An
   * install without it shows no editable login form, so it never posts to a 404.
   */
  LOGIN_CHANGE?: string;
  LOGIN_CHANGE_SLUGS?: string;
}

/** The platform side has no public origin for this route (binding only). */
export const LOGIN_ORIGIN = "https://login.oa.internal";
export const LOGIN_GATE_PATH = "/login-domains";

const FORWARD = ["content-type", "x-oa-kid", "x-oa-sig"] as const;
const INSTALL_ID = /^i[a-z0-9]{11}$/;

const refuse = (status: number, error: GateRefusal) =>
  Response.json({ error }, { status, headers: { [GATE_HEADER]: "1" } });

/**
 * One request through the gate: 404 for any other method, route or a query
 * string, 415 for a body that isn't JSON, 413 over GATE_MAX_BODY, 400 for a
 * body that can't be read or isn't a JSON object, 500 for missing or
 * malformed props. Every refusal carries `x-oa-gate: 1`.
 */
export async function passLoginGate(
  req: Request,
  props: LoginGateProps | undefined,
  env: LoginGateEnv,
): Promise<Response> {
  if (
    !props ||
    typeof props.installId !== "string" ||
    !INSTALL_ID.test(props.installId)
  )
    return refuse(500, "gate_misconfigured");
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return refuse(404, "not_found");
  }
  if (
    req.method !== "POST" ||
    url.search !== "" ||
    url.pathname !== LOGIN_GATE_PATH
  ) {
    await req.body?.cancel();
    return refuse(404, "not_found");
  }
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type)) {
    await req.body?.cancel();
    return refuse(415, "json_only");
  }
  let text: string | null;
  try {
    text = await boundedText(req, GATE_MAX_BODY);
  } catch {
    return refuse(400, "bad_body");
  }
  if (text === null) return refuse(413, "too_large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, "bad_json");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return refuse(400, "bad_json");

  const headers = new Headers();
  for (const h of FORWARD) {
    const v = req.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  // The platform's only source of the install id: this gate's, never a caller's.
  headers.set(GATE_INSTALL_HEADER, props.installId);
  return env.LOGIN.fetch(
    new Request(`${LOGIN_ORIGIN}${LOGIN_GATE_PATH}`, {
      method: "POST",
      headers,
      body: text,
      redirect: "manual",
    }),
  );
}

export class LoginGate extends WorkerEntrypoint<LoginGateEnv, LoginGateProps> {
  override fetch(req: Request): Promise<Response> {
    return passLoginGate(req, this.ctx.props, this.env);
  }
}

/**
 * The install's login gate for one request, for that install only, whenever
 * the caller has the LOGIN binding (the opt-out list rides it too, #2652).
 * LOGIN_EDITABLE (true) tells the install its owner may change the login
 * domains: the switch is on, or its slug (from its app host, "" when unknown)
 * is listed. Without it the install shows no editable form (#2802).
 */
export function loginProps(
  exports: { LoginGate: (o: { props: LoginGateProps }) => Fetcher },
  installId: string,
  slug: string,
  env: Partial<LoginGateEnv>,
): { LOGIN?: Fetcher; LOGIN_EDITABLE?: true } {
  if (!env.LOGIN) return {};
  const LOGIN = exports.LoginGate({ props: { installId } });
  const listed = (env.LOGIN_CHANGE_SLUGS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const editable =
    env.LOGIN_CHANGE === "1" || (slug !== "" && listed.includes(slug));
  return editable ? { LOGIN, LOGIN_EDITABLE: true } : { LOGIN };
}
