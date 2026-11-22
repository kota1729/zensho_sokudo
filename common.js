/* ==================================================
   共通処理（index.html / editor.html で共有）
   - 課題文の整形（半角→全角、無駄な改行の削除）
   - 文字数からの級判定
   ================================================== */
(function () {
  "use strict";

  // 級ごとの課題文字数（これ以上でその級の課題として扱う）
  var GRADE_MIN = { 3: 310, 2: 460, 1: 710 };

  function halfToFull(val) {
    // 段落先頭（およびテキスト先頭）の空白を全角化
    val = val.replace(/(^|\n)[ \t]+/g, function (indent) {
      return indent.replace(/ /g, "　").replace(/\t/g, "　");
    });
    // 半角英数記号 → 全角
    val = val.replace(/[!-~]/g, function (s) {
      return String.fromCharCode(s.charCodeAt(0) + 0xFEE0);
    });
    // 文中の半角空白 → 全角
    return val.replace(/ /g, "　");
  }

  // 文末（。！？）や空白で終わらない行の改行を削除する。
  // 次の行が空白（字下げ）で始まる場合は段落の区切りとして残す。
  function joinBrokenLines(text) {
    return text.replace(/([^。\n！？\s])\n(?![ \t　])/g, "$1");
  }

  function normalizeNewlines(text) {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  // 課題文として使える形に整える
  function prepareTarget(text) {
    text = normalizeNewlines(text);
    text = text.replace(/\n{2,}/g, "\n").replace(/\n+$/, "");
    text = halfToFull(text);
    text = joinBrokenLines(text);
    return halfToFull(text);
  }

  // 文字数（countNewline=false のとき改行を数えない）
  function countChars(text, countNewline) {
    text = normalizeNewlines(text);
    if (!countNewline) text = text.replace(/\n/g, "");
    return text.length;
  }

  // 文字数から級を判定。足りなければ null
  function gradeByLength(len) {
    if (len >= GRADE_MIN[1]) return 1;
    if (len >= GRADE_MIN[2]) return 2;
    if (len >= GRADE_MIN[3]) return 3;
    return null;
  }

  window.ZenshoCommon = {
    GRADE_MIN: GRADE_MIN,
    halfToFull: halfToFull,
    joinBrokenLines: joinBrokenLines,
    normalizeNewlines: normalizeNewlines,
    prepareTarget: prepareTarget,
    countChars: countChars,
    gradeByLength: gradeByLength
  };
})();
