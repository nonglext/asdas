// Calls (1:1)
// ---------------------------------------------------------------------
async function initiateCall(friendId, type) {
    try {
        const constraints = { video: type === 'video', audio: true };
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

        incomingCallTimer = setTimeout(() => {
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

    clearTimeout(incomingCallTimer);
    incomingCallDiv.classList.remove('hidden');

    const acceptBtn = document.getElementById('acceptCallBtn');
    const rejectBtn = document.getElementById('rejectCallBtn');

    acceptBtn.onclick = async () => {
        clearTimeout(incomingCallTimer);
        incomingCallDiv.classList.add('hidden');
        await acceptCall(caller, type);
    };

    rejectBtn.onclick = () => {
        clearTimeout(incomingCallTimer);
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
        const constraints = { video: type === 'video', audio: true };
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
    const chatView = document.getElementById('chatView');
    chatView.classList.add('dm-open');
    animateView(chatView);
    document.getElementById('channelsView').style.display = 'none';
    document.getElementById('dmListView').style.display = 'block';
    document.getElementById('dmProfileName').textContent = friendUsername;
    document.getElementById('dmProfileTag').textContent = `@${friendUsername}`;
    document.getElementById('dmProfileAvatar').textContent =
        friendUsername.charAt(0).toUpperCase();

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

    animateView(document.getElementById('friendsView'));
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
    const chatView = document.getElementById('chatView');
    chatView.classList.remove('dm-open');
    animateView(chatView);
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

    let channelContainer = container.querySelector('.channels-container');
    if (!channelContainer) {
        channelContainer = document.createElement('div');
        channelContainer.className = 'channels-container';
        container.appendChild(channelContainer);
    }
    channelContainer.innerHTML = '';

    const textChannels = channelsList.filter(c => c.type === 'text');
    const voiceChannels = channelsList.filter(c => c.type === 'voice');

    if (textChannels.length === 0 && voiceChannels.length === 0) {
        renderEmptyState(channelContainer, 'No channels available');
        return;
    }

    if (textChannels.length > 0) {
        const textHeader = document.createElement('div');
        textHeader.className = 'channel-category';
        textHeader.textContent = 'TEXT CHANNELS';
        channelContainer.appendChild(textHeader);

        textChannels.forEach(ch => {
            const el = document.createElement('div');
            el.className = 'channel text-channel';
            el.setAttribute('data-channel-id', ch.id);
            el.textContent = `# ${ch.name}`;
            const openChannel = () => switchChannel(ch);
            el.addEventListener('click', openChannel);
            makeKeyboardClickable(el, openChannel);
            channelContainer.appendChild(el);
        });
    }

    if (voiceChannels.length > 0) {
        const voiceHeader = document.createElement('div');
        voiceHeader.className = 'channel-category';
        voiceHeader.textContent = 'VOICE CHANNELS';
        channelContainer.appendChild(voiceHeader);

        voiceChannels.forEach(ch => {
            const el = document.createElement('div');
            el.className = 'channel voice-channel';
            el.setAttribute('data-channel-id', ch.id);
            el.textContent = `🔊 ${ch.name}`;
            const openVoice = () => joinVoiceChannel(ch);
            el.addEventListener('click', openVoice);
            makeKeyboardClickable(el, openVoice);
            channelContainer.appendChild(el);
        });
    }
}

// ---------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------
async function loadUserServers() {
    try {
        servers = await apiFetchJson('/api/servers');
        document.querySelectorAll('.server-icon[data-server-id]').forEach(icon => icon.remove());
        servers.forEach(server => addServerToUI(server, false));
    } catch (error) {
        console.error('Error loading servers:', error);
        notifyError('Unable to load servers', error);
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
    makeKeyboardClickable(serverIcon, () => serverIcon.click());

    serverList.insertBefore(serverIcon, addServerBtn);

    if (switchTo) serverIcon.click();
}

// ---------------------------------------------------------------------
