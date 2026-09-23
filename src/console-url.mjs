import {parseAllDocuments} from 'yaml';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const DEFAULT_CONSOLE_URL = 'https://localhost:1114';

/** Canonical browser origin for a managed Console installation. */
export function normalizeConsoleUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--console must be an absolute HTTPS URL or loopback HTTP origin');
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if ((url.protocol !== 'https:' && !loopbackHttp) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('--console must be an HTTPS origin or loopback HTTP origin without credentials, path, query, or fragment');
  }
  return url.origin;
}

export function defaultConsoleUrl(channel, authEnvironment) {
  return DEFAULT_CONSOLE_URL;
}

export function consoleServiceEndpoint(consoleUrl) {
  const url=new URL(normalizeConsoleUrl(consoleUrl));
  const https=url.protocol==='https:';
  return {origin:url.origin,name:https?'https':'http',port:Number(url.port||(https?443:80)),targetPort:https?8443:8080};
}

// c8bde85 temporarily made loopback HTTP the edge/development default. A managed
// installation carrying exactly that origin may be repaired in place when Setup's
// canonical default returns to HTTPS. No other endpoint change is implicit.
export function isLegacyEdgeLoopbackHttpOrigin({ channel, authEnvironment, storedUrl, requestedUrl } = {}) {
  return channel === 'edge'
    && authEnvironment === 'development'
    && normalizeConsoleUrl(storedUrl) === 'http://localhost:8090'
    && normalizeConsoleUrl(requestedUrl) === 'https://localhost:8090';
}

/**
 * The signed Console manifest exposes both nginx listeners. Setup selects the
 * listener that matches the immutable installation origin while preserving
 * compatibility with already-signed manifests that predate endpoint tokens.
 */
export function configureShellServiceEndpoint(yaml, consoleUrl) {
  const endpoint=consoleServiceEndpoint(consoleUrl);
  if(!yaml.includes('opensphere-console-ext'))return yaml;
  const documents=parseAllDocuments(yaml,{prettyErrors:false});
  if(documents.some(doc=>doc.errors.length))throw Error('Invalid Console Service manifest YAML');
  const services=documents.filter(doc=>doc.get('kind')==='Service'&&doc.getIn(['metadata','name'])==='opensphere-console-ext');
  if(services.length!==1)throw Error('Console manifest must expose exactly one governed shell service endpoint');
  const service=services[0];
  const ports=service.getIn(['spec','ports'])?.toJSON();
  if(service.getIn(['metadata','namespace'])!=='opensphere-console'||!Array.isArray(ports)||ports.length!==1
    ||!['https','http'].includes(ports[0].name)||(ports[0].protocol??'TCP')!=='TCP'
    ||!Number.isInteger(ports[0].port)||![8443,8080].includes(ports[0].targetPort)) {
    throw Error('Console manifest does not expose the governed shell service endpoint');
  }
  if(ports[0].name===endpoint.name&&ports[0].port===endpoint.port&&ports[0].targetPort===endpoint.targetPort)return yaml;
  // Edit only the Service document; signed workload bytes and image references
  // in the surrounding documents remain unchanged.
  for(const key of ['name','port','targetPort'])service.setIn(['spec','ports',0,key],endpoint[key]);
  const [start,,end]=service.range;
  return yaml.slice(0,start)+service.toString({lineWidth:0})+yaml.slice(end);
}
