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
.login{flex:1;display:grid;grid-template-columns:3fr 2fr;min-height:100vh}
.pitch{position:relative;overflow:hidden;display:flex}
.top{position:relative;z-index:1;flex:1;display:flex;flex-direction:column;padding:28px 48px;font-weight:700}
.brand{display:flex;align-items:center;gap:8px}
.pitchtext{margin:auto 0;max-width:30em}
.pitchtext .pt{font-size:32px;line-height:1.2;font-weight:700;letter-spacing:-.02em;margin:0 0 12px}
.pitchtext .ps{font-size:16px;font-weight:400;color:var(--text2);margin:0}
.top .links{font-weight:500;font-size:12.5px;color:var(--text2);display:flex;gap:6px}
.mark.ghost{position:absolute;right:-40px;bottom:-40px;width:340px;height:340px;opacity:.06;pointer-events:none}
.mark.lg{width:36px;height:36px;margin-bottom:20px}
.login main.side{max-width:none;width:auto;margin:0;padding:32px;background:var(--surface);border-left:1px solid var(--divider);display:flex;align-items:center;justify-content:center}
.col{width:100%;max-width:360px}
.foot{display:none}
.col:has(.panel.ld) .mark.lg{display:none}
.side .panel{background:none;border:0;box-shadow:none;padding:0;border-radius:0}
.side h1{font-size:23px}
@media (max-width:700px){
.login{grid-template-columns:1fr;grid-template-rows:auto 1fr}
.top{padding:20px 20px 0}
.pitchtext{margin:20px 0}
.pitchtext .pt{font-size:21px;margin:0 0 6px}
.pitchtext .ps{font-size:14px}
.top .links,.mark.ghost,.mark.lg{display:none}
.login main.side{flex-direction:column;align-items:stretch;justify-content:space-between;gap:32px;padding-bottom:24px}
.foot{display:block;font-size:13px;color:var(--muted)}
.foot a{color:var(--muted)}
.login main.side{border-left:0;border-top:1px solid var(--divider);padding:24px 20px 24px}
}
.top .links a{color:var(--text2)}
.mark{width:20px;height:20px;flex:none;color:var(--text)}
.mark .f{fill:currentColor}
.mark .a{fill:var(--accent)}
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
.panel .mt{margin:10px 0 0;text-align:left}
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
.panel .signin-lead{margin:8px 0 16px}
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
.field.roomy{margin:16px 0 0}
.ta{width:100%;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font:inherit;padding:8px 10px;resize:vertical;min-height:62px}
.ta:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.ta:disabled{background:var(--sunken)}
.help.count{display:flex;justify-content:flex-end}
.help.near{color:var(--warn)}
.spin{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-top-color:transparent;animation:spin 1s linear infinite}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dot.now{animation:none}}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

.panel .lead.body{font-size:14px;line-height:1.5;color:var(--text)}
.contact .grp{border:0;padding:0;margin:14px 0 0;min-width:0}
.contact legend{font-weight:600;font-size:12px;color:var(--text2);padding:0;margin-bottom:6px}
.contact .opts{display:grid;gap:6px}
.contact .opt{display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer}
.contact .opt input{margin:0;width:16px;height:16px;accent-color:var(--accent)}
.contact .inp input:-webkit-autofill{-webkit-text-fill-color:var(--text)}

.cx{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);grid-template-areas:"head form" "more form";grid-template-rows:auto 1fr;min-height:100vh;flex:1}
.cx-head{grid-area:head;padding:36px 48px 0;display:flex;flex-direction:column;gap:26px}
.cx-head .brand{font-weight:600}
.cx-head .mark{width:22px;height:22px}
.cx-t{font-size:40px;line-height:1.06;letter-spacing:-.025em;font-weight:600;margin:0;max-width:13ch}
.cx-s{font-size:17.5px;color:var(--text2);max-width:44ch;margin:10px 0 0}
.cx-more{grid-area:more;padding:26px 48px 32px;display:flex;flex-direction:column;gap:26px}
.cx-kick{font:500 12px ui-monospace,Menlo,monospace;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin:0 0 12px}
.cx-adds ul{display:grid;gap:14px;margin:0;padding:0;list-style:none}
.cx-adds li{display:grid;grid-template-columns:22px 1fr;gap:10px;align-items:start}
.cx-adds svg{width:18px;height:18px;stroke:var(--ok);fill:none;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;margin-top:3px}
.cx-adds b{display:block;font-weight:600}
.cx-adds span{color:var(--text2);font-size:14.5px}
.soon{font:500 11px ui-monospace,Menlo,monospace;font-style:normal;background:var(--sunken);color:var(--muted);border:1px dashed var(--border);border-radius:999px;padding:1px 7px;margin-left:6px;vertical-align:2px}
.cx-price{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:14px 16px;background:var(--surface);border:1px solid var(--divider);border-radius:12px;max-width:440px}
.cx-price b{font-size:26px;letter-spacing:-.02em}
.cx-price span{color:var(--text2);font-size:14.5px}
.cx-next>div{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;counter-reset:n;max-width:520px}
.cx-next>div>div{counter-increment:n;font-size:14px;color:var(--text2)}
.cx-next>div>div::before{content:counter(n);display:block;font:500 13px ui-monospace,Menlo,monospace;color:var(--accent-fg);margin-bottom:2px}
.cx-next b{display:block;color:var(--text);font-weight:600}
.cx-foot{margin-top:auto;font-size:13.5px;color:var(--muted);display:flex;gap:16px;flex-wrap:wrap}
.cx-foot a{color:var(--muted)}
.cx-form{grid-area:form;background:var(--surface);border-left:1px solid var(--divider);padding:36px 44px;display:flex;flex-direction:column;justify-content:center;max-width:none;margin:0;width:auto}
.cx-col{width:100%;max-width:420px;margin:0 auto}
.cx .panel{background:none;border:0;box-shadow:none;padding:0;border-radius:0}
.cx .field{margin:14px 0 0}
.cx .two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.cx .two .field{margin-top:0}
.cx .field label,.cx .contact legend{font-size:13px}
.cx .inp{border-radius:8px;min-height:40px}
.cx .inp input{font-size:15px;height:38px}
.cx .ta{border-radius:8px;font-size:15px;min-height:76px}
.cx .grp{margin:18px 0 0}
.cx .contact legend{margin-bottom:6px}
.cx .opts.picks{grid-template-columns:repeat(4,1fr);gap:6px}
.cx .pick{position:relative;border:1px solid var(--border);border-radius:8px;padding:8px 6px;justify-content:center;text-align:center;font-size:14px}
.cx .pick input{position:absolute;opacity:0;inset:0;width:100%;height:100%;margin:0;cursor:pointer}
.cx .pick:has(input:checked){border-color:var(--accent);background:var(--accent-soft);font-weight:600;box-shadow:inset 0 0 0 1px var(--accent)}
.cx .pick:has(input:focus-visible){outline:2px solid var(--accent);outline-offset:2px}
.cx .opts.checks{grid-template-columns:1fr 1fr;gap:6px 12px}
.cx .opts.checks .opt{font-size:14.5px}
.cx .cta{min-height:44px;margin-top:18px;border-radius:9px;font-size:14.5px}
.cx-priv{font-size:13px;color:var(--muted);margin:10px 0 0;text-align:center}
.cx .panel .cx-priv{color:var(--muted);margin:10px 0 0}
.cx-from{display:flex;gap:8px;align-items:center;background:var(--sunken);border-radius:8px;padding:8px 10px;font-size:13.5px;color:var(--text2);margin-bottom:14px}
.cx-from .mark{width:16px;height:16px}
.cx-done{text-align:center;max-width:380px;margin:0 auto}
.cx-tick{width:52px;height:52px;border-radius:50%;background:var(--ok-soft);display:grid;place-items:center;margin:0 auto 14px}
.cx-tick svg{width:26px;height:26px;stroke:var(--ok);fill:none;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}
.cx-done h2{font-size:22px;margin:0 0 6px;letter-spacing:-.015em}
.cx .panel.cx-done p{color:var(--text2);margin:0;font-size:15.5px}
.cx-done .btn{margin-top:20px;min-height:44px;border-radius:9px;text-decoration:none}
@media (max-width:820px){
.cx{grid-template-columns:1fr;grid-template-areas:"head" "form" "more";grid-template-rows:auto;min-height:0}
.cx-head{padding:20px 18px 18px;gap:14px}
.cx-t{font-size:28px;max-width:none}
.cx-s{font-size:15.5px}
.cx-form{border-left:0;border-top:1px solid var(--divider);padding:18px}
.cx-more{padding:22px 18px 28px;gap:14px}
.cx-adds ul{gap:8px}
.cx-adds span,.cx-next{display:none}
.cx-self{display:none}
.cx-foot{margin-top:0}
.cx .two{grid-template-columns:1fr;gap:0}
.cx .two .field{margin-top:14px}
.cx .two .field:first-child{margin-top:0}
.cx .opts.picks{grid-template-columns:repeat(2,1fr)}
.cx .opts.checks{grid-template-columns:1fr}
}
`;
