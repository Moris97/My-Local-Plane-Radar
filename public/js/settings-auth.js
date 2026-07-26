const TOKEN_KEY = 'mlpr-settings-token';

export function getStoredToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function storeToken(token) {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

export async function authorizedFetch(url, options = {}) {
  const token = getStoredToken();
  const headers = { ...(options.headers ?? {}) };
  if (token) headers['X-MLPR-Settings-Token'] = token;
  return fetch(url, { ...options, headers });
}
