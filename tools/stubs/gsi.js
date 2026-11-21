window.google = window.google || {};
google.accounts = { oauth2: { initTokenClient: o => ({ requestAccessToken: () => setTimeout(() => o.callback({ access_token:"TESTTOKEN", expires_in:3600 }), 10) }) } };
