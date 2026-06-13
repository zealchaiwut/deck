// Property Inspector for the Antigravity action.
//
// Saving from a Qt webview can be flaky if you rely on a single delayed event,
// so this sends the value through every channel on every relevant event:
//   - reads the input value DIRECTLY (no FormData timing games)
//   - fires on input (debounced), change, blur, and Enter
//   - calls BOTH setSettings (host store) and sendParamFromPlugin (live -> main)
// The main service additionally funnels whatever arrives into the config file,
// so a single successful send makes the choice stick.

const FORM = '#property-inspector';
const input = () => document.querySelector('[name="projectPath"]');

$UD.connect();

$UD.onConnected(() => {
  document.querySelector('.udpi-wrapper').classList.remove('hidden');
});

function load(param) {
  if (param && typeof param.projectPath === 'string' && input()) {
    input().value = param.projectPath;
  }
}
$UD.onAdd((m) => load(m && m.param));
$UD.onParamFromApp((m) => load(m && m.param));
$UD.onDidReceiveSettings((m) => load(m && m.settings));

function save() {
  const el = input();
  if (!el) return;
  const params = { projectPath: el.value.trim() };
  $UD.setSettings(params);
  $UD.sendParamFromPlugin(params);
}

const form = document.getElementById('property-inspector');
form.addEventListener('change', save);
form.addEventListener('blur', save, true);            // capture: fires for the input
form.addEventListener('input', Utils.debounce(save, 350));
form.addEventListener('keyup', (e) => { if (e.key === 'Enter') save(); });
