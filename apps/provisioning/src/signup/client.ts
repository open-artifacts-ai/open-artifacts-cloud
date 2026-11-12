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
    gate: null, token: null, busy: false, joining: false, joinErr: "", note: "", step: "address", chips: [], chipsFor: "", err: "", notice: "", widget: null, poll: null
  };
  // How long the ready view waits before it shows "Open your instance" as a
  // fallback, when the automatic hand-off has not left the page.
  var FALLBACK_MS = 3000;
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
        return { status: r.status, body: j, code: j && j.error && j.error.code, message: j && j.error && j.error.message, details: j && j.error && j.error.details };
      });
    });
  }

  var HOSTED_URL = "https://open-artifacts.com/docs/hosted/";
  function nw(t) { return h("span", { class: "nw" }, [t]); }
  function host(slug) { return slug + "." + S.cfg.appDomain; }
  function rid() {
    var a = new Uint8Array(18);
    crypto.getRandomValues(a);
    return "su-" + Array.prototype.map.call(a, function (b) {
      return ("0" + b.toString(16)).slice(-2);
    }).join("");
  }

  // The Open Artifacts mark (open-artifacts packages/ui brand/mark.svg), inline:
  // the frame follows the text colour, the corners and artifact the accent, so
  // one SVG serves light and dark (classes, not style="", for the CSP).
  function brandMark() {
    var ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg"), p;
    s.setAttribute("class", "mark");
    s.setAttribute("viewBox", "0 0 32 32");
    s.setAttribute("aria-hidden", "true");
    [["f", "M22 2H5a3 3 0 0 0-3 3v17l4 4V6h20zM10 30h17a3 3 0 0 0 3-3V10l-4-4v20H6z"],
     ["a", "M22 2h5a3 3 0 0 1 3 3v5zM2 22v5a3 3 0 0 0 3 3h5zM11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z"]
    ].forEach(function (d) {
      p = document.createElementNS(ns, "path");
      p.setAttribute("class", d[0]);
      p.setAttribute("d", d[1]);
      s.appendChild(p);
    });
    return s;
  }

  function shell(panel) {
    var links = h("span", { class: "links" }, [
      h("a", { href: S.cfg.docsUrl, rel: "noopener" }, ["Docs"]), " · ",
      h("a", { href: HOSTED_URL, rel: "noopener" }, ["Hosted"]), " · ",
      h("a", { href: S.cfg.githubUrl, rel: "noopener" }, ["GitHub"])
    ]);
    var foot = links.cloneNode(true); foot.setAttribute("class", "foot");
    var ghost = brandMark(); ghost.setAttribute("class", "mark ghost");
    var big = brandMark(); big.setAttribute("class", "mark lg");
    root.replaceChildren(h("div", { class: "login" }, [
      h("section", { class: "pitch" }, [
        h("header", { class: "top" }, [
          h("div", { class: "brand" }, [brandMark(), "Open Artifacts"]),
          h("div", { class: "pitchtext" }, [
            h("p", { class: "pt" }, ["Where any AI agent publishes for your team."]),
            h("p", { class: "ps" }, ["Pages, docs, code and PDFs, private by default and shared when you choose."])
          ]),
          links
        ]),
        ghost
      ]),
      h("main", { class: "side" }, [h("div", { class: "col" }, [big, panel]), foot])
    ]));
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
      h("a", { class: "btn pri", href: "https://open-artifacts.com/docs/setup/", rel: "noopener" }, ["Run it yourself"]),
      h("p", { class: "muted small mt" }, ["It runs on your own Cloudflare account."]),
      h("div", { class: "or" }, ["or"]),
      h("div", { class: "field tight" }, [
        h("label", { for: "go" }, ["Already have an instance?"]),
        h("div", { class: "inp" }, [inp, h("span", { class: "suf" }, ["." + S.cfg.appDomain])]),
        help
      ]),
      h("button", { class: "btn", type: "button", onclick: go }, ["Go to it"])
    ]));
  }

  // ---------- sign-in, then the address (design: round 2, address option A) ----------
  var refs = {};
  var PRICE_TRIAL = "Solo: free for 30 days, then $10 a year ($0.83 a month) or $1 a month. No card needed.";
  var PRICE_BETA = "Free during the private beta. No card needed.";
  function price() { return S.cfg && S.cfg.billing ? PRICE_TRIAL : PRICE_BETA; }

  function initials(email) {
    var l = String(email).split("@")[0].replace(/[^a-z0-9]+/gi, " ").trim().split(" ");
    var t = (l[0] || "?").charAt(0) + (l.length > 1 ? l[l.length - 1].charAt(0) : (l[0] || "").charAt(1));
    return t.toUpperCase();
  }

  // First screen: only Google. Back from the address step lands here still
  // signed in, with Continue in place of the Google button.
  function viewSignin() {
    var action;
    if (S.me) {
      action = h("div", {}, [
        h("div", { class: "who" }, [
          h("span", {}, ["Logged in as ", h("b", {}, [S.me.email])]),
          h("button", { class: "btn link", type: "button", onclick: signOut }, ["Not you?"])
        ]),
        h("button", { class: "btn pri", type: "button", onclick: function () { S.step = "address"; route(); } }, ["Continue"])
      ]);
    } else {
      action = h("a", { class: "btn pri gsign", href: "/auth/start" }, [googleMark(), "Sign in with Google"]);
    }
    shell(h("div", { class: "panel" }, [
      h("h1", {}, [S.me ? "Continue to Open Artifacts" : "Create your Open Artifacts"]),
      S.notice ? h("div", { class: "note warn", role: "alert" }, [S.notice]) : null,
      action,
      h("p", { class: "muted small mt" }, [price()])
    ]));
  }

  function checkIcon() {
    var ns = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2.6");
    s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true");
    var p = document.createElementNS(ns, "path");
    p.setAttribute("d", "M5 12l5 5 9-10");
    s.appendChild(p);
    return s;
  }

  function whoRow() {
    return h("div", { class: "who" }, [
      h("span", { class: "av", "aria-hidden": "true" }, [initials(S.me.email)]),
      h("span", { class: "wt" }, ["Logged in as ", h("b", {}, [S.me.email])]),
      h("button", { class: "btn link", type: "button", onclick: signOut }, ["Not you?"])
    ]);
  }

  // ---------- private beta (design: waitlist screens, #2096) ----------
  var NOTE_MAX = 280, NOTE_NEAR = 40;
  function viewJoin() {
    var ta = h("textarea", {
      class: "ta", id: "use", rows: "2", maxlength: String(NOTE_MAX), "aria-describedby": "use-count",
      disabled: S.joining
    });
    ta.value = S.note;
    var cnt = h("p", { class: "help count", id: "use-count", "aria-live": "polite" });
    function paintCount() {
      var left = NOTE_MAX - ta.value.length;
      cnt.textContent = left <= NOTE_NEAR ? left + " left" : "";
      cnt.className = "help count" + (left <= 0 ? " near" : "");
    }
    ta.addEventListener("input", function () { S.note = ta.value; paintCount(); });
    paintCount();
    shell(h("div", { class: "panel" }, [
      h("h1", {}, ["Open Artifacts is in private beta"]),
      whoRow(),
      h("p", { class: "lead" }, ["We're letting people in a few at a time. Join the waitlist and we'll email you when it's your turn."]),
      h("div", { class: "field roomy" }, [h("label", { for: "use" }, ["What would you use it for? (optional)"]), ta, cnt]),
      S.joinErr ? h("div", { class: "note bad", role: "alert" }, [S.joinErr]) : null,
      h("button", { class: "btn pri cta", type: "button", disabled: S.joining, "aria-busy": S.joining ? "true" : null, onclick: joinWaitlist },
        S.joining ? [h("span", { class: "spin", "aria-hidden": "true" }), "Joining\u2026"] : ["Join the waitlist"])
    ]));
  }
  function joinWaitlist() {
    if (S.joining) return;
    S.joining = true; S.joinErr = ""; render();
    var note = S.note.trim();
    api("POST", "/api/v1/signup/waitlist", note ? { note: note } : {}).then(function (r) {
      S.joining = false;
      if (r.status === 200 && r.body && r.body.gate === "waitlisted") { S.gate = "waitlisted"; route(); return; }
      if (r.status === 401) { S.me = null; S.notice = NOTICES.expired; route(); return; }
      if (r.code === "invalid_state" && r.details && r.details.reason === "already_allowed") { S.gate = "allowed"; S.step = "address"; route(); return; }
      S.joinErr = "That didn't save. Try again."; render();
    }, function () {
      S.joining = false; S.joinErr = "That didn't save. Try again."; render();
    });
  }
  function viewListed() {
    shell(h("div", { class: "panel" }, [
      h("h1", {}, ["You're on the list"]),
      whoRow(),
      h("p", { class: "lead" }, ["We'll email " + S.me.email + " when you're in. Nothing else to do for now."]),
      h("p", { class: "muted small mt" }, ["Don't want to wait? ", h("a", { href: "https://open-artifacts.com/docs/setup/", rel: "noopener" }, ["Run it yourself, free."])])
    ]));
  }

  function viewAddress() {
    var inp = h("input", {
      type: "text", id: "slug", autocomplete: "off", autocapitalize: "none",
      spellcheck: "false", placeholder: "acme", maxlength: "32",
      "aria-describedby": "slug-help", value: S.slug
    });
    inp.addEventListener("input", function () {
      S.edited = true;
      S.slug = inp.value.trim().toLowerCase();
      S.err = "";
      checkSlug();
    });
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") create(); });
    refs.inp = inp;
    refs.box = h("div", { class: "inp" }, [inp, h("span", { class: "suf" }, ["." + S.cfg.appDomain])]);
    refs.help = h("p", { class: "help", id: "slug-help", "aria-live": "polite" });
    refs.sugg = h("div", { class: "sugg" });
    refs.chips = h("div", { class: "chips" });
    refs.err = h("div", { "aria-live": "polite" });
    refs.btn = h("button", { class: "btn pri cta", type: "button", onclick: create }, ["Create my instance"]);
    refs.ts = h("div", { class: "ts" });

    shell(h("div", { class: "panel" }, [
      h("h1", {}, ["Choose your address"]),
      whoRow(),
      h("p", { class: "lead" }, ["It's where you and your team open your artifacts. You can't change it later."]),
      S.notice ? h("div", { class: "note warn", role: "alert" }, [S.notice]) : null,
      h("div", { class: "field" }, [h("label", { for: "slug" }, ["Address"]), refs.box, refs.help, refs.sugg, refs.chips]),
      refs.err, refs.ts, refs.btn,
      h("button", { class: "btn link back", type: "button", onclick: function () { S.step = "signin"; route(); } }, ["Back"]),
      h("p", { class: "muted small mt" }, [price()])
    ]));
    paintAvail();
    paintChips();
    paintCreate();
    mountTurnstile();
    inp.focus();
    loadChips();
  }

  // Suggestions: the Google Workspace domain (the sign-in's hd, which is the
  // email's domain whenever there is one; Gmail has none) and the email's
  // local part. Each is checked first; only free ones show.
  function slugify(x) {
    return String(x).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 26).replace(/-+$/, "");
  }
  function companyOf(email) {
    var d = String(email).split("@")[1] || "";
    if (/^(gmail|googlemail)\.com$/i.test(d)) return "";
    var p = d.toLowerCase().split(".");
    if (p.length >= 3 && /^(co|com|org|net|ac|gov|edu)$/.test(p[p.length - 2])) return slugify(p[p.length - 3]);
    return p.length >= 2 ? slugify(p[p.length - 2]) : "";
  }
  function candidates(email) {
    var co = companyOf(email), me = slugify(String(email).split("@")[0]);
    var base = co || me;
    var out = [];
    [co, me, base ? slugify(base) + "-team" : ""].forEach(function (c) {
      if (c && out.indexOf(c) < 0 && SLUG_RE.test(c) && c.slice(2, 4) !== "--") out.push(c);
    });
    return out;
  }
  function loadChips() {
    if (S.chipsFor === S.me.email) { prefill(); return; }
    var email = S.me.email;
    Promise.all(candidates(email).map(function (c) {
      return api("GET", "/api/v1/slugs/" + encodeURIComponent(c)).then(function (r) {
        return r.status === 200 && r.body && r.body.status === "ok" ? c : null;
      }, function () { return null; });
    })).then(function (all) {
      if (!S.me || S.me.email !== email) return;
      S.chips = all.filter(Boolean);
      S.chipsFor = email;
      prefill();
    });
  }
  function prefill() {
    if (!refs.inp) return;
    if (!S.edited && !S.slug && S.chips.length) {
      S.slug = S.chips[0]; S.avail = "ok"; S.availSlug = S.slug;
      refs.inp.value = S.slug;
    }
    paintAvail();
    paintChips();
  }
  function paintChips() {
    if (!refs.chips) return;
    refs.chips.replaceChildren();
    (S.chips || []).forEach(function (c) {
      refs.chips.appendChild(h("button", {
        type: "button", class: "chip" + (c === S.slug ? " sel" : ""), "aria-pressed": c === S.slug ? "true" : "false",
        onclick: function () { S.slug = c; refs.inp.value = c; checkSlug(); refs.inp.focus(); }
      }, [c]));
    });
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
    var cls = "help", text = "", box = "inp", good = false;
    refs.sugg.replaceChildren();
    if (!s) text = "Pick the address your team will use.";
    else if (a === null || S.availSlug !== s) text = "Checking...";
    else if (a === "ok") { cls += " ok"; box += " ok"; good = true; text = host(s) + " is available"; }
    else if (a === "taken" || a === "cooling") {
      cls += " err"; box += " err";
      var base = s.slice(0, 26);
      var opts = [base + "-team", base + "-labs"];
      text = a === "cooling"
        ? host(s) + " was used recently and isn't available yet. Pick another address."
        : host(s) + " is taken.";
      opts.forEach(function (o) {
        refs.sugg.appendChild(h("button", { type: "button", onclick: function () {
          S.slug = o; refs.inp.value = o; checkSlug(); refs.inp.focus();
        } }, [o]));
      });
    } else if (a === "rate_limited") { cls += " err"; text = "Too many checks. Wait a moment."; }
    else if (a === "error") { cls += " err"; text = "Couldn't check that address. Try again."; }
    else { cls += " err"; box += " err"; text = AVAIL_MSG[a] || AVAIL_MSG.invalid; }
    refs.help.className = cls;
    refs.help.replaceChildren.apply(refs.help, good ? [checkIcon(), text] : [text]);
    refs.box.className = box;
    paintChips();
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
    refs.btn.textContent = S.busy ? "Creating..." : "Create my instance";
    refs.err.replaceChildren();
    var msg = S.err;
    if (S.me && !S.cfg.turnstileSiteKey) msg = "Sign-ups are temporarily unavailable. Try again later.";
    if (msg) {
      refs.err.appendChild(h("div", { class: "note bad", role: "alert" }, typeof msg === "string" ? [msg] : msg));
    }
  }

  function mountTurnstile() {
    S.widget = null;
    if (S.view !== "address" || !S.me || !S.cfg.turnstileSiteKey || !refs.ts) return;
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
      if (r.status === 403 && r.details && r.details.reason === "not_invited") { S.gate = "waitlist"; route(); return; }
      if (r.code === "signups_closed") { S.view = "closed"; render(); return; }
      if (r.code === "signup_limit") {
        loadSignup().then(function () {
          route();
          if (S.view === "address") { S.err = LIMIT_ERR; paintCreate(); }
        });
        return;
      }
      if (r.code === "slug_taken") { S.avail = r.message === "slug_cooling" ? "cooling" : "taken"; S.availSlug = slug; S.err = ""; paintAvail(); return; }
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
      S.me = null; S.slug = ""; S.avail = null; S.token = null; S.err = ""; S.chips = []; S.chipsFor = ""; S.edited = false; S.step = "address"; S.gate = null; S.note = ""; S.joinErr = ""; route();
    });
  }
  function startOver() {
    S.signup = null; S.slug = ""; S.avail = null; S.err = ""; S.token = null; S.step = "address"; S.edited = false;
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

  // ---------- loading page (design: round 2, loading option D) ----------
  var VERBS = ["Bookbinding", "Annotating", "Margin-noting", "Inking", "Drafting", "Collating",
    "Proofreading", "Indexing", "Unfolding", "Pinning", "Typesetting", "Shelving"];
  var SVGNS = "http://www.w3.org/2000/svg";
  function reduced() { return window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches; }
  function svgEl(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag), k;
    for (k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function animMark() {
    var s = svgEl("svg", { class: "anim a1", viewBox: "0 0 32 32", "aria-hidden": "true" });
    s.appendChild(svgEl("path", { class: "fr", pathLength: "1", d: "M22 2H5a3 3 0 0 0-3 3v17l4 4V6h20zM10 30h17a3 3 0 0 0 3-3V10l-4-4v20H6z" }));
    s.appendChild(svgEl("path", { class: "cn", d: "M22 2h5a3 3 0 0 1 3 3v5zM2 22v5a3 3 0 0 0 3 3h5z" }));
    s.appendChild(svgEl("path", { class: "sq", d: "M12 10h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z" }));
    return s;
  }
  function animStack() {
    return h("div", { class: "anim a2", "aria-hidden": "true" }, [h("i"), h("i"), h("i"), h("i")]);
  }
  function animPage() {
    return h("div", { class: "anim a3", "aria-hidden": "true" }, [
      h("div", { class: "pg3" }, [h("i"), h("i"), h("i", { class: "s" }), h("i"),
        h("span", { class: "pin" }), h("span", { class: "bub" }), h("span", { class: "bub r" })])
    ]);
  }
  var SEQ = [[animMark, 2800], [animStack, 3600], [animPage, 3400]];

  function stopAnim() {
    clearTimeout(S.seqT); clearInterval(S.verbT);
    S.seqT = null; S.verbT = null;
  }
  // Each animation plays once, in turn: fade out, a short blank, fade in.
  function startAnim(slot, word) {
    if (reduced()) {
      slot.classList.add("in");
      slot.replaceChildren(animMark());
      return;
    }
    var si = 0, vi = 0;
    function step() {
      var e = SEQ[si];
      slot.replaceChildren(e[0]());
      slot.classList.remove("in"); void slot.offsetWidth; slot.classList.add("in");
      si = (si + 1) % SEQ.length;
      S.seqT = setTimeout(function () {
        slot.classList.remove("in");
        S.seqT = setTimeout(step, 900);
      }, e[1]);
    }
    step();
    S.verbT = setInterval(function () {
      vi = (vi + 1) % VERBS.length;
      var n = word.cloneNode(false);
      n.textContent = VERBS[vi];
      word.replaceWith(n);
      word = n;
    }, 2200);
  }

  function pendingLabel(g) {
    if (g.stage === "waiting_cap") return "Lots of people are signing up right now. You're in line, and it starts on its own.";
    return "Creating " + g.slug + "." + S.cfg.appDomain + "…";
  }

  // The animation and verbs are built once and survive status updates: only
  // the status line (and the lost-connection notice) change in place.
  function viewLoading() {
    var g = S.signup, hostName = g.host;
    if (!refs.ld || !document.body.contains(refs.ld)) {
      stopAnim();
      var slot = h("div", { class: "slot", id: "slot" });
      var word = h("span", { class: "w" }, [VERBS[0]]);
      refs.lab = h("p", { class: "addr", "aria-live": "polite" });
      refs.live = h("div", { role: "status" });
      refs.ld = h("div", { class: "panel ld" }, [
        h("h1", { class: "sr" }, ["Setting up ", nw(hostName)]),
        refs.live,
        h("div", { class: "seq" }, [slot]),
        h("p", { class: "verb", "aria-hidden": "true" }, [word, "…"]),
        refs.lab
      ]);
      refs.hint = h("p", { class: "hint" }, ["This usually takes a minute or two. We'll open your instance as soon as it's ready, and email you the link too."]);
      shell(refs.ld);
      startAnim(slot, word);
    }
    refs.lab.textContent = pendingLabel(g);
    // No wait-time line while in line for the daily cap: it starts on its own.
    if (g.stage === "waiting_cap") refs.hint.remove();
    else if (!refs.hint.parentNode) refs.ld.appendChild(refs.hint);
    paintLive();
  }

  function viewSetup() {
    var g = S.signup, hostName = g.host, st = g.stage;
    if (st !== "ready" && st !== "failed") { viewLoading(); return; }
    var steps, label, head, body = [];
    var reserve = step("done", "Reserve your address");
    var create = "Create your instance", email = "Send your welcome email";
    if (st === "ready") {
      label = "Ready";
      var btn = h("a", { class: "btn pri", href: "https://" + hostName + "/", onclick: openInstance }, S.opening ? ["Open your instance"] : ["Open " + hostName]);
      // Seen going from in progress to ready in this page view: "fresh", with
      // the checklist. Otherwise a returning owner whose instance is ready.
      // Either way we go in once per tab session (sessionStorage guard, so a
      // failed hand-off that reloads the page cannot loop).
      var key = "oa-signup-opened:" + hostName, seen = false;
      try { seen = !!window.sessionStorage.getItem(key); } catch (e) { seen = false; }
      var auto = S.opening || !seen;
      if (S.opening) {
        head = [h("h1", {}, ["Ready. Opening ", nw(hostName), "\u2026"])];
        steps = [reserve, step("done", create), step("done", email)];
      } else {
        head = [h("h1", {}, ["Welcome back"]),
          h("div", { class: "who" }, [
            h("span", {}, ["Logged in as ", h("b", {}, [S.me.email])]),
            h("button", { class: "btn link", type: "button", onclick: signOut }, ["Not you?"])
          ]),
          h("p", {}, ["You have ", nw(hostName), "."])];
        steps = null;
      }
      body = [];
      if (!S.openStarted) {
        S.openStarted = true;
        if (auto) {
          try { window.sessionStorage.setItem(key, "1"); } catch (e) { /* no storage: still once per page view */ }
          goToInstance(btn.href);
          S.auto = true;
          S.fbT = setTimeout(function () {
            S.fbT = null;
            if (S.view === "setup" && S.auto) document.querySelector(".panel").appendChild(btn);
          }, FALLBACK_MS);
        }
      }
      if (!auto) body = [btn];
    } else {
      label = "Something went wrong while we were building it.";
      head = [h("h1", {}, ["We couldn't set up ", nw(hostName)])];
      steps = [reserve, step("fail", create, "This didn't finish."), step("todo", email)];
      body = [
        h("div", { class: "note bad" }, [
          "We've been alerted and will look into it. Your address isn't reserved anymore. If you have questions, email support."
        ]),
        h("div", { class: "stack" }, [
          h("a", { class: "btn", href: "mailto:" + HELP_EMAIL }, ["Email support"]),
          h("button", { class: "btn", type: "button", onclick: startOver }, ["Try again"])
        ])
      ];
    }
    shell(h("div", { class: "panel", "aria-live": "polite" }, head.concat(steps ? [
      h("div", { class: "state" }, [h("div", { class: "lab" }, [label]), h("ul", { class: "steps" }, steps)])
    ] : [], body)));
  }

  // POST /auth/open mints a short-lived ticket so the instance can sign the
  // owner in without a second prompt; any failure is the plain link.
  function openInstance(ev) {
    ev.preventDefault();
    goToInstance(ev.currentTarget.href);
  }
  function goToInstance(plain) {
    api("POST", "/auth/open").then(function (r) {
      var u = r.status === 200 && r.body && typeof r.body.url === "string" ? r.body.url : plain;
      window.location.assign(u);
    }, function () { window.location.assign(plain); });
  }

  function loadSignup() {
    return api("GET", "/api/v1/signup").then(function (r) {
      if (r.status === 401) return "unauth";
      if (r.status === 200 && r.body) S.gate = r.body.gate || null;
      if (r.status === 404 || (r.status === 200 && r.body && r.body.stage === "none")) {
        S.signup = null; return "gone";
      }
      if (r.status !== 200 || !r.body) return "error";
      S.signup = { stage: r.body.stage, slug: r.body.slug, host: r.body.host };
      return "ok";
    }, function () { return "error"; });
  }
  function paintLive() {
    if (!refs.live) return;
    refs.live.className = S.offline ? "note warn" : "";
    refs.live.textContent = S.offline ? "Can't reach the server. Retrying\u2026" : "";
  }
  function stopPoll() { clearInterval(S.poll); S.polling = false; }
  function pollOnce() {
    if (document.hidden || S.inflight || S.view !== "setup") return;
    S.inflight = true;
    var before = S.signup && S.signup.stage;
    var wasOffline = S.offline;
    loadSignup().then(function (res) {
      S.inflight = false;
      if (S.view !== "setup") return;
      if (res === "unauth") {
        stopPoll(); S.me = null; S.signup = null; S.offline = false;
        S.notice = NOTICES.expired; route(); return;
      }
      if (res === "gone") { stopPoll(); S.offline = false; route(); return; }
      if (res === "error") {
        S.fails = (S.fails || 0) + 1;
        if (S.fails >= 3 && !S.offline) { S.offline = true; paintLive(); }
        return;
      }
      S.fails = 0;
      if (wasOffline) { S.offline = false; paintLive(); }
      if (S.signup.stage === "ready" && before !== "ready" && before !== "failed") S.opening = true;
      if (S.signup.stage !== before) render();
      if (S.signup.stage === "ready" || S.signup.stage === "failed") stopPoll();
    });
  }
  function startPoll() {
    clearInterval(S.poll);
    S.polling = true; S.fails = 0; S.offline = false;
    S.poll = setInterval(pollOnce, 5000);
  }
  window.addEventListener("pagehide", function () { clearTimeout(S.fbT); S.fbT = null; });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && S.polling) pollOnce();
  });

  // ---------- routing ----------
  function render() {
    var pend = S.view === "setup" && S.signup && S.signup.stage !== "ready" && S.signup.stage !== "failed";
    if (!pend || !refs.ld || !document.body.contains(refs.ld)) stopAnim();
    if (S.view === "closed") viewClosed();
    else if (S.view === "setup") viewSetup();
    else if (S.view === "join") viewJoin();
    else if (S.view === "listed") viewListed();
    else if (S.view === "address") viewAddress();
    else viewSignin();
  }
  function route() {
    stopPoll(); stopAnim();
    clearTimeout(S.fbT); S.fbT = null; S.opening = false; S.openStarted = false; S.auto = false;
    refs = {};
    if (S.me && S.signup) {
      S.view = "setup";
      if (S.signup.stage !== "ready" && S.signup.stage !== "failed") startPoll();
    } else if (!S.cfg.open) S.view = "closed";
    else if (S.me && S.gate === "waitlist") S.view = "join";
    else if (S.me && S.gate === "waitlisted") S.view = "listed";
    else S.view = S.me && S.step !== "signin" ? "address" : "signin";
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
