import {isIP,BlockList} from 'node:net';
const invalidTargets = new BlockList();
for (const [address,prefix] of [['0.0.0.0',8],['127.0.0.0',8],['169.254.0.0',16],['224.0.0.0',4],['240.0.0.0',4]]) invalidTargets.addSubnet(address,prefix,'ipv4');
for (const [address,prefix] of [['::',128],['::1',128],['fe80::',10],['ff00::',8]]) invalidTargets.addSubnet(address,prefix,'ipv6');

export const KUBERNETES_EGRESS_SLOT = '__OPENSPHERE_REGISTRY_KUBERNETES_EGRESS__';
const fail = () => { throw new Error('Registry Kubernetes egress requires valid default/kubernetes Service and ready HTTPS EndpointSlices'); };

// Include both sides of Service DNAT. Never widen a missing endpoint to 0/0.
export function registryKubernetesEgress(service, slices) {
  if (service?.metadata?.name !== 'kubernetes' || service?.metadata?.namespace !== 'default'
      || !Array.isArray(slices?.items)) fail();
  const servicePorts = (service.spec?.ports || []).filter(p => p.name === 'https' && (p.protocol || 'TCP') === 'TCP');
  if (servicePorts.length !== 1) fail();
  const entries = new Map();
  const add = (address, port) => {
    const family = isIP(address || '');
    if (!family || !Number.isInteger(port) || port < 1 || port > 65535) fail();
    // Unspecified, loopback, multicast and link-local cannot be a remote API target.
    if (invalidTargets.check(address, family === 4 ? 'ipv4' : 'ipv6')) fail();
    const cidr = `${address}/${family === 4 ? 32 : 128}`;
    entries.set(`${cidr}:${port}`, {to:[{ipBlock:{cidr}}],ports:[{protocol:'TCP',port}]});
  };
  const serviceIPs = service.spec?.clusterIPs || [service.spec?.clusterIP];
  if (!serviceIPs.length) fail();
  for (const ip of serviceIPs) add(ip, servicePorts[0].port);
  let readyEndpoints = 0;
  for (const slice of slices.items) {
    if (slice?.metadata?.namespace !== 'default'
        || slice?.metadata?.labels?.['kubernetes.io/service-name'] !== 'kubernetes'
        || !['IPv4','IPv6'].includes(slice.addressType)) fail();
    const ports = (slice.ports || []).filter(p => p.name === 'https' && (p.protocol || 'TCP') === 'TCP');
    if (ports.length !== 1) fail();
    for (const endpoint of slice.endpoints || []) {
      if (endpoint.conditions?.ready === false || endpoint.conditions?.terminating === true) continue;
      if (!Array.isArray(endpoint.addresses) || !endpoint.addresses.length) fail();
      for (const ip of endpoint.addresses) {
        if (isIP(ip) !== (slice.addressType === 'IPv4' ? 4 : 6)) fail();
        add(ip, ports[0].port);
        readyEndpoints++;
      }
    }
  }
  if (!readyEndpoints || entries.size > 128) fail();
  return [...entries.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,rule])=>rule);
}

export function discoverRegistryKubernetesEgress(kubectl) {
  const read = args => JSON.parse(kubectl(args, {capture:true}));
  return registryKubernetesEgress(
    read(['-n','default','get','service','kubernetes','-o','json']),
    read(['-n','default','get','endpointslices.discovery.k8s.io','-l','kubernetes.io/service-name=kubernetes','-o','json'])
  );
}

export function renderRegistryKubernetesEgress(source, rules) {
  if (!source.includes(KUBERNETES_EGRESS_SLOT)) return source;
  if (!Array.isArray(rules) || !rules.length || rules.length > 128) fail();
  for (const rule of rules) {
    const cidr = rule?.to?.[0]?.ipBlock?.cidr;
    const [ip, mask] = String(cidr).split('/');
    const family = isIP(ip);
    const port = rule?.ports?.[0]?.port;
    const expected = {to:[{ipBlock:{cidr}}],ports:[{protocol:'TCP',port}]};
    if (!family || mask !== (family === 4 ? '32' : '128')
        || !Number.isInteger(port) || port < 1 || port > 65535
        || JSON.stringify(rule) !== JSON.stringify(expected)) fail();
  }
  const pattern = /^([ \t]*)- __OPENSPHERE_REGISTRY_KUBERNETES_EGRESS__[ \t]*\r?$/gm;
  if ([...source.matchAll(pattern)].length !== 1) fail();
  return source.replace(pattern, (_, indent) => rules.map(rule => `${indent}- ${JSON.stringify(rule)}`).join('\n'));
}