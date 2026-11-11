/* Waddle's illustrated, interactive product tour. All artwork is hand-drawn inline SVG/CSS. */
(function () {
  'use strict';

  var menuButton = document.getElementById('menuToggle');
  var menu = document.getElementById('mobileNav');
  if (menuButton && menu) {
    menuButton.addEventListener('click', function () {
      var open = menuButton.getAttribute('aria-expanded') !== 'true';
      menuButton.setAttribute('aria-expanded', String(open));
      menu.hidden = !open;
    });
    menu.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        menu.hidden = true;
        menuButton.setAttribute('aria-expanded', 'false');
      });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !menu.hidden) {
        menu.hidden = true;
        menuButton.setAttribute('aria-expanded', 'false');
        menuButton.focus();
      }
    });
  }

  var chainLength = 1;
  var chain = document.getElementById('routeChain');
  var hopCount = document.getElementById('hopCount');
  var hopMinus = document.getElementById('hopMinus');
  var hopPlus = document.getElementById('hopPlus');
  var icons = {
    you: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.3"/><path d="M5.5 20c.5-3.6 2.7-5.5 6.5-5.5s6 1.9 6.5 5.5"/></svg>',
    relay:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v14H5zM9 9h6m-6 3h6m-6 3h3"/><path d="M8 2v3m8-3v3M8 19v3m8-3v3"/></svg>',
    exit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h14m-5-5 5 5-5 5"/><circle cx="5" cy="12" r="2"/></svg>',
    site: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3.5 12h17M12 3c2.4 2.4 3.5 5.4 3.5 9s-1.1 6.6-3.5 9c-2.4-2.4-3.5-5.4-3.5-9S9.6 5.4 12 3z"/></svg>',
  };
  function makeChainNode(kind, label, detail) {
    var node = document.createElement('div');
    node.className = 'chain-node ' + kind;
    var icon = document.createElement('span');
    icon.className = 'node-icon';
    icon.innerHTML = icons[kind];
    var title = document.createElement('b');
    title.textContent = label;
    var sub = document.createElement('small');
    sub.textContent = detail;
    node.appendChild(icon);
    node.appendChild(title);
    node.appendChild(sub);
    return node;
  }
  function drawChain() {
    if (!chain) return;
    chain.textContent = '';
    chain.appendChild(makeChainNode('you', 'Your browser', 'here'));
    for (var i = 0; i < chainLength; i++) {
      var exit = i === chainLength - 1;
      chain.appendChild(
        makeChainNode(exit ? 'exit' : 'relay', exit ? 'Exit proxy' : 'Relay ' + (i + 1), exit ? 'site sees this' : 'next hop only')
      );
    }
    chain.appendChild(makeChainNode('site', 'Website', 'destination'));
    chain.setAttribute(
      'aria-label',
      'Browser through ' + chainLength + (chainLength === 1 ? ' proxy exit' : ' proxy hops') + ' to a website'
    );
    if (hopCount) hopCount.textContent = chainLength + (chainLength === 1 ? ' hop' : ' hops');
    if (hopMinus) hopMinus.disabled = chainLength <= 1;
    if (hopPlus) hopPlus.disabled = chainLength >= 16;
  }
  if (hopMinus)
    hopMinus.addEventListener('click', function () {
      chainLength = Math.max(1, chainLength - 1);
      drawChain();
    });
  if (hopPlus)
    hopPlus.addEventListener('click', function () {
      chainLength = Math.min(16, chainLength + 1);
      drawChain();
    });
  drawChain();

  var resolverNames = ['Cloudflare', 'Quad9', 'Google'];
  var resolverHosts = ['cloudflare-dns.com', 'dns.quad9.net', 'dns.google'];
  var resolverList = document.getElementById('resolverList');
  var resolverCount = document.getElementById('resolverCount');
  var addResolver = document.getElementById('addResolver');
  var strategyNote = document.getElementById('strategyNote');
  var strategyCopy = {
    fallback: 'If one resolver is slow or unavailable, the next can answer through the same proxy route.',
    race: 'Ask several resolvers together; use the first usable answer. More parallel checks use more server bandwidth.',
    check: 'Ask multiple resolvers for the same answer. Conflicting answers are surfaced instead of silently trusted.',
  };
  function drawResolvers() {
    if (!resolverList) return;
    resolverList.textContent = '';
    resolverNames.forEach(function (name, index) {
      var row = document.createElement('div');
      row.className = 'resolver-row';
      var number = document.createElement('span');
      number.className = 'resolver-num';
      number.textContent = String(index + 1).padStart(2, '0');
      var label = document.createElement('span');
      label.className = 'resolver-label';
      label.textContent = name;
      var host = document.createElement('span');
      host.className = 'resolver-host';
      host.textContent = resolverHosts[index];
      var dot = document.createElement('i');
      dot.className = 'resolver-dot';
      dot.setAttribute('aria-label', 'example endpoint');
      row.appendChild(number);
      row.appendChild(label);
      row.appendChild(host);
      row.appendChild(dot);
      resolverList.appendChild(row);
    });
    if (resolverCount) resolverCount.textContent = resolverNames.length + ' / 64 in stack';
    if (addResolver) {
      addResolver.disabled = resolverNames.length >= 64;
      addResolver.setAttribute('aria-label', resolverNames.length >= 64 ? 'Demo stack is full' : 'Add a demo resolver');
    }
  }
  if (addResolver)
    addResolver.addEventListener('click', function () {
      if (resolverNames.length >= 64) return;
      var index = resolverNames.length + 1;
      resolverNames.push('Resolver ' + index);
      resolverHosts.push('your-resolver-' + index + '.example');
      drawResolvers();
    });
  document.querySelectorAll('.strategy').forEach(function (button) {
    button.addEventListener('click', function () {
      document.querySelectorAll('.strategy').forEach(function (other) {
        var selected = other === button;
        other.classList.toggle('on', selected);
        other.setAttribute('aria-pressed', String(selected));
      });
      if (strategyNote) strategyNote.textContent = strategyCopy[button.getAttribute('data-strategy')] || strategyCopy.fallback;
    });
  });
  drawResolvers();

  var tabUnix = document.getElementById('tabUnix');
  var tabWindows = document.getElementById('tabWindows');
  var unixCode = document.getElementById('unixCode');
  var windowsCode = document.getElementById('windowsCode');
  function selectPlatform(platform) {
    var unix = platform === 'unix';
    tabUnix.classList.toggle('on', unix);
    tabWindows.classList.toggle('on', !unix);
    tabUnix.setAttribute('aria-selected', String(unix));
    tabWindows.setAttribute('aria-selected', String(!unix));
    unixCode.hidden = !unix;
    windowsCode.hidden = unix;
  }
  if (tabUnix && tabWindows) {
    tabUnix.addEventListener('click', function () {
      selectPlatform('unix');
    });
    tabWindows.addEventListener('click', function () {
      selectPlatform('windows');
    });
    [tabUnix, tabWindows].forEach(function (tab) {
      tab.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          var next = tab === tabUnix ? tabWindows : tabUnix;
          next.focus();
          selectPlatform(next.getAttribute('data-platform'));
        }
      });
    });
  }

  var toast = document.getElementById('tourToast');
  var toastTimer = 0;
  function announce(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toast.hidden = true;
    }, 2200);
  }
  function fallbackCopy(text) {
    var field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (error) {
      ok = false;
    }
    field.remove();
    return ok;
  }
  document.querySelectorAll('[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () {
      var command = button.getAttribute('data-copy');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(command).then(
          function () {
            announce('Install command copied');
          },
          function () {
            announce(fallbackCopy(command) ? 'Install command copied' : 'Copy did not work — select the command to copy it');
          }
        );
      } else announce(fallbackCopy(command) ? 'Install command copied' : 'Copy did not work — select the command to copy it');
    });
  });

  var reveals = document.querySelectorAll('[data-reveal]');
  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -20px 0px' }
    );
    reveals.forEach(function (element) {
      observer.observe(element);
    });
  } else
    reveals.forEach(function (element) {
      element.classList.add('is-visible');
    });
})();
