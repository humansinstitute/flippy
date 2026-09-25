const id = new URL(location.href).searchParams.get('id');
const error = document.querySelector('#error');
chrome.runtime.sendMessage({ type: 'approval.get', id }, request => {
  if (!request) { error.textContent = 'This request has expired.'; document.querySelectorAll('button').forEach(button => button.disabled = true); return; }
  document.querySelector('#origin').textContent = request.origin;
  document.querySelector('#peer').textContent = request.peerNpub;
  document.querySelector('#port').textContent = String(request.port);
  document.querySelector('#purpose').textContent = request.purpose;
});
async function decide(approved) {
  document.querySelectorAll('button').forEach(button => button.disabled = true);
  try { await chrome.runtime.sendMessage({ type: 'approval.decide', id, approved }); close(); }
  catch (failure) { error.textContent = failure.message; }
}
document.querySelector('#approve').addEventListener('click', () => decide(true));
document.querySelector('#deny').addEventListener('click', () => decide(false));
