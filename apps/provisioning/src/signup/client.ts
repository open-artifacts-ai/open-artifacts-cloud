// The sign-up page's script (served as /app.js; CSP script-src 'self' plus
// Turnstile). Plain browser JS, no framework and nothing from the admin SPA.
// It only ever writes text through textContent: no innerHTML, so no value
// from the API or the URL can become markup. Keep backticks and dollar-brace
// out of this string (it is a template literal).
export const CLIENT_JS = String.raw`(function () {
  "use strict";
  var root = document.getElementById("app");
  var S = {
    cfg: null, me: null, signup: null, view: "loading",
    slug: "", avail: null, availSlug: "", seq: 0,
    token: null, busy: false, err: "", notice: "", widget: null, poll: null
  };
  var SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

  function h(tag, props, kids) {
    var el = document.createElement(tag);
    var k;
    for (k in props || {}) {
      var v = props[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return el;
  }

  function api(method, path, body) {
    var headers = { accept: "application/json" };
    if (body) headers["content-type"] = "application/json";
    if (method !== "GET" && S.me && S.me.csrf) headers["x-csrf-token"] = S.me.csrf;
    return fetch(path, {
      method: method, headers: headers, credentials: "same-origin",
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
        return { status: r.status, body: j, code: j && j.error && j.error.code, message: j && j.error && j.error.message };
      });
    });
  }

  function nw(t) { return h("span", { class: "nw" }, [t]); }
  function host(slug) { return slug + "." + S.cfg.appDomain; }
  function rid() {
    var a = new Uint8Array(18);
    crypto.getRandomValues(a);
    return "su-" + Array.prototype.map.call(a, function (b) {
      return ("0" + b.toString(16)).slice(-2);
    }).join("");
  }

  function shell(panel) {
    var links = h("span", { class: "links" }, [
      h("a", { href: S.cfg.docsUrl, rel: "noopener" }, ["Docs"]), " · ",
      h("a", { href: S.cfg.githubUrl, rel: "noopener" }, ["GitHub"])
    ]);
    root.replaceChildren(
      h("header", { class: "top" }, [
        h("span", { class: "logo", "aria-hidden": "true" }, [h("i")]),
        "Open Artifacts", links
      ]),
      h("main", {}, [panel])
    );
  }

  var NOTICES = {
    expired: "Sign-in expired. Try again.",
    denied: "Google sign-in did not finish. Try again.",
    rate_limited: "Too many attempts. Wait a few minutes and try again."
  };

  // ---------- sign-ups closed (design: sign-ups closed, option B) ----------
  function viewClosed() {
    var inp = h("input", {
      type: "text", id: "go", autocomplete: "off", autocapitalize: "none",
      spellcheck: "false", placeholder: "acme", "aria-describedby": "go-help"
    });
    var help = h("p", { class: "help tight", id: "go-help", "aria-live": "polite" });
    function go() {
      var v = inp.value.trim().toLowerCase();
      if (!SLUG_RE.test(v)) {
        help.className = "help tight err";
        help.textContent = "Use letters, numbers and hyphens.";
        return;
      }
      window.location.assign("https://" + host(v) + "/");
    }
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
    shell(h("div", { class: "panel" }, [
      h("h1", {}, ["Sign-ups are closed for now"]),
      h("p", {}, ["We're not opening new instances yet. You can run Open Artifacts yourself today, free and open source."]),
      h("a", { class: "btn pri", href: S.cfg.githubUrl, rel: "noopener" }, ["Run it yourself"]),
      h("div", { class: "or" }, ["or"]),
      h("div", { class: "field" }, [
        h("label", { for: "go" }, ["Already have an instance?"]),
        h("div", { class: "inp" }, [inp, h("span", { class: "suf" }, ["." + S.cfg.appDomain])]),
        help
      ]),
      h("button", { class: "btn", type: "button", onclick: go }, ["Go to it"]),
      h("p", { class: "muted small mt" }, ["It runs on your own Cloudflare account."])
    ]));
  }

  // ---------- sign-up form (design: sign-up, option A) ----------
  var refs = {};
  function viewForm() {
    var signedIn = !!S.me;
    var inp = h("input", {
      type: "text", id: "slug", autocomplete: "off", autocapitalize: "none",
      spellcheck: "false", placeholder: "acme", maxlength: "32",
      "aria-describedby": "slug-help", disabled: !signedIn, value: S.slug
    });
    inp.addEventListener("input", function () {
      S.slug = inp.value.trim().toLowerCase();
      S.err = "";
      checkSlug();
    });
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") create(); });
    refs.inp = inp;
    refs.box = h("div", { class: "inp" + (signedIn ? "" : " off") }, [inp, h("span", { class: "suf" }, ["." + S.cfg.appDomain])]);
    refs.help = h("p", { class: "help", id: "slug-help", "aria-live": "polite" });
    refs.sugg = h("div", { class: "sugg" });
    refs.err = h("div", { "aria-live": "polite" });
    refs.btn = h("button", { class: "btn pri cta", type: "button", onclick: create }, ["Create"]);
    refs.ts = h("div", { class: "ts" });

    var who = signedIn
      ? h("div", { class: "who" }, [
          h("span", {}, ["Signed in as ", h("b", {}, [S.me.email])]),
          h("button", { class: "btn link", type: "button", onclick: signOut }, ["Not you? Sign out"])
        ])
      : h("a", { class: "btn gsign", href: "/auth/start" }, [googleMark(), "Continue with Google"]);

    shell(h("div", { class: "panel" }, [
      h("h1", {}, ["Create your Open Artifacts"]),
      S.notice ? h("div", { class: "note warn", role: "alert" }, [S.notice]) : null,
      who,
      h("div", { class: "field" }, [h("label", { for: "slug" }, ["Your address"]), refs.box, refs.help, refs.sugg]),
      refs.err, refs.ts, refs.btn,
      h("p", { class: "muted small mt" }, [
        "Solo: free for your first month, then $1/month or $10/year. No card needed."
      ])
    ]));
    paintAvail();
    paintCreate();
    mountTurnstile();
    if (signedIn) inp.focus();
  }

  function googleMark() {
    var ns = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(ns, "svg");
    s.setAttribute("width", "16"); s.setAttribute("height", "16");
    s.setAttribute("viewBox", "0 0 48 48"); s.setAttribute("aria-hidden", "true");
    [
      ["#EA4335", "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"],
      ["#4285F4", "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"],
      ["#FBBC05", "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"],
      ["#34A853", "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"]
    ].forEach(function (d) {
      var p = document.createElementNS(ns, "path");
      p.setAttribute("fill", d[0]); p.setAttribute("d", d[1]);
      s.appendChild(p);
    });
    return s;
  }

  var AVAIL_MSG = {
    invalid: "Use 1 to 32 letters, numbers and hyphens, not starting or ending with a hyphen.",
    reserved: "That address is reserved. Pick another."
  };

  function paintAvail() {
    if (!refs.help) return;
    var s = S.slug, a = S.avail;
    var cls = "help", text = "", box = "inp" + (S.me ? "" : " off");
    refs.sugg.replaceChildren();
    if (!S.me) text = "Sign in with Google first.";
    else if (!s) text = "Pick the address your team will use.";
    else if (a === null || S.availSlug !== s) text = "Checking...";
    else if (a === "ok") { cls += " ok"; box += " ok"; text = host(s) + " is available."; }
    else if (a === "taken") {
      cls += " err"; box += " err";
      var base = s.slice(0, 26);
      var opts = [base + "-team", base + "-labs"];
      text = host(s) + " is taken.";
      opts.forEach(function (o) {
        refs.sugg.appendChild(h("button", { type: "button", onclick: function () {
          S.slug = o; refs.inp.value = o; checkSlug(); refs.inp.focus();
        } }, [o]));
      });
    } else if (a === "rate_limited") { cls += " err"; text = "Too many checks. Wait a moment."; }
    else if (a === "error") { cls += " err"; text = "Couldn't check that address. Try again."; }
    else { cls += " err"; box += " err"; text = AVAIL_MSG[a] || AVAIL_MSG.invalid; }
    refs.help.className = cls;
    refs.help.textContent = text;
    refs.box.className = box;
    paintCreate();
  }

  var timer = null;
  function checkSlug() {
    var s = S.slug;
    S.avail = null;
    clearTimeout(timer);
    if (!s) { paintAvail(); return; }
    if (!SLUG_RE.test(s) || s.slice(2, 4) === "--") {
      S.avail = "invalid"; S.availSlug = s; paintAvail(); return;
    }
    paintAvail();
    var n = ++S.seq;
    timer = setTimeout(function () {
      api("GET", "/api/v1/slugs/" + encodeURIComponent(s)).then(function (r) {
        if (n !== S.seq) return;
        S.availSlug = s;
        if (r.status === 200 && r.body) S.avail = r.body.status;
        else if (r.code === "rate_limited") S.avail = "rate_limited";
        else if (r.status === 401) { S.me = null; S.notice = NOTICES.expired; route(); return; }
        else S.avail = "error";
        paintAvail();
      }, function () {
        if (n !== S.seq) return;
        S.availSlug = s; S.avail = "error"; paintAvail();
      });
    }, 300);
  }

  function canCreate() {
    return !!S.me && S.avail === "ok" && S.availSlug === S.slug && !S.busy &&
      (!S.cfg.turnstileSiteKey || !!S.token) && !!S.cfg.turnstileSiteKey;
  }
  function paintCreate() {
    if (!refs.btn) return;
    refs.btn.disabled = !canCreate();
    refs.btn.textContent = S.busy ? "Creating..." : "Create";
    refs.err.replaceChildren();
    var msg = S.err;
    if (S.me && !S.cfg.turnstileSiteKey) msg = "Sign-ups are temporarily unavailable. Try again later.";
    if (msg) {
      refs.err.appendChild(h("div", { class: "note bad", role: "alert" }, typeof msg === "string" ? [msg] : msg));
    }
  }

  function mountTurnstile() {
    S.widget = null;
    if (!S.me || !S.cfg.turnstileSiteKey || !refs.ts) return;
    function render() {
      if (!window.turnstile || !document.body.contains(refs.ts)) return;
      S.widget = window.turnstile.render(refs.ts, {
        sitekey: S.cfg.turnstileSiteKey, action: "signup",
        callback: function (t) { S.token = t; paintCreate(); },
        "expired-callback": function () { S.token = null; paintCreate(); },
        "error-callback": function () { S.token = null; paintCreate(); }
      });
    }
    if (window.turnstile) { render(); return; }
    if (document.getElementById("ts-api")) { window.__oaTs = render; return; }
    window.__oaTs = render;
    var sc = document.createElement("script");
    sc.id = "ts-api"; sc.async = true;
    sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__oaTsLoaded";
    document.head.appendChild(sc);
  }
  window.__oaTsLoaded = function () { if (window.__oaTs) window.__oaTs(); };

  var CREATE_ERR = {
    turnstile_failed: "The verification did not pass. Try again.",
    rate_limited: "Too many attempts. Wait a minute and try again.",
    slug_invalid: AVAIL_MSG.invalid,
    slug_reserved: AVAIL_MSG.reserved
  };

  var HELP_EMAIL = "hello@open-artifacts.com";
  var LIMIT_ERR = [
    "You already have an Open Artifacts instance with this Google account. Need help? Email ",
    h("a", { href: "mailto:" + HELP_EMAIL }, [HELP_EMAIL]), "."
  ];

  function create() {
    if (!canCreate()) return;
    S.busy = true; S.err = ""; paintCreate();
    var slug = S.slug;
    api("POST", "/api/v1/installs", { requestId: rid(), slug: slug, turnstile: S.token }).then(function (r) {
      S.busy = false;
      if (r.status === 202 || r.status === 200 || r.status === 201) {
        S.signup = { stage: "queued", slug: slug, host: host(slug) };
        S.view = "setup"; startPoll(); render();
        return;
      }
      resetTurnstile();
      if (r.code === "signups_closed") { S.view = "closed"; render(); return; }
      if (r.code === "signup_limit") {
        loadSignup().then(function () {
          route();
          if (S.view === "form") { S.err = LIMIT_ERR; paintCreate(); }
        });
        return;
      }
      if (r.code === "slug_taken") { S.avail = "taken"; S.availSlug = slug; S.err = ""; paintAvail(); return; }
      if (r.status === 401) { S.me = null; S.notice = NOTICES.expired; route(); return; }
      S.err = CREATE_ERR[r.code] || (r.code === "forbidden" && r.message && r.message !== "forbidden" ? r.message : null) || "We couldn't create your instance. Try again in a few minutes.";
      paintCreate();
    }, function () {
      S.busy = false; resetTurnstile();
      S.err = "We couldn't reach Open Artifacts. Check your connection and try again.";
      paintCreate();
    });
  }

  function resetTurnstile() {
    S.token = null;
    try { if (window.turnstile && S.widget !== null) window.turnstile.reset(S.widget); } catch (e) {}
  }

  function signOut() {
    return api("POST", "/auth/logout").then(function () {
      S.me = null; S.slug = ""; S.avail = null; S.token = null; S.err = ""; route();
    });
  }
  function startOver() {
    S.signup = null; S.slug = ""; S.avail = null; S.err = ""; S.token = null;
    route();
  }

  // ---------- provisioning (design: provisioning screen) ----------
  function step(state, title, sub) {
    var mark = state === "done" ? "✓" : state === "fail" ? "!" : "";
    var label = { done: "Done", now: "In progress", wait: "Waiting", fail: "Failed", todo: "Not started" }[state];
    return h("li", {}, [
      h("span", { class: "dot " + (state === "todo" ? "" : state), "aria-hidden": "true" }, [mark]),
      h("span", {}, [
        h("span", { class: "sr" }, [label + ": "]),
        h("span", state === "todo" ? { class: "muted" } : {}, [title]),
        sub ? h("br") : null,
        sub ? h("span", { class: "muted" }, [sub]) : null
      ])
    ]);
  }

  function viewSetup() {
    var g = S.signup, hostName = g.host, st = g.stage;
    var steps, label, head, body = [];
    var reserve = step("done", "Reserve your address");
    var create = "Create your instance", email = "Send your welcome email";
    var pending = [
      h("h1", {}, ["Setting up ", nw(hostName)]),
      h("p", { class: "muted lead" }, ["We'll email you when it's ready. You can close this page."])
    ];
    head = pending;
    if (st === "ready") {
      label = "Ready";
      head = [h("h1", {}, [nw(hostName), " is ready"])];
      steps = [reserve, step("done", create), step("done", email)];
      body = [h("a", { class: "btn pri", href: "https://" + hostName + "/" }, ["Open your instance"])];
    } else if (st === "failed") {
      label = "Failed";
      head = [h("h1", {}, ["We couldn't set up ", nw(hostName)])];
      steps = [reserve, step("fail", create, "This didn't finish."), step("todo", email)];
      body = [
        h("div", { class: "note bad" }, [
          "We've been alerted and will look into it. Your address isn't reserved anymore. If you have questions, email support."
        ]),
        h("div", { class: "stack" }, [
          h("a", { class: "btn", href: "mailto:" + S.cfg.supportEmail }, ["Email support"]),
          h("button", { class: "btn", type: "button", onclick: startOver }, ["Start over"])
        ])
      ];
    } else if (st === "waiting_cap") {
      label = "Waiting for capacity";
      steps = [reserve, step("wait", create, "Waiting for capacity. We're adding room, no need to do anything."), step("todo", email)];
    } else if (st === "creating") {
      label = "Creating";
      steps = [reserve, step("now", create, "This is the longest step."), step("todo", email)];
    } else {
      label = "Queued";
      steps = [reserve, step("now", create, "Waiting for a free slot."), step("todo", email)];
    }
    shell(h("div", { class: "panel", "aria-live": "polite" }, head.concat([
      h("div", { class: "state" }, [h("div", { class: "lab" }, [label]), h("ul", { class: "steps" }, steps)])
    ], body)));
  }

  function loadSignup() {
    return api("GET", "/api/v1/signup").then(function (r) {
      if (r.status === 200 && r.body && r.body.stage !== "none") {
        S.signup = { stage: r.body.stage, slug: r.body.slug, host: r.body.host };
      } else { S.signup = null; }
    }, function () {});
  }
  function startPoll() {
    clearInterval(S.poll);
    S.poll = setInterval(function () {
      if (document.hidden) return;
      var before = S.signup && S.signup.stage;
      loadSignup().then(function () {
        if (S.view !== "setup" || !S.signup) return;
        if (S.signup.stage !== before) render();
        if (S.signup.stage === "ready" || S.signup.stage === "failed") clearInterval(S.poll);
      });
    }, 5000);
  }

  // ---------- routing ----------
  function render() {
    if (S.view === "closed") viewClosed();
    else if (S.view === "setup") viewSetup();
    else if (S.view === "form") viewForm();
  }
  function route() {
    clearInterval(S.poll);
    refs = {};
    if (S.me && S.signup) {
      S.view = "setup";
      if (S.signup.stage !== "ready" && S.signup.stage !== "failed") startPoll();
    } else if (!S.cfg.open) S.view = "closed";
    else S.view = "form";
    render();
  }

  function boot() {
    var q = new URLSearchParams(window.location.search);
    var e = q.get("error");
    if (e && NOTICES[e]) S.notice = NOTICES[e];
    if (e) window.history.replaceState(null, "", "/");
    fetch("/api/v1/config", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (cfg) {
      S.cfg = cfg;
      return api("GET", "/api/v1/me");
    }).then(function (r) {
      if (r.status === 200 && r.body && r.body.principal === "user") S.me = { email: r.body.email, csrf: r.body.csrf };
      return S.me ? loadSignup() : null;
    }).then(route, function () {
      root.replaceChildren(h("main", {}, [h("div", { class: "panel" }, [
        h("h1", {}, ["Open Artifacts"]),
        h("p", {}, ["We couldn't load this page. Reload to try again."])
      ])]));
    });
  }
  boot();
})();
`;
