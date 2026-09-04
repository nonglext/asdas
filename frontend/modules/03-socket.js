// Socket.IO
// ---------------------------------------------------------------------
function connectToSocketIO() {
    if (typeof io === 'undefined') return;

    socket = io({ auth: { token: token } });

    socket.on('connect', () => {
        console.log('Connected to server');
        if (currentChannelId) {
            socket.emit('join-channel', { channelId: currentChannelId });
            joinedChannelId = currentChannelId;
        }
    });
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
