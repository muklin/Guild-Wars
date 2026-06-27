const KEY_SHOW_TUTORIALS = 'gw.settings.showTutorials'

const Settings = {
  get showTutorials() {
    try {
      const v = localStorage.getItem(KEY_SHOW_TUTORIALS)
      return v === null ? true : v === '1'
    } catch { return true }
  },
  set showTutorials(value) {
    try { localStorage.setItem(KEY_SHOW_TUTORIALS, value ? '1' : '0') }
    catch { /* ignore */ }
  }
}

export default Settings
