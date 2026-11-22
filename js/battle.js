/* ==================================================
   オンライン対戦（2人）
   - サーバーは使わず、WebRTC（ブラウザ同士の直接通信）で対戦します。
   - 相手を見つける仲介には、ライブラリ Trystero が使う公開リレー
     （MQTT / BitTorrent / Nostr）を利用します。合言葉が同じ2人が同じ部屋に入ります。
   - 合言葉は SHA-256 でハッシュ化して部屋名にし、通信内容の暗号化キーにも使います。

   流れ: 接続 → 部屋（準備OK） → 対戦 → 結果 → 再戦 / 退室
   ================================================== */
(function () {
  "use strict";

  var APP_ID = "zensho-typing-battle-v1";
  var LIB_URLS = [
    "https://cdn.jsdelivr.net/npm/@trystero-p2p/mqtt@0.25.4/+esm",
    "https://cdn.jsdelivr.net/npm/@trystero-p2p/torrent@0.25.3/+esm",
    "https://cdn.jsdelivr.net/npm/trystero@0.25.4/+esm"
  ];
  var NAME_KEY = "zensho_battle_name";

  var $ = function (id) { return document.getElementById(id); };

  var Battle = window.Battle = { active: false };

  var net = null;            // 通信の窓口（下の createTransport 参照）
  var me = { name: "", t: 0 };
  var peers = {};            // peerId -> {name, t}（hello を受け取った相手）
  var opp = null;            // {id, name} 対戦相手
  var oppState = null;       // 相手の状態
  var phase = "off";         // off | lobby | playing | done
  var isHost = true;
  var grade = 3;             // 部屋の級（ホストが決める）
  var myReady = false;
  var myRand = 0;
  var myFinished = false;
  var myResult = null;
  var myElapsed = 0;
  var usedTasks = {};        // ホストのみ: 出題済み
  var progTimer = null;
  var bigView = false;
  var prevCountNewline = true;

  function freshOppState() {
    return { ready: false, rand: 0, text: "", scroll: 0, finished: false, dc: false, elapsed: 0, result: null };
  }

  function lineHeightOf(el) {
    var lh = parseFloat(getComputedStyle(el).lineHeight);
    return isFinite(lh) && lh > 0 ? lh : 28.8;
  }

  function clean(s, max) {
    return String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, "").trim().slice(0, max);
  }

  function send(data, to) {
    if (!net) return;
    try { net.send(data, to); } catch (e) { /* 切断中などは無視 */ }
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

  function loadLibrary() {
    var i = 0;
    function next() {
      if (i >= LIB_URLS.length) return Promise.reject(new Error("接続用ライブラリを読み込めませんでした"));
      var url = LIB_URLS[i++];
      return import(url).then(function (mod) {
        if (!mod || typeof mod.joinRoom !== "function") throw new Error("bad module");
        return mod;
      }).catch(next);
    }
    return next();
  }

  function createTransport(pass) {
    return sha256Hex("zensho-typing:" + pass).then(function (roomId) {
      if (typeof window.ZENSHO_BATTLE_TRANSPORT === "function") {
        return window.ZENSHO_BATTLE_TRANSPORT(roomId, pass);
      }
      return loadLibrary().then(function (mod) {
        var room = mod.joinRoom({ appId: APP_ID, password: pass }, roomId);
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
  // 接続・退室
  // ==================================================
  function isTestRunning() {
    return !!(timerId || readyInterval);
  }

  // ロビー画面（接続・準備）を開く／閉じる
  Battle.openLobby = function () {
    if (isTestRunning()) { customAlert("練習中は開けません。練習を終えてから開いてください。"); return; }
    document.body.classList.add("view-lobby");
    window.scrollTo(0, 0);
  };

  Battle.closeLobby = function () {
    if (Battle.active) return;
    document.body.classList.remove("view-lobby");
  };

  Battle.connect = function () {
    var name = clean($("battleName").value, 12);
    var pass = $("battlePass").value.trim();
    if (!name) { customAlert("プレイヤー名を入力してください。"); return; }
    if (!pass) { customAlert("合言葉を入力してください。"); return; }
    if (isTestRunning()) { customAlert("練習中は接続できません。練習を終えてから接続してください。"); return; }
    try { localStorage.setItem(NAME_KEY, name); } catch (e) { /* 保存できなくても続行 */ }

    $("battleConnectBtn").disabled = true;
    $("battleConnectBtn").textContent = "接続中…";

    createTransport(pass).then(function (t) {
      net = t;
      me = { name: name, t: Date.now() };
      peers = {};
      opp = null;
      oppState = freshOppState();
      usedTasks = {};
      grade = 3;
      myReady = false;
      myFinished = false;
      myResult = null;

      Battle.active = true;
      phase = "lobby";
      prevCountNewline = $("countNewline").checked;
      $("countNewline").checked = true; // 採点条件を2人でそろえる
      document.body.classList.add("battle-on", "view-lobby");

      // 通常練習の画面をいったん初期状態に戻す
      restartTest();
      clearTarget();
      populateTaskSelect("");
      setSelectorsDisabled(true);
      $("oppPanel").style.display = "none";
      $("battleResult").innerHTML = "";

      net.onPeerJoin(function (id) { send({ k: "hello", name: me.name, t: me.t }, id); });
      net.onPeerLeave(onPeerLeave);
      net.onMessage(onMessage);

      $("battleConnect").style.display = "none";
      $("battleRoom").style.display = "block";
      $("battleMe").textContent = me.name;
      $("battleBarMe").textContent = me.name;
      refreshRoles();
    }).catch(function (e) {
      $("battleConnectBtn").disabled = false;
      $("battleConnectBtn").textContent = "接続する";
      customAlert("接続できませんでした。\n" + (e && e.message ? e.message : e) + "\n\nインターネット接続や、学校ネットワークの制限を確認してください。");
    });
  };

  Battle.leave = function () {
    if (phase === "playing" && !myFinished) {
      customConfirm("対戦中です。退室すると負けになります。退室しますか？").then(function (ok) {
        if (ok) doLeave();
      });
    } else {
      doLeave();
    }
  };

  function doLeave() {
    try { if (net) net.leave(); } catch (e) { /* ignore */ }
    net = null;
    clearTimeout(progTimer);
    progTimer = null;
    Battle.active = false;
    phase = "off";
    peers = {};
    opp = null;
    document.body.classList.remove("battle-on", "view-lobby");
    $("countNewline").checked = prevCountNewline;
    $("oppPanel").style.display = "none";
    $("battleResult").innerHTML = "";
    resetToTestStart();           // 実行中のタイマー等も止めて初期化
    populateTaskSelect("");
    clearTarget();
    $("battleRoom").style.display = "none";
    $("battleConnect").style.display = "block";
    $("battleConnectBtn").disabled = false;
    $("battleConnectBtn").textContent = "接続する";
  }

  // ==================================================
  // 参加者の管理
  // ==================================================
  function refreshRoles() {
    var all = Object.keys(peers).map(function (id) {
      return { id: id, name: peers[id].name, t: peers[id].t };
    });
    all.push({ id: net.selfId, name: me.name, t: me.t });
    all.sort(function (a, b) { return a.t - b.t || (a.id < b.id ? -1 : 1); });
    var top2 = all.slice(0, 2);

    if (!top2.some(function (p) { return p.id === net.selfId; })) {
      customAlert("この合言葉の部屋はすでに2人で満員です。\n別の合言葉を使ってください。");
      doLeave();
      return;
    }

    var other = top2.filter(function (p) { return p.id !== net.selfId; })[0] || null;
    if (!other && opp && (phase === "playing" || phase === "done")) {
      // 対戦中・結果表示中に相手が抜けた: 結果表示のため相手の情報は保持する
      isHost = true;
      renderRoom();
      return;
    }
    var prevId = opp ? opp.id : null;
    opp = other ? { id: other.id, name: other.name } : null;
    if ((opp ? opp.id : null) !== prevId) oppState = freshOppState();
    isHost = top2[0].id === net.selfId;

    if (isHost && opp && phase === "lobby") send({ k: "g", grade: grade }, opp.id);
    renderRoom();
  }

  function onPeerLeave(id) {
    if (!net) return;
    delete peers[id];
    if (opp && opp.id === id && phase === "playing" && !oppState.finished) {
      // 対戦中の切断: そこまでの入力を最終結果とみなす
      oppState.finished = true;
      oppState.dc = true;
      oppState.elapsed = 600;
      oppState.result = scoreOpp(oppState.text);
      renderOpp();
      checkVerdict();
    }
    refreshRoles();
  }

  // ==================================================
  // メッセージ受信
  // ==================================================
  function onMessage(d, from) {
    if (!net || !d || typeof d !== "object") return;

    if (d.k === "hello") {
      peers[from] = { name: clean(d.name, 12) || "ななし", t: Number(d.t) || 0 };
      refreshRoles();
      return;
    }
    if (!opp || from !== opp.id) return; // 相手以外（3人目など）は無視

    switch (d.k) {
      case "g":
        if (!isHost) {
          grade = [1, 2, 3].indexOf(Number(d.grade)) >= 0 ? Number(d.grade) : 3;
          renderRoom();
        }
        break;
      case "r":
        oppState.ready = !!d.ready;
        oppState.rand = Number(d.rand) || 0;
        renderRoom();
        maybeStart();
        break;
      case "go":
        if (!isHost && phase !== "playing") begin(Number(d.g), String(d.no));
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
          renderRoom();
        }
        break;
    }
  }

  function scoreOpp(text) {
    var target = getNormalizedText("targetArea");
    var t = ZenshoCommon.normalizeNewlines(text);
    t = ZenshoCommon.joinBrokenLines(t).replace(/\n+$/, "");
    return scoreZenshoTyping(target, t, grade);
  }

  // ==================================================
  // 準備・開始
  // ==================================================
  Battle.onGradeSelect = function () {
    if (!isHost) return;
    grade = parseInt($("battleGrade").value, 10);
    if (opp) send({ k: "g", grade: grade }, opp.id);
  };

  Battle.toggleReady = function () {
    if (phase !== "lobby" || !opp) return;
    myReady = !myReady;
    myRand = myReady ? Math.floor(Math.random() * 1e9) : 0;
    send({ k: "r", ready: myReady, rand: myRand }, opp.id);
    renderRoom();
    maybeStart();
  };

  // ホストが、2人の準備が整ったところで課題を決めて開始を知らせる
  function maybeStart() {
    if (!isHost || phase !== "lobby" || !opp || !myReady || !oppState.ready) return;

    var all = (window.ZENSHO_TASKS || {})[String(grade)] || [];
    var cand = all.filter(function (t) { return !usedTasks[grade + ":" + t.no]; });
    if (cand.length === 0) {
      cand = all;
      Object.keys(usedTasks).forEach(function (k) { if (k.indexOf(grade + ":") === 0) delete usedTasks[k]; });
    }
    if (cand.length === 0) return;
    var pick = cand[(myRand + oppState.rand) % cand.length];
    usedTasks[grade + ":" + pick.no] = true;

    send({ k: "go", g: grade, no: pick.no }, opp.id);
    begin(grade, pick.no);
  }

  function begin(g, no) {
    var list = (window.ZENSHO_TASKS || {})[String(g)] || [];
    var task = list.filter(function (t) { return t.no === no; })[0];
    if (!task) {
      customAlert("課題データが見つかりませんでした。ページを更新してください。");
      return;
    }
    phase = "playing";
    grade = g;
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
    document.body.classList.remove("view-lobby"); // ロビー → 対戦画面へ
    window.scrollTo(0, 0);
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

  function checkVerdict() {
    if (!(myFinished && oppState && oppState.finished && myResult && oppState.result)) return;
    phase = "done";
    var j = judge(myResult, myElapsed, oppState.result, oppState.elapsed);
    var cls = j > 0 ? "win" : (j < 0 ? "lose" : "draw");
    var text = j > 0 ? "🏆 あなたの勝ち！" : (j < 0 ? "😢 あなたの負け…" : "🤝 引き分け");

    function row(name, r, el, isMe) {
      var pass = r.isPass ? "合格" : "不合格";
      return "<tr><td><strong style=\"color:" + (isMe ? "#1976d2" : "#d32f2f") + "\">" + esc(name) + "</strong></td>" +
        "<td><strong>" + r.netSpeed + "字</strong></td><td>" + r.totalErrors + "個</td><td>" + r.inputLength + "字</td>" +
        "<td>" + fmtTime(el) + "</td><td>" + pass + "</td></tr>";
    }

    $("battleResult").innerHTML =
      "<div class=\"verdict " + cls + "\">" + text + "</div>" +
      (oppState.dc ? "<p class=\"battle-hint\">※相手は対戦中に切断したため、それまでの入力で比べています。</p>" : "") +
      "<table><thead><tr><th>プレイヤー</th><th>得点</th><th>エラー</th><th>総字数</th><th>終了時間</th><th>判定</th></tr></thead><tbody>" +
      row(me.name, myResult, myElapsed, true) +
      row(opp ? opp.name : "相手", oppState.result, oppState.elapsed, false) +
      "</tbody></table>";
  }

  Battle.rematch = function () {
    if (phase !== "done") return;
    phase = "lobby";
    myReady = false;
    myFinished = false;
    myResult = null;
    restartTest();
    clearTarget();
    populateTaskSelect("");
    setSelectorsDisabled(true);
    document.body.classList.add("view-lobby"); // 対戦画面 → ロビーへ
    window.scrollTo(0, 0);
    $("battleResult").innerHTML = "";
    $("oppPanel").style.display = "none";
    // 相手が先に再戦ボタンを押していても準備状態は保つ（ready は go のときだけ消える）
    if (opp) send({ k: "r", ready: false, rand: 0 }, opp.id);
    refreshRoles(); // 相手が退室済みならここで部屋の状態を更新する
  };

  // ==================================================
  // 画面の更新
  // ==================================================
  function renderRoom() {
    if (!Battle.active) return;
    var oppName = opp ? opp.name : "（相手を待っています…）";
    $("battleOpp").textContent = oppName;
    $("battleBarOpp").textContent = opp ? opp.name : "相手";

    // 参加者カード（準備状況）
    var meSt = $("battleMeState"), opSt = $("battleOppState");
    meSt.textContent = myReady ? "✅ 準備OK" : "準備中…";
    meSt.className = "pstate" + (myReady ? " ready" : "");
    opSt.textContent = !opp ? "未接続" : (oppState.ready ? "✅ 準備OK" : "準備中…");
    opSt.className = "pstate" + (opp && oppState.ready ? " ready" : "");

    var sel = $("battleGrade");
    sel.value = String(grade);
    sel.style.display = isHost ? "" : "none";
    sel.disabled = phase !== "lobby";
    var gt = $("battleGradeText");
    gt.style.display = isHost ? "none" : "";
    gt.textContent = grade + "級（先に入った相手が選択）";

    var ready = $("battleReadyBtn");
    ready.disabled = !opp;
    ready.textContent = myReady ? "準備を取り消す" : "準備OK";
    $("battleAgainBtn").style.display = phase === "done" ? "" : "none";

    var msg = "", barMsg = "";
    if (phase === "lobby") {
      msg = !opp
        ? "相手の接続を待っています…（相手にも同じ合言葉を入力してもらってください）"
        : (myReady && !oppState.ready ? "相手の準備を待っています…" :
          (!myReady && oppState.ready ? "相手は準備OKです。準備ができたら押してください。" :
            "準備ができたら「準備OK」を押してください。2人とも押すと対戦が始まります。"));
    } else if (phase === "playing") {
      barMsg = !myFinished
        ? "対戦中！ 先に終えた人は、相手の画面を大きくして見られます。"
        : "終了しました。相手の入力が終わるのを待っています。下の「相手の画面を大きく見る」で様子を見られます。";
    } else if (phase === "done") {
      barMsg = "対戦が終わりました。結果は下に表示されています。もう一度対戦するときは「ロビーに戻る」を押してください。";
    }
    $("battleMsg").textContent = msg;
    $("battleBarMsg").textContent = barMsg;
  }

  function renderOpp() {
    if (!oppState || !opp) return;
    $("oppName").textContent = opp.name;
    $("oppCount").textContent = "入力 " + ZenshoCommon.countChars(oppState.text, true) + "字";
    $("oppStatus").textContent = oppState.dc ? "🔌 切断" : (oppState.finished ? "✅ 終了" : "⌨ 入力中");
    $("oppStatus").style.color = oppState.finished ? "#28a745" : "#d32f2f";
    $("oppToggleBtn").disabled = !(myFinished || phase === "done");

    var inp = $("oppInput");
    inp.value = oppState.text;
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

  // 自分のお手本の自動スクロールに合わせて相手側にも送る
  document.addEventListener("DOMContentLoaded", function () {
    try { $("battleName").value = localStorage.getItem(NAME_KEY) || ""; } catch (e) { /* ignore */ }
  });
  window.addEventListener("resize", function () { if (Battle.active) layoutOpp(); });
  $("targetArea").addEventListener("scroll", function () {
    if (Battle.active && phase === "playing" && !myFinished) queueProg();
  });
  window.addEventListener("beforeunload", function () {
    try { if (net) net.leave(); } catch (e) { /* ignore */ }
  });
})();
