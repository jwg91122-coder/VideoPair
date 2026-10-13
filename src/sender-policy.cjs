'use strict';

function isTrustedSender(event, window, applicationUrl) {
  if (!window || window.isDestroyed()) return false;
  const contents = window.webContents;
  return !contents.isDestroyed()
    && event.sender === contents
    && event.senderFrame === contents.mainFrame
    && event.senderFrame?.url === applicationUrl;
}

module.exports = { isTrustedSender };
