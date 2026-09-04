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

    const dmSearchInput = document.querySelector('.dm-search-bar input');
    if (dmSearchInput) {
        dmSearchInput.addEventListener('input', () => {
            const query = dmSearchInput.value.trim().toLowerCase();
            document.querySelectorAll('#dmList .channel').forEach(item => {
                item.hidden = query !== '' && !item.textContent.toLowerCase().includes(query);
            });
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

function renderErrorState(container, message, retry) {
    if (!container) return;
    container.innerHTML = '';
    const state = document.createElement('div');
    state.className = 'friends-empty error-state';
    state.textContent = message;
    const button = document.createElement('button');
    button.className = 'retry-btn';
    button.type = 'button';
    button.textContent = 'Retry';
    button.addEventListener('click', retry);
    state.appendChild(button);
    container.appendChild(state);
}

function makeKeyboardClickable(element, handler) {
    element.tabIndex = 0;
    element.setAttribute('role', 'button');
    element.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handler();
        }
    });
}

function renderEmptyState(container, message) {
    if (!container) return;
    const state = document.createElement('div');
    state.className = 'friends-empty';
    state.textContent = message;
    container.appendChild(state);
}

async function loadFriends() {
    try {
        const friends = await apiFetchJson('/api/friends');
        displayFriends(friends);
        populateDMList(friends);
    } catch (error) {
        console.error('Error loading friends:', error);
        renderErrorState(document.getElementById('friendsOnline'), 'Unable to load friends', loadFriends);
        renderErrorState(document.getElementById('friendsAll'), 'Unable to load friends', loadFriends);
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
            <button class="friend-action-btn audio-call" title="Audio Call" aria-label="Audio Call">
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M6.62 10.79a15.46 15.46 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24c1.12.37 2.33.57 3.57.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C11.72 21 3 12.28 3 2.99a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1.02l-2.2 2.21Z"/>
                </svg>
            </button>
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

    if (!query) {
        displaySearchResults([]);
        return;
    }

    try {
        const users = await apiFetchJson('/api/users');
        const results = users.filter(u =>
            u.username.toLowerCase().includes(query.toLowerCase()) &&
            u.id !== currentUser.id
        );
        displaySearchResults(results);
    } catch (error) {
        console.error('Error searching users:', error);
        renderErrorState(document.getElementById('searchResults'), 'Search failed', searchUsers);
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
        renderErrorState(document.getElementById('friendsPending'), 'Unable to load requests', loadPendingRequests);
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
