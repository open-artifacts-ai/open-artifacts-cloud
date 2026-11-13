// The Business contact page (open-artifacts#2404), served at GET /contact on the
// sign-up host. It reuses the sign-up page's stylesheet (/app.css, plus the
// contact rules in style.ts) and brand shell. Its script is /contact.js (CSP
// script-src 'self' plus Turnstile) and, like the sign-up page's, writes text
// only through textContent: no innerHTML. Keep backticks and dollar-brace out
// of CONTACT_JS (it is a template literal).

export const CONTACT_TITLE = "Let's talk Business";
export const CONTACT_SUBLINE =
  "Tell us about your team and we'll email you to set up the Business plan.";

export const CONTACT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${CONTACT_TITLE}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div id="app"></div>
<noscript><main class="ns"><h1>${CONTACT_TITLE}</h1><p>This page needs JavaScript. You can also email hello@open-artifacts.com.</p></main></noscript>
<script src="/contact.js"></script>
</body>
</html>
`;

export const CONTACT_JS = `(function () {
  "use strict";
  var root = document.getElementById("app");
  var TITLE = "Let's talk Business";
  var SUB = "Tell us about your team and we'll email you to set up the Business plan.";
  var SIZES = [["1-10", "1 to 10"], ["11-50", "11 to 50"], ["51-200", "51 to 200"], ["200+", "200+"]];
  var NEEDS = [["group_sync", "Google group sync"], ["sharing_controls", "Outside-sharing controls"], ["audit_log", "Audit log"], ["custom_domain", "Custom domain"], ["other", "Something else"]];
  var q = new URLSearchParams(window.location.search);
  var pre = {
    name: (q.get("name") || "").slice(0, 100),
    email: (q.get("email") || "").slice(0, 254),
    instance: (q.get("instance") || "").slice(0, 253),
    source: q.get("source") === "dashboard" ? "dashboard" : "landing"
  };
  var S = { siteKey: null, token: null, widget: null, busy: false };

  function h(tag, props, kids) {
    var el = document.createElement(tag), k;
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

  function brandMark(cls) {
    var ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg"), p;
    s.setAttribute("class", cls || "mark");
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

  var HOME = "https://open-artifacts.com/";
  var PLANS = HOME + "#pricing";
  var PRIVACY = HOME + "privacy/";
  var ADDS = [
    ["Google group sync", "People join and leave with your Google groups.", false],
    ["Outside-sharing controls", "Decide who may share pages outside the company.", false],
    ["Audit log", "Who opened, shared or changed what, and when.", true],
    ["Custom domain", "Your pages on an address of your own.", true]
  ];
  var NEXT = [
    ["You send this", "It takes a minute."],
    ["We email you", "A person reads every request."],
    ["We set it up", "On your existing instance, or a new one."]
  ];

  function tick() {
    var ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg"), p = document.createElementNS(ns, "path");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    p.setAttribute("d", "M5 12l5 5 9-10");
    s.appendChild(p);
    return s;
  }

  function link(href, text) {
    return h("a", { href: href, target: "_blank", rel: "noopener" }, [text]);
  }

  function details() {
    return h("div", { class: "cx-more" }, [
      h("div", { class: "cx-adds" }, [
        h("p", { class: "cx-kick" }, ["What Business adds to Team"]),
        h("ul", {}, ADDS.map(function (a) {
          return h("li", {}, [tick(), h("div", {}, [
            h("b", {}, [a[0], a[2] ? h("em", { class: "soon" }, ["Soon"]) : null]),
            h("span", {}, [a[1]])
          ])]);
        }))
      ]),
      h("div", { class: "cx-price" }, [h("b", {}, ["$25"]), h("span", {}, ["per creator per month. Viewers are free."])]),
      h("div", { class: "cx-next" }, [
        h("p", { class: "cx-kick" }, ["What happens next"]),
        h("div", {}, NEXT.map(function (n) { return h("div", {}, [h("b", {}, [n[0]]), n[1]]); }))
      ]),
      h("div", { class: "cx-foot" }, [
        link(PLANS, "See all plans"), link(PRIVACY, "Privacy"),
        h("span", { class: "cx-self" }, ["Self-hosting? There are no plans to buy: every feature that ships is yours."])
      ])
    ]);
  }

  function shell(panel) {
    root.replaceChildren(h("div", { class: "cx" }, [
      h("section", { class: "cx-head" }, [
        h("div", { class: "brand" }, [brandMark(), "Open Artifacts"]),
        h("div", {}, [h("h1", { class: "cx-t" }, [TITLE]), h("p", { class: "cx-s" }, [SUB])])
      ]),
      h("main", { class: "cx-form" }, [h("div", { class: "cx-col" }, [panel])]),
      details()
    ]));
  }

  function field(label, id, input) {
    return h("div", { class: "field" }, [
      h("label", { for: id }, [label]),
      h("div", { class: "inp" }, [input])
    ]);
  }

  function done(title, text) {
    shell(h("div", { class: "panel cx-done", role: "status" }, [
      h("div", { class: "cx-tick" }, [tick()]),
      h("h2", {}, [title]),
      h("p", {}, [text]),
      h("a", { class: "btn", href: HOME }, ["Back to Open Artifacts"])
    ]));
  }

  function form() {
    var locked = pre.source === "dashboard";
    var name = h("input", { type: "text", id: "c-name", name: "name", autocomplete: "name", required: true, maxlength: "100", value: pre.name, readonly: locked && pre.name ? true : null });
    var email = h("input", { type: "email", id: "c-email", name: "email", autocomplete: "email", required: true, maxlength: "254", value: pre.email, readonly: locked && pre.email ? true : null });
    var company = h("input", { type: "text", id: "c-company", name: "company", autocomplete: "organization", required: true, maxlength: "100" });
    var note = h("textarea", { class: "ta", id: "c-note", name: "note", maxlength: "1000", rows: "3" });
    var err = h("div", { "aria-live": "polite" });
    var ts = h("div", { class: "ts" });
    var btn = h("button", { class: "btn pri cta", type: "submit" }, ["Send request"]);
    var sizeBoxes = SIZES.map(function (s, i) {
      return h("label", { class: "opt pick" }, [
        h("input", { type: "radio", name: "teamSize", value: s[0], required: i === 0 ? true : null }), h("span", {}, [s[1]])
      ]);
    });
    var needBoxes = NEEDS.map(function (n) {
      return h("label", { class: "opt" }, [h("input", { type: "checkbox", name: "needs", value: n[0] }), n[1]]);
    });
    var from = locked && pre.instance
      ? h("div", { class: "cx-from" }, [brandMark("mark"), "For " + pre.instance + ", where you're an owner."])
      : null;
    var f = h("form", { class: "panel contact" }, [
      from,
      h("div", { class: "two" }, [
        field("Your name", "c-name", name),
        field("Work email", "c-email", email)
      ]),
      field("Company", "c-company", company),
      h("fieldset", { class: "grp" }, [h("legend", {}, ["How many people will publish pages?"]), h("div", { class: "opts picks" }, sizeBoxes)]),
      h("fieldset", { class: "grp" }, [h("legend", {}, [h("span", {}, ["What do you need? (optional)"])]), h("div", { class: "opts checks" }, needBoxes)]),
      h("div", { class: "field roomy" }, [h("label", { for: "c-note" }, ["Anything else? (optional)"]), note]),
      ts, err, btn,
      h("p", { class: "cx-priv" }, ["We use this only to reply to you. ", link(PRIVACY, "Privacy")])
    ]);
    if (locked) {
      f.querySelectorAll("input[readonly]").forEach(function (i) { i.parentNode.classList.add("off"); });
    }

    function fail() {
      err.replaceChildren(h("div", { class: "note bad", role: "alert" }, ["That didn't send. Try again."]));
      S.busy = false; btn.disabled = false;
      S.token = null;
      try { if (window.turnstile && S.widget !== null) window.turnstile.reset(S.widget); } catch (e) {}
    }

    f.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (S.busy) return;
      var size = f.querySelector("input[name=teamSize]:checked");
      if (!size || !S.token) { fail(); return; }
      var needs = Array.prototype.map.call(f.querySelectorAll("input[name=needs]:checked"), function (c) { return c.value; });
      var body = {
        name: name.value.trim(), email: email.value.trim(), company: company.value.trim(),
        teamSize: size.value, needs: needs, source: pre.source, turnstile: S.token
      };
      if (note.value.trim()) body.note = note.value.trim();
      if (pre.instance) body.instance = pre.instance;
      S.busy = true; btn.disabled = true; err.replaceChildren();
      fetch("/api/v1/contact", {
        method: "POST", credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body)
      }).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (j) { return { ok: r.ok, body: j }; });
      }).then(function (r) {
        if (!r.ok || !r.body) { fail(); return; }
        if (r.body.duplicate) done("We already have your request from today.", "We'll be in touch.");
        else done("Thanks. We have your request.", "We'll email you at " + body.email + ".");
      }).catch(fail);
    });

    shell(f);
    mountTurnstile(ts, btn, err);
  }

  function mountTurnstile(el, btn, err) {
    if (!S.siteKey) {
      err.replaceChildren(h("div", { class: "note bad", role: "alert" }, ["That didn't send. Try again."]));
      btn.disabled = true;
      return;
    }
    function render() {
      if (!window.turnstile || !document.body.contains(el)) return;
      S.widget = window.turnstile.render(el, {
        sitekey: S.siteKey, action: "signup", theme: "auto",
        callback: function (t) { S.token = t; },
        "expired-callback": function () { S.token = null; },
        "error-callback": function () { S.token = null; }
      });
    }
    if (window.turnstile) { render(); return; }
    window.__oaTs = render;
    window.__oaTsLoaded = function () { if (window.__oaTs) window.__oaTs(); };
    var sc = document.createElement("script");
    sc.async = true;
    sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__oaTsLoaded";
    document.head.appendChild(sc);
  }

  fetch("/api/v1/config", { headers: { accept: "application/json" }, credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (c) { S.siteKey = (c && c.turnstileSiteKey) || null; form(); })
    .catch(function () { form(); });
})();
`;
