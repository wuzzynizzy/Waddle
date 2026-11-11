'use strict';
// The pages Waddle writes itself: what is shown when a site cannot be loaded, and the
// "what sites see" check. Both are plain documents served in place of a proxied page.

const { encode, PREFIX } = require('./rewrite');
const { countryName } = require('./geo');

const esc = (s) => encode(String(s == null ? '' : s));

// Shared look: the same tokens as the app, small enough to inline.
const STYLE =
  '@font-face{font-family:Geist;src:url(/-/fonts/geist.woff2) format("woff2");font-weight:100 900;font-display:swap}' +
  '@font-face{font-family:"Geist Mono";src:url(/-/fonts/geist-mono.woff2) format("woff2");font-weight:100 900;font-display:swap}' +
  ':root{--bg:#f5f6f8;--card:#fff;--line:#e2e6eb;--text:#0e1620;--muted:#5d6875;--accent:#ff8a1f;--ink:#1c1206;--ok:#12805c;--bad:#c62828;--warn:#a15c00;color-scheme:light}' +
  '@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0b0f14;--card:#121821;--line:#232c38;--text:#e9eef4;--muted:#94a1b0;--ok:#4ad3a2;--bad:#ff7b72;--warn:#f0b35a;color-scheme:dark}}' +
  ':root[data-theme=dark]{--bg:#0b0f14;--card:#121821;--line:#232c38;--text:#e9eef4;--muted:#94a1b0;--ok:#4ad3a2;--bad:#ff7b72;--warn:#f0b35a;color-scheme:dark}' +
  '*{box-sizing:border-box}html{height:100%}' +
  'body{margin:0;min-height:100%;display:grid;place-items:center;padding:32px 20px;background:var(--bg);color:var(--text);' +
  'font:15px/1.55 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}' +
  'main{width:100%;max-width:440px}' +
  'img.mark{width:44px;height:44px;display:block;margin:0 0 20px}' +
  'h1{font-size:22px;line-height:1.25;font-weight:650;letter-spacing:-.01em;margin:0 0 8px}' +
  'p{margin:0 0 6px;color:var(--muted);overflow-wrap:anywhere}' +
  '.host{font:13px/1.5 "Geist Mono",ui-monospace,Menlo,Consolas,monospace;color:var(--muted);margin:14px 0 0;overflow-wrap:anywhere}' +
  '.row{display:flex;flex-wrap:wrap;gap:10px;margin:26px 0 0}' +
  'button,a.btn{font:inherit;font-weight:550;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:10px;' +
  'padding:9px 16px;cursor:pointer;text-decoration:none;display:inline-block}' +
  'button:hover,a.btn:hover{border-color:var(--muted)}button:focus-visible,a.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}' +
  'button.go{background:var(--accent);border-color:var(--accent);color:var(--ink)}button[hidden]{display:none}' +
  '.wait{margin:18px 0 0;font-size:13px;color:var(--muted);min-height:1.5em}';

/**
 * The page shown instead of a site that could not be loaded.
 * @param {object} o { title, detail, target: URL|null, theme, actions: string[], retry: seconds|0, code }
 */
function errorHtml(o) {
  const href = o.target ? PREFIX + o.target.href : '/';
  const has = (a) => (o.actions || []).includes(a);
  const theme = o.theme === 'light' || o.theme === 'dark' ? ' data-theme="' + o.theme + '"' : '';
  return (
    '<!doctype html><html lang="en"' +
    theme +
    '><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="same-origin"><title>' +
    esc(o.title) +
    '</title><style>' +
    STYLE +
    '</style></head><body><main>' +
    '<img class="mark" src="/-/icon.svg" alt="">' +
    '<h1>' +
    esc(o.title) +
    '</h1>' +
    (o.detail ? '<p>' + esc(o.detail) + '</p>' : '') +
    (o.target ? '<div class="host">' + esc(o.target.host) + '</div>' : '') +
    '<div class="row">' +
    '<button class="go" data-act="retry">Try again</button>' +
    (has('exit') ? '<button data-act="exit" hidden>New exit</button>' : '') +
    (has('plain') ? '<button data-act="plain" hidden>Continue without HTTPS</button>' : '') +
    (has('proxies') ? '<button data-act="proxies" hidden>Proxies</button>' : '') +
    '</div><div class="wait" id="wait" role="status"></div></main>' +
    '<script>(function(){' +
    'var data=' +
    JSON.stringify({
      url: o.target ? o.target.href : '',
      host: o.target ? o.target.hostname : '',
      title: o.title,
      retry: o.retry || 0,
      code: o.code || '',
    }).replace(/</g, '\\u003c') +
    ';var shell=null;try{if(parent!==window&&parent.location.origin===location.origin&&parent.location.pathname.indexOf("/~/")!==0)shell=parent}catch(e){}' +
    'function tell(m){m.waddle=1;if(shell)shell.postMessage(m,location.origin)}' +
    'tell({kind:"load",url:data.url,title:data.title,error:data.code||"error"});' +
    'var b=document.querySelectorAll("button[data-act]");for(var i=0;i<b.length;i++)(function(el){var a=el.getAttribute("data-act");' +
    'if(a!=="retry"){if(!shell)return;el.hidden=false}' +
    'el.onclick=function(){if(a==="retry"||!shell){location.replace(' +
    JSON.stringify(href).replace(/</g, '\\u003c') +
    ');return}tell({kind:"action",action:a,host:data.host,url:data.url})}})(b[i]);' +
    // While the pool is still finding its first proxy, keep trying quietly.
    'if(data.retry){var n=data.retry,tries=+(sessionStorage.getItem("w-retry:"+data.url)||0),w=document.getElementById("wait");' +
    'if(tries<40){var t=setInterval(function(){w.textContent="Trying again in "+n+" s";if(n--<=0){clearInterval(t);' +
    'sessionStorage.setItem("w-retry:"+data.url,tries+1);location.replace(' +
    JSON.stringify(href).replace(/</g, '\\u003c') +
    ')}},1000)}}else{try{sessionStorage.removeItem("w-retry:"+data.url)}catch(e){}}' +
    '})()</script></body></html>'
  );
}

const CHECK_STYLE =
  'body{place-items:start center;padding:40px 20px 64px}main{max-width:720px}' +
  'h1{font-size:24px}h2{font-size:13px;font-weight:600;color:var(--muted);margin:34px 0 10px;letter-spacing:.01em}' +
  'table{width:100%;table-layout:fixed;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;border-spacing:0}' +
  'tr+tr td,tr+tr th{border-top:1px solid var(--line)}th,td{text-align:left;padding:11px 16px;vertical-align:top;font-weight:400}' +
  'th{color:var(--muted);overflow-wrap:anywhere}td{overflow-wrap:anywhere}' +
  'thead th:first-child,#sent th{width:170px}thead th.r{width:34%}' +
  'td.v{font:13px/1.6 "Geist Mono",ui-monospace,Menlo,Consolas,monospace}td.r{color:var(--muted);font-size:13px}' +
  'thead th{font-size:12px;color:var(--muted);background:transparent}' +
  '.pill{display:inline-block;font:500 12px/1 Geist,system-ui,sans-serif;padding:4px 8px;border-radius:999px;border:1px solid var(--line);margin-left:8px;white-space:nowrap;vertical-align:1px}' +
  '.pill.ok{color:var(--ok)}.pill.bad{color:var(--bad)}.pill.warn{color:var(--warn)}.pill.same{color:var(--muted)}' +
  '.lead{font-size:16px;color:var(--text);margin:0 0 4px}.sub{font-size:13px}' +
  '@media(max-width:560px){td.r,thead th.r{display:none}thead th:first-child,#sent th{width:110px}}';

/**
 * "What sites see": a page that looks at itself the way any site could, next to what the
 * browser really is (handed over by Waddle's own window in the address fragment, which
 * never leaves the browser).
 * @param {object} o { inject, theme, exit: {ip, cc, hops: [{proto, addr, cc}]}|null, exitError, sent: {name: value}, policy: {...} }
 */
function checkHtml(o) {
  const theme = o.theme === 'light' || o.theme === 'dark' ? ' data-theme="' + o.theme + '"' : '';
  const data = JSON.stringify({
    exit: o.exit,
    exitError: o.exitError || '',
    sent: o.sent || {},
    policy: o.policy || {},
    detectable: !!o.detectable,
    visitor: o.visitor || '',
  }).replace(/</g, '\\u003c');
  const place = o.exit && o.exit.cc ? countryName(o.exit.cc) : '';
  return (
    '<!doctype html><html lang="en"' +
    theme +
    '><head>' +
    (o.inject || '') +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>What sites see</title><style>' +
    STYLE +
    CHECK_STYLE +
    '</style></head><body><main>' +
    '<img class="mark" src="/-/icon.svg" alt="">' +
    '<h1>What sites see</h1>' +
    '<p class="lead">' +
    (o.exit
      ? 'A site you open now is visited from <b>' +
        esc(o.exit.ip || 'an unknown address') +
        '</b>' +
        (place ? ' in ' + esc(place) : '') +
        '.'
      : esc(o.exitError || 'No exit could be tested.')) +
    '</p>' +
    '<p class="sub" id="path"></p>' +
    '<h2>Connection</h2><table id="net"><thead><tr><th></th><th>Sites see</th><th class="r">Really</th></tr></thead><tbody></tbody></table>' +
    '<h2>Browser</h2><table id="fp"><thead><tr><th></th><th>Sites see</th><th class="r">Really</th></tr></thead><tbody></tbody></table>' +
    '<h2>Sent with every request</h2><table id="sent"></table>' +
    '</main><script>(function(){var D=' +
    data +
    ';var real={};try{real=JSON.parse(decodeURIComponent(location.hash.slice(1))||"{}")}catch(e){}' +
    'function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}' +
    'function pill(k,x){return el("span","pill "+k,x)}' +
    'function row(tb,name,seen,was,verdict){var tr=el("tr");tr.appendChild(el("th","",name));var td=el("td","v",seen==null||seen===""?"none":String(seen));' +
    'if(verdict)td.appendChild(pill(verdict[0],verdict[1]));tr.appendChild(td);' +
    // nothing to set it against: the value takes the whole width
    'if(was==null||was==="")td.colSpan=2;else tr.appendChild(el("td","r",String(was)));tb.appendChild(tr);return td}' +
    'function cmp(seen,was){if(was==null||was==="")return null;return String(seen)===String(was)?["same","same as real"]:["ok","changed"]}' +
    // connection
    'var net=document.querySelector("#net tbody");' +
    'if(D.exit){row(net,"Address",D.exit.ip||"unknown",D.visitor,!D.exit.ip?null:D.visitor&&D.visitor===D.exit.ip?["bad","your own address"]:["ok","not yours"]);' +
    'row(net,"Country",D.exit.cc||"unknown","");' +
    'document.getElementById("path").textContent="Path: you → "+D.exit.hops.map(function(h){return h.proto+" "+(h.cc||"??")}).join(" → ")+" → site";}' +
    'else row(net,"Address","not tested",D.visitor,["warn","no exit"]);' +
    'row(net,"Name lookups",D.policy.dns,"");row(net,"HTTPS only",D.policy.https?"on":"off","");' +
    'row(net,"Other sites\' cookies",D.policy.cookies,"");row(net,"Trackers",D.policy.trackers?"refused":"allowed","");' +
    // browser
    'var fp=document.querySelector("#fp tbody"),n=navigator,i=Intl.DateTimeFormat().resolvedOptions();' +
    'row(fp,"Browser",n.userAgent,real.ua,cmp(n.userAgent,real.ua));' +
    'if(D.detectable)row(fp,"","The claimed browser is a different engine from the real one. A site that tests for it can tell.",undefined,["warn","detectable"]);' +
    'row(fp,"Platform",n.platform,real.platform,cmp(n.platform,real.platform));' +
    'row(fp,"Languages",(n.languages||[n.language]).join(", "),real.languages,cmp((n.languages||[n.language]).join(", "),real.languages));' +
    'row(fp,"Time zone",i.timeZone,real.tz,cmp(i.timeZone,real.tz));' +
    'row(fp,"Clock",new Date().toString().replace(/^\\S+ /,""),real.clock);' +
    'var sc=screen.width+" × "+screen.height+" @"+devicePixelRatio;row(fp,"Screen",sc,real.screen,cmp(sc,real.screen));' +
    'row(fp,"Processor cores",n.hardwareConcurrency,real.cores,cmp(n.hardwareConcurrency,real.cores));' +
    'if("deviceMemory" in n||real.memory){var mem="deviceMemory" in n?n.deviceMemory+" GB":"not exposed",rm=real.memory?real.memory+" GB":"";row(fp,"Memory",mem,rm,cmp(mem,rm))}' +
    'row(fp,"Touch points",n.maxTouchPoints,real.touch,cmp(n.maxTouchPoints,real.touch));' +
    'var gl="";try{var c=document.createElement("canvas"),g=c.getContext("webgl")||c.getContext("experimental-webgl"),x=g&&g.getExtension("WEBGL_debug_renderer_info");' +
    'gl=g?(x?g.getParameter(x.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER)):"no WebGL"}catch(e){gl="blocked"}row(fp,"Graphics",gl,real.gl,cmp(gl,real.gl));' +
    'var cv="";try{var c2=document.createElement("canvas");c2.width=220;c2.height=40;var k=c2.getContext("2d");k.textBaseline="top";k.font="16px Arial";k.fillStyle="#f60";k.fillRect(100,2,80,24);' +
    'k.fillStyle="#069";k.fillText("Waddle, 1.0 \\ud83d\\udc27",2,8);var u=c2.toDataURL(),h=0;for(var j=0;j<u.length;j++)h=(h*31+u.charCodeAt(j))|0;cv=(h>>>0).toString(16)}catch(e){cv="blocked"}' +
    'row(fp,"Canvas print",cv,real.canvas,cmp(cv,real.canvas));' +
    'row(fp,"Plugins",n.plugins?n.plugins.length:0,real.plugins,cmp(n.plugins?n.plugins.length:0,real.plugins));' +
    'row(fp,"Do not track",(n.doNotTrack==="1"?"on":"off")+(n.globalPrivacyControl?" + GPC":""));' +
    'var rt=row(fp,"WebRTC","testing…",real.webrtc);' +
    '(function(){var P=window.RTCPeerConnection||window.webkitRTCPeerConnection;if(!P){rt.textContent="not available";rt.appendChild(pill("ok","no leak"));return}' +
    'var found=[],pc;try{pc=new P({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});pc.createDataChannel("x");' +
    'pc.onicecandidate=function(e){if(e.candidate&&e.candidate.candidate){var m=/ (\\d+\\.\\d+\\.\\d+\\.\\d+|[0-9a-f:]{6,}|[\\w-]+\\.local) \\d+ typ (\\w+)/.exec(e.candidate.candidate);if(m)found.push(m[1]+" ("+m[2]+")")}};' +
    'pc.createOffer().then(function(o){return pc.setLocalDescription(o)}).catch(function(){});' +
    'setTimeout(function(){rt.textContent=found.length?found.join(", "):"no addresses";rt.appendChild(found.length?pill("bad","exposed"):pill("ok","no leak"));try{pc.close()}catch(e){}},2500)}' +
    'catch(e){rt.textContent="blocked";rt.appendChild(pill("ok","no leak"))}})();' +
    'var ge=row(fp,"Location",D.policy.geo==="block"?"refused":D.policy.geo==="exit"?"testing…":"your browser asks you first","");' +
    'if(D.policy.geo==="exit"&&n.geolocation)n.geolocation.getCurrentPosition(function(p){ge.textContent=p.coords.latitude.toFixed(2)+", "+p.coords.longitude.toFixed(2)+" (made up, in the exit\'s country)"},function(){ge.textContent="refused"});' +
    // sent headers
    'var st=document.getElementById("sent");Object.keys(D.sent).forEach(function(k){row(st,k,D.sent[k])});' +
    'try{var shell=parent!==window&&parent.location.pathname.indexOf("/~/")!==0?parent:null;if(shell)shell.postMessage({waddle:1,kind:"load",url:"https://check.waddle.invalid/",title:"What sites see"},location.origin)}catch(e){}' +
    '})()</script></body></html>'
  );
}

module.exports = { errorHtml, checkHtml, STYLE };
