/* ==================================================
   オンライン対戦（2人）
   - サーバーは使わず、WebRTC（ブラウザ同士の直接通信）で対戦します。
   - 相手を見つける仲介には、ライブラリ Trystero が使う公開リレー
     （MQTT / BitTorrent / Nostr）を利用します。
   - 部屋番号（6桁）を SHA-256 でハッシュ化して部屋名にし、通信の暗号化キーにも使います。

   流れ:
     メニュー（部屋を作る / 部屋に参加する）
       → 部屋（級・課題の選択 → 2人とも「準備OK」で確定）
       → 対戦画面（カウントダウン → 10分）
       → 結果 → ロビーに戻って再戦 / 退室
   ================================================== */
(function () {
  "use strict";

  var APP_ID = "zensho-typing-battle-v1";
  var LIBS = [
    { name: "MQTT", url: "https://cdn.jsdelivr.net/npm/@trystero-p2p/mqtt@0.25.4/+esm" },
    { name: "BitTorrent", url: "https://cdn.jsdelivr.net/npm/@trystero-p2p/torrent@0.25.3/+esm" },
    { name: "Nostr", url: "https://cdn.jsdelivr.net/npm/trystero@0.25.4/+esm" }
  ];
  var LOAD_TIMEOUT_MS = 12000;   // ライブラリ1つあたりの読み込み待ち
  var SEARCH_TIMEOUT_MS = 15000; // 部屋を探す時間
  var NAME_KEY = "zensho_battle_name";

  var $ = function (id) { return document.getElementById(id); };

  var Battle = window.Battle = { active: false };

  var net = null;            // 通信の窓口（createTransport 参照）
  var role = "";             // "host"（部屋を作った人） / "guest"（参加した人）
  var me = { name: "", t: 0 };
  var opp = null;            // {id, name}
  var oppState = null;
  var oppGone = false;       // 結果表示中などに相手が抜けた
  var phase = "off";         // off | lobby | playing | done
  var sel = { grade: 3, no: "random", ver: 0 }; // 級・課題（ホストが管理）
  var pendingSel = null;     // ゲストが変更を送って、ホストの確定待ちのもの
  var roomCode = "";
  var searching = false;
  var searchTimer = null;
  var waitTimer = null;
  var myReady = false;
  var myRand = 0;
  var myFinished = false;
  var myResult = null;
  var myElapsed = 0;
  var usedTasks = {};        // ホストのみ: 出題済み
  var progTimer = null;
  var bigView = false;
  var prevCountNewline = true;
  var strategyName = "";
  var relayInfo = function () { return ""; };
  var renderedGrade = 0;

  function freshOppState() {
    return { ready: false, readyVer: -1, rand: 0, text: "", scroll: 0, finished: false, dc: false, elapsed: 0, result: null };
  }

  function lineHeightOf(el) {
    var lh = parseFloat(getComputedStyle(el).lineHeight);
    return isFinite(lh) && lh > 0 ? lh : 28.8;
  }

  function clean(s, max) {
    return String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, "").trim().slice(0, max);
  }

  function tasksOf(g) {
    return (window.ZENSHO_TASKS || {})[String(g)] || [];
  }

  function send(data, to) {
    if (!net) return;
    try { net.send(data, to); } catch (e) { /* 切断中などは無視 */ }
  }

  function isTestRunning() {
    return !!(timerId || readyInterval);
  }

  function show(id, on) {
    $(id).style.display = on ? "" : "none";
  }

  // ==================================================
  // 通信の窓口
  //   { selfId, send(data, peerId), onMessage(fn(data, peerId)),
  //     onPeerJoin(fn(peerId)), onPeerLeave(fn(peerId)), leave() }
  // テストなどで差し替えたいときは window.ZENSHO_BATTLE_TRANSPORT(roomId, password) を定義する。
  // ==================================================
  function sha256Hex(text) {
    try {
      var data = new TextEncoder().encode(text);
      return crypto.subtle.digest("SHA-256", data).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) {
          return ("0" + b.toString(16)).slice(-2);
        }).join("").slice(0, 32);
      });
    } catch (e) {
      return Promise.resolve("p-" + text);
    }
  }

  function withTimeout(p, ms, label) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error(label + " の読み込みがタイムアウトしました")); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  var statusTarget = "hostStatus";
  function setStatus(text) {
    var el = $(statusTarget);
    if (el) el.textContent = text;
    if (text) console.log("[battle] " + text);
  }

  function loadLibrary() {
    var i = 0;
    var errors = [];
    function next() {
      if (i >= LIBS.length) {
        return Promise.reject(new Error("接続用ライブラリを読み込めませんでした。\n" + errors.join("\n")));
      }
      var lib = LIBS[i++];
      setStatus("接続用ライブラリ（" + lib.name + "）を読み込み中…");
      return withTimeout(import(lib.url), LOAD_TIMEOUT_MS, lib.name).then(function (mod) {
        if (!mod || typeof mod.joinRoom !== "function") throw new Error("joinRoom がありません");
        strategyName = lib.name;
        relayInfo = function () {
          try {
            if (typeof mod.getRelaySockets !== "function") return "";
            var socks = mod.getRelaySockets();
            var list = Array.isArray(socks) ? socks : Object.keys(socks || {}).map(function (k) { return socks[k]; });
            var open = list.filter(function (s) { return s && s.readyState === 1; }).length;
            return "中継サーバー接続 " + open + "/" + list.length;
          } catch (e) { return ""; }
        };
        return mod;
      }).catch(function (e) {
        console.warn("[battle] " + lib.name + " 失敗", e);
        errors.push(lib.name + ": " + (e && e.message ? e.message : e));
        return next();
      });
    }
    return next();
  }

  function createTransport(code) {
    return sha256Hex("zensho-typing:" + code).then(function (roomId) {
      if (typeof window.ZENSHO_BATTLE_TRANSPORT === "function") {
        return window.ZENSHO_BATTLE_TRANSPORT(roomId, code);
      }
      return loadLibrary().then(function (mod) {
        var room = mod.joinRoom({ appId: APP_ID, password: code }, roomId);
        var action = room.makeAction("zb");
        return {
          selfId: mod.selfId,
          send: function (data, to) {
            if (to) action.send(data, { target: to });
            else action.send(data);
          },
          onMessage: function (fn) {
            action.onMessage = function (data, meta) {
              fn(data, meta && typeof meta === "object" ? meta.peerId : meta);
            };
          },
          onPeerJoin: function (fn) { room.onPeerJoin = fn; },
          onPeerLeave: function (fn) { room.onPeerLeave = fn; },
          leave: function () { room.leave(); }
        };
      });
    });
  }

  // ==================================================
  // メニュー・フォーム
  // ==================================================
  function showStep(step) {
    show("battleMenu", step === "menu");
    show("battleHostForm", step === "host");
    show("battleJoinForm", step === "join");
    show("battleRoom", step === "room");
  }

  function savedName() {
    try { return localStorage.getItem(NAME_KEY) || ""; } catch (e) { return ""; }
  }

  function saveName(n) {
    try { localStorage.setItem(NAME_KEY, n); } catch (e) { /* ignore */ }
  }

  function newRandomCode() {
    var n;
    try {
      var a = new Uint32Array(1);
      crypto.getRandomValues(a);
      n = a[0] % 900000;
    } catch (e) {
      n = Math.floor(Math.random() * 900000);
    }
    return String(100000 + n);
  }

  Battle.openLobby = function () {
    if (isTestRunning()) { customAlert("練習中は開けません。練習を終えてから開いてください。"); return; }
    document.body.classList.add("view-lobby");
    Battle.showMenu();
    window.scrollTo(0, 0);
  };

  Battle.closeLobby = function () {
    if (Battle.active) return;
    document.body.classList.remove("view-lobby");
  };

  Battle.showMenu = function () {
    showStep("menu");
    setStatus("");
    statusTarget = "hostStatus";
  };

  Battle.showHostForm = function () {
    showStep("host");
    statusTarget = "hostStatus";
    setStatus("");
    $("hostCode").textContent = newRandomCode();
    if (!$("hostName").value) $("hostName").value = savedName();
    $("hostCreateBtn").textContent = "部屋を作成";
    Battle.updateForms();
    $("hostName").focus();
  };

  Battle.newCode = function () {
    $("hostCode").textContent = newRandomCode();
  };

  Battle.showJoinForm = function () {
    showStep("join");
    statusTarget = "joinStatus";
    setStatus("");
    if (!$("joinName").value) $("joinName").value = savedName();
    $("joinBtn").textContent = "参加する";
    Battle.updateForms();
    $("joinName").focus();
  };

  Battle.updateForms = function () {
    $("hostCreateBtn").disabled = !clean($("hostName").value, 12);
    $("joinBtn").disabled = !(clean($("joinName").value, 12) && /^[0-9]{6}$/.test($("joinCode").value));
  };

  // 部屋番号欄: 半角数字だけ入力できるようにする（全角数字は半角に直す）
  Battle.onCodeInput = function (e) {
    var el = $("joinCode");
    if (e && e.isComposing) return;
    var v = el.value
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[^0-9]/g, "")
      .slice(0, 6);
    if (v !== el.value) el.value = v;
    Battle.updateForms();
  };

  Battle.onCodeKey = function (e) {
    // 数字・編集キー以外は入力させない（Ctrl/Meta との組み合わせ、IME入力中は通す）
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.key === "Process") return;
    if (e.key.length === 1 && !/[0-9]/.test(e.key)) e.preventDefault();
  };

  // ==================================================
  // 部屋を作る / 部屋に参加する
  // ==================================================
  function resetSession(r, name, code) {
    role = r;
    me = { name: name, t: Date.now() };
    roomCode = code;
    opp = null;
    oppState = freshOppState();
    oppGone = false;
    usedTasks = {};
    sel = { grade: 3, no: "random", ver: 0 };
    pendingSel = null;
    renderedGrade = 0;
    myReady = false;
    myFinished = false;
    myResult = null;
    phase = "lobby";
    Battle.active = true;
    prevCountNewline = $("countNewline").checked;
    $("countNewline").checked = true; // 採点条件を2人でそろえる
    document.body.classList.add("battle-on", "view-lobby");

    // 通常練習の画面を初期状態に戻す
    restartTest();
    clearTarget();
    populateTaskSelect("");
    setSelectorsDisabled(true);
    $("oppPanel").style.display = "none";
    $("battleResult").innerHTML = "";
    $("battleMe").textContent = name;
    $("battleBarMe").textContent = name;
    $("roomCode").textContent = code;
  }

  function attachHandlers() {
    net.onPeerJoin(function (id) { send({ k: "hello", name: me.name, role: role, t: me.t }, id); });
    net.onPeerLeave(onPeerLeave);
    net.onMessage(onMessage);
  }

  Battle.createRoom = function () {
    var name = clean($("hostName").value, 12);
    var code = $("hostCode").textContent;
    if (!name) return;
    if (isTestRunning()) { customAlert("練習中は作成できません。"); return; }
    saveName(name);
    statusTarget = "hostStatus";
    $("hostCreateBtn").disabled = true;
    $("hostCreateBtn").textContent = "作成中…";
    setStatus("接続を準備しています…");

    createTransport(code).then(function (t) {
      net = t;
      resetSession("host", name, code);
      attachHandlers();
      setStatus("");
      enterRoom();
      startWaitDiagnostics();
    }).catch(function (e) {
      $("hostCreateBtn").textContent = "部屋を作成";
      Battle.updateForms();
      setStatus("接続に失敗しました");
      customAlert("部屋を作成できませんでした。\n" + (e && e.message ? e.message : e) + "\n\nインターネット接続や、学校ネットワークの制限を確認してください。");
    });
  };

  Battle.joinRoom = function () {
    var name = clean($("joinName").value, 12);
    var code = $("joinCode").value;
    if (!name || !/^[0-9]{6}$/.test(code)) return;
    if (isTestRunning()) { customAlert("練習中は参加できません。"); return; }
    saveName(name);
    statusTarget = "joinStatus";
    $("joinBtn").disabled = true;
    $("joinBtn").textContent = "探しています…";
    setStatus("接続を準備しています…");

    createTransport(code).then(function (t) {
      net = t;
      resetSession("guest", name, code);
      attachHandlers();
      showStep("join"); // 部屋が見つかるまでは参加画面のまま
      searching = true;
      var t0 = Date.now();
      clearInterval(waitTimer);
      waitTimer = setInterval(function () {
        if (!searching) return;
        var sec = Math.floor((Date.now() - t0) / 1000);
        setStatus("部屋を探しています…（" + sec + "秒）\n接続方式: " + strategyName + "　" + relayInfo());
      }, 500);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        if (!searching) return;
        endSearch();
        abandonSession();
        showStep("join");
        setStatus("見つかりませんでした。\n部屋番号が合っているか、相手が部屋を作成済みか確認してください。");
        $("joinBtn").textContent = "参加する";
        Battle.updateForms();
      }, SEARCH_TIMEOUT_MS);
    }).catch(function (e) {
      $("joinBtn").textContent = "参加する";
      Battle.updateForms();
      setStatus("接続に失敗しました");
      customAlert("接続できませんでした。\n" + (e && e.message ? e.message : e) + "\n\nインターネット接続や、学校ネットワークの制限を確認してください。");
    });
  };

  function endSearch() {
    searching = false;
    clearTimeout(searchTimer);
    clearInterval(waitTimer);
  }

  // 部屋に入った（ロビーの部屋画面を表示）
  function enterRoom() {
    endSearch();
    $("hostCreateBtn").textContent = "部屋を作成";
    $("joinBtn").textContent = "参加する";
    showStep("room");
    $("roomCodeHint").style.display = role === "host" ? "" : "none";
    renderRoom();
  }

  // 相手が見つかるまでの診断表示（ホスト側）
  function startWaitDiagnostics() {
    clearInterval(waitTimer);
    var t0 = Date.now();
    waitTimer = setInterval(function () {
      var el = $("battleDiag");
      if (!el) return;
      if (!Battle.active || opp || role !== "host") { el.textContent = ""; return; }
      var sec = Math.floor((Date.now() - t0) / 1000);
      var txt = "接続方式: " + strategyName + "　" + relayInfo() + "　待機 " + sec + "秒";
      if (sec >= 30) {
        txt += "\n相手が来ません。相手が同じ部屋番号で「参加する」を押したか、中継サーバー接続が 0 でないか（0 ならネットワークが通信を止めている可能性）を確認してください。";
      }
      el.textContent = txt;
    }, 1000);
  }

  // 接続だけ片づける（画面はそのまま）
  function abandonSession() {
    try { if (net) net.leave(); } catch (e) { /* ignore */ }
    net = null;
    clearTimeout(progTimer);
    progTimer = null;
    clearInterval(waitTimer);
    Battle.active = false;
    phase = "off";
    opp = null;
    document.body.classList.remove("battle-on");
    $("countNewline").checked = prevCountNewline;
    $("oppPanel").style.display = "none";
    $("battleResult").innerHTML = "";
    resetToTestStart(); // 実行中のタイマー等も止めて初期化
    populateTaskSelect("");
    clearTarget();
  }

  Battle.leave = function () {
    if (phase === "playing" && !myFinished) {
      customConfirm("対戦中です。退室すると負けになります。退室しますか？").then(function (ok) {
        if (ok) doLeave();
      });
    } else {
      doLeave();
    }
  };

  // 退室して、メニュー（部屋を作る / 部屋に参加する）に戻る
  function doLeave() {
    endSearch();
    abandonSession();
    document.body.classList.add("view-lobby");
    window.scrollTo(0, 0);
    Battle.showMenu();
    $("hostCreateBtn").textContent = "部屋を作成";
    $("joinBtn").textContent = "参加する";
  }

  // ==================================================
  // 相手の出入り
  // ==================================================
  function onPeerLeave(id) {
    if (!net || !opp || opp.id !== id) return;

    if (phase === "playing" && !oppState.finished) {
      // 対戦中の切断: そこまでの入力を最終結果とみなす
      oppState.finished = true;
      oppState.dc = true;
      oppState.elapsed = 600;
      oppState.result = scoreOpp(oppState.text);
      oppGone = true;
      renderOpp();
      checkVerdict();
      renderBattleResult();
      renderRoom();
      return;
    }
    if (phase === "lobby") {
      if (role === "guest") {
        customAlert("部屋を作った人が退室したため、部屋が閉じられました。");
        doLeave();
      } else {
        opp = null;
        oppState = freshOppState();
        myReady = false;
        renderRoom();
      }
      return;
    }
    // 対戦中に終了済み・結果表示中: 結果表示のため相手の情報は保持する
    oppGone = true;
    renderRoom();
  }

  // ==================================================
  // メッセージ受信
  // ==================================================
  function onMessage(d, from) {
    if (!net || !d || typeof d !== "object") return;

    if (d.k === "hello") {
      var theirName = clean(d.name, 12) || "ななし";
      if (role === "host") {
        if (d.role === "host") {
          // 同じ部屋番号で2人が部屋を作ってしまった。後から作った方がやり直す。
          var theirT = Number(d.t) || 0;
          if (theirT < me.t || (theirT === me.t && from < net.selfId)) {
            customAlert("同じ部屋番号の部屋が他にも作られていました。\nもう一度「部屋を作る」からやり直してください。");
            doLeave();
          }
          return;
        }
        if (opp && opp.id !== from) { send({ k: "full" }, from); return; }
        if (!opp) {
          opp = { id: from, name: theirName };
          oppState = freshOppState();
          oppGone = false;
        }
        send({ k: "sel", grade: sel.grade, no: sel.no, ver: sel.ver }, from);
        renderRoom();
      } else {
        if (d.role !== "host") return;
        if (opp && opp.id !== from) return;
        if (!opp) {
          opp = { id: from, name: theirName };
          oppState = freshOppState();
        }
        if (searching) enterRoom();
        else renderRoom();
      }
      return;
    }

    if (d.k === "full") {
      if (role === "guest" && searching) {
        endSearch();
        abandonSession();
        showStep("join");
        setStatus("この部屋はすでに2人で満員です。");
        $("joinBtn").textContent = "参加する";
        Battle.updateForms();
      }
      return;
    }

    if (!opp || from !== opp.id) return; // 相手以外は無視

    switch (d.k) {
      case "sreq": // ゲストからの級・課題の変更依頼（ホストだけが処理）
        if (role === "host") hostSetSel(Number(d.grade), String(d.no));
        break;
      case "sel": // ホストが確定した級・課題（ゲストだけが処理）
        if (role === "guest") {
          sel = { grade: normGrade(d.grade), no: String(d.no), ver: Number(d.ver) || 0 };
          pendingSel = null;
          myReady = false;
          oppState.ready = false;
          renderRoom();
        }
        break;
      case "r":
        oppState.ready = !!d.ready;
        oppState.readyVer = Number(d.ver);
        oppState.rand = Number(d.rand) || 0;
        renderRoom();
        maybeStart();
        break;
      case "go":
        if (role === "guest" && phase !== "playing") begin(normGrade(d.g), String(d.no));
        break;
      case "p":
        if (phase === "playing" && !oppState.finished) {
          oppState.text = String(d.t || "");
          oppState.scroll = Number(d.s) || 0;
          renderOpp();
        }
        break;
      case "f":
        if (phase === "playing" || phase === "done") {
          oppState.text = String(d.t || "");
          oppState.elapsed = Math.min(600, Math.max(0, Number(d.el) || 0));
          oppState.finished = true;
          oppState.result = scoreOpp(oppState.text);
          renderOpp();
          checkVerdict();
          renderBattleResult();
          renderRoom();
        }
        break;
    }
  }

  function normGrade(g) {
    g = Number(g);
    return [1, 2, 3].indexOf(g) >= 0 ? g : 3;
  }

  function scoreOpp(text) {
    var target = getNormalizedText("targetArea");
    var t = ZenshoCommon.normalizeNewlines(text);
    t = ZenshoCommon.joinBrokenLines(t).replace(/\n+$/, "");
    return scoreZenshoTyping(target, t, sel.grade);
  }

  // ==================================================
  // 級・課題の選択と、準備OK（2人がOKした時点で確定）
  // ==================================================
  function validNo(grade, no) {
    return no === "random" || tasksOf(grade).some(function (t) { return t.no === no; });
  }

  // ホストが級・課題を決める（ゲストの依頼もここで処理）。変更すると2人の準備はやり直し。
  function hostSetSel(grade, no) {
    if (phase !== "lobby") return;
    grade = normGrade(grade);
    if (!validNo(grade, no)) no = "random";
    if (grade === sel.grade && no === sel.no) { renderRoom(); return; }
    sel = { grade: grade, no: no, ver: sel.ver + 1 };
    myReady = false;
    oppState.ready = false;
    if (opp) send({ k: "sel", grade: sel.grade, no: sel.no, ver: sel.ver }, opp.id);
    renderRoom();
  }

  function requestSel(grade, no) {
    if (phase !== "lobby" || myReady) return;
    if (role === "host") {
      hostSetSel(grade, no);
    } else if (opp) {
      pendingSel = { grade: grade, no: no };
      send({ k: "sreq", grade: grade, no: no }, opp.id);
      renderRoom();
    }
  }

  Battle.onGradeChange = function () {
    requestSel(parseInt($("selGrade").value, 10), "random");
  };

  Battle.onNoChange = function () {
    var cur = pendingSel || sel;
    requestSel(cur.grade, $("selNo").value);
  };

  function setReady(v) {
    if (phase !== "lobby" || !opp) return;
    if (myReady === v) return;
    myReady = v;
    myRand = v ? Math.floor(Math.random() * 1e9) : 0;
    send({ k: "r", ready: v, rand: myRand, ver: sel.ver }, opp.id);
    renderRoom();
    maybeStart();
  }

  Battle.ready = function () { setReady(true); };
  Battle.cancelReady = function () { setReady(false); };

  // ホストが、2人とも同じ設定で準備OKになったところで確定し、開始を知らせる
  function maybeStart() {
    if (role !== "host" || phase !== "lobby" || !opp || !myReady || !oppState.ready) return;
    if (oppState.readyVer !== sel.ver) return;

    var no = sel.no;
    if (no === "random") {
      var all = tasksOf(sel.grade);
      var cand = all.filter(function (t) { return !usedTasks[sel.grade + ":" + t.no]; });
      if (cand.length === 0) {
        cand = all;
        Object.keys(usedTasks).forEach(function (k) { if (k.indexOf(sel.grade + ":") === 0) delete usedTasks[k]; });
      }
      if (cand.length === 0) return;
      no = cand[(myRand + oppState.rand) % cand.length].no;
    }
    usedTasks[sel.grade + ":" + no] = true;

    send({ k: "go", g: sel.grade, no: no }, opp.id);
    begin(sel.grade, no);
  }

  function begin(g, no) {
    var task = tasksOf(g).filter(function (t) { return t.no === no; })[0];
    if (!task) {
      customAlert("課題データが見つかりませんでした。ページを更新してください。");
      return;
    }
    phase = "playing";
    sel.grade = g;
    myReady = false;
    myFinished = false;
    myResult = null;
    oppState.ready = false;
    oppState.text = "";
    oppState.scroll = 0;
    oppState.finished = false;
    oppState.dc = false;
    oppState.result = null;
    bigView = false;
    document.body.classList.remove("view-lobby"); // 部屋 → 対戦画面へ
    $("battleResult").innerHTML = "";

    $("gradeSelect").value = String(g);
    populateTaskSelect("b:" + g + ":" + no);
    applyTarget(task.text, "第" + no + "回");

    $("oppTarget").value = $("targetArea").value;
    $("oppInput").value = "";
    $("oppPanel").style.display = "block";
    setBig(false);
    renderOpp();
    renderRoom();

    startTest(); // 3秒のカウントダウン → 10分
    scrollToPlayView();
  }

  // 自分の画面と相手の画面がどちらも見える位置にスクロールする
  function scrollToPlayView() {
    function go() {
      var panel = $("oppPanel");
      var bottom = panel.getBoundingClientRect().bottom + window.pageYOffset;
      var y = Math.max(0, Math.ceil(bottom - window.innerHeight + 12));
      window.scrollTo(0, y);
    }
    go();
    requestAnimationFrame(go);
    setTimeout(go, 150);
  }

  // ==================================================
  // 自分の入力・終了（index.html から呼ばれる）
  // ==================================================
  Battle.onLocalInput = function () {
    if (Battle.active && phase === "playing" && !myFinished) queueProg();
  };

  function queueProg() {
    if (progTimer) return;
    progTimer = setTimeout(function () {
      progTimer = null;
      sendProg();
    }, 150);
  }

  function sendProg() {
    if (!net || !opp || phase !== "playing" || myFinished) return;
    var ta = $("targetArea");
    send({
      k: "p",
      t: $("inputArea").value,
      s: Math.round(ta.scrollTop / lineHeightOf(ta) * 100) / 100
    }, opp.id);
  }

  Battle.onLocalFinish = function (info) {
    if (!Battle.active) return;
    clearTimeout(progTimer);
    progTimer = null;
    myFinished = true;
    myResult = info.result;
    myElapsed = info.elapsed;
    // finishTest が元に戻してしまう画面状態を、対戦用に戻す
    setSelectorsDisabled(true);
    $("countNewline").checked = true;
    if (opp) send({ k: "f", t: info.text, el: info.elapsed }, opp.id);
    renderOpp();
    checkVerdict();
    renderBattleResult();
    renderRoom();
  };

  // ==================================================
  // 結果
  // ==================================================
  function judge(a, ae, b, be) {
    if (a.netSpeed !== b.netSpeed) return a.netSpeed > b.netSpeed ? 1 : -1;
    if (a.totalErrors !== b.totalErrors) return a.totalErrors < b.totalErrors ? 1 : -1;
    if (ae !== be) return ae < be ? 1 : -1;
    return 0;
  }

  function fmtTime(sec) {
    return Math.floor(sec / 60) + ":" + ("0" + (sec % 60)).slice(-2);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var verdictShown = false;

  function checkVerdict() {
    if (phase !== "playing") return;
    if (!(myFinished && oppState && oppState.finished && myResult && oppState.result)) return;
    phase = "done";
    verdictShown = false;
  }

  // 採点結果の上に、勝敗とお互いの結果を表示する
  function renderBattleResult() {
    var box = $("battleResult");
    if (!Battle.active || !myFinished || !myResult) return;

    if (phase !== "done") {
      box.innerHTML = "<div class=\"verdict wait\">⏳ 相手の終了を待っています…（勝敗はここに表示されます）</div>";
      return;
    }

    var j = judge(myResult, myElapsed, oppState.result, oppState.elapsed);
    var cls = j > 0 ? "win" : (j < 0 ? "lose" : "draw");
    var text = j > 0 ? "🏆 あなたの勝ち！" : (j < 0 ? "😢 あなたの負け…" : "🤝 引き分け");

    function row(name, r, el, isMe) {
      return "<tr><td><strong style=\"color:" + (isMe ? "#1976d2" : "#d32f2f") + "\">" + esc(name) + (isMe ? "（あなた）" : "") + "</strong></td>" +
        "<td><strong>" + r.netSpeed + "字</strong></td><td>" + r.totalErrors + "個</td><td>" + r.inputLength + "字</td>" +
        "<td>" + fmtTime(el) + "</td><td>" + (r.isPass ? "合格" : "不合格") + "</td></tr>";
    }

    box.innerHTML =
      "<div class=\"verdict " + cls + "\">" + text + "</div>" +
      (oppState.dc ? "<p class=\"battle-hint\">※相手は対戦中に切断したため、それまでの入力で比べています。</p>" : "") +
      "<table><thead><tr><th>プレイヤー</th><th>得点</th><th>エラー</th><th>総字数</th><th>かかった時間</th><th>判定</th></tr></thead><tbody>" +
      row(me.name, myResult, myElapsed, true) +
      row(opp ? opp.name : "相手", oppState.result, oppState.elapsed, false) +
      "</tbody></table>";

    if (!verdictShown) {
      verdictShown = true;
      // 勝敗と結果が見える位置へ移動する
      setTimeout(function () {
        $("resultBox").scrollIntoView({ behavior: "smooth", block: "start" });
      }, 100);
    }
  }

  Battle.rematch = function () {
    if (phase !== "done") return;
    if (oppGone) {
      if (role === "guest") {
        customAlert("部屋を作った人が退室したため、再戦できません。");
        doLeave();
        return;
      }
      opp = null;           // ホストは、新しい相手を待つ状態に戻る
      oppState = freshOppState();
      oppGone = false;
    }
    phase = "lobby";
    myReady = false;
    myFinished = false;
    myResult = null;
    oppState.ready = false;
    restartTest();
    clearTarget();
    populateTaskSelect("");
    setSelectorsDisabled(true);
    document.body.classList.add("view-lobby"); // 対戦画面 → 部屋へ
    window.scrollTo(0, 0);
    $("battleResult").innerHTML = "";
    $("oppPanel").style.display = "none";
    if (opp) send({ k: "r", ready: false, rand: 0, ver: sel.ver }, opp.id);
    if (role === "host" && opp) send({ k: "sel", grade: sel.grade, no: sel.no, ver: sel.ver }, opp.id);
    if (role === "host" && !opp) startWaitDiagnostics();
    renderRoom();
  };

  // ==================================================
  // 画面の更新
  // ==================================================
  function noLabel(no) {
    return no === "random" ? "ランダム" : "第" + no + "回";
  }

  function renderRoom() {
    if (!Battle.active) return;
    $("battleOpp").textContent = opp ? opp.name : "（相手を待っています…）";
    $("battleBarOpp").textContent = opp ? opp.name : "相手";

    // 参加者カード（準備状況）
    var oppReady = !!(opp && oppState.ready && oppState.readyVer === sel.ver);
    var meSt = $("battleMeState"), opSt = $("battleOppState");
    meSt.textContent = myReady ? "✅ 準備OK" : "準備中…";
    meSt.className = "pstate" + (myReady ? " ready" : "");
    opSt.textContent = !opp ? "未接続" : (oppReady ? "✅ 準備OK" : "準備中…");
    opSt.className = "pstate" + (oppReady ? " ready" : "");

    // 級・課題の選択（ゲストは、変更依頼中はそれを表示）
    var cur = pendingSel || sel;
    var gsel = $("selGrade"), nsel = $("selNo");
    if (renderedGrade !== cur.grade) {
      nsel.innerHTML = "";
      var o = document.createElement("option");
      o.value = "random";
      o.textContent = "ランダム（おまかせ）";
      nsel.appendChild(o);
      tasksOf(cur.grade).forEach(function (t) {
        var op = document.createElement("option");
        op.value = t.no;
        op.textContent = "第" + t.no + "回";
        nsel.appendChild(op);
      });
      renderedGrade = cur.grade;
    }
    gsel.value = String(cur.grade);
    nsel.value = cur.no;
    var locked = phase !== "lobby" || myReady || !opp;
    gsel.disabled = locked;
    nsel.disabled = locked;
    $("selNote").textContent = !opp
      ? "相手が入ると、級と課題を選べます。"
      : (myReady
        ? "確定待ちです（変更するには「準備キャンセル」を押してください）。　現在の設定：" + sel.grade + "級・" + noLabel(sel.no)
        : "現在の設定：" + sel.grade + "級・" + noLabel(sel.no) + "　— どちらが変更しても準備はやり直しになります。2人とも「準備OK」で確定します。");

    // 準備ボタン: 押したら灰色になり、「準備キャンセル」が退室ボタンの横に出る
    var ready = $("battleReadyBtn");
    ready.disabled = !opp || myReady;
    ready.textContent = myReady ? "準備OK済み" : "準備OK";
    ready.classList.toggle("btn-grey", myReady);
    ready.classList.toggle("btn-success", !myReady);
    $("battleCancelBtn").style.display = myReady ? "" : "none";
    $("battleAgainBtn").style.display = phase === "done" ? "" : "none";

    var msg = "", barMsg = "";
    if (phase === "lobby") {
      if (!opp) {
        msg = role === "host"
          ? "相手の参加を待っています…（部屋番号 " + roomCode + " を相手に伝えてください）"
          : "";
      } else if (myReady && !oppReady) {
        msg = "相手の準備を待っています…";
      } else if (!myReady && oppReady) {
        msg = "相手は準備OKです。準備ができたら押してください。";
      } else {
        msg = "級と課題を決めて、準備ができたら「準備OK」を押してください。";
      }
    } else if (phase === "playing") {
      barMsg = !myFinished
        ? "対戦中！ 先に終えた人は、相手の画面を大きくして見られます。"
        : "終了しました。相手の入力が終わるのを待っています。下の「相手の画面を大きく見る」で様子を見られます。";
    } else if (phase === "done") {
      barMsg = "対戦が終わりました。もう一度対戦するときは「ロビーに戻る（再戦）」を押してください。";
    }
    $("battleMsg").textContent = msg;
    $("battleBarMsg").textContent = barMsg;
  }

  function renderOpp() {
    if (!oppState || !opp) return;
    $("oppName").textContent = opp.name;
    // 採点と同じルールで、文の途中の余計な改行は表示から除く（段落の区切りの改行は残す）
    var shown = ZenshoCommon.joinBrokenLines(ZenshoCommon.normalizeNewlines(oppState.text));
    $("oppCount").textContent = "入力 " + ZenshoCommon.countChars(shown, true) + "字";
    $("oppStatus").textContent = oppState.dc ? "🔌 切断" : (oppState.finished ? "✅ 終了" : "⌨ 入力中");
    $("oppStatus").style.color = oppState.finished ? "#28a745" : "#d32f2f";
    $("oppToggleBtn").disabled = !(myFinished || phase === "done");

    var inp = $("oppInput");
    inp.value = shown;
    inp.scrollTop = inp.scrollHeight;
    var tg = $("oppTarget");
    tg.scrollTop = oppState.scroll * lineHeightOf(tg);
    layoutOpp();
  }

  // 相手の画面は、自分の画面と同じ大きさのものを縮小表示する（スクロール位置もそのまま対応する）
  function layoutOpp() {
    var pair = $("oppPair");
    var nw = pair.offsetWidth, nh = pair.offsetHeight;
    if (!nw) return;
    var s = 0.5;
    if (bigView) s = Math.min(1, ($("oppPanel").clientWidth - 34) / nw);
    $("oppScaler").style.transform = "scale(" + s + ")";
    var vp = $("oppViewport");
    vp.style.width = Math.floor(nw * s) + "px";
    vp.style.height = Math.floor(nh * s) + "px";
  }

  function setBig(v) {
    bigView = v;
    $("oppToggleBtn").textContent = v ? "相手の画面を小さくする" : "相手の画面を大きく見る";
    layoutOpp();
  }

  Battle.toggleBig = function () {
    if ($("oppToggleBtn").disabled) return;
    setBig(!bigView);
    if (bigView) $("oppPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  window.addEventListener("resize", function () { if (Battle.active) layoutOpp(); });
  $("targetArea").addEventListener("scroll", function () {
    if (Battle.active && phase === "playing" && !myFinished) queueProg();
  });
  window.addEventListener("beforeunload", function () {
    try { if (net) net.leave(); } catch (e) { /* ignore */ }
  });
})();
