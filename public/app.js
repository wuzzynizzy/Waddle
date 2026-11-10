/* Waddle shell: address bar, the page frame, and the settings drawer. */
(function () {
  'use strict';
  var $ = function (s, r) {
    return (r || document).querySelector(s);
  };
  var el = function (tag, attrs, kids) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    [].concat(kids || []).forEach(function (c) {
      if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  };
  var api = function (path, body) {
    return fetch('/-/api/' + path, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: body ? { 'x-waddle': '1', 'content-type': 'application/json' } : { 'x-waddle': '1' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json();
    });
  };

  var frame = $('#frame');
  var addr = $('#addr');
  var state = null; // last /-/api/state
  var current = ''; // real URL shown in the frame
  var tab = 'route';
  var extra = {}; // transient results (speed test, dns test)
  var drafts = {}; // text typed into the drawer but not yet submitted, by element id
  var writes = 0; // settings changes made here; a state reply that predates one is stale
  var P = '/~/';

  // ---- navigation -----------------------------------------------------------------
  function resolve(text) {
    var t = String(text || '').trim();
    if (!t) return null;
    if (/^https?:\/\//i.test(t)) return t;
    if (
      !/\s/.test(t) &&
      (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(t) ||
        /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/.*)?$/.test(t) ||
        /^localhost(?::\d+)?(?:\/.*)?$/i.test(t))
    )
      return 'https://' + t;
    var search = (state && state.config.ui.search) || 'https://duckduckgo.com/html/?q=%s';
    return search.replace('%s', encodeURIComponent(t));
  }
  function show(url) {
    current = url || '';
    addr.value = current;
    document.body.classList.toggle('browsing', !!current);
    try {
      history.replaceState(null, '', current ? '#' + current : location.pathname);
    } catch (e) {
      /* sandboxed */
    }
    if (!current) document.title = 'Waddle';
  }
  function go(text) {
    var url = resolve(text);
    if (!url) return;
    show(url);
    document.body.classList.add('loading');
    frame.src = P + url;
    addr.blur();
  }
  function home() {
    show('');
    document.body.classList.remove('loading');
    frame.removeAttribute('src');
    try {
      frame.contentWindow.location.replace('about:blank');
    } catch (e) {
      /* gone */
    }
    $('#q').value = '';
    $('#q').focus();
  }
  $('#nav').addEventListener('submit', function (e) {
    e.preventDefault();
    go(addr.value);
  });
  $('#start').addEventListener('submit', function (e) {
    e.preventDefault();
    go($('#q').value);
  });
  addr.addEventListener('focus', function () {
    addr.select();
  });
  $('#home').addEventListener('click', home);
  $('#back').addEventListener('click', function () {
    try {
      frame.contentWindow.history.back();
    } catch (e) {
      /* cross-origin */
    }
  });
  $('#fwd').addEventListener('click', function () {
    try {
      frame.contentWindow.history.forward();
    } catch (e) {
      /* cross-origin */
    }
  });
  $('#reload').addEventListener('click', function () {
    document.body.classList.add('loading');
    try {
      frame.contentWindow.location.reload();
    } catch (e) {
      frame.src = P + current;
    }
  });
  $('#rotate').addEventListener('click', function () {
    var host = '';
    try {
      host = new URL(current).hostname;
    } catch (e) {
      /* none */
    }
    api('pool', { action: 'rotate', site: host }).then(function (s) {
      apply(s);
      $('#reload').click();
    });
  });
  frame.addEventListener('load', function () {
    document.body.classList.remove('loading');
    refresh();
    try {
      // pages without the page script (errors, downloads) still report where they are
      var href = frame.contentWindow.location.href;
      var at = href.indexOf(P);
      if (at >= 0 && href.indexOf(location.origin) === 0) {
        addr.value = current = href.slice(at + P.length);
      }
    } catch (e) {
      /* cross-origin */
    }
  });
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (e.origin !== location.origin || e.source !== frame.contentWindow || !m || m.waddle !== 1) return;
    if (m.kind === 'leave') {
      document.body.classList.add('loading');
      return;
    }
    if (m.url) {
      current = m.url;
      if (document.activeElement !== addr) addr.value = m.url;
      try {
        history.replaceState(null, '', '#' + m.url);
      } catch (err) {
        /* sandboxed */
      }
    }
    document.title = m.title ? m.title + ' · Waddle' : 'Waddle';
    if (m.kind === 'start') document.body.classList.add('loading');
    if (m.kind === 'ready' || m.kind === 'load') {
      document.body.classList.remove('loading');
      refresh();
    }
    fit(m.viewport);
    frame.style.colorScheme = m.theme || '';
  });

  // Lock the page to the spoofed screen's shape: lay it out at that size, then scale to fit.
  var locked = null;
  function fit(v) {
    if (v !== undefined) locked = v;
    var box = $('#fit');
    if (!locked) {
      frame.style.cssText = '';
      return;
    }
    var w = locked[0];
    var h = locked[1];
    var k = Math.min(box.clientWidth / w, box.clientHeight / h);
    frame.style.width = w + 'px';
    frame.style.height = h + 'px';
    frame.style.transform = 'scale(' + k + ')';
    frame.style.left = Math.max(0, (box.clientWidth - w * k) / 2) + 'px';
    frame.style.top = Math.max(0, (box.clientHeight - h * k) / 2) + 'px';
  }
  window.addEventListener('resize', function () {
    fit();
  });

  // ---- state ----------------------------------------------------------------------
  function hops(last) {
    if (!last) return '';
    if (last.error) return last.error;
    if (last.direct) return (last.fellBack ? 'direct (no proxy answered)' : 'direct') + ' · ' + last.ms + ' ms';
    var chain = (last.hops || [])
      .map(function (h) {
        return h.cc || h.proto;
      })
      .join(' › ');
    return chain + ' · ' + last.ms + ' ms';
  }
  function apply(s, force) {
    if (!s || !s.config) return;
    state = s;
    var p = s.pool;
    var last = p.last;
    var dot = $('#route i');
    dot.className =
      last && last.error ? 'bad' : last && !last.direct ? 'ok' : p.alive ? 'ok' : s.config.route.mode === 'direct' ? '' : 'warn';
    $('#route span').textContent =
      document.body.classList.contains('browsing') && last ? hops(last) : p.alive + (p.alive === 1 ? ' proxy' : ' proxies');
    var chips = $('#chips');
    chips.textContent = '';
    var sys =
      (
        s.options.systems.filter(function (x) {
          return x.id === s.config.spoof.system;
        })[0] || {}
      ).label || s.config.spoof.system;
    [
      ['proxies', p.alive + ' live · ' + p.found.toLocaleString() + ' found', p.alive ? 'ok' : p.status === 'paused' ? 'warn' : ''],
      [
        'route',
        { auto: 'Auto', proxy: 'Proxies only', direct: 'Direct' }[s.config.route.mode] +
          (s.config.route.hops > 1 ? ' · ' + s.config.route.hops + ' hops' : ''),
        '',
      ],
      [
        'dns',
        s.config.dns.mode === 'doh'
          ? 'DNS · ' + ((s.dns.last && s.dns.last.via) || (s.dns.servers[0] || {}).name || 'encrypted')
          : 'DNS · system',
        '',
      ],
      ['identity', s.config.spoof.on ? sys : 'Real identity', ''],
    ].forEach(function (c) {
      chips.appendChild(
        el(
          'button',
          {
            class: 'chip',
            onclick: function () {
              open(c[0]);
            },
          },
          [c[2] ? el('i', { class: 'dot ' + c[2] }) : null, c[1]]
        )
      );
    });
    if (!$('#drawer').hidden) render(force);
  }
  var busy = false;
  function refresh() {
    if (busy) return;
    busy = true;
    var seen = writes;
    api('state')
      .then(
        function (s) {
          // A reply that was already on its way when a setting changed would undo the change on screen.
          if (seen === writes && !pending) apply(s);
        },
        function () {}
      )
      .then(function () {
        busy = false;
      });
  }
  setInterval(function () {
    if (!document.hidden) refresh();
  }, 4000);

  var pending = null;
  var timer = 0;
  function merge(a, b) {
    for (var k in b) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) a[k] = merge(a[k] || {}, b[k]);
      else a[k] = b[k];
    }
    return a;
  }
  function save(path, v) {
    var patch = {};
    var keys = path.split('.');
    var at = patch;
    keys.forEach(function (k, i) {
      at = at[k] = i === keys.length - 1 ? v : {};
    });
    merge(state.config, JSON.parse(JSON.stringify(patch)));
    pending = merge(pending || {}, patch);
    writes++;
    clearTimeout(timer);
    timer = setTimeout(function () {
      var p = pending;
      pending = null;
      api('config', p).then(apply);
    }, 250);
  }
  var get = function (path) {
    return path.split('.').reduce(function (o, k) {
      return o == null ? o : o[k];
    }, state.config);
  };

  // ---- settings controls ----------------------------------------------------------
  function row(label, control, col) {
    return el('div', { class: 'row' + (col ? ' col' : '') }, [el('label', { text: label }), control]);
  }
  function seg(label, path, opts) {
    var cur = get(path);
    var box = el(
      'div',
      { class: 'seg' },
      opts.map(function (o) {
        var v = Array.isArray(o) ? o[0] : o;
        return el('button', {
          class: String(cur) === String(v) ? 'on' : '',
          text: Array.isArray(o) ? o[1] : String(o),
          onclick: function () {
            save(path, v);
            render(true);
          },
        });
      })
    );
    return row(label, box);
  }
  function tog(label, path, onv, offv) {
    var on = onv === undefined ? !!get(path) : get(path) === onv;
    return row(
      label,
      el('button', {
        class: 'sw' + (on ? ' on' : ''),
        role: 'switch',
        'aria-checked': String(on),
        'aria-label': label,
        onclick: function () {
          save(path, onv === undefined ? !on : on ? offv : onv);
          render(true);
        },
      })
    );
  }
  function num(label, path, scale) {
    scale = scale || 1;
    return row(
      label,
      el('input', {
        type: 'number',
        value: get(path) / scale,
        'data-k': path,
        onchange: function (e) {
          save(path, Number(e.target.value) * scale);
        },
      })
    );
  }
  function txt(label, path, ph, col, list) {
    return row(
      label,
      el('input', {
        type: 'text',
        value: get(path),
        placeholder: ph || '',
        spellcheck: 'false',
        autocomplete: 'off',
        list: list,
        'data-k': path,
        onchange: function (e) {
          save(path, e.target.value);
        },
      }),
      col
    );
  }
  function csv(label, path, ph) {
    return row(
      label,
      el('input', {
        type: 'text',
        value: get(path).join(', '),
        placeholder: ph || '',
        spellcheck: 'false',
        'data-k': path,
        onchange: function (e) {
          save(path, e.target.value.split(/[\s,]+/).filter(Boolean));
        },
      })
    );
  }
  function sel(label, path, opts) {
    var cur = get(path);
    var s = el(
      'select',
      {
        'data-k': path,
        onchange: function (e) {
          save(path, e.target.value);
          render(true);
        },
      },
      opts.map(function (o) {
        return el('option', { value: o[0], selected: o[0] === cur, text: o[1] });
      })
    );
    return row(label, s);
  }
  function multi(label, path, opts) {
    var cur = get(path);
    return row(
      label,
      el(
        'div',
        { class: 'seg' },
        opts.map(function (o) {
          var on = cur.indexOf(o) >= 0;
          return el('button', {
            class: on ? 'on' : '',
            text: o,
            onclick: function () {
              save(
                path,
                on
                  ? cur.filter(function (x) {
                      return x !== o;
                    })
                  : cur.concat(o)
              );
              render(true);
            },
          });
        })
      )
    );
  }
  function btn(text, fn, pri) {
    return el('button', {
      class: 'btn' + (pri ? ' pri' : ''),
      text: text,
      onclick: function (e) {
        var b = e.currentTarget;
        b.disabled = true;
        Promise.resolve(fn())
          .then(
            function (s) {
              if (s && s.config) apply(s, true);
              else render(true);
            },
            function () {}
          )
          .then(function () {
            b.disabled = false;
          });
      },
    });
  }
  var h2 = function (t) {
    return el('h2', { text: t });
  };
  var ms = function (v) {
    return v ? v + ' ms' : '';
  };

  var TABS = {
    route: [
      'Route',
      function (c) {
        var r = [
          seg('Mode', 'route.mode', [
            ['auto', 'Auto'],
            ['proxy', 'Proxies only'],
            ['direct', 'Direct'],
          ]),
          seg('New exit', 'route.rotate', [
            ['sticky', 'Per site'],
            ['request', 'Every request'],
            ['timed', 'Timed'],
          ]),
          c.route.rotate !== 'request' ? num('Keep exit (min)', 'route.minutes') : null,
          seg('Chain', 'route.hops', [
            [1, '1 hop'],
            [2, '2 hops'],
            [3, '3 hops'],
          ]),
          num('Retries', 'route.retries'),
          num('Timeout (s)', 'route.timeout', 1000),
          multi('Protocols', 'route.protocols', ['http', 'socks4', 'socks5']),
          csv('Countries', 'route.countries', 'any'),
          row(
            'Rules',
            el(
              'textarea',
              {
                rows: 5,
                spellcheck: 'false',
                'data-k': 'route.rules',
                placeholder: '*.github.com direct\nexample.com proxy US,DE hops=2\n*tracker* block',
                onchange: function (e) {
                  save(
                    'route.rules',
                    e.target.value
                      .split('\n')
                      .map(function (x) {
                        return x.trim();
                      })
                      .filter(Boolean)
                  );
                },
              },
              [c.route.rules.join('\n')]
            ),
            true
          ),
        ];
        var last = state.pool.last;
        if (last) {
          r.push(h2('Last page'));
          var list = el('div', { class: 'list' });
          list.appendChild(
            el('div', {}, [
              el('span', { class: 'name', text: last.host }),
              el('span', { class: 'dim', text: last.error || last.status + ' · ' + last.ms + ' ms' }),
            ])
          );
          (last.hops || []).forEach(function (h, i) {
            list.appendChild(
              el('div', {}, [
                el('span', { class: 'tag', text: i === last.hops.length - 1 ? 'exit' : 'hop ' + (i + 1) }),
                el('span', { class: 'name mono', text: h.proto + '://' + h.addr }),
                el('span', { class: 'dim', text: h.cc }),
              ])
            );
          });
          if (last.direct)
            list.appendChild(
              el('div', {}, [
                el('span', { class: 'tag', text: 'direct' }),
                el('span', { class: 'name dim', text: last.fellBack ? 'no proxy answered' : last.rule ? 'rule ' + last.rule : '' }),
              ])
            );
          r.push(list);
        }
        return r;
      },
    ],
    proxies: [
      'Proxies',
      function (c) {
        var p = state.pool;
        var words = { starting: 'Starting', off: 'Off', harvesting: 'Harvesting', checking: 'Checking', idle: 'Idle', paused: 'Paused' };
        var r = [
          el(
            'div',
            { class: 'stats' },
            [
              ['Live', p.alive],
              ['Checked', p.checked],
              ['Found', p.found],
            ].map(function (x) {
              return el('div', {}, [el('b', { text: x[1].toLocaleString() }), el('span', { text: x[0] })]);
            })
          ),
          el('div', { class: 'note' }, [
            el('i', { class: 'dot ' + (p.status === 'paused' ? 'warn' : p.status === 'off' ? '' : 'ok') }),
            words[p.status] +
              (p.note
                ? ' · ' + p.note + (p.resumeIn ? ' · retry\u00a0in\u00a0' + p.resumeIn + '\u00a0s' : '')
                : p.waiting
                  ? ' · ' + p.waiting.toLocaleString() + ' waiting'
                  : ''),
          ]),
          el('div', { class: 'btns' }, [
            btn(
              'Harvest',
              function () {
                return api('pool', { action: 'harvest' });
              },
              true
            ),
            btn('Speed test', function () {
              return api('pool', { action: 'speed' }).then(function (s) {
                extra.speed = s.results;
                return s;
              });
            }),
            btn('Clear', function () {
              extra.speed = null;
              return api('pool', { action: 'clear' });
            }),
          ]),
        ];
        if (extra.speed) {
          r.push(h2('Response time'));
          r.push(
            el(
              'div',
              { class: 'list' },
              extra.speed.map(function (x) {
                return el('div', {}, [
                  el('span', { class: 'name mono', text: x.via }),
                  el('span', { class: x.error ? 'dim' : '', text: x.error || x.ms + ' ms' }),
                ]);
              })
            )
          );
        }
        r.push(
          tog('Pool', 'pool.on'),
          tog('Find new sources', 'pool.discover'),
          num('Keep live', 'pool.target'),
          num('Harvest every (min)', 'pool.harvestMinutes'),
          num('Recheck every (min)', 'pool.recheckMinutes'),
          num('Check timeout (s)', 'pool.checkTimeout', 1000),
          num('Parallel checks', 'pool.concurrency'),
          txt('Judge', 'pool.judge', '', true)
        );
        if (p.proxies.length) {
          r.push(h2('Live'));
          r.push(
            el(
              'div',
              { class: 'list' },
              p.proxies.map(function (x) {
                return el('div', {}, [
                  el('span', { class: 'tag', text: x.proto }),
                  el('span', { class: 'name mono', text: x.addr }),
                  el('span', { class: 'dim', text: x.cc || '' }),
                  el('span', { text: ms(x.ms) }),
                ]);
              })
            )
          );
        }
        r.push(h2('Sources'));
        r.push(
          el('div', { class: 'add' }, [
            el('input', { id: 'src', type: 'text', placeholder: 'owner/repo · gitlab:group/repo · list URL', spellcheck: 'false' }),
            btn('Add', function () {
              var v = $('#src').value.trim();
              if (!v) return null;
              return api('pool', { action: 'source', text: v }).then(function (s) {
                if (s && s.config) forget('src');
                return s;
              });
            }),
          ])
        );
        r.push(
          el(
            'div',
            { class: 'list' },
            p.sources.map(function (s) {
              return el('div', {}, [
                el('button', {
                  class: 'sw' + (s.on ? ' on' : ''),
                  style: 'transform:scale(.8)',
                  'aria-label': 'Use source',
                  onclick: function () {
                    api('pool', { action: 'toggle', id: s.id, on: !s.on }).then(apply);
                  },
                }),
                el('span', { class: 'name', title: s.error || s.name, text: s.name.replace(/^https?:\/\//, '') }),
                s.found ? el('span', { class: 'tag', text: 'found' }) : null,
                el('span', {
                  class: 'dim',
                  text:
                    s.state === 'error'
                      ? s.error
                      : s.count
                        ? s.count.toLocaleString() + (s.alive ? ' · ' + s.alive + ' live' : '')
                        : s.state === 'pending'
                          ? '…'
                          : '0',
                }),
                s.id === 'manual'
                  ? null
                  : el('button', {
                      class: 'x',
                      title: 'Remove',
                      text: '×',
                      onclick: function () {
                        api('pool', { action: 'unsource', id: s.id }).then(apply);
                      },
                    }),
              ]);
            })
          )
        );
        r.push(h2('Add proxies'));
        r.push(el('textarea', { id: 'manual', rows: 3, spellcheck: 'false', placeholder: 'socks5://1.2.3.4:1080\n5.6.7.8:8080' }));
        r.push(
          el('div', { class: 'btns' }, [
            btn('Add', function () {
              var v = $('#manual').value;
              return v.trim()
                ? api('pool', { action: 'add', text: v }).then(function (s) {
                    forget('manual');
                    return s;
                  })
                : null;
            }),
          ])
        );
        return r;
      },
    ],
    dns: [
      'DNS',
      function (c) {
        var d = state.dns;
        var r = [
          seg('Resolver', 'dns.mode', [
            ['doh', 'Encrypted'],
            ['system', 'System'],
          ]),
          seg('Stack', 'dns.strategy', [
            ['fallback', 'In order'],
            ['race', 'Fastest'],
            ['rotate', 'Rotate'],
          ]),
          tog('System fallback', 'dns.fallback'),
          tog('Resolve at exit', 'dns.remote'),
          h2('Stack'),
        ];
        var servers = c.dns.servers;
        var move = function (i, by) {
          var list = servers.slice();
          var x = list.splice(i, 1)[0];
          list.splice(i + by, 0, x);
          save('dns.servers', list);
          render(true);
        };
        r.push(
          el(
            'div',
            { class: 'list' },
            servers.map(function (url, i) {
              var s =
                d.servers.filter(function (x) {
                  return x.url === url;
                })[0] || {};
              return el('div', {}, [
                el('i', { class: 'dot ' + (s.down ? 'bad' : s.ok ? 'ok' : s.fail ? 'warn' : '') }),
                el('span', { class: 'name', title: url, text: s.name || url }),
                el('span', { class: 'dim', text: s.down ? s.error || 'down' : ms(s.ms) }),
                i
                  ? el('button', {
                      class: 'x',
                      title: 'Up',
                      text: '↑',
                      onclick: function () {
                        move(i, -1);
                      },
                    })
                  : null,
                el('button', {
                  class: 'x',
                  title: 'Remove',
                  text: '×',
                  onclick: function () {
                    save(
                      'dns.servers',
                      servers.filter(function (x) {
                        return x !== url;
                      })
                    );
                    render(true);
                  },
                }),
              ]);
            })
          )
        );
        var free = state.options.dns.filter(function (x) {
          return servers.indexOf(x.url) < 0;
        });
        r.push(
          el('div', { class: 'add' }, [
            el(
              'select',
              {
                id: 'dnspick',
                onchange: function (e) {
                  var u = $('#dnsurl');
                  u.hidden = e.target.value !== 'custom';
                  if (!u.hidden) u.focus();
                },
              },
              [el('option', { value: '', text: 'Add resolver' })]
                .concat(
                  free.map(function (x) {
                    return el('option', { value: x.url, text: x.label });
                  })
                )
                .concat(el('option', { value: 'custom', text: 'Custom…' }))
            ),
            el('input', { id: 'dnsurl', type: 'text', placeholder: 'https://…/dns-query', spellcheck: 'false', hidden: true }),
            btn('Add', function () {
              var pick = $('#dnspick').value;
              var v = pick && pick !== 'custom' ? pick : $('#dnsurl').value.trim();
              if (v && servers.indexOf(v) < 0) {
                forget('dnspick', 'dnsurl');
                save('dns.servers', servers.concat(v));
              }
              return null;
            }),
          ])
        );
        r.push(h2('Test'));
        r.push(
          el('div', { class: 'add' }, [
            el('input', { id: 'dnshost', type: 'text', placeholder: 'example.com', spellcheck: 'false', value: extra.dnsHost || '' }),
            btn('Test', function () {
              var h = $('#dnshost').value.trim() || 'example.com';
              extra.dnsHost = h;
              return api('dns', { action: 'test', host: h }).then(function (s) {
                extra.dns = s.results;
                return s;
              });
            }),
            btn('Flush', function () {
              extra.dns = null;
              return api('dns', { action: 'flush' });
            }),
          ])
        );
        if (extra.dns) {
          r.push(
            el(
              'div',
              { class: 'list' },
              extra.dns.map(function (x) {
                return el('div', {}, [
                  el('span', { class: 'name', text: x.name }),
                  el('span', { class: 'mono dim', text: x.address || x.error }),
                  el('span', { text: ms(x.ms) }),
                ]);
              })
            )
          );
        }
        r.push(
          el('div', {
            class: 'note',
            text:
              d.cached +
              ' cached' +
              (d.last && d.last.via ? ' · last answer from ' + d.last.via : '') +
              (d.system ? ' · system used ' + d.system + '×' : ''),
          })
        );
        return r;
      },
    ],
    identity: [
      'Identity',
      function (c) {
        var o = state.options;
        var s = c.spoof;
        var zones = [];
        try {
          zones = Intl.supportedValuesOf('timeZone');
        } catch (e) {
          /* older browser */
        }
        var dl =
          $('#zones') ||
          document.body.appendChild(
            el(
              'datalist',
              { id: 'zones' },
              zones.map(function (z) {
                return el('option', { value: z });
              })
            )
          );
        void dl;
        var r = [tog('Spoofing', 'spoof.on')];
        if (!s.on) return r;
        r.push(
          h2('System'),
          sel(
            'Browser',
            'spoof.system',
            o.systems
              .map(function (x) {
                return [x.id, x.label];
              })
              .concat([
                ['random', 'Random per session'],
                ['custom', 'Custom'],
                ['real', 'Real'],
              ])
          ),
          s.system === 'custom' ? txt('User agent', 'spoof.customUa', 'Mozilla/5.0 …', true) : null,
          s.system === 'custom' ? txt('Platform', 'spoof.customPlatform', 'Win32') : null,
          txt('Languages', 'spoof.languages', 'real'),
          txt('Time zone', 'spoof.timezone', 'real', false, 'zones'),
          h2('Screen'),
          sel(
            'Size',
            'spoof.screen',
            [['real', 'Real']].concat(
              o.screens.map(function (x) {
                var m = /^(\d+)x(\d+)@([\d.]+)$/.exec(x);
                return [x, m[1] + ' × ' + m[2] + ' · ' + m[3] + 'x'];
              })
            )
          ),
          tog('Lock viewport', 'spoof.viewport', 'screen', 'window'),
          h2('Theme'),
          seg('Colour scheme', 'spoof.theme', [
            ['real', 'Real'],
            ['light', 'Light'],
            ['dark', 'Dark'],
          ]),
          seg('Motion', 'spoof.motion', [
            ['real', 'Real'],
            ['reduce', 'Reduced'],
            ['no-preference', 'Full'],
          ]),
          h2('Network'),
          sel(
            'Connection',
            'spoof.network',
            o.networks
              .map(function (x) {
                return [x, x === 'real' ? 'Real' : x];
              })
              .concat(o.networks.indexOf('real') < 0 ? [['real', 'Real']] : [])
          ),
          tog('Save-Data', 'spoof.saveData'),
          seg('WebRTC', 'spoof.webrtc', [
            ['block', 'Blocked'],
            ['real', 'Allowed'],
          ]),
          tog('Do Not Track + GPC', 'spoof.dnt'),
          seg('Referer to other sites', 'spoof.referer', [
            ['full', 'Full'],
            ['origin', 'Origin'],
            ['none', 'None'],
          ]),
          h2('Fingerprint'),
          seg('Canvas', 'spoof.canvas', [
            ['real', 'Real'],
            ['noise', 'Noise'],
            ['block', 'Blank'],
          ]),
          seg('WebGL', 'spoof.webgl', [
            ['real', 'Real'],
            ['spoof', 'Spoofed'],
          ]),
          seg('Audio', 'spoof.audio', [
            ['real', 'Real'],
            ['noise', 'Noise'],
          ]),
          seg('Layout rects', 'spoof.rects', [
            ['real', 'Real'],
            ['noise', 'Noise'],
          ]),
          seg('Fonts', 'spoof.fonts', [
            ['real', 'Real'],
            ['limit', 'Basic set'],
          ]),
          seg('Devices', 'spoof.devices', [
            ['real', 'Real'],
            ['spoof', 'Generic'],
          ])
        );
        return r;
      },
    ],
    data: [
      'Data',
      function () {
        var up = state.uptime;
        return [
          txt('Search', 'ui.search', '', true),
          row('Cookies', el('span', { class: 'dim', text: state.cookies + ' stored' })),
          el('div', { class: 'btns' }, [
            btn('Clear cookies', function () {
              return api('cookies', {});
            }),
            btn('Reset settings', function () {
              return api('config', { reset: true });
            }),
          ]),
          el('div', {
            class: 'note',
            text: 'Up ' + (up > 3600 ? Math.floor(up / 3600) + ' h ' : '') + Math.floor((up % 3600) / 60) + ' min',
          }),
        ];
      },
    ],
  };
  var ALIAS = { proxies: 'proxies', route: 'route', dns: 'dns', identity: 'identity', data: 'data' };

  function render(force) {
    if (!state) return;
    var tabs = $('#tabs');
    tabs.textContent = '';
    Object.keys(TABS).forEach(function (k) {
      tabs.appendChild(
        el('button', {
          class: k === tab ? 'on' : '',
          text: TABS[k][0],
          onclick: function () {
            tab = k;
            render(true);
          },
        })
      );
    });
    var panel = $('#panel');
    var active = document.activeElement;
    if (active && panel.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) {
      if (!force) return; // a background refresh never yanks a field someone is typing in
      active.blur(); // commits an edited setting before its field is replaced
    }
    [].forEach.call(panel.querySelectorAll('input[id], textarea[id], select[id]'), function (n) {
      drafts[n.id] = n.value;
    });
    var top = panel.scrollTop;
    panel.textContent = '';
    TABS[tab][1](state.config).forEach(function (n) {
      if (n) panel.appendChild(n);
    });
    Object.keys(drafts).forEach(function (id) {
      var n = document.getElementById(id);
      if (!n || !panel.contains(n)) return;
      n.value = drafts[id];
      if (n.tagName === 'SELECT' && n.selectedIndex < 0) n.value = '';
    });
    var pick = $('#dnspick');
    if (pick) $('#dnsurl').hidden = pick.value !== 'custom';
    panel.scrollTop = top;
  }
  function forget() {
    [].forEach.call(arguments, function (id) {
      delete drafts[id];
      var n = document.getElementById(id);
      if (n) n.value = '';
    });
  }
  function open(which) {
    if (which && ALIAS[which]) tab = ALIAS[which];
    $('#drawer').hidden = false;
    render(true);
    refresh();
  }
  $('#gear').addEventListener('click', function () {
    var d = $('#drawer');
    if (d.hidden) open();
    else d.hidden = true;
  });
  $('#route').addEventListener('click', function () {
    open(document.body.classList.contains('browsing') ? 'route' : 'proxies');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') $('#drawer').hidden = true;
  });
  // Enter in a one-line "add" field presses the button next to it.
  $('#panel').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || !e.target.parentNode.classList.contains('add')) return;
    var b = e.target.parentNode.querySelector('.btn');
    if (b && !b.disabled) {
      e.preventDefault();
      b.click();
    }
  });

  // ---- start ----------------------------------------------------------------------
  function ready() {
    // The service worker is a second net under the page script; Waddle works without it.
    var sw = Promise.resolve();
    try {
      if ('serviceWorker' in navigator) {
        sw = navigator.serviceWorker
          .register('/-/sw.js', { scope: P })
          .then(function (reg) {
            var w = reg.installing || reg.waiting;
            if (!w || reg.active) return null;
            return new Promise(function (done) {
              w.addEventListener('statechange', function () {
                if (w.state === 'activated' || w.state === 'redundant') done();
              });
            });
          })
          .catch(function () {});
      }
    } catch (e) {
      /* not allowed here */
    }
    return Promise.race([
      sw,
      new Promise(function (done) {
        setTimeout(done, 1500);
      }),
    ]);
  }
  Promise.all([api('state').then(apply, function () {}), ready()]).then(function () {
    var h = decodeURIComponent(location.hash.slice(1));
    if (/^https?:\/\//i.test(h)) go(location.hash.slice(1));
    else if (h) go(h);
  });
  window.addEventListener('hashchange', function () {
    var h = location.hash.slice(1);
    if (h && h !== current) go(h);
    else if (!h && current) home();
  });
})();
