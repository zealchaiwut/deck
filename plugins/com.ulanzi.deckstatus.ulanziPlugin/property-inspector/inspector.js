// Property Inspector for the Status Tile action. Lightweight by design: it only
// loads saved settings into the form and pushes edits back to the main service
// via the host's standard param channel (no direct WebSocket / RandomPort).

const FORM = '#property-inspector';

$UD.connect();

$UD.onConnected(() => {
  document.querySelector('.udpi-wrapper').classList.remove('hidden');
});

// Host delivers the key's saved settings when the action is added/selected.
$UD.onAdd((message) => {
  if (message && message.param) Utils.setFormValue(message.param, FORM);
});
$UD.onParamFromApp((message) => {
  if (message && message.param) Utils.setFormValue(message.param, FORM);
});

// Persist on every edit. setSettings saves; sendParamFromPlugin notifies the
// main service so it can rebind/repaint immediately.
function pushParams() {
  const params = Utils.getFormValue(FORM);
  $UD.setSettings(params);
  $UD.sendParamFromPlugin(params);
}

document.getElementById('property-inspector').addEventListener('change', pushParams);
document.getElementById('property-inspector').addEventListener('input', Utils.debounce(pushParams, 400));
