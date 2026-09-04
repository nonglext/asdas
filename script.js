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
let currentServerChannels = [];       // channels of the server currently open
let currentVoiceChannelId = null;

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

    if (response.status === 401) {
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

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    token = localStorage.getItem('token');
    const userStr = localStorage.getItem('currentUser');

    if (!token || !userStr) {
        window.location.replace('login.html');
        return;
    }

    try {
        currentUser = JSON.parse(userStr);
        initializeApp();
    } catch (e) {
        console.error('Error parsing user data:', e);
        localStorage.removeItem('token');
        localStorage.removeItem('currentUser');
        window.location.replace('login.html');
    }
});

function initializeApp() {
    updateUserInfo();
    initializeFriendsTabs();
    initializeChannels();
    initializeMessageInput();
    initializeUserControls();
    initializeCallControls();
    initializeServerManagement();
    initializeFileUpload();
    initializeEmojiPicker();
    initializeDraggableCallWindow();
    connectToSocketIO();
    requestNotificationPermission();
    loadUserServers();
    showFriendsView();
}

function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

function showNotification(title, body) {
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body, icon: '/assets/icon.png' });
    }
}

function updateUserInfo() {
    const userAvatar = document.querySelector('.user-avatar');
    const username = document.querySelector('.username');

    if (userAvatar) userAvatar.textContent = currentUser.avatar;
    if (username) username.textContent = currentUser.username;
}

// ---------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------
function connectToSocketIO() {
    if (typeof io === 'undefined') return;

    socket = io({ auth: { token: token } });

    socket.on('connect', () => console.log('Connected to server'));
    socket.on('connect_error', (error) => console.error('Connection error:', error));

    socket.on('new-message', (data) => {
        // Compare against the real DB channel id (unique across all servers),
        // not the channel display name (which can repeat between servers).
        if (String(data.channelId) === String(currentChannelId) && currentView === 'server') {
            addMessageToUI(data.message);
            scrollToBottom();
        }
        if (document.hidden) {
            showNotification('New Message', `${data.message.author}: ${data.message.text}`);
        }
    });

    socket.on('reaction-update', (data) => {
        updateMessageReactions(data.messageId, data.reactions);
    });

    socket.on('user-list-update', () => {
        // Someone came online/went offline — refresh friend statuses without a reload.
        loadFriends();
    });

    socket.on('friend-request-accepted', () => {
        loadFriends();
        showNotification('Friend Request Accepted', 'Someone accepted your friend request!');
    });

    socket.on('friend-removed', () => {
        loadFriends();
    });

    // --- WebRTC signaling ---
    socket.on('user-joined-voice', (data) => {
        console.log('User joined voice:', data);
        createPeerConnection(data.socketId, true);
    });

    socket.on('existing-voice-users', (users) => {
        users.forEach(user => createPeerConnection(user.socketId, false));
    });

    socket.on('user-left-voice', (socketId) => {
        if (peerConnections[socketId]) {
            peerConnections[socketId].close();
            delete peerConnections[socketId];
        }
        const remoteEl = document.getElementById(`participant-${socketId}`);
        if (remoteEl) remoteEl.remove();
    });

    socket.on('offer', async (data) => {
        if (!peerConnections[data.from]) {
            createPeerConnection(data.from, false);
        }
        const pc = peerConnections[data.from];
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('answer', { to: data.from, answer });
        } catch (error) {
            console.error('Error handling offer:', error);
        }
    });

    socket.on('answer', async (data) => {
        const pc = peerConnections[data.from];
        if (pc) {
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            } catch (error) {
                console.error('Error handling answer:', error);
            }
        }
    });

    socket.on('ice-candidate', async (data) => {
        const pc = peerConnections[data.from];
        if (pc && data.candidate) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (error) {
                console.error('Error adding ICE candidate:', error);
            }
        }
    });

    socket.on('video-toggle', (data) => {
        const participantDiv = document.getElementById(`participant-${data.from}`);
        if (participantDiv) {
            participantDiv.style.opacity = data.enabled ? '1' : '0.7';
        }
    });

    socket.on('new-dm', (data) => {
        if (data.senderId === currentDMUserId) {
            addMessageToUI({
                id: data.message.id,
                author: data.message.author,
                avatar: data.message.avatar,
                text: data.message.text,
                timestamp: data.message.timestamp
            });
            scrollToBottom();
        }
    });

    socket.on('dm-sent', (data) => {
        if (data.receiverId === currentDMUserId) {
            addMessageToUI({
                id: data.message.id,
                author: currentUser.username,
                avatar: currentUser.avatar,
                text: data.message.text,
                timestamp: data.message.timestamp
            });
            scrollToBottom();
        }
    });

    socket.on('new-friend-request', () => {
        loadPendingRequests();
        showNotification('New Friend Request', 'You have a new friend request!');
    });

    socket.on('incoming-call', (data) => {
        if (data && data.from) {
            showIncomingCall(data.from, data.type);
        }
    });

    socket.on('call-accepted', (data) => {
        console.log('Call accepted by:', data.from);
        const nameEl = document.querySelector('.call-channel-name');
        if (nameEl) nameEl.textContent = `Connected with ${data.from.username}`;

        if (!peerConnections[data.from.socketId]) {
            createPeerConnection(data.from.socketId, true);
        }
    });

    socket.on('call-rejected', () => {
        alert('Call was declined');
        const callInterface = document.getElementById('callInterface');
        callInterface.classList.add('hidden');
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }
        inCall = false;
    });

    socket.on('call-ended', (data) => {
        if (peerConnections[data.from]) {
            peerConnections[data.from].close();
            delete peerConnections[data.from];
        }
        const participantEl = document.getElementById(`participant-${data.from}`);
        if (participantEl) participantEl.remove();

        if (Object.keys(peerConnections).length === 0) {
            leaveVoiceChannel(true);
        }
    });
}

// ---------------------------------------------------------------------
// Friends
// ---------------------------------------------------------------------
function initializeFriendsTabs() {
    document.querySelectorAll('.friends-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            switchFriendsTab(tab.getAttribute('data-tab'));
        });
    });

    const searchBtn = document.getElementById('searchUserBtn');
    if (searchBtn) searchBtn.addEventListener('click', searchUsers);

    const searchInput = document.getElementById('searchUserInput');
    if (searchInput) {
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                searchUsers();
            }
        });
    }

    loadFriends();
}

function switchFriendsTab(tabName) {
    document.querySelectorAll('.friends-tab').forEach(t => t.classList.remove('active'));
    const tabEl = document.querySelector(`[data-tab="${tabName}"]`);
    if (tabEl) tabEl.classList.add('active');

    document.querySelectorAll('.friends-list').forEach(l => l.classList.remove('active-tab'));
    const contentMap = {
        online: 'friendsOnline',
        all: 'friendsAll',
        pending: 'friendsPending',
        add: 'friendsAdd'
    };
    const contentEl = document.getElementById(contentMap[tabName]);
    if (contentEl) contentEl.classList.add('active-tab');

    if (tabName === 'pending') loadPendingRequests();
}

async function loadFriends() {
    try {
        const friends = await apiFetchJson('/api/friends');
        displayFriends(friends);
        populateDMList(friends);
    } catch (error) {
        console.error('Error loading friends:', error);
    }
}

function displayFriends(friends) {
    const onlineList = document.getElementById('friendsOnline');
    const allList = document.getElementById('friendsAll');

    onlineList.innerHTML = '';
    allList.innerHTML = '';

    if (friends.length === 0) {
        onlineList.innerHTML = '<div class="friends-empty">No friends yet</div>';
        allList.innerHTML = '<div class="friends-empty">No friends yet</div>';
        return;
    }

    const onlineFriends = friends.filter(f => f.status === 'Online');

    if (onlineFriends.length === 0) {
        onlineList.innerHTML = '<div class="friends-empty">No one is online</div>';
    } else {
        onlineFriends.forEach(friend => onlineList.appendChild(createFriendItem(friend)));
    }

    friends.forEach(friend => allList.appendChild(createFriendItem(friend)));
}

function createFriendItem(friend) {
    const div = document.createElement('div');
    div.className = 'friend-item';

    const avatarText = friend.avatar || friend.username.charAt(0).toUpperCase();

    div.innerHTML = `
        <div class="friend-avatar">${escapeHtml(avatarText)}</div>
        <div class="friend-info">
            <div class="friend-name">${escapeHtml(friend.username)}</div>
            <div class="friend-status ${friend.status === 'Online' ? '' : 'offline'}">${escapeHtml(friend.status)}</div>
        </div>
        <div class="friend-actions">
            <button class="friend-action-btn message" title="Message">💬</button>
            <button class="friend-action-btn audio-call" title="Audio Call">📞</button>
            <button class="friend-action-btn video-call" title="Video Call">📹</button>
            <button class="friend-action-btn remove" title="Remove">🗑️</button>
        </div>
    `;

    div.querySelector('.message').addEventListener('click', () => startDM(friend.id, friend.username));
    div.querySelector('.audio-call').addEventListener('click', () => initiateCall(friend.id, 'audio'));
    div.querySelector('.video-call').addEventListener('click', () => initiateCall(friend.id, 'video'));
    div.querySelector('.remove').addEventListener('click', () => removeFriend(friend.id));

    return div;
}

async function searchUsers() {
    const searchInput = document.getElementById('searchUserInput');
    const query = searchInput.value.trim();

    if (!query) return;

    try {
        const users = await apiFetchJson('/api/users');
        const results = users.filter(u =>
            u.username.toLowerCase().includes(query.toLowerCase()) &&
            u.id !== currentUser.id
        );
        displaySearchResults(results);
    } catch (error) {
        console.error('Error searching users:', error);
    }
}

function displaySearchResults(users) {
    const resultsDiv = document.getElementById('searchResults');
    resultsDiv.innerHTML = '';

    if (users.length === 0) {
        resultsDiv.innerHTML = '<div class="friends-empty">No users found</div>';
        return;
    }

    users.forEach(user => {
        const div = document.createElement('div');
        div.className = 'user-search-item';

        const avatarText = user.avatar || user.username.charAt(0).toUpperCase();

        div.innerHTML = `
            <div class="user-avatar">${escapeHtml(avatarText)}</div>
            <div class="user-info">
                <div class="user-name">${escapeHtml(user.username)}</div>
            </div>
            <button class="add-friend-btn">Add Friend</button>
        `;

        div.querySelector('.add-friend-btn').addEventListener('click', () => sendFriendRequest(user.id));

        resultsDiv.appendChild(div);
    });
}

async function sendFriendRequest(friendId) {
    try {
        await apiFetchJson('/api/friends/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ friendId })
        });
        alert('Friend request sent!');
    } catch (error) {
        notifyError(error.message || 'Failed to send friend request', error);
    }
}
window.sendFriendRequest = sendFriendRequest;

async function loadPendingRequests() {
    try {
        const requests = await apiFetchJson('/api/friends/pending');

        const pendingList = document.getElementById('friendsPending');
        pendingList.innerHTML = '';

        if (requests.length === 0) {
            pendingList.innerHTML = '<div class="friends-empty">No pending requests</div>';
            return;
        }

        requests.forEach(request => {
            const div = document.createElement('div');
            div.className = 'friend-item';

            const avatarText = request.avatar || request.username.charAt(0).toUpperCase();

            div.innerHTML = `
                <div class="friend-avatar">${escapeHtml(avatarText)}</div>
                <div class="friend-info">
                    <div class="friend-name">${escapeHtml(request.username)}</div>
                    <div class="friend-status">Incoming Friend Request</div>
                </div>
                <div class="friend-actions">
                    <button class="friend-action-btn accept">✓</button>
                    <button class="friend-action-btn reject">✕</button>
                </div>
            `;

            div.querySelector('.accept').addEventListener('click', () => acceptFriendRequest(request.id));
            div.querySelector('.reject').addEventListener('click', () => rejectFriendRequest(request.id));

            pendingList.appendChild(div);
        });
    } catch (error) {
        console.error('Error loading pending requests:', error);
    }
}

async function acceptFriendRequest(friendId) {
    try {
        await apiFetchJson('/api/friends/accept', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ friendId })
        });
        loadPendingRequests();
        loadFriends();
    } catch (error) {
        console.error('Error accepting friend request:', error);
    }
}
window.acceptFriendRequest = acceptFriendRequest;

async function rejectFriendRequest(friendId) {
    try {
        await apiFetchJson('/api/friends/reject', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ friendId })
        });
        loadPendingRequests();
    } catch (error) {
        console.error('Error rejecting friend request:', error);
    }
}
window.rejectFriendRequest = rejectFriendRequest;

async function removeFriend(friendId) {
    if (!confirm('Are you sure you want to remove this friend?')) return;

    try {
        await apiFetchJson(`/api/friends/${friendId}`, { method: 'DELETE' });
        loadFriends();
    } catch (error) {
        console.error('Error removing friend:', error);
    }
}
window.removeFriend = removeFriend;

// ---------------------------------------------------------------------
// Calls (1:1)
// ---------------------------------------------------------------------
async function initiateCall(friendId, type) {
    try {
        const constraints = { video: true, audio: true };
        localStream = await navigator.mediaDevices.getUserMedia(constraints);

        if (type === 'audio') {
            localStream.getVideoTracks().forEach(track => { track.enabled = false; });
        }

        const callInterface = document.getElementById('callInterface');
        callInterface.classList.remove('hidden');

        document.querySelector('.call-channel-name').textContent = 'Calling...';

        const localVideo = document.getElementById('localVideo');
        localVideo.srcObject = localStream;

        window.currentCallDetails = {
            friendId,
            type,
            isInitiator: true,
            originalType: type
        };

        if (socket && socket.connected) {
            socket.emit('initiate-call', {
                to: friendId,
                type,
                from: {
                    id: currentUser.id,
                    username: currentUser.username,
                    socketId: socket.id
                }
            });
        }

        inCall = true;
        isVideoEnabled = type === 'video';
        isAudioEnabled = true;
        updateCallButtons();

        setTimeout(() => {
            if (typeof initializeResizableVideos === 'function') {
                initializeResizableVideos();
            }
        }, 100);

    } catch (error) {
        console.error('Error initiating call:', error);
        alert('Failed to access camera/microphone. Please check permissions.');
    }
}

function showIncomingCall(caller, type) {
    const incomingCallDiv = document.getElementById('incomingCall');
    const callerName = incomingCallDiv.querySelector('.caller-name');
    const callerAvatar = incomingCallDiv.querySelector('.caller-avatar');

    callerName.textContent = caller.username || 'Unknown User';
    callerAvatar.textContent = caller.avatar || caller.username?.charAt(0).toUpperCase() || 'U';

    incomingCallDiv.classList.remove('hidden');

    const acceptBtn = document.getElementById('acceptCallBtn');
    const rejectBtn = document.getElementById('rejectCallBtn');

    acceptBtn.onclick = async () => {
        incomingCallDiv.classList.add('hidden');
        await acceptCall(caller, type);
    };

    rejectBtn.onclick = () => {
        incomingCallDiv.classList.add('hidden');
        rejectCall(caller);
    };

    // Auto-reject after 30 seconds
    setTimeout(() => {
        if (!incomingCallDiv.classList.contains('hidden')) {
            incomingCallDiv.classList.add('hidden');
            rejectCall(caller);
        }
    }, 30000);
}

async function acceptCall(caller, type) {
    try {
        const constraints = { video: true, audio: true };
        localStream = await navigator.mediaDevices.getUserMedia(constraints);

        if (type === 'audio') {
            localStream.getVideoTracks().forEach(track => { track.enabled = false; });
        }

        const callInterface = document.getElementById('callInterface');
        callInterface.classList.remove('hidden');

        document.querySelector('.call-channel-name').textContent = `Call with ${caller.username}`;

        const localVideo = document.getElementById('localVideo');
        localVideo.srcObject = localStream;

        window.currentCallDetails = {
            peerId: caller.socketId,
            type,
            isInitiator: false,
            originalType: type
        };

        if (socket && socket.connected) {
            socket.emit('accept-call', {
                to: caller.socketId,
                from: {
                    id: currentUser.id,
                    username: currentUser.username,
                    socketId: socket.id
                }
            });
        }

        inCall = true;
        isVideoEnabled = type === 'video';
        isAudioEnabled = true;
        updateCallButtons();

        if (!peerConnections[caller.socketId]) {
            createPeerConnection(caller.socketId, false);
        }

        setTimeout(() => {
            if (typeof initializeResizableVideos === 'function') {
                initializeResizableVideos();
            }
        }, 100);

    } catch (error) {
        console.error('Error accepting call:', error);
        alert('Failed to access camera/microphone. Please check permissions.');
    }
}

function rejectCall(caller) {
    if (socket && socket.connected) {
        socket.emit('reject-call', { to: caller.socketId });
    }
}

// ---------------------------------------------------------------------
// Views (friends / DM / server)
// ---------------------------------------------------------------------
async function startDM(friendId, friendUsername) {
    currentView = 'dm';
    currentDMUserId = friendId;
    currentServerId = null;

    document.getElementById('friendsView').style.display = 'none';
    document.getElementById('chatView').style.display = 'flex';
    document.getElementById('channelsView').style.display = 'none';
    document.getElementById('dmListView').style.display = 'block';

    const chatHeaderInfo = document.getElementById('chatHeaderInfo');
    chatHeaderInfo.innerHTML = `
        <div class="friend-avatar">${escapeHtml(friendUsername.charAt(0).toUpperCase())}</div>
        <span class="channel-name">${escapeHtml(friendUsername)}</span>
    `;

    document.getElementById('messageInput').placeholder = `Message @${friendUsername}`;

    await loadDMHistory(friendId);
}
window.startDM = startDM;

function showFriendsView() {
    currentView = 'friends';
    currentDMUserId = null;
    currentServerId = null;

    document.getElementById('friendsView').style.display = 'flex';
    document.getElementById('chatView').style.display = 'none';
    document.getElementById('channelsView').style.display = 'none';
    document.getElementById('dmListView').style.display = 'block';

    document.getElementById('serverName').textContent = 'Friends';

    document.querySelectorAll('.server-icon').forEach(icon => icon.classList.remove('active'));
    document.getElementById('friendsBtn').classList.add('active');
}

async function showServerView(server) {
    currentView = 'server';
    currentServerId = server.id;
    currentDMUserId = null;

    document.getElementById('friendsView').style.display = 'none';
    document.getElementById('chatView').style.display = 'flex';
    document.getElementById('channelsView').style.display = 'block';
    document.getElementById('dmListView').style.display = 'none';

    document.getElementById('serverName').textContent = server.name;

    await loadServerChannels(server.id);
}

// Fetch this server's real channels (each server has its own text/voice
// channel ids — no hardcoded "general = 1, random = 2").
async function loadServerChannels(serverId) {
    try {
        currentServerChannels = await apiFetchJson(`/api/servers/${serverId}/channels`);
    } catch (error) {
        console.error('Error loading channels:', error);
        currentServerChannels = [];
    }

    renderServerChannels(currentServerChannels);

    const firstTextChannel = currentServerChannels.find(c => c.type === 'text');
    if (firstTextChannel) switchChannel(firstTextChannel);
}

// Rebuild the channel list in the sidebar for the currently open server.
function renderServerChannels(channelsList) {
    const container = document.getElementById('channelsView');
    if (!container) return;

    container.innerHTML = '';

    const textChannels = channelsList.filter(c => c.type === 'text');
    const voiceChannels = channelsList.filter(c => c.type === 'voice');

    if (textChannels.length > 0) {
        const textHeader = document.createElement('div');
        textHeader.className = 'channel-category';
        textHeader.textContent = 'TEXT CHANNELS';
        container.appendChild(textHeader);

        textChannels.forEach(ch => {
            const el = document.createElement('div');
            el.className = 'channel text-channel';
            el.setAttribute('data-channel-id', ch.id);
            el.textContent = `# ${ch.name}`;
            el.addEventListener('click', () => switchChannel(ch));
            container.appendChild(el);
        });
    }

    if (voiceChannels.length > 0) {
        const voiceHeader = document.createElement('div');
        voiceHeader.className = 'channel-category';
        voiceHeader.textContent = 'VOICE CHANNELS';
        container.appendChild(voiceHeader);

        voiceChannels.forEach(ch => {
            const el = document.createElement('div');
            el.className = 'channel voice-channel';
            el.setAttribute('data-channel-id', ch.id);
            el.textContent = `🔊 ${ch.name}`;
            el.addEventListener('click', () => joinVoiceChannel(ch));
            container.appendChild(el);
        });
    }
}

// ---------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------
async function loadUserServers() {
    try {
        servers = await apiFetchJson('/api/servers');
        servers.forEach(server => addServerToUI(server, false));
    } catch (error) {
        console.error('Error loading servers:', error);
    }
}

function initializeServerManagement() {
    const friendsBtn = document.getElementById('friendsBtn');
    const addServerBtn = document.getElementById('addServerBtn');

    friendsBtn.addEventListener('click', showFriendsView);
    addServerBtn.addEventListener('click', createNewServer);
}

async function createNewServer() {
    const serverName = prompt('Enter server name:');
    if (!serverName || serverName.trim() === '') return;

    try {
        const server = await apiFetchJson('/api/servers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: serverName.trim() })
        });
        servers.push(server);
        addServerToUI(server, true);
    } catch (error) {
        notifyError('Failed to create server', error);
    }
}

function addServerToUI(server, switchTo = false) {
    const serverList = document.querySelector('.server-list');
    const addServerBtn = document.getElementById('addServerBtn');

    const serverIcon = document.createElement('div');
    serverIcon.className = 'server-icon';
    serverIcon.textContent = server.icon;
    serverIcon.title = server.name;
    serverIcon.setAttribute('data-server-id', server.id);

    serverIcon.addEventListener('click', () => {
        document.querySelectorAll('.server-icon').forEach(icon => icon.classList.remove('active'));
        serverIcon.classList.add('active');
        showServerView(server);
    });

    serverList.insertBefore(serverIcon, addServerBtn);

    if (switchTo) serverIcon.click();
}

// ---------------------------------------------------------------------
// Channels & messages
// ---------------------------------------------------------------------
function initializeChannels() {
    document.querySelectorAll('.channel').forEach(channel => {
        channel.addEventListener('click', () => {
            const channelName = channel.getAttribute('data-channel');
            const isVoiceChannel = channel.classList.contains('voice-channel');

            if (isVoiceChannel) {
                joinVoiceChannel(channelName);
            } else {
                switchChannel(channelName);
            }
        });
    });
}

function switchChannel(channel) {
    // `channel` is the real { id, name, type, serverId } object from the DB.
    currentChannel = channel.name;
    currentChannelId = channel.id;

    document.querySelectorAll('.text-channel').forEach(ch => ch.classList.remove('active'));
    const channelEl = document.querySelector(`[data-channel-id="${channel.id}"]`);
    if (channelEl) channelEl.classList.add('active');

    document.getElementById('currentChannelName').textContent = channel.name;
    document.getElementById('messageInput').placeholder = `Message #${channel.name}`;

    loadChannelMessages(channel.id);
}

async function loadChannelMessages(channelId) {
    const messagesContainer = document.getElementById('messagesContainer');
    messagesContainer.innerHTML = '';

    try {
        const messages = await apiFetchJson(`/api/messages/${channelId}`);
        messages.forEach(message => {
            addMessageToUI({
                id: message.id,
                author: message.username,
                avatar: message.avatar || message.username.charAt(0).toUpperCase(),
                text: message.content,
                timestamp: message.created_at
            });
        });
    } catch (error) {
        console.error('Error loading messages:', error);
    }

    scrollToBottom();
}

function initializeMessageInput() {
    const messageInput = document.getElementById('messageInput');

    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
}

function sendMessage() {
    const messageInput = document.getElementById('messageInput');
    const text = messageInput.value.trim();

    if (text === '') return;
    if (!socket || !socket.connected) {
        console.error('Cannot send message: socket not connected');
        return;
    }

    const message = { text };

    if (currentView === 'dm' && currentDMUserId) {
        socket.emit('send-dm', { receiverId: currentDMUserId, message });
    } else if (currentView === 'server' && currentChannelId) {
        socket.emit('send-message', { channelId: currentChannelId, message });
    }

    messageInput.value = '';
}

// Note: all user-supplied text below is inserted via textContent, never
// innerHTML, so message authors/content can't inject markup.
function addMessageToUI(message) {
    const messagesContainer = document.getElementById('messagesContainer');

    const messageGroup = document.createElement('div');
    messageGroup.className = 'message-group';
    messageGroup.setAttribute('data-message-id', message.id || Date.now());

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = message.avatar;

    const content = document.createElement('div');
    content.className = 'message-content';

    const header = document.createElement('div');
    header.className = 'message-header';

    const author = document.createElement('span');
    author.className = 'message-author';
    author.textContent = message.author;

    const timestamp = document.createElement('span');
    timestamp.className = 'message-timestamp';
    timestamp.textContent = formatTimestamp(message.timestamp);

    const text = document.createElement('div');
    text.className = 'message-text';
    text.textContent = message.text;

    const reactionsContainer = document.createElement('div');
    reactionsContainer.className = 'message-reactions';

    const addReactionBtn = document.createElement('button');
    addReactionBtn.className = 'add-reaction-btn';
    addReactionBtn.textContent = '😊';
    addReactionBtn.title = 'Add reaction';
    addReactionBtn.addEventListener('click', () => showEmojiPickerForMessage(message.id || Date.now()));

    header.appendChild(author);
    header.appendChild(timestamp);
    content.appendChild(header);
    content.appendChild(text);

    // Render a file attachment (if any) as a real preview instead of just text.
    if (message.file && message.file.url) {
        const fileEl = document.createElement('div');
        fileEl.className = 'message-file';

        if (message.file.type && message.file.type.startsWith('image/')) {
            const img = document.createElement('img');
            img.src = message.file.url;
            img.alt = message.file.filename || 'attachment';
            img.style.maxWidth = '300px';
            img.style.borderRadius = '8px';
            fileEl.appendChild(img);
        } else {
            const link = document.createElement('a');
            link.href = message.file.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = message.file.filename || 'Download attachment';
            fileEl.appendChild(link);
        }

        content.appendChild(fileEl);
    }

    content.appendChild(reactionsContainer);
    content.appendChild(addReactionBtn);

    messageGroup.appendChild(avatar);
    messageGroup.appendChild(content);

    messagesContainer.appendChild(messageGroup);
}

function formatTimestamp(date) {
    const messageDate = new Date(date);
    const hours = messageDate.getHours().toString().padStart(2, '0');
    const minutes = messageDate.getMinutes().toString().padStart(2, '0');
    return `Today at ${hours}:${minutes}`;
}

function scrollToBottom() {
    const messagesContainer = document.getElementById('messagesContainer');
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// ---------------------------------------------------------------------
// Emoji picker & reactions
// ---------------------------------------------------------------------
function initializeEmojiPicker() {
    const emojiBtn = document.querySelector('.emoji-btn');
    if (emojiBtn) {
        emojiBtn.addEventListener('click', showEmojiPickerForInput);
    }
}

function showEmojiPickerForInput() {
    const emojis = ['😀', '😂', '❤️', '👍', '👎', '🎉', '🔥', '✨', '💯', '🚀'];
    const picker = createEmojiPicker(emojis, (emoji) => {
        const input = document.getElementById('messageInput');
        input.value += emoji;
        input.focus();
    });
    document.body.appendChild(picker);
}

function showEmojiPickerForMessage(messageId) {
    const emojis = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
    const picker = createEmojiPicker(emojis, (emoji) => addReaction(messageId, emoji));
    document.body.appendChild(picker);
}

function createEmojiPicker(emojis, onSelect) {
    const picker = document.createElement('div');
    picker.className = 'emoji-picker';

    emojis.forEach(emoji => {
        const btn = document.createElement('button');
        btn.className = 'emoji-option';
        btn.textContent = emoji;
        btn.addEventListener('click', () => {
            onSelect(emoji);
            picker.remove();
        });
        picker.appendChild(btn);
    });

    setTimeout(() => {
        document.addEventListener('click', function closePickerAnywhere(e) {
            if (!picker.contains(e.target)) {
                picker.remove();
                document.removeEventListener('click', closePickerAnywhere);
            }
        });
    }, 100);

    return picker;
}

function addReaction(messageId, emoji) {
    if (socket && socket.connected) {
        socket.emit('add-reaction', { messageId, emoji });
    }
}

function updateMessageReactions(messageId, reactions) {
    const reactionsContainer = document.querySelector(`[data-message-id="${messageId}"] .message-reactions`);
    if (!reactionsContainer) return;

    reactionsContainer.innerHTML = '';

    reactions.forEach(reaction => {
        const reactionEl = document.createElement('div');
        reactionEl.className = 'reaction';

        const emojiSpan = document.createElement('span');
        emojiSpan.textContent = `${reaction.emoji} `;
        const countSpan = document.createElement('span');
        countSpan.textContent = reaction.count;

        reactionEl.appendChild(emojiSpan);
        reactionEl.appendChild(countSpan);
        reactionEl.title = reaction.users;

        reactionEl.addEventListener('click', () => {
            if (socket && socket.connected) {
                socket.emit('remove-reaction', { messageId, emoji: reaction.emoji });
            }
        });
        reactionsContainer.appendChild(reactionEl);
    });
}

// ---------------------------------------------------------------------
// File upload
// ---------------------------------------------------------------------
function initializeFileUpload() {
    const attachBtn = document.querySelector('.attach-btn');
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);

    attachBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) await uploadFile(file);
        fileInput.value = '';
    });
}

async function uploadFile(file) {
    try {
        // channelId must be the real DB channel id so /api/upload and the
        // subsequent chat message can be associated with the right channel.
        const channelId = currentView === 'server' ? currentChannelId : currentDMUserId;

        const formData = new FormData();
        formData.append('file', file);
        formData.append('channelId', channelId);

        const fileData = await apiFetchJson('/api/upload', {
            method: 'POST',
            body: formData
            // Note: no Content-Type header here on purpose — the browser
            // sets the correct multipart boundary automatically.
        });

        const message = { text: `Uploaded ${file.name}`, file: fileData };

        if (socket && socket.connected) {
            if (currentView === 'dm' && currentDMUserId) {
                socket.emit('send-dm', { receiverId: currentDMUserId, message });
            } else if (currentView === 'server') {
                socket.emit('send-message', { channelId, message });
            }
        }

    } catch (error) {
        notifyError(error.message || 'Failed to upload file', error);
    }
}

// ---------------------------------------------------------------------
// User controls (mute / deafen / logout)
// ---------------------------------------------------------------------
function setMuteIcon(muted) {
    const muteBtn = document.getElementById('muteBtn');
    if (!muteBtn) return;
    muteBtn.querySelector('.icon-normal').style.display = muted ? 'none' : 'block';
    muteBtn.querySelector('.icon-slashed').style.display = muted ? 'block' : 'none';
    muteBtn.classList.toggle('active', muted);
}

function setDeafenIcon(deafened) {
    const deafenBtn = document.getElementById('deafenBtn');
    if (!deafenBtn) return;
    deafenBtn.querySelector('.icon-normal').style.display = deafened ? 'none' : 'block';
    deafenBtn.querySelector('.icon-slashed').style.display = deafened ? 'block' : 'none';
}

function applyLocalAudioState() {
    if (localStream) {
        localStream.getAudioTracks().forEach(track => { track.enabled = !isMuted; });
    }
}

function initializeUserControls() {
    const muteBtn = document.getElementById('muteBtn');
    const deafenBtn = document.getElementById('deafenBtn');
    const settingsBtn = document.getElementById('settingsBtn');

    muteBtn.addEventListener('click', () => {
        isMuted = !isMuted;
        isAudioEnabled = !isMuted;
        setMuteIcon(isMuted);
        applyLocalAudioState();
        updateCallButtons();
    });

    deafenBtn.addEventListener('click', () => {
        isDeafened = !isDeafened;
        setDeafenIcon(isDeafened);

        // Deafening also mutes the microphone.
        if (isDeafened && !isMuted) {
            isMuted = true;
            isAudioEnabled = false;
            setMuteIcon(true);
        }

        document.querySelectorAll('video[id^="remote-"]').forEach(video => {
            video.volume = isDeafened ? 0 : 1;
        });

        applyLocalAudioState();
        updateCallButtons();
    });

    settingsBtn.addEventListener('click', () => {
        if (confirm('Do you want to logout?')) {
            logout();
        }
    });
}

// ---------------------------------------------------------------------
// Voice channels — call persists when switching views
// ---------------------------------------------------------------------
async function joinVoiceChannel(channel) {
    const channelId = typeof channel === 'object' ? channel.id : channel;
    const channelName = typeof channel === 'object' ? channel.name : channel;

    if (inCall) {
        const callInterface = document.getElementById('callInterface');
        callInterface.classList.remove('hidden');
        return;
    }

    inCall = true;
    currentVoiceChannelId = channelId;

    document.querySelectorAll('.voice-channel').forEach(ch => ch.classList.remove('in-call'));
    const channelEl = document.querySelector(`[data-channel-id="${channelId}"]`);
    if (channelEl) channelEl.classList.add('in-call');

    const callInterface = document.getElementById('callInterface');
    callInterface.classList.remove('hidden');

    document.querySelector('.call-channel-name').textContent = channelName;

    try {
        await initializeMedia();

        // Use the channel's DB id as the room key (not its display name) so
        // same-named voice channels on different servers don't share a room.
        if (socket && socket.connected) {
            socket.emit('join-voice-channel', { channelName: channelId, userId: currentUser.id });
        }
    } catch (error) {
        console.error('Error initializing media:', error);
        alert('Error accessing camera/microphone. Please grant permissions.');
        leaveVoiceChannel(true); // Force leave
    }
}

async function initializeMedia() {
    const constraints = {
        video: {
            width: { ideal: 1280 },
            height: { ideal: 720 }
        },
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
            sampleSize: 16,
            channelCount: 1
        }
    };

    localStream = await navigator.mediaDevices.getUserMedia(constraints);

    const localVideo = document.getElementById('localVideo');
    localVideo.srcObject = localStream;

    const audioTracks = localStream.getAudioTracks();
    console.log('Local audio tracks:', audioTracks.length);
    audioTracks.forEach(track => {
        console.log(`Audio track: ${track.label}, enabled: ${track.enabled}, readyState: ${track.readyState}`);
    });

    if (isMuted || isDeafened) {
        audioTracks.forEach(track => { track.enabled = false; });
    }
}

function leaveVoiceChannel(force = false) {
    if (!inCall) return;

    if (force) {
        inCall = false;

        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }

        if (screenStream) {
            screenStream.getTracks().forEach(track => track.stop());
            screenStream = null;
        }

        if (socket && socket.connected && currentVoiceChannelId) {
            socket.emit('leave-voice-channel', currentVoiceChannelId);
        }
        currentVoiceChannelId = null;

        Object.values(peerConnections).forEach(pc => pc.close());
        peerConnections = {};

        document.querySelectorAll('.voice-channel').forEach(ch => ch.classList.remove('in-call'));
        document.getElementById('remoteParticipants').innerHTML = '';
    }

    const callInterface = document.getElementById('callInterface');
    callInterface.classList.add('hidden');

    if (force) {
        const localVideo = document.getElementById('localVideo');
        localVideo.srcObject = null;
        isVideoEnabled = true;
        isAudioEnabled = true;
        updateCallButtons();
    }
}

function initializeCallControls() {
    const closeCallBtn = document.getElementById('closeCallBtn');
    const toggleVideoBtn = document.getElementById('toggleVideoBtn');
    const toggleAudioBtn = document.getElementById('toggleAudioBtn');
    const toggleScreenBtn = document.getElementById('toggleScreenBtn');

    closeCallBtn.addEventListener('click', () => {
        // End call for both voice channels and direct calls.
        if (window.currentCallDetails) {
            Object.keys(peerConnections).forEach(socketId => {
                if (socket && socket.connected) {
                    socket.emit('end-call', { to: socketId });
                }
            });
            window.currentCallDetails = null;
        }
        leaveVoiceChannel(true);
    });

    toggleVideoBtn.addEventListener('click', toggleVideo);
    toggleAudioBtn.addEventListener('click', toggleAudio);
    toggleScreenBtn.addEventListener('click', toggleScreenShare);
}

function toggleVideo() {
    if (!localStream) return;

    isVideoEnabled = !isVideoEnabled;
    localStream.getVideoTracks().forEach(track => { track.enabled = isVideoEnabled; });

    Object.keys(peerConnections).forEach(socketId => {
        if (socket && socket.connected) {
            socket.emit('video-toggle', { to: socketId, enabled: isVideoEnabled });
        }
    });

    updateCallButtons();
}

function toggleAudio() {
    if (!localStream) return;

    isAudioEnabled = !isAudioEnabled;
    isMuted = !isAudioEnabled;

    localStream.getAudioTracks().forEach(track => { track.enabled = isAudioEnabled; });
    setMuteIcon(isMuted);
    updateCallButtons();
}

async function toggleScreenShare() {
    if (screenStream) {
        // Stop screen sharing, fall back to the camera track.
        screenStream.getTracks().forEach(track => track.stop());

        const videoTrack = localStream ? localStream.getVideoTracks()[0] : null;
        Object.values(peerConnections).forEach(pc => {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender && videoTrack) sender.replaceTrack(videoTrack);
        });

        screenStream = null;

        const localVideo = document.getElementById('localVideo');
        localVideo.srcObject = localStream;

        updateCallButtons();
        return;
    }

    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                cursor: 'always',
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                sampleRate: 44100
            }
        });

        const screenTrack = screenStream.getVideoTracks()[0];

        Object.values(peerConnections).forEach(pc => {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) sender.replaceTrack(screenTrack);
        });

        const localVideo = document.getElementById('localVideo');
        const audioTracks = localStream ? localStream.getAudioTracks() : [];
        localVideo.srcObject = new MediaStream([screenTrack, ...audioTracks]);

        screenTrack.addEventListener('ended', () => {
            toggleScreenShare(); // Stops screen sharing.
        });

        updateCallButtons();
    } catch (error) {
        console.error('Error sharing screen:', error);
        if (error.name === 'NotAllowedError') {
            alert('Screen sharing permission denied');
        } else {
            alert('Error sharing screen. Please try again.');
        }
    }
}

function updateCallButtons() {
    const toggleVideoBtn = document.getElementById('toggleVideoBtn');
    const toggleAudioBtn = document.getElementById('toggleAudioBtn');
    const toggleScreenBtn = document.getElementById('toggleScreenBtn');

    if (toggleVideoBtn) toggleVideoBtn.classList.toggle('active', !isVideoEnabled);
    if (toggleAudioBtn) toggleAudioBtn.classList.toggle('active', !isAudioEnabled);
    if (toggleScreenBtn) toggleScreenBtn.classList.toggle('active', screenStream !== null);
}

// ---------------------------------------------------------------------
// Draggable call window
// ---------------------------------------------------------------------
function initializeDraggableCallWindow() {
    const callInterface = document.getElementById('callInterface');
    const callHeader = callInterface.querySelector('.call-header');
    let isDragging = false;
    let offsetX, offsetY;

    callHeader.addEventListener('mousedown', (e) => {
        isDragging = true;
        offsetX = e.clientX - callInterface.offsetLeft;
        offsetY = e.clientY - callInterface.offsetTop;
        callInterface.style.transition = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        let newX = e.clientX - offsetX;
        let newY = e.clientY - offsetY;

        const maxX = window.innerWidth - callInterface.offsetWidth;
        const maxY = window.innerHeight - callInterface.offsetHeight;

        newX = Math.max(0, Math.min(newX, maxX));
        newY = Math.max(0, Math.min(newY, maxY));

        callInterface.style.left = `${newX}px`;
        callInterface.style.top = `${newY}px`;
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            callInterface.style.transition = 'all 0.3s ease';
        }
    });
}

// ---------------------------------------------------------------------
// Direct messages
// ---------------------------------------------------------------------
async function loadDMHistory(userId) {
    const messagesContainer = document.getElementById('messagesContainer');
    messagesContainer.innerHTML = '';

    try {
        const messages = await apiFetchJson(`/api/dm/${userId}`);
        messages.forEach(message => {
            addMessageToUI({
                id: message.id,
                author: message.username,
                avatar: message.avatar || message.username.charAt(0).toUpperCase(),
                text: message.content,
                timestamp: message.created_at
            });
        });
    } catch (error) {
        console.error('Error loading DM history:', error);
    }

    scrollToBottom();
}

function populateDMList(friends) {
    const dmList = document.getElementById('dmList');
    dmList.innerHTML = '';

    if (friends.length === 0) {
        const emptyDM = document.createElement('div');
        emptyDM.className = 'empty-dm-list';
        emptyDM.textContent = 'No conversations yet.';
        dmList.appendChild(emptyDM);
        return;
    }

    friends.forEach(friend => {
        const dmItem = document.createElement('div');
        dmItem.className = 'channel';
        dmItem.setAttribute('data-dm-id', friend.id);

        const avatarText = friend.avatar || friend.username.charAt(0).toUpperCase();

        dmItem.innerHTML = `
            <div class="friend-avatar">${escapeHtml(avatarText)}</div>
            <span>${escapeHtml(friend.username)}</span>
        `;
        dmItem.addEventListener('click', () => startDM(friend.id, friend.username));
        dmList.appendChild(dmItem);
    });
}

// ---------------------------------------------------------------------
// WebRTC
// ---------------------------------------------------------------------
function createPeerConnection(remoteSocketId, isInitiator) {
    console.log(`Creating peer connection with ${remoteSocketId}, initiator: ${isInitiator}`);

    if (peerConnections[remoteSocketId]) {
        console.log('Peer connection already exists');
        return peerConnections[remoteSocketId];
    }

    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' }
        ],
        iceCandidatePoolSize: 10
    });

    peerConnections[remoteSocketId] = pc;

    if (localStream) {
        const audioTracks = localStream.getAudioTracks();
        const videoTracks = localStream.getVideoTracks();

        console.log(`Adding tracks - Audio: ${audioTracks.length}, Video: ${videoTracks.length}`);

        // Audio tracks first — priority for voice calls.
        audioTracks.forEach(track => {
            console.log(`Adding audio track: ${track.label}, enabled: ${track.enabled}`);
            pc.addTrack(track, localStream);
        });
        videoTracks.forEach(track => {
            console.log(`Adding video track: ${track.label}, enabled: ${track.enabled}`);
            pc.addTrack(track, localStream);
        });
    } else {
        console.error('No local stream available');
    }

    pc.onicecandidate = (event) => {
        if (event.candidate && socket && socket.connected) {
            socket.emit('ice-candidate', { to: remoteSocketId, candidate: event.candidate });
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`ICE connection state: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed') {
            console.error('ICE connection failed, restarting ICE');
            pc.restartIce();
        }
        if (pc.iceConnectionState === 'connected') {
            console.log('Peer connection established successfully!');
        }
    };

    pc.ontrack = (event) => {
        console.log('Received remote track:', event.track.kind, 'Stream ID:', event.streams[0]?.id);

        const remoteParticipants = document.getElementById('remoteParticipants');

        let participantDiv = document.getElementById(`participant-${remoteSocketId}`);
        let remoteVideo = document.getElementById(`remote-${remoteSocketId}`);

        if (!participantDiv) {
            participantDiv = document.createElement('div');
            participantDiv.className = 'participant';
            participantDiv.id = `participant-${remoteSocketId}`;

            remoteVideo = document.createElement('video');
            remoteVideo.id = `remote-${remoteSocketId}`;
            remoteVideo.autoplay = true;
            remoteVideo.playsInline = true;
            remoteVideo.volume = isDeafened ? 0 : 1;

            const participantName = document.createElement('div');
            participantName.className = 'participant-name';
            participantName.textContent = 'Friend';

            participantDiv.appendChild(remoteVideo);
            participantDiv.appendChild(participantName);
            remoteParticipants.appendChild(participantDiv);
        }

        if (event.streams && event.streams[0]) {
            console.log('Setting remote stream to video element');
            remoteVideo = document.getElementById(`remote-${remoteSocketId}`);
            if (remoteVideo) {
                remoteVideo.srcObject = event.streams[0];
                remoteVideo.play().catch(e => {
                    console.error('Error playing remote video:', e);
                    document.addEventListener('click', () => {
                        remoteVideo.play().catch(err => console.error('Still cannot play:', err));
                    }, { once: true });
                });
            }
        }

        setTimeout(() => {
            if (typeof makeResizable === 'function' && participantDiv) {
                makeResizable(participantDiv);
            }
        }, 100);
    };

    if (isInitiator) {
        pc.createOffer()
            .then(offer => {
                console.log('Created offer with SDP:', offer.sdp.substring(0, 200));
                return pc.setLocalDescription(offer);
            })
            .then(() => {
                console.log('Sending offer to:', remoteSocketId);
                socket.emit('offer', { to: remoteSocketId, offer: pc.localDescription });
            })
            .catch(error => console.error('Error creating offer:', error));
    }

    return pc;
}

// ---------------------------------------------------------------------
// Resizable video windows
// ---------------------------------------------------------------------
function initializeResizableVideos() {
    const callInterface = document.getElementById('callInterface');
    if (!callInterface) return;

    callInterface.querySelectorAll('.participant').forEach(makeResizable);
    makeInterfaceResizable(callInterface);
}

function makeResizable(element) {
    if (!element || element.hasAttribute('data-resizable')) return;

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'resize-handle';
    resizeHandle.innerHTML = '↘';
    resizeHandle.style.cssText = `
        position: absolute;
        bottom: 5px;
        right: 5px;
        width: 20px;
        height: 20px;
        background: rgba(255,255,255,0.3);
        cursor: nwse-resize;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 3px;
        font-size: 12px;
        color: white;
        user-select: none;
        z-index: 10;
    `;

    const sizeControls = document.createElement('div');
    sizeControls.className = 'video-size-controls';
    sizeControls.innerHTML = `
        <button class="size-control-btn minimize-btn" title="Minimize">_</button>
        <button class="size-control-btn maximize-btn" title="Maximize">□</button>
        <button class="size-control-btn fullscreen-btn" title="Fullscreen">⛶</button>
    `;
    sizeControls.style.cssText = `
        position: absolute;
        top: 8px;
        right: 8px;
        display: flex;
        gap: 4px;
        opacity: 0;
        transition: opacity 0.3s ease;
        z-index: 10;
    `;

    element.appendChild(resizeHandle);
    element.appendChild(sizeControls);
    element.style.resize = 'both';
    element.style.overflow = 'auto';
    element.style.minWidth = '150px';
    element.style.minHeight = '100px';
    element.style.maxWidth = '90vw';
    element.style.maxHeight = '90vh';
    element.setAttribute('data-resizable', 'true');

    element.addEventListener('mouseenter', () => { sizeControls.style.opacity = '1'; });
    element.addEventListener('mouseleave', () => { sizeControls.style.opacity = '0'; });

    element.addEventListener('dblclick', (e) => {
        if (!e.target.closest('.video-size-controls')) {
            toggleVideoFullscreen(element);
        }
    });

    const minimizeBtn = sizeControls.querySelector('.minimize-btn');
    const maximizeBtn = sizeControls.querySelector('.maximize-btn');
    const fullscreenBtn = sizeControls.querySelector('.fullscreen-btn');

    minimizeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        element.classList.toggle('minimized');
        element.classList.remove('maximized');
    });

    maximizeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        element.classList.toggle('maximized');
        element.classList.remove('minimized');
    });

    fullscreenBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const video = element.querySelector('video');
        if (video && video.requestFullscreen) video.requestFullscreen();
    });
}

function toggleVideoFullscreen(element) {
    element.classList.toggle('maximized');
    if (element.classList.contains('maximized')) {
        element.classList.remove('minimized');
    }
}

function makeInterfaceResizable(callInterface) {
    if (!callInterface || callInterface.hasAttribute('data-interface-resizable')) return;

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'interface-resize-handle';
    resizeHandle.style.cssText = `
        position: absolute;
        bottom: 0;
        right: 0;
        width: 15px;
        height: 15px;
        cursor: nwse-resize;
        background: linear-gradient(135deg, transparent 50%, #5865f2 50%);
        border-bottom-right-radius: 12px;
    `;

    callInterface.appendChild(resizeHandle);
    callInterface.setAttribute('data-interface-resizable', 'true');

    let isResizing = false;
    let startWidth = 0;
    let startHeight = 0;
    let startX = 0;
    let startY = 0;

    resizeHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startWidth = parseInt(document.defaultView.getComputedStyle(callInterface).width, 10);
        startHeight = parseInt(document.defaultView.getComputedStyle(callInterface).height, 10);
        startX = e.clientX;
        startY = e.clientY;
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;

        const newWidth = startWidth + e.clientX - startX;
        const newHeight = startHeight + e.clientY - startY;

        if (newWidth > 400 && newWidth < window.innerWidth * 0.9) {
            callInterface.style.width = `${newWidth}px`;
        }
        if (newHeight > 300 && newHeight < window.innerHeight * 0.9) {
            callInterface.style.height = `${newHeight}px`;
        }
    });

    document.addEventListener('mouseup', () => { isResizing = false; });
}

console.log('Discord Clone initialized successfully!');