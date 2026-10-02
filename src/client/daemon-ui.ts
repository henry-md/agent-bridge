// The pane is read-only. Words are visual connection checks, never credentials.
export const bridgePane = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Bridge</title>
<style>body{font:16px system-ui;background:#10171b;color:#d9e6df;max-width:680px;margin:12vh auto;padding:24px}h1{font-size:20px;color:#9bb7aa}#word{font-size:36px;overflow-wrap:anywhere}#detail{color:#9bb7aa;line-height:1.5}.ok{color:#95efad}input,button{font:inherit;background:#1f2c30;color:inherit;border:1px solid #668173;border-radius:6px;padding:8px}form{display:flex;gap:8px}#state{margin-top:30px}</style>
<h1>Agent Bridge</h1><form><label>Channel <input name="channel" inputmode="numeric" pattern="0|[1-9][0-9]{0,63}" required size="8"></label><button>View</button></form>
<p id="state" role="status">Waiting for a connection</p><p id="word"></p><p id="detail">Run /agent-bridge with this number on both computers.</p>
<script>
const channel=new URLSearchParams(location.search).get('channel');
const state=document.querySelector('#state'),word=document.querySelector('#word'),detail=document.querySelector('#detail');
if(channel&&/^(0|[1-9][0-9]{0,63})$/.test(channel)){
 document.querySelector('input').value=channel;
 const events=new EventSource('/ui/events?channel='+encodeURIComponent(channel));
 events.onmessage=event=>{const value=JSON.parse(event.data);const verified=value.word&&value.transport==='online';state.textContent=verified?'Connected on channel '+channel+'. Secret word is:':'Channel '+channel+' — '+value.transport;state.className=verified?'ok':'';word.textContent=verified?value.word:'';detail.textContent=verified?'Fresh message-channel proof: '+value.proof_ms.toFixed(1)+' ms · '+new Date(value.verified_at).toLocaleTimeString():'Waiting for a fresh echoed nonce. The agent continues in the chat.'};
 events.onerror=()=>{state.textContent='Reconnecting local runtime…';state.className='';word.textContent='';detail.textContent='The pane reconnects automatically when the runtime restarts.'};
}
</script></html>`;
