// =====================================================================
// Discord Clone — client script (refactored)
// =====================================================================

// ---------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------
let currentChannel = 'general';
let servers = [];
let inCall = false;
let localStream = null;
let screenStream = null;
let peerConnections = {};
let isVideoEnabled = true;
let isAudioEnabled = true;
let isMuted = false;
let isDeafened = false;
let currentUser = null;
let socket = null;
let token = null;
let currentView = 'friends';
let currentServerId = null;
let currentDMUserId = null;
let currentChannelId = null;          // real DB id of the active text channel
let joinedChannelId = null;
let currentServerChannels = [];       // channels of the server currently open
let currentVoiceChannelId = null;
let messagesLoadRequest = 0;
let incomingCallTimer = null;

// ---------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------

// Escapes text before it is dropped into innerHTML, to avoid XSS from
// usernames / any other user-controlled string.
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function authHeaders(extra = {}) {
    return {
        'Authorization': `Bearer ${token}`,
        ...extra
    };
}

// Central fetch wrapper: attaches the auth header, parses JSON, and
// redirects to the login page on 401 instead of failing silently
// everywhere a request happens to touch a protected endpoint.
async function apiFetch(url, options = {}) {
    const headers = authHeaders(options.headers || {});
    const response = await fetch(url, { ...options, headers });

    if (response.status === 401 || response.status === 403) {
        logout();
        throw new Error('Session expired');
    }
    return response;
}

async function apiFetchJson(url, options = {}) {
    const response = await apiFetch(url, options);
    if (!response.ok) {
        let message = `Request failed (${response.status})`;
        try {
            const err = await response.json();
            if (err && err.error) message = err.error;
        } catch (_) { /* ignore non-JSON error bodies */ }
        throw new Error(message);
    }
    // Some endpoints (e.g. DELETE) may return no body.
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

function logout() {
    if (inCall) leaveVoiceChannel(true);
    localStorage.removeItem('token');
    localStorage.removeItem('currentUser');
    if (socket) socket.disconnect();
    window.location.replace('login.html');
}

function notifyError(message, error) {
    if (error) console.error(message, error);
    else console.error(message);
    alert(message);
}

function animateView(element, display = 'flex') {
    if (!element) return;
    element.style.display = element.id === 'chatView' ? 'grid' : display;
    element.classList.remove('view-enter');
    requestAnimationFrame(() => element.classList.add('view-enter'));
}

// ---------------------------------------------------------------------
