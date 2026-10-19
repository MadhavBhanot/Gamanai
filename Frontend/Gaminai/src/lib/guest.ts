// Guest demo flag: lets recruiters try the app without OAuth. Lives for the tab session only.
const GUEST_KEY = 'gaminai_guest';

export function isGuestMode() {
  try {
    return sessionStorage.getItem(GUEST_KEY) === '1';
  } catch {
    return false;
  }
}

export function setGuestMode(enabled: boolean) {
  try {
    if (enabled) {
      sessionStorage.setItem(GUEST_KEY, '1');
    } else {
      sessionStorage.removeItem(GUEST_KEY);
    }
  } catch {
    // storage blocked: guest mode simply won't persist across reloads
  }
}
