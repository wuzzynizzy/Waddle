'use strict';
// A short list of hosts that exist to follow people between sites or to serve ads. Requests to
// them are refused before they leave. It is deliberately small and conservative: only names
// whose whole purpose is tracking or advertising, so that refusing them does not break pages.
// Anything else can be blocked with a routing rule ("<pattern> block").

const LIST = `
google-analytics.com googletagmanager.com googletagservices.com googlesyndication.com googleadservices.com
doubleclick.net adservice.google.com pagead2.googlesyndication.com analytics.google.com app-measurement.com
2mdn.net admob.com
connect.facebook.net pixel.facebook.com an.facebook.com graph.facebook.com/tr facebook.com/tr
analytics.twitter.com ads-twitter.com static.ads-twitter.com t.co/i/adsct ads.linkedin.com px.ads.linkedin.com snap.licdn.com
analytics.tiktok.com ads.tiktok.com business-api.tiktok.com
bat.bing.com clarity.ms c.bing.com
scorecardresearch.com quantserve.com quantcount.com comscore.com chartbeat.com chartbeat.net
hotjar.com hotjar.io mouseflow.com fullstory.com logrocket.com logrocket.io smartlook.com inspectlet.com crazyegg.com luckyorange.com
segment.com segment.io cdn.segment.com mixpanel.com amplitude.com heap.io heapanalytics.com kissmetrics.com kissmetrics.io
newrelic.com nr-data.net bugsnag.com
optimizely.com vwo.com visualwebsiteoptimizer.com abtasty.com
criteo.com criteo.net taboola.com outbrain.com adnxs.com rubiconproject.com pubmatic.com openx.net casalemedia.com
adsrvr.org amazon-adsystem.com moatads.com adform.net smartadserver.com bidswitch.net 3lift.com sharethrough.com
teads.tv yieldmo.com media.net contextweb.com indexww.com lijit.com sovrn.com gumgum.com triplelift.com
adroll.com rlcdn.com bluekai.com krxd.net demdex.net everesttech.net omtrdc.net 2o7.net exelator.com eyeota.net
agkn.com crwdcntrl.net tapad.com adsymptotic.com liadm.com id5-sync.com intentiq.com zeotap.com
mathtag.com turn.com dotomi.com serving-sys.com flashtalking.com adition.com yieldlab.net stickyadstv.com
spotxchange.com freewheel.tv fwmrm.net tremorhub.com advertising.com adtechus.com adtech.de
onetrust.com/logs cookielaw.org/logs
branch.io appsflyer.com adjust.com kochava.com singular.net
mc.yandex.ru an.yandex.ru top-fwz1.mail.ru counter.yadro.ru hm.baidu.com cnzz.com umeng.com
statcounter.com histats.com clicky.com getclicky.com matomo.cloud piwik.pro woopra.com gaug.es
addthis.com sharethis.com addtoany.com
zemanta.com revcontent.com mgid.com adblade.com propellerads.com popads.net popcash.net exoclick.com juicyads.com
trafficjunky.net trafficjunky.com adsterra.com hilltopads.net clickadu.com
braze.com appboy.com onesignal.com pushwoosh.com pushcrew.com izooto.com
permutive.com permutive.app parsely.com parse.ly keywee.co
`;

const hosts = new Set();
const paths = []; // "host/path prefix" entries
for (const item of LIST.split(/\s+/)) {
  if (!item) continue;
  const cut = item.indexOf('/');
  if (cut < 0) hosts.add(item);
  else paths.push([item.slice(0, cut), item.slice(cut)]);
}

/**
 * Is this request going to a known tracker?
 * @param {string} host lower-case host name
 * @param {string} [pathname]
 */
function isTracker(host, pathname) {
  let h = String(host || '').toLowerCase();
  for (;;) {
    if (hosts.has(h)) return true;
    const dot = h.indexOf('.');
    if (dot < 0) break;
    h = h.slice(dot + 1);
  }
  if (pathname) {
    h = String(host).toLowerCase();
    for (const [name, prefix] of paths) if ((h === name || h.endsWith('.' + name)) && pathname.startsWith(prefix)) return true;
  }
  return false;
}

module.exports = { isTracker, size: hosts.size + paths.length };
