/* Login / registrazione / progressi. Richiede window.__api_base (definito in game.html). */
(function () {
  var KEY = 'agar_token', api = window.__api_base || '/games/agar/api/';
  var token = null;
  try { token = localStorage.getItem(KEY); } catch (e) {}
  window.__agarToken = function () { return token; };

  function call(path, body, auth) {
    var h = { 'Content-Type': 'application/json' };
    if (auth && token) h.Authorization = 'Bearer ' + token;
    return fetch(api + path, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Risposta non valida (HTTP ' + r.status + ')' }; }); })
      .catch(function () { return { ok: false, error: 'Server non raggiungibile' }; });
  }
  function setToken(t) {
    token = t;
    try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch (e) {}
  }

  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;background:rgba(0,0,0,.72);color:#fff;' +
    'font:13px/1.4 Arial,sans-serif;padding:8px 10px;border-radius:8px;max-width:210px';
  document.body.appendChild(box);
  var inp = 'display:block;width:100%;box-sizing:border-box;margin:3px 0;padding:4px;border:0;border-radius:4px;font-size:13px';
  var btn = 'padding:4px 8px;margin:3px 4px 0 0;border:0;border-radius:4px;background:#007bff;color:#fff;cursor:pointer;font-size:12px';
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }

  function showGuest(msg) {
    box.innerHTML = '<b>Accedi per salvare i progressi</b>' +
      '<input id="ag_u" placeholder="Username" maxlength="16" autocomplete="username" style="' + inp + '">' +
      '<input id="ag_p" type="password" placeholder="Password (min 8)" maxlength="72" autocomplete="current-password" style="' + inp + '">' +
      '<button id="ag_l" style="' + btn + '">Accedi</button><button id="ag_r" style="' + btn + '">Registrati</button>' +
      '<div id="ag_m" style="color:#ffb3b3;margin-top:4px">' + (msg ? esc(msg) : '') + '</div>';
    function go(path) {
      var u = document.getElementById('ag_u').value, p = document.getElementById('ag_p').value;
      call(path, { username: u, password: p }).then(function (d) {
        if (!d.ok) return (document.getElementById('ag_m').textContent = d.error || 'Errore');
        setToken(d.token); showUser(d.user);
        // il token viene inviato all'apertura del WebSocket: se il gioco è ricarico la pagina per riconnettere
        window.location.reload();
      });
    }
    document.getElementById('ag_l').onclick = function () { go('login.php'); };
    document.getElementById('ag_r').onclick = function () { go('register.php'); };
  }
  function showUser(u) {
    box.innerHTML = '<b>' + esc(u.name) + '</b> · Lv ' + (u.level | 0) + '<br>XP: ' + (u.xp | 0) +
      (u.kills !== undefined ? '<br>Kill: ' + u.kills + ' · Max massa: ' + u.best_mass : '') +
      '<br><button id="ag_o" style="' + btn + '">Esci</button><button id="ag_t" style="' + btn + '">Top 20</button>' +
      '<div id="ag_top"></div>';
    document.getElementById('ag_o').onclick = function () { setToken(null); window.location.reload(); };
    document.getElementById('ag_t').onclick = function () {
      call('leaderboard.php').then(function (d) {
        if (!d.ok) return;
        document.getElementById('ag_top').innerHTML = '<ol style="margin:4px 0 0 16px;padding:0">' +
          d.top.map(function (r) { return '<li>' + esc(r.name) + ' – Lv ' + r.level + '</li>'; }).join('') + '</ol>';
      });
    };
  }

  if (token) {
    call('me.php', null, true).then(function (d) {
      if (d.ok) showUser(d.user); else { setToken(null); showGuest(); }
    });
    box.textContent = '…';
  } else showGuest();
})();
