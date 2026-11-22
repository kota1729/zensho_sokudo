(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const sections = ["lobby", "game", "results"];
  let peer = null, channel = null, role = "", localName = "", phrase = "", remoteName = "", roomId = "";
  let helloSent = false, helloReceived = false, helloAttempts = 0, helloTimer = null, connected = false, joinAttempts = 0, joinTimer = null, connectionTimer = null;
  let proposal = null, agreed = false, ownReady = false, remoteReady = false, gameStarted = false;
  let target = "", startedAt = 0, elapsed = 0, ticker = null, sendTicker = null, countdownToken = 0;
  let ownDone = false, remoteDone = false, ownResult = null, remoteResult = null, lastPayload = "";
  function status(s) { $("status").textContent = s; $("connectionNotice").textContent = s; $("roomStatus").textContent=s; }
  function error(s) { $("error").textContent = s || ""; $("roomError").textContent=s||""; }
  function setCredentialsDisabled(disabled) { $("name").disabled=disabled;$("phrase").disabled=disabled;$("createBtn").disabled=disabled; }
  function showSection(id) { sections.forEach(x => $(x).classList.toggle("hidden", x !== id)); }
  function setConnected() {
    const wasConnected=connected;
    if(helloTimer)clearTimeout(helloTimer);status(`接続済み：${remoteName} さん`); $("globalResetBtn").classList.remove("hidden"); error(""); $("connectPanel").classList.add("hidden");
    $("lobby").classList.remove("hidden");$("roomSelf").textContent=localName;$("roomOpponent").textContent=remoteName;$("matchSetup").classList.remove("hidden");if(!wasConnected)populateTasks();connected=true;
  }
  function openRoom(message) { $("connectPanel").classList.add("hidden");showSection("lobby");$("roomSelf").textContent=localName||"—";$("roomOpponent").textContent="相手を待っています…";$("matchSetup").classList.add("hidden");status(message); }
  function validateNameAndPhrase() {
    localName = $("name").value.trim().slice(0,24); phrase = $("phrase").value.trim().normalize("NFKC");
    if (!localName) throw Error("プレイヤー名を入力してください。");
    if (!phrase.trim()) throw Error("合言葉を入力してください。");
  }
  async function getRoomId() {
    if(!window.crypto?.subtle) throw Error("安全な接続（HTTPSまたはlocalhost）が必要です。");
    const appPath=location.pathname.replace(/[^/]*$/, "");
    const source=`zensho-typing-room-v1|${location.origin}${appPath}|${phrase.trim().normalize("NFKC")}`;
    const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(source));
    return "zs-"+Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,"0")).join("");
  }
  function peerOptions(){return {debug:1,config:{iceServers:[{urls:"stun:stun.l.google.com:19302"}]}};}
  function bindChannel(conn) {
    channel=conn; conn.on("open",()=>{status("相手と接続しました。名前と合言葉を確認しています…");sendHello();});
    conn.on("close",()=>{if(helloTimer)clearTimeout(helloTimer);if(channel===conn)channel=null;if(connected)status("相手との接続が切れました。勝敗は確定していません。両方で部屋を作り直してください。");});
    conn.on("error",e=>{if(role==="B"&&!connected){if(channel===conn)channel=null;scheduleJoin();}else error(`接続エラー：${e.message||e.type||"ネットワークを確認してください"}`);});
    conn.on("data",data=>{let m=data;if(typeof data==="string"){if(data.length>100000)return;try{m=JSON.parse(data);}catch(_){return;}}if(!m||typeof m.type!=="string")return;receive(m);});
  }
  function send(m) { if (channel && channel.open) channel.send(m); }
  function sendHello(){
    if(connected||helloReceived||!channel)return;
    if(channel.open){send({type:"hello",name:localName,phrase});helloSent=true;helloAttempts++;}
    if(helloAttempts<12)helloTimer=setTimeout(sendHello,700);
    else status("データ接続はできましたが、相手の確認応答が届きません。両者で「部屋を閉じて戻る」を押し、同じ合言葉で接続し直してください。");
  }
  async function createRoom() {
    if($("createBtn").disabled)return;setCredentialsDisabled(true);
    try { error("");validateNameAndPhrase();if(!window.Peer)throw Error("PeerJSを読み込めません。インターネット接続を確認してページを再読み込みしてください。");roomId=await getRoomId();role="A";helloSent=helloReceived=connected=false;helloAttempts=0;status("部屋を作成しています…");peer=new Peer(roomId,peerOptions());
      const roomPeer=peer;peer.on("open",()=>{if(peer===roomPeer)openRoom("募集を開始しました。同じ合言葉の相手が入室するまでお待ちください。");});
      peer.on("connection",conn=>{if(channel){conn.close();return;}bindChannel(conn);});
      peer.on("error",e=>{if(e.type==="unavailable-id"&&peer===roomPeer){peer=null;role="";roomPeer.destroy();status("募集済みの相手が見つかりました。参加しています…");joinRoom();}else if(peer===roomPeer){setCredentialsDisabled(false);error(`部屋を作れません：${e.message||e.type||"通信エラー"}`);status("相手を探せませんでした。");}});
    }catch(e){setCredentialsDisabled(false);error(e.message);status("相手を探せませんでした。");}
  }
  function tryJoin() {
    if(role!=="B"||connected||!peer)return;if(joinAttempts>=12){const oldPeer=peer;peer=null;role="";oldPeer.destroy();setCredentialsDisabled(false);status("部屋が見つかりません。相手に先に同じボタンを押してもらい、合言葉を確認してください。");return;}joinAttempts++;status(`同じ合言葉の部屋を検索中… (${joinAttempts}/12)`);
    const conn=peer.connect(roomId,{reliable:true,serialization:"json"});bindChannel(conn);
    connectionTimer=setTimeout(()=>{if(!connected&&!conn.open&&channel===conn){channel=null;conn.close();scheduleJoin();}},2500);
  }
  function scheduleJoin(){if(joinTimer||role!=="B"||connected)return;joinTimer=setTimeout(()=>{joinTimer=null;tryJoin();},1500);}
  async function joinRoom() {
    try {error("");validateNameAndPhrase();if(!window.Peer)throw Error("PeerJSを読み込めません。インターネット接続を確認してページを再読み込みしてください。");roomId=await getRoomId();role="B";helloSent=helloReceived=connected=false;helloAttempts=0;joinAttempts=0;openRoom("同じ合言葉の部屋を検索しています…");peer=new Peer(undefined,peerOptions());
      peer.on("open",()=>tryJoin());peer.on("error",e=>{if(role==="B"&&!connected){if(e.type==="peer-unavailable")scheduleJoin();else{const oldPeer=peer;peer=null;role="";oldPeer?.destroy();setCredentialsDisabled(false);error(`待ち合わせサービスに接続できません：${e.message||e.type}`);}}});
    }catch(e){setCredentialsDisabled(false);error(e.message);status("参加できませんでした。");}
  }
  $("createBtn").onclick=createRoom;
  function resetConnection() { countdownToken++;if(helloTimer)clearTimeout(helloTimer);if(joinTimer)clearTimeout(joinTimer);if(connectionTimer)clearTimeout(connectionTimer);if(ticker)clearInterval(ticker);if(sendTicker)clearInterval(sendTicker);if(peer)peer.destroy();peer=null;channel=null;role="";gameStarted=false;startedAt=0;helloSent=helloReceived=connected=false;helloAttempts=joinAttempts=0;setCredentialsDisabled(false);$("globalResetBtn").classList.add("hidden");$("connectPanel").classList.remove("hidden");sections.forEach(x=>$(x).classList.add("hidden"));error("");status("未接続。名前と合言葉を入力し、相手と同じボタンを押してください。"); }
  $("resetBtn").onclick=resetConnection; $("lobbyResetBtn").onclick=resetConnection;$("globalResetBtn").onclick=resetConnection;
  window.addEventListener("pagehide",()=>{if(peer){try{peer.destroy();}catch(_){}peer=null;channel=null;}});
  function receive(m) {
    if (m.type === "hello") {
      if (typeof m.name !== "string" || m.name.length > 24 || typeof m.phrase !== "string" || m.phrase.length > 80) return;
      remoteName=m.name; if (m.phrase !== phrase) { error("合言葉が一致しません。接続をリセットして、同じ合言葉でやり直してください。"); status("合言葉不一致"); channel.close(); return; }
      helloReceived=true;if(helloTimer)clearTimeout(helloTimer);
      $("ownTitle").textContent=`自分：${localName}`; $("opponentTitle").textContent=`相手：${remoteName}`; setConnected(); return;
    }
    if (!remoteName) return;
    if (m.type === "proposal") {
      if (typeof m.id !== "string" || typeof m.text !== "string" || m.text.length > 10000) return;
      const [grade, no, extra] = m.id.split(":");
      const known = ["1", "2", "3"].includes(grade) && !extra && (window.ZENSHO_TASKS[grade] || []).find(t => t.no === no);
      if (!known || ZenshoCommon.prepareTarget(known.text) !== m.text) { error("相手の課題IDまたは本文がこのサイトの課題データと一致しません。別の課題を提案してください。"); return; }
      proposal={id:m.id,text:m.text}; agreed=false; ownReady=false; remoteReady=false; $("agreeBtn").disabled=false; $("readyBtn").disabled=true;
      $("sample").value=m.text; $("proposalStatus").textContent=`${remoteName} さんの提案です。課題内容を確認して同意してください。`; $("readyStatus").textContent=""; return;
    }
    if (m.type === "agree") {
      if (!proposal || m.id !== proposal.id || m.text !== proposal.text) return;
      agreed=true; $("sample").value=proposal.text; $("proposalStatus").textContent="同じお手本に双方が合意しました。準備完了を押してください。"; $("readyBtn").disabled=false; $("agreeBtn").disabled=true; return;
    }
    if (m.type === "ready" && agreed && m.id === proposal.id) { remoteReady=!!m.ready; $("readyStatus").textContent=remoteReady?`${remoteName} さんは準備完了です。`:`${remoteName} さんの準備を待っています。`; startWhenReady(); return; }
    if (m.type === "start" && agreed && ownReady && m.id===proposal.id && Number.isFinite(m.delay) && m.delay >= 2000 && m.delay <= 6000) { beginCountdown(m.delay); return; }
    if (m.type === "progress") { updateOpponent(m); return; }
    if (m.type === "finished") { if(!validStats(m.stats))return; remoteResult=m.stats;remoteDone=true;$("ownDone").textContent=ownDone?"両者入力完了":"相手は入力完了。あなたは続けて入力できます。"; maybeResults(); return; }
  }
  function populateTasks() { const grade=Number($("grade").value),sel=$("task");sel.innerHTML="";(window.ZENSHO_TASKS[String(grade)]||[]).forEach(t=>{const o=document.createElement("option");o.value=t.no;o.textContent=`第${t.no}回`;sel.appendChild(o);}); }
  $("grade").onchange=populateTasks; populateTasks();
  function selectedTask() { const g=String($("grade").value), t=(window.ZENSHO_TASKS[g]||[]).find(x=>x.no===$("task").value); if(!t)throw Error("課題を選択してください。"); const text=ZenshoCommon.prepareTarget(t.text);return {id:`${g}:${t.no}`,text}; }
  $("proposeBtn").onclick=()=>{ try { const p=selectedTask();proposal=p;agreed=false;ownReady=false;remoteReady=false;$("sample").value=p.text;$("proposalStatus").textContent="提案を送信しました。相手の確認を待っています。";$("agreeBtn").disabled=true;$("readyBtn").disabled=true;$("readyStatus").textContent="";send({type:"proposal",...p}); }catch(e){error(e.message);} };
  $("agreeBtn").onclick=()=>{if(!proposal)return; agreed=true;send({type:"agree",...proposal});$("agreeBtn").disabled=true;$("readyBtn").disabled=false;$("proposalStatus").textContent="お手本に合意しました。双方が同じお手本に合意すると準備できます。";};
  $("readyBtn").onclick=()=>{if(!agreed||!proposal)return;ownReady=true;$("readyBtn").disabled=true;$("readyStatus").textContent="あなたは準備完了です。相手を待っています。";send({type:"ready",id:proposal.id,ready:true});startWhenReady();};
  function startWhenReady() { if(!ownReady||!remoteReady||!agreed||gameStarted)return; if(role==="A") { gameStarted=true;send({type:"start",id:proposal.id,delay:3500});beginCountdown(3500); } }
  function beginCountdown(delay) { if(gameStarted&&role==="B")return;gameStarted=true;const token=++countdownToken;showSection("game");target=proposal.text;$("ownSample").value=target;$("opponentSample").value=target;$("typing").value="";$("typing").disabled=true;let left=Math.ceil(delay/1000);$("countdown").classList.remove("hidden");$("countdown").textContent=String(left);const step=()=>{if(token!==countdownToken)return;left--;if(left>0)$("countdown").textContent=String(left);else if(left===0)$("countdown").textContent="START";else{$("countdown").classList.add("hidden");$("typing").disabled=false;$("typing").focus();startedAt=Date.now();ticker=setInterval(updateOwn,100);sendTicker=setInterval(sendProgress,250);}};setTimeout(step,1000);setTimeout(step,2000);setTimeout(step,3000);setTimeout(step,delay); }
  function calcStats(value, time) { let correct=0,miss=0;for(let i=0;i<value.length;i++){if(value[i]===target[i]&&i<target.length)correct++;else miss++;}const minutes=Math.max(time/60000,1/60000);return {progress:Math.min(100,Math.floor(value.length/Math.max(target.length,1)*100)),correct,miss,cpm:Math.round(correct/minutes),elapsed:Math.round(time/100)/10,accuracy:value.length?Math.round(correct/value.length*1000)/10:100,done:value.length>=target.length}; }
  function updateOwn() {if(ownDone)return;elapsed=Date.now()-startedAt;const s=calcStats($("typing").value,elapsed);["Progress","Correct","Miss","Cpm","Time"].forEach((k,i)=>$("own"+k).textContent=[`${s.progress}%`,s.correct,s.miss,s.cpm,s.elapsed][i]);if(s.done)finishOwn(s);}
  function finishOwn(s) {if(ownDone)return;ownDone=true;$("typing").disabled=true;clearInterval(ticker);clearInterval(sendTicker);ownResult=s;$("ownDone").textContent="入力完了。相手の終了を待っています。";$("expandBtn").disabled=false;send({type:"finished",stats:s});maybeResults();}
  $("typing").addEventListener("input",()=>{if(!startedAt||ownDone)return;updateOwn();});
  function sendProgress(){if(!startedAt)return;const value=$("typing").value.slice(0,target.length);const payload=JSON.stringify({type:"progress",text:value,stats:calcStats(value,Date.now()-startedAt)});if(payload!==lastPayload){lastPayload=payload;send(JSON.parse(payload));}}
  function validStats(s){return s&&Number.isInteger(s.correct)&&s.correct>=0&&s.correct<=target.length&&Number.isInteger(s.miss)&&s.miss>=0&&s.miss<=target.length&&Number.isInteger(s.cpm)&&s.cpm>=0&&s.cpm<100000&&Number.isFinite(s.elapsed)&&s.elapsed>=0&&s.elapsed<86400&&Number.isInteger(s.progress)&&s.progress>=0&&s.progress<=100&&Number.isFinite(s.accuracy)&&s.accuracy>=0&&s.accuracy<=100;}
  function updateOpponent(m){if(typeof m.text!=="string"||m.text.length>target.length||!validStats(m.stats))return;$("remoteText").textContent=m.text||"（入力待ち）";$("opProgress").textContent=`${m.stats.progress}%`;$("opCorrect").textContent=m.stats.correct;$("opMiss").textContent=m.stats.miss;$("opCpm").textContent=m.stats.cpm;$("opTime").textContent=m.stats.elapsed;}
  function maybeResults(){if(!ownDone||!remoteDone||!ownResult||!remoteResult)return;showSection("results");const score=s=>[s.done?1:0,s.accuracy,s.cpm];let a=score(ownResult),b=score(remoteResult),cmp=0;for(let i=0;i<a.length;i++){if(a[i]!==b[i]){cmp=a[i]>b[i]?1:-1;break;}}$("winner").textContent=cmp===0?"引き分け":cmp>0?"勝ち！":"負け";const row=(name,s)=>`<div class="result-row"><strong>${escapeHtml(name)}</strong>正解率 ${s.accuracy}% ／ 正解 ${s.correct} ／ ミス ${s.miss} ／ ${s.cpm} 字/分 ／ ${s.elapsed} 秒</div>`;$("resultRows").innerHTML=row(localName,ownResult)+row(remoteName,remoteResult);}
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  $("expandBtn").onclick=()=>{document.body.classList.add("expanded");$("expandBtn").classList.add("hidden");$("shrinkBtn").classList.remove("hidden");};$("shrinkBtn").onclick=()=>{document.body.classList.remove("expanded");$("shrinkBtn").classList.add("hidden");$("expandBtn").classList.remove("hidden");};
  $("againBtn").onclick=()=>{proposal=null;agreed=ownReady=remoteReady=ownDone=remoteDone=gameStarted=false;ownResult=remoteResult=null;startedAt=0;lastPayload="";$("readyBtn").disabled=true;$("agreeBtn").disabled=true;$("readyStatus").textContent="";$("proposalStatus").textContent="新しい課題を提案してください。";$("sample").value="";$("typing").value="";$("ownDone").textContent="";$("opProgress").textContent="0%";$("opCorrect").textContent="0";$("opMiss").textContent="0";$("opCpm").textContent="0";$("opTime").textContent="0.0";showSection("lobby");};
})();
