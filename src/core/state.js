/** Shared mutable runtime state for browser / local-auth processes. */
const state = {
  localAuthServerProcess: null,
  chromeProcess: null,
  cdpBrowser: null,
  attachedToExistingChrome: false,
};

module.exports = { state };
