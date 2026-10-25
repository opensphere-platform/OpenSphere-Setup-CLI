'use strict';
// Pinned native configuration. No provider account, balance or shared API key.
function renderNativeOpenClawConfig(){
 return {
  gateway:{mode:'local',port:18789,bind:'loopback',auth:{mode:'token'},controlUi:{enabled:false},terminal:{enabled:false},tailscale:{mode:'off'}},
  models:{mode:'replace',providers:{'opensphere-model-proxy':{
   baseUrl:'http://127.0.0.1:18790/model/v1',apiKey:'${OPENSPHERE_MODEL_PROXY_TOKEN}',api:'openai-completions',
   agentRuntime:{id:'openclaw'},models:[{id:'opensphere-default',name:'Existing verified OpenSphere model',contextWindow:32768,maxTokens:8192,input:['text']}],
  }}},
  agents:{defaults:{workspace:'/data/workspace',model:{primary:'opensphere-model-proxy/opensphere-default'}}},
  memory:{search:{provider:'none',fallback:'none',sources:['memory'],rememberAcrossConversations:false}},
  plugins:{allow:['opensphere-console-bridge','memory-core'],load:{paths:['/opt/opensphere-integration/opensphere-plugin']},
   entries:{'opensphere-console-bridge':{enabled:true},'memory-core':{enabled:true}}},
  // Native personal files and FTS memory remain available. Operating host
  // commands use OS Shell; direct runtime/process execution has no approval path.
  tools:{fs:{workspaceOnly:true},exec:{mode:'deny'},codeMode:false,elevated:{enabled:false},deny:['group:runtime','cron','sessions_spawn']},
  cron:{enabled:false},
 };
}
module.exports={renderNativeOpenClawConfig};
