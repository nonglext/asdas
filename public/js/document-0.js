// Не мигать экраном логина, если сессия уже есть
    try {
      if (localStorage.getItem('chatapp_token') && localStorage.getItem('chatapp_profile')) document.documentElement.classList.add('has-session');
    } catch {}
  