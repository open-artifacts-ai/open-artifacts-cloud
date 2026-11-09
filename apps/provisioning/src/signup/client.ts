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
        return { status: r.status, body: j, code: j && j.error && j.error.code };
      });
    });
  }

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

  // ---------- sign-ups closed (design: sign-ups closed, option A) ----------
  function viewClosed() {
    var inp = h("input", {
      type: "text", id: "go", autocomplete: "off", autocapitalize: "none",
      spellcheck: "false", placeholder: "acme", "aria-describedby": "go-help"
    });
    var help = h("p", { class: "help", id: "go-help", "aria-live": "polite" });
    function go() {
      var v = inp.value.trim().toLowerCase();
      if (!SLUG_RE.test(v)) {
        help.className = "help err";
        help.textContent = "Use letters, numbers and hyphens.";
        return;
      }
      window.location.assign("https://" + host(v) + "/");
    }
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
    shell(h("div", { class: "panel" }, [
      h("h1", {}, ["New sign-ups are closed right now"]),
      h("p", {}, ["You can't create a new instance at the moment. Nothing has changed for instances that already exist."]),
      h("div", { class: "field" }, [
        h("label", { for: "go" }, ["Already have one? Go to your instance"]),
        h("div", { class: "inp" }, [inp, h("span", { class: "suf" }, ["." + S.cfg.appDomain])]),
        help
      ]),
      h("button", { class: "btn pri", type: "button", onclick: go }, ["Go to my instance"]),
      h("div", { class: "or" }, ["or"]),
      h("a", { class: "btn", href: S.cfg.githubUrl, rel: "noopener" }, ["Run Open Artifacts yourself"]),
      h("p", { class: "muted small", style: "margin:10px 0 0" }, ["Open source; it runs on your own Cloudflare account."])
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
      h("p", { class: "muted small", style: "margin:10px 0 0" }, [
        "Solo: free for your first 30 days, then $1/month or $12/year. No card needed."
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
    s.setAttribute("viewBox", "0 0 16 16"); s.setAttribute("aria-hidden", "true");
    var c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", "8"); c.setAttribute("cy", "8"); c.setAttribute("r", "7");
    c.setAttribute("fill", "none"); c.setAttribute("stroke", "currentColor"); c.setAttribute("stroke-width", "2");
    s.appendChild(c);
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
      text = host(s) + " is taken. Try " + opts[0] + " or " + opts[1] + ".";
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
    if (msg) refs.err.appendChild(h("div", { class: "note bad", role: "alert" }, [msg]));
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
    forbidden: "Open Artifacts needs a Google Workspace account to sign up. Sign in with your work account.",
    turnstile_failed: "The verification did not pass. Try again.",
    rate_limited: "Too many attempts. Wait a minute and try again.",
    slug_invalid: AVAIL_MSG.invalid,
    slug_reserved: AVAIL_MSG.reserved
  };

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
      if (r.code === "signup_limit") { loadSignup().then(route); return; }
      if (r.code === "slug_taken") { S.avail = "taken"; S.availSlug = slug; S.err = ""; paintAvail(); return; }
      if (r.status === 401) { S.me = null; S.notice = NOTICES.expired; route(); return; }
      S.err = CREATE_ERR[r.code] || "We couldn't create your instance. Try again in a few minutes.";
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
    api("POST", "/auth/logout").then(function () {
      S.me = null; S.slug = ""; S.avail = null; S.token = null; route();
    });
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
    var steps, label, body = [];
    var reserve = step("done", "Reserve your address");
    if (st === "ready") {
      label = "Ready";
      steps = [reserve, step("done", "Create your instance"), step("done", "Welcome email sent")];
      body = [
        h("h1", {}, [hostName + " is ready"]),
        h("a", { class: "btn pri", href: "https://" + hostName + "/" }, ["Open your instance"])
      ];
    } else if (st === "failed") {
      label = "Failed";
      steps = [reserve, step("fail", "Create your instance", "This didn't finish.")];
      body = [
        h("div", { class: "note bad" }, [
          h("strong", {}, ["We couldn't set up your instance"]),
          "We've been alerted and will look into it. Your address isn't reserved anymore. If you have questions, email support."
        ]),
        h("a", { class: "btn", href: "mailto:" + S.cfg.supportEmail }, ["Email support"])
      ];
    } else if (st === "waiting_cap") {
      label = "Waiting for capacity";
      steps = [reserve, step("wait", "Waiting for capacity", "We're adding room. No need to do anything."),
        step("todo", "Create your instance"), step("todo", "Send your welcome email")];
    } else if (st === "creating") {
      label = "Creating";
      steps = [reserve, step("now", "Creating your instance", "This is the longest step."),
        step("todo", "Send your welcome email")];
    } else {
      label = "Queued";
      steps = [reserve, step("now", "In the queue", "Waiting for a free slot."),
        step("todo", "Create your instance"), step("todo", "Send your welcome email")];
    }
    var head = st === "ready" || st === "failed" ? [] : [
      h("h1", {}, ["Setting up " + hostName]),
      h("p", { class: "muted", style: "margin:4px 0 0" }, ["We'll email you when it's ready. You can close this page."])
    ];
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
