const { app, BrowserWindow, Notification, ipcMain } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        },
        icon: path.join(__dirname, 'assets', 'icon.png'),
        frame: true,
        titleBarStyle: 'default',
        backgroundColor: '#36393f'
    });

    // Load the app
    mainWindow.loadURL('http://localhost:3000/login.html');

    // Open DevTools in development
    if (process.env.NODE_ENV === 'development') {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // Handle notifications
    ipcMain.on('show-notification', (event, { title, body }) => {
        if (Notification.isSupported()) {
            new Notification({
                title,
                body,
                icon: path.join(__dirname, 'assets', 'icon.png')
            }).show();
        }
    });

    // Handle minimize to tray
    mainWindow.on('minimize', (event) => {
        event.preventDefault();
        mainWindow.hide();
    });

    mainWindow.on('close', (event) => {
        if (!app.isQuiting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    } else {
        mainWindow.show();
    }
});

app.on('before-quit', () => {
    app.isQuiting = true;
});

// Auto-updater (optional)
if (process.platform !== 'linux') {
    const { autoUpdater } = require('electron-updater');
    
    autoUpdater.on('update-downloaded', () => {
        autoUpdater.quitAndInstall();
    });
    
    app.on('ready', () => {
        if (process.env.NODE_ENV === 'production') {
            autoUpdater.checkForUpdates();
        }
    });
}