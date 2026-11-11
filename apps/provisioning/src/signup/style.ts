// The sign-up page's stylesheet (served as /app.css; CSP style-src 'self').
// Tokens are the Open Artifacts tokens from the approved design, light and
// dark. Nothing here is shared with the admin SPA.
export const CSS = `
:root{color-scheme:light;--bg:#eef0f3;--chrome:#f5f6f8;--surface:#fff;--sunken:#eceef1;--divider:#e0e3e8;--border:#bec4cd;--text:#15181c;--text2:#454c56;--muted:#5f6670;--accent:#2350d0;--accent-fg:#1d45b8;--accent-soft:#e7edfc;--accent-text:#fff;--ok:#157a3a;--ok-soft:#e3f3e8;--danger:#be2f1c;--danger-soft:#fbe7e3;--warn:#8a5a00;--warn-soft:#fbf0d9;--btn:#15181c;--btn-text:#fff;--shadow:0 1px 2px rgba(20,24,30,.06),0 8px 24px rgba(20,24,30,.08)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#131518;--chrome:#17191d;--surface:#1c1f23;--sunken:#181a1e;--divider:#2c3037;--border:#3b414a;--text:#e9ebee;--text2:#b7bdc6;--muted:#9097a1;--accent:#7f9cff;--accent-fg:#a3b8ff;--accent-soft:#1f2a4a;--accent-text:#131518;--ok:#6fd08f;--ok-soft:#173022;--danger:#ff7f6b;--danger-soft:#3a1d19;--warn:#f0b955;--warn-soft:#352a12;--btn:#e9ebee;--btn-text:#131518;--shadow:0 0 0 1px #3b414a}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#131518;--chrome:#17191d;--surface:#1c1f23;--sunken:#181a1e;--divider:#2c3037;--border:#3b414a;--text:#e9ebee;--text2:#b7bdc6;--muted:#9097a1;--accent:#7f9cff;--accent-fg:#a3b8ff;--accent-soft:#1f2a4a;--accent-text:#131518;--ok:#6fd08f;--ok-soft:#173022;--danger:#ff7f6b;--danger-soft:#3a1d19;--warn:#f0b955;--warn-soft:#352a12;--btn:#e9ebee;--btn-text:#131518;--shadow:0 0 0 1px #3b414a}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column;min-height:100vh}
a{color:var(--accent-fg)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.top{display:flex;align-items:center;gap:8px;padding:12px 16px;font-weight:700}
.top .links{margin-left:auto;font-weight:500;font-size:12.5px;color:var(--text2);display:flex;gap:6px}
.top .links a{color:var(--text2)}
.logo{width:18px;height:18px;border-radius:4px;border:2px solid var(--accent);display:grid;place-items:center;flex:none}
.logo i{width:8px;height:8px;background:var(--accent);border-radius:1px}
main{flex:1;width:100%;max-width:452px;margin:0 auto;padding:24px 16px 48px}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;box-shadow:var(--shadow)}
h1{font-size:19px;line-height:1.3;margin:0 0 6px;letter-spacing:-.01em}
.panel p{color:var(--text2);margin:0 0 14px}
.nw{white-space:nowrap}
.muted{color:var(--muted)}
.small{font-size:12px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:38px;padding:0 14px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font:600 13.5px/1 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;text-decoration:none;cursor:pointer}
.btn.pri{background:var(--btn);border-color:var(--btn);color:var(--btn-text)}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.btn.link{width:auto;min-height:0;border:0;background:none;padding:0;color:var(--accent-fg);font-weight:500;text-decoration:underline}
.gsign{margin-bottom:12px}
.who{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;justify-content:space-between;border:1px solid var(--border);border-radius:6px;padding:8px 12px;margin-bottom:12px;background:var(--sunken)}
.who b{font-weight:600;overflow-wrap:anywhere}
.field{display:grid;gap:4px;margin:10px 0}
.field label{font-weight:600;font-size:12px;color:var(--text2)}
.inp{display:flex;align-items:center;border:1px solid var(--border);border-radius:6px;background:var(--surface);min-height:38px;overflow:hidden}
.inp.ok{border-color:var(--ok)}
.inp.err{border-color:var(--danger)}
.inp.off{background:var(--sunken)}
.inp input{flex:1;min-width:0;border:0;background:none;color:var(--text);font:inherit;padding:0 4px 0 10px;height:36px;outline:none}
.inp:focus-within{outline:2px solid var(--accent);outline-offset:1px}
.inp .suf{color:var(--muted);padding-right:10px;white-space:nowrap}
.help{font-size:12px;margin:0;min-height:18px;color:var(--muted)}
.field.tight{row-gap:0}
.field.tight label{margin-bottom:4px}
.help.tight{min-height:0;margin:4px 0 0}
.help.tight:empty{margin:0}
.help.ok{color:var(--ok)}
.help.err{color:var(--danger)}
.sugg{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.sugg button{border:1px solid var(--border);background:var(--surface);color:var(--accent-fg);border-radius:999px;padding:2px 10px;font:inherit;font-size:12px;cursor:pointer}
.cta{margin-top:14px}
.ts{margin-top:12px;min-height:0}
.note{border-radius:6px;padding:8px 10px;margin:10px 0;border:1px solid var(--divider);color:var(--text)}
.note strong{display:block}
.note.bad{background:var(--danger-soft);border-color:var(--danger)}
.note.warn{background:var(--warn-soft);border-color:var(--warn)}
.note.info{background:var(--accent-soft);border-color:var(--accent)}
.or{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px;margin:16px 0}
.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--divider)}
.stack{display:grid;gap:10px}
.panel .mt{margin:10px 0 0}
.panel .lead{margin:4px 0 0}
.note .btn{display:flex;width:fit-content}
.ns{max-width:420px;margin:24px auto;padding:0 16px}
.state{border-top:1px solid var(--divider);margin-top:12px;padding-top:8px}
.lab{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.steps{list-style:none;margin:10px 0;padding:0;display:grid;gap:10px}
.steps li{display:grid;grid-template-columns:22px 1fr;gap:8px;align-items:start}
.dot{width:20px;height:20px;border-radius:50%;border:2px solid var(--border);display:grid;place-items:center;font-size:11px;font-weight:700;color:var(--muted)}
.dot.done{background:var(--ok);border-color:var(--ok);color:var(--accent-text)}
.dot.now{border-color:var(--accent);border-top-color:transparent;animation:spin 1s linear infinite}
.dot.wait{border-color:var(--warn);border-style:dashed}
.dot.fail{background:var(--danger);border-color:var(--danger);color:var(--accent-text)}
.who .av{width:24px;height:24px;border-radius:50%;background:#1e7a5a;color:#fff;display:grid;place-items:center;font-size:11px;font-weight:600;flex:none}
.who .wt{flex:1;min-width:0}
.panel .lead{color:var(--text2);margin:8px 0 0}
.help.ok{display:flex;align-items:center;gap:6px}
.help svg{width:14px;height:14px;flex:none}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.chip{border:1px solid var(--border);border-radius:99px;padding:3px 11px;font:inherit;font-size:13px;background:var(--surface);color:var(--text);cursor:pointer}
.chip.sel{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-fg)}
.back{margin-top:12px;display:flex;margin-inline:auto}
.panel.ld{background:none;border:0;box-shadow:none;min-height:480px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;padding:24px 0}
.panel.ld .note{margin:0}
.anim{width:132px;height:132px}
.verb{font-size:22px;font-weight:500;letter-spacing:-.01em;color:var(--text);min-height:32px;margin:0;text-align:center}
.panel .verb{color:var(--text);margin:0}
.verb .w{display:inline-block;animation:vin .35s ease-out}
@keyframes vin{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.panel .addr{font:14px Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--muted);margin:0;text-align:center}
.panel .hint{font-size:13.5px;color:var(--muted);margin:0;text-align:center;max-width:38ch}
.a1 .fr{fill:none;stroke:var(--text);stroke-width:1.2;stroke-dasharray:1;stroke-dashoffset:1;animation:draw 2.8s ease-in-out infinite}
.a1 .cn{fill:var(--accent);opacity:0;animation:fade 2.8s ease-in-out infinite}
.a1 .sq{fill:var(--accent);transform-origin:16px 16px;transform:scale(0);animation:land 2.8s cubic-bezier(.3,1.6,.5,1) infinite}
@keyframes draw{0%{stroke-dashoffset:1}45%,85%{stroke-dashoffset:0}100%{stroke-dashoffset:-1}}
@keyframes fade{0%,40%{opacity:0}55%,85%{opacity:1}100%{opacity:0}}
@keyframes land{0%,45%{transform:scale(0)}60%,85%{transform:scale(1)}100%{transform:scale(0)}}
.a2{position:relative}
.a2 i{position:absolute;left:22px;width:88px;height:64px;border-radius:8px;background:var(--surface);border:1.5px solid var(--border);box-shadow:0 6px 14px -8px rgba(20,24,30,.35);opacity:0;animation:stack 3.2s ease-in-out infinite}
.a2 i::before{content:"";position:absolute;left:10px;right:24px;top:12px;height:5px;border-radius:3px;background:var(--divider)}
.a2 i::after{content:"";position:absolute;left:10px;right:40px;top:24px;height:5px;border-radius:3px;background:var(--divider)}
.a2 i:nth-child(1){top:58px;animation-delay:0s}
.a2 i:nth-child(2){top:44px;animation-delay:.35s}
.a2 i:nth-child(3){top:30px;animation-delay:.7s}
.a2 i:nth-child(4){top:16px;animation-delay:1.05s;border-color:var(--accent)}
.a2 i:nth-child(4)::before{background:var(--accent)}
@keyframes stack{0%{opacity:0;transform:translateY(-28px) rotate(-6deg)}14%{opacity:1;transform:none}80%{opacity:1;transform:none}100%{opacity:0;transform:translateY(6px)}}
.pg3{position:relative;width:100px;height:124px;margin:4px auto 0;border-radius:8px;background:var(--surface);border:1.5px solid var(--border);padding:14px 12px}
.pg3 i{display:block;height:5px;border-radius:3px;background:var(--divider);margin-bottom:9px}
.pg3 i.s{width:60%}
.pg3 .pin{position:absolute;left:58px;top:40px;width:14px;height:14px;border-radius:50% 50% 50% 0;transform:rotate(-45deg) scale(0);background:var(--warn);animation:pin 3.4s ease-in-out infinite}
.pg3 .bub{position:absolute;right:-30px;top:58px;width:46px;height:20px;border-radius:10px 10px 10px 3px;background:var(--accent-soft);border:1.5px solid var(--accent);opacity:0;animation:bub 3.4s ease-in-out infinite}
.pg3 .bub.r{right:auto;left:-26px;top:86px;border-radius:10px 10px 3px 10px;background:var(--ok-soft);border-color:var(--ok);animation-name:bub2}
@keyframes pin{0%,8%{transform:rotate(-45deg) scale(0)}18%,90%{transform:rotate(-45deg) scale(1)}100%{transform:rotate(-45deg) scale(0)}}
@keyframes bub{0%,25%{opacity:0;transform:translateY(6px)}35%,90%{opacity:1;transform:none}100%{opacity:0}}
@keyframes bub2{0%,50%{opacity:0;transform:translateY(6px)}60%,90%{opacity:1;transform:none}100%{opacity:0}}
@media (prefers-reduced-motion:reduce){.a1 .fr{animation:none;stroke-dashoffset:0}.a1 .cn{animation:none;opacity:1}.a1 .sq{animation:none;transform:none}.a2 i{animation:none;opacity:1}.pg3 .pin{animation:none;transform:rotate(-45deg)}.pg3 .bub{animation:none;opacity:1}.verb .w{animation:none}}
.seq{width:132px;height:132px}.slot{width:132px;height:132px;opacity:0;transition:opacity .5s ease}.slot.in{opacity:1}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dot.now{animation:none}}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:480px){.panel{padding:18px 16px}main{padding-top:12px}}
`;
