// Private share viewer (JUN-308). Everything sensitive happens here, in the
// recipient's browser: the invite key arrives in the URL fragment (never sent
// to any server), unwraps the content key, and decrypts the payload fetched
// from june-api. No analytics, no external requests (CSP-enforced).
"use strict";
(function () {
  var config = {
    accountsUrl: document.body.getAttribute("data-accounts-url") || "",
    clientId: document.body.getAttribute("data-client-id") || "",
  };
  var statusEl = document.getElementById("status");
  var NOT_AVAILABLE =
    "This link isn't available. It may have been revoked, or it may not be " +
    "meant for the account you signed in with.";

  function showStatus(text, isError) {
    statusEl.hidden = false;
    statusEl.textContent = text;
    statusEl.className = isError ? "error" : "";
    document.getElementById("prompt").hidden = true;
    document.getElementById("passcode").hidden = true;
    document.getElementById("content").hidden = true;
  }

  function b64urlEncode(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(text) {
    var normalized = text.replace(/-/g, "+").replace(/_/g, "/");
    while (normalized.length % 4 !== 0) normalized += "=";
    return b64Decode(normalized);
  }

  function b64Decode(text) {
    var bin = atob(text);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function randomBytes(length) {
    var bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  }

  async function sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  }

  async function aesGcmDecrypt(keyBytes, iv, ciphertext) {
    var key = await crypto.subtle.importKey(
      "raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]
    );
    var plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv }, key, ciphertext
    );
    return new Uint8Array(plain);
  }

  async function derivePasscodeKey(passcode, salt) {
    var material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(passcode.normalize("NFKC")),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    var bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: salt, iterations: 600000 },
      material,
      256
    );
    return new Uint8Array(bits);
  }

  // ── Session state (per-tab; nothing persists past the tab) ───────────────
  function saveState(state) {
    sessionStorage.setItem("june_share_state", JSON.stringify(state));
  }
  function loadState() {
    try {
      return JSON.parse(sessionStorage.getItem("june_share_state") || "null");
    } catch (error) {
      return null;
    }
  }
  function saveToken(token) {
    sessionStorage.setItem("june_share_token", token);
  }
  function loadToken() {
    return sessionStorage.getItem("june_share_token") || "";
  }

  // ── PKCE sign-in ──────────────────────────────────────────────────────────
  async function beginSignIn(sharePath, fragment) {
    var verifierBytes = randomBytes(32);
    var verifier = b64urlEncode(verifierBytes);
    var challenge = b64urlEncode(
      await sha256(new TextEncoder().encode(verifier))
    );
    var csrf = b64urlEncode(randomBytes(18));
    saveState({
      verifier: verifier,
      csrf: csrf,
      returnPath: sharePath,
      fragment: fragment,
    });
    var redirectUri = location.origin + "/s/callback";
    location.href =
      config.accountsUrl +
      "/login?client_id=" + encodeURIComponent(config.clientId) +
      "&redirect_uri=" + encodeURIComponent(redirectUri) +
      "&scope=" + encodeURIComponent("profile:read") +
      "&state=" + encodeURIComponent(csrf) +
      "&code_challenge=" + encodeURIComponent(challenge) +
      "&code_challenge_method=S256";
  }

  async function completeSignIn() {
    var params = new URLSearchParams(location.search);
    var code = params.get("code") || "";
    var state = loadState();
    if (!state || !code || params.get("state") !== state.csrf) {
      showStatus("Sign-in did not complete. Open your share link again.", true);
      return;
    }
    var response = await fetch("/v1/share-viewer/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: code,
        code_verifier: state.verifier,
        redirect_uri: location.origin + "/s/callback",
      }),
    });
    var body = await response.json().catch(function () { return null; });
    var token = body && body.success && body.data && body.data.access_token;
    if (!token) {
      showStatus("Sign-in did not complete. Open your share link again.", true);
      return;
    }
    saveToken(token);
    // Return to the share, restoring the fragment (it never left this tab).
    location.replace(state.returnPath + "#" + state.fragment);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function inlineMarkdown(text) {
    return text
      .replace(/`([^`]+)`/g, function (_m, code) { return "<code>" + code + "</code>"; })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, function (_m, label, url) {
        return '<a href="' + url + '" rel="noreferrer nofollow noopener" target="_blank">' + label + "</a>";
      });
  }

  // Deliberately small markdown subset: headings, lists, code fences,
  // paragraphs, bold/italic/code/links. Input is escaped FIRST; the only
  // tags in the output are the ones this function emits.
  function renderMarkdown(markdown) {
    var lines = escapeHtml(markdown.replace(/\r\n/g, "\n")).split("\n");
    var html = [];
    var inCode = false;
    var inList = false;
    function closeList() {
      if (inList) { html.push("</ul>"); inList = false; }
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^```/.test(line)) {
        closeList();
        html.push(inCode ? "</code></pre>" : "<pre><code>");
        inCode = !inCode;
        continue;
      }
      if (inCode) { html.push(line + "\n"); continue; }
      var heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) {
        closeList();
        var level = heading[1].length;
        html.push("<h" + level + ">" + inlineMarkdown(heading[2]) + "</h" + level + ">");
        continue;
      }
      var item = /^\s*[-*]\s+(.*)$/.exec(line);
      if (item) {
        if (!inList) { html.push("<ul>"); inList = true; }
        html.push("<li>" + inlineMarkdown(item[1]) + "</li>");
        continue;
      }
      closeList();
      if (line.trim() === "") continue;
      html.push("<p>" + inlineMarkdown(line) + "</p>");
    }
    if (inCode) html.push("</code></pre>");
    closeList();
    return html.join("");
  }

  function renderSession(messages) {
    var html = [];
    for (var i = 0; i < messages.length; i++) {
      var role = messages[i].role === "user" ? "user" : "assistant";
      var label = role === "user" ? "You" : "June";
      html.push(
        '<div class="turn ' + role + '"><p class="turn-role">' + label +
        '</p><div class="turn-body">' + escapeHtml(String(messages[i].content || "")) +
        "</div></div>"
      );
    }
    return html.join("");
  }

  function showContent(payload) {
    statusEl.hidden = true;
    document.getElementById("topbar").hidden = false;
    var content = document.getElementById("content");
    var kindLabel = payload.kind === "session" ? "session" : "meeting note";
    var owner = payload.owner_name || "Someone";
    document.getElementById("content-title").textContent =
      payload.title || "Untitled";
    document.getElementById("content-meta").textContent =
      owner + " shared this " + kindLabel + " with you";
    var body = document.getElementById("content-body");
    if (payload.kind === "session" && Array.isArray(payload.messages)) {
      body.innerHTML = renderSession(payload.messages);
    } else {
      body.innerHTML = renderMarkdown(String(payload.markdown || ""));
    }
    content.hidden = false;
  }

  function maybeShowPrompt(shareId, payload, done) {
    var seenKey = "june_share_seen_" + shareId;
    var seen = false;
    try { seen = localStorage.getItem(seenKey) === "1"; } catch (error) { seen = false; }
    if (seen) { done(); return; }
    var prompt = document.getElementById("prompt");
    statusEl.hidden = true;
    var kindLabel = payload.kind === "session" ? "session" : "meeting note";
    var owner = payload.owner_name || "Someone";
    document.getElementById("prompt-title").textContent =
      owner + " shared this " + kindLabel + " with you";
    prompt.hidden = false;
    document.getElementById("prompt-later").addEventListener("click", function () {
      try { localStorage.setItem(seenKey, "1"); } catch (error) { /* private mode */ }
      prompt.hidden = true;
      done();
    });
  }

  // ── Main flow ─────────────────────────────────────────────────────────────
  async function decryptLinkData(shareId, data, linkKey) {
    var contentKey = await aesGcmDecrypt(
      linkKey,
      b64Decode(data.envelopeIvB64),
      b64Decode(data.envelopeB64)
    );
    var plaintext = await aesGcmDecrypt(
      contentKey,
      b64Decode(data.ivB64),
      b64Decode(data.ciphertextB64)
    );
    var payload = JSON.parse(new TextDecoder().decode(plaintext));
    document.getElementById("passcode").hidden = true;
    maybeShowPrompt(shareId, payload, function () { showContent(payload); });
  }

  async function viewLinkShare(shareId, fragment) {
    var parts = fragment.split(".");
    if (parts.length !== 4 || parts[0] !== "link" ||
        (parts[2] !== "key" && parts[2] !== "pass")) {
      showStatus("This link is incomplete. Ask for a fresh share link.", true);
      return;
    }
    var inviteId = parts[1];
    var material;
    try { material = b64urlDecode(parts[3]); } catch (error) {
      showStatus("This link is incomplete. Ask for a fresh share link.", true);
      return;
    }
    showStatus("Loading encrypted share…", false);
    var response = await fetch(
      "/v1/shares/" + encodeURIComponent(shareId) +
      "/link-view?link=" + encodeURIComponent(inviteId)
    );
    if (!response.ok) {
      showStatus("This link isn't available. It may have been stopped.", true);
      return;
    }
    var body = await response.json().catch(function () { return null; });
    var data = body && body.success && body.data;
    if (!data || !data.envelopeB64) {
      showStatus("This link isn't available. It may have been stopped.", true);
      return;
    }
    if (parts[2] === "key") {
      if (material.length !== 32) throw new Error("invalid link key");
      try {
        await decryptLinkData(shareId, data, material);
      } catch (error) {
        showStatus("This link's key doesn't match its content.", true);
      }
      return;
    }
    if (material.length !== 16) throw new Error("invalid passcode salt");
    statusEl.hidden = true;
    var panel = document.getElementById("passcode");
    var form = document.getElementById("passcode-form");
    var input = document.getElementById("passcode-input");
    var errorEl = document.getElementById("passcode-error");
    panel.hidden = false;
    input.focus();
    form.onsubmit = async function (event) {
      event.preventDefault();
      errorEl.hidden = true;
      try {
        var linkKey = await derivePasscodeKey(input.value, material);
        await decryptLinkData(shareId, data, linkKey);
      } catch (error) {
        errorEl.textContent = "That passcode didn't work.";
        errorEl.hidden = false;
        input.select();
      }
    };
  }

  async function viewShare(shareId, fragment) {
    var dot = fragment.indexOf(".");
    if (dot <= 0) {
      showStatus("This link is incomplete. Ask for a fresh share link.", true);
      return;
    }
    var inviteId = fragment.slice(0, dot);
    var inviteKey;
    try {
      inviteKey = b64urlDecode(fragment.slice(dot + 1));
    } catch (error) {
      showStatus("This link is incomplete. Ask for a fresh share link.", true);
      return;
    }
    var token = loadToken();
    if (!token) {
      await beginSignIn("/s/" + shareId, fragment);
      return;
    }
    showStatus("Decrypting…", false);
    // Send the invite id (not the key) so the server returns this link's own
    // envelope even if the same address holds more than one active invite.
    var viewUrl =
      "/v1/shares/" +
      encodeURIComponent(shareId) +
      "/view?invite=" +
      encodeURIComponent(inviteId);
    var response = await fetch(viewUrl, {
      headers: { authorization: "Bearer " + token },
    });
    if (response.status === 401) {
      sessionStorage.removeItem("june_share_token");
      await beginSignIn("/s/" + shareId, fragment);
      return;
    }
    if (!response.ok) {
      showStatus(NOT_AVAILABLE, true);
      return;
    }
    var body = await response.json().catch(function () { return null; });
    var data = body && body.success && body.data;
    if (!data || !data.envelopeB64) {
      // Owners land here too (no envelope): the app is their viewer.
      showStatus(NOT_AVAILABLE, true);
      return;
    }
    try {
      var contentKey = await aesGcmDecrypt(
        inviteKey,
        b64Decode(data.envelopeIvB64),
        b64Decode(data.envelopeB64)
      );
      var plaintext = await aesGcmDecrypt(
        contentKey,
        b64Decode(data.ivB64),
        b64Decode(data.ciphertextB64)
      );
      var payload = JSON.parse(new TextDecoder().decode(plaintext));
    } catch (error) {
      showStatus(
        "This link's key doesn't match its content. Ask for a fresh share link.",
        true
      );
      return;
    }
    maybeShowPrompt(shareId, payload, function () { showContent(payload); });
  }

  function main() {
    if (!crypto || !crypto.subtle) {
      showStatus("This browser doesn't support the decryption this page needs.", true);
      return;
    }
    var path = location.pathname;
    if (path === "/s/callback") {
      completeSignIn().catch(function () {
        showStatus("Sign-in did not complete. Open your share link again.", true);
      });
      return;
    }
    var match = /^\/s\/(shr_[A-Za-z0-9_-]+)$/.exec(path);
    if (!match) {
      showStatus(NOT_AVAILABLE, true);
      return;
    }
    var fragment = location.hash.replace(/^#/, "");
    if (!fragment) {
      showStatus("This link is incomplete. Ask for a fresh share link.", true);
      return;
    }
    var flow = fragment.indexOf("link.") === 0 ? viewLinkShare : viewShare;
    flow(match[1], fragment).catch(function () {
      showStatus(NOT_AVAILABLE, true);
    });
  }

  main();
})();
