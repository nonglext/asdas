// Channels & messages
// ---------------------------------------------------------------------
function initializeChannels() {
    document.querySelectorAll('.channel').forEach(channel => {
        const channelName = channel.getAttribute('data-channel');
        const isVoiceChannel = channel.classList.contains('voice-channel');
        const openChannel = () => isVoiceChannel
            ? joinVoiceChannel(channelName)
            : switchChannel(channelName);
        makeKeyboardClickable(channel, openChannel);
        channel.addEventListener('click', () => {
            openChannel();
        });
    });
}

function switchChannel(channel) {
    // `channel` is the real { id, name, type, serverId } object from the DB.
    if (typeof channel === 'string') {
        channel = { id: channel, name: channel };
    }
    if (socket && socket.connected && joinedChannelId && String(joinedChannelId) !== String(channel.id)) {
        socket.emit('leave-channel', { channelId: joinedChannelId });
    }
    currentChannel = channel.name;
    currentChannelId = channel.id;
    if (socket && socket.connected) {
        socket.emit('join-channel', { channelId: channel.id });
        joinedChannelId = channel.id;
    }

    document.querySelectorAll('.text-channel').forEach(ch => ch.classList.remove('active'));
    const channelEl = document.querySelector(`[data-channel-id="${channel.id}"], [data-channel="${channel.name}"]`);
    if (channelEl) channelEl.classList.add('active');

    const channelNameEl = document.querySelector('#chatHeaderInfo .channel-name');
    if (channelNameEl) channelNameEl.textContent = channel.name;
    document.getElementById('messageInput').placeholder = `Message #${channel.name}`;

    loadChannelMessages(channel.id);
}

async function loadChannelMessages(channelId) {
    const messagesContainer = document.getElementById('messagesContainer');
    const requestId = ++messagesLoadRequest;
    messagesContainer.innerHTML = '';
    messagesContainer.classList.add('is-loading');

    try {
        const messages = await apiFetchJson(`/api/messages/${channelId}`);
        if (requestId !== messagesLoadRequest || currentChannelId !== channelId) return;
        if (messages.length === 0) renderEmptyState(messagesContainer, 'No messages yet');
        messages.forEach(message => {
            addMessageToUI({
                id: message.id,
                author: message.username,
                avatar: message.avatar || message.username.charAt(0).toUpperCase(),
                text: message.content,
                file: message.file || (message.attachment_url ? {
                    url: message.attachment_url,
                    filename: message.attachment_name,
                    type: message.attachment_type,
                    size: message.attachment_size
                } : null),
                timestamp: message.created_at
            });
        });
    } catch (error) {
        console.error('Error loading messages:', error);
        renderErrorState(messagesContainer, 'Unable to load messages', () => loadChannelMessages(channelId));
    } finally {
        if (requestId === messagesLoadRequest) {
            messagesContainer.classList.remove('is-loading');
        }
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
    avatar.textContent = message.avatar || (message.author || '?').charAt(0).toUpperCase();

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

    if (currentView === 'server') {
        content.appendChild(reactionsContainer);
        content.appendChild(addReactionBtn);
    }

    messageGroup.appendChild(avatar);
    messageGroup.appendChild(content);

    messagesContainer.appendChild(messageGroup);
}

function formatTimestamp(date) {
    const messageDate = new Date(date);
    if (Number.isNaN(messageDate.getTime())) return '';
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
    document.querySelectorAll('.emoji-picker').forEach(existingPicker => existingPicker.remove());
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
        if (currentView === 'server' && channelId) formData.append('channelId', channelId);

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
    deafenBtn.classList.toggle('active', deafened);
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
    const profileBtn = document.getElementById('profileBtn');
    const profilePopover = document.getElementById('profilePopover');
    const profileLogoutBtn = document.getElementById('profileLogoutBtn');
    const profileStatusBtn = document.getElementById('profileStatusBtn');
    const profileEditBtn = document.getElementById('profileEditBtn');

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

    if (profileBtn && profilePopover) {
        const closeProfile = () => {
            profilePopover.classList.remove('open');
            profilePopover.setAttribute('aria-hidden', 'true');
            profileBtn.setAttribute('aria-expanded', 'false');
        };

        profileBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            const isOpen = profilePopover.classList.toggle('open');
            profilePopover.setAttribute('aria-hidden', String(!isOpen));
            profileBtn.setAttribute('aria-expanded', String(isOpen));
            if (isOpen) {
                document.querySelector('.profile-username').textContent = currentUser.username;
                document.querySelector('.profile-tag').textContent = currentUser.status || 'Online';
                document.querySelector('.profile-avatar').textContent =
                    currentUser.avatar || currentUser.username.charAt(0).toUpperCase();
            }
        });

        profilePopover.addEventListener('click', event => event.stopPropagation());
        document.addEventListener('click', closeProfile);
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') closeProfile();
        });
        profileLogoutBtn.addEventListener('click', () => {
            closeProfile();
            if (confirm('Do you want to logout?')) logout();
        });
        profileStatusBtn.addEventListener('click', async () => {
            const status = prompt('Set status (Online, Idle, Do Not Disturb, Invisible):', currentUser.status || 'Online');
            if (!status || !status.trim()) return;
            try {
                const response = await apiFetchJson('/api/user/status', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: status.trim() })
                });
                currentUser.status = response.status;
                localStorage.setItem('currentUser', JSON.stringify(currentUser));
                document.querySelector('.profile-tag').textContent = response.status;
                document.querySelector('.user-status').textContent = response.status;
            } catch (error) {
                notifyError(error.message || 'Failed to update status', error);
            }
        });
        profileEditBtn.addEventListener('click', async () => {
            const username = prompt('Change username:', currentUser.username);
            if (!username || username.trim() === currentUser.username) return;
            try {
                const response = await apiFetchJson('/api/user/profile', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: username.trim() })
                });
                currentUser.username = response.username;
                localStorage.setItem('currentUser', JSON.stringify(currentUser));
                updateUserInfo();
                document.querySelector('.profile-username').textContent = response.username;
            } catch (error) {
                notifyError(error.message || 'Failed to update profile', error);
            }
        });
    }
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
    if (toggleScreenBtn) toggleScreenBtn.classList.toggle('screen-active', screenStream !== null);
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
        const rect = callInterface.getBoundingClientRect();
        callInterface.style.transform = 'none';
        callInterface.style.left = `${rect.left}px`;
        callInterface.style.top = `${rect.top}px`;
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
    const requestId = ++messagesLoadRequest;
    messagesContainer.innerHTML = '';
    messagesContainer.classList.add('is-loading');

    try {
        const messages = await apiFetchJson(`/api/dm/${userId}`);
        if (requestId !== messagesLoadRequest || currentDMUserId !== userId) return;
        if (messages.length === 0) renderEmptyState(messagesContainer, 'No messages yet');
        messages.forEach(message => {
            addMessageToUI({
                id: message.id,
                author: message.username,
                avatar: message.avatar || message.username.charAt(0).toUpperCase(),
                text: message.content,
                file: message.attachment || (message.attachment_url ? {
                    url: message.attachment_url,
                    filename: message.attachment_name,
                    type: message.attachment_type,
                    size: message.attachment_size
                } : null),
                timestamp: message.created_at
            });
        });
    } catch (error) {
        console.error('Error loading DM history:', error);
        if (requestId === messagesLoadRequest) {
            renderErrorState(messagesContainer, 'Unable to load messages', () => loadDMHistory(userId));
        }
    } finally {
        if (requestId === messagesLoadRequest) {
            messagesContainer.classList.remove('is-loading');
        }
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
        const openDM = () => startDM(friend.id, friend.username);
        dmItem.addEventListener('click', openDM);
        makeKeyboardClickable(dmItem, openDM);
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
        toggleVideoFullscreen(element);
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
