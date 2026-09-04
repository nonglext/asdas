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
    const status = document.querySelector('.user-status');
    if (status) status.textContent = currentUser.status || 'Online';
}

// ---------------------------------------------------------------------
