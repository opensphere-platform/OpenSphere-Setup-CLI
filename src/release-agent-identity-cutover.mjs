// One-way reader for the exact agent component identity used by installations
// created before OSAA became canonical. This module is never used to accept a
// new request, build a target lock, resolve an image, or expose an API alias.

export const LEGACY_INSTALLED_AGENT_COMPONENTS = Object.freeze({
  oaaGateway: 'opensphere-console-oaa-gateway',
  oaaGovernedAdapter: 'opensphere-oaa-governed-adapter'
});

export const CANONICAL_AGENT_COMPONENTS = Object.freeze({
  osaaGateway: 'opensphere-console-osaa-gateway',
  osaaGovernedAdapter: 'opensphere-osaa-governed-adapter'
});

export const LEGACY_INSTALLED_AGENT_NAMESPACE = 'opensphere-oaa-credentials';
export const CANONICAL_AGENT_NAMESPACE = 'opensphere-osaa-credentials';

export const LEGACY_INSTALLED_AGENT_ROLLOUTS = Object.freeze({
  oaaGateway: Object.freeze([
    Object.freeze(['opensphere-console', 'deployment/opensphere-console-oaa-gateway', '600s'])
  ]),
  oaaGovernedAdapter: Object.freeze([
    Object.freeze(['opensphere-console', 'deployment/oaa-governed-adapter', '600s'])
  ])
});

const LEGACY_TO_CANONICAL = Object.freeze({
  oaaGateway: 'osaaGateway',
  oaaGovernedAdapter: 'osaaGovernedAdapter'
});

const CANONICAL_TO_LEGACY = Object.freeze(
  Object.fromEntries(Object.entries(LEGACY_TO_CANONICAL).map(([legacy, canonical]) => [canonical, legacy]))
);

export function legacyInstalledComponentMap(canonicalComponents) {
  const components = Object.fromEntries(
    Object.entries(canonicalComponents)
      .filter(([name]) => !Object.hasOwn(CANONICAL_AGENT_COMPONENTS, name))
  );
  return Object.freeze({ ...components, ...LEGACY_INSTALLED_AGENT_COMPONENTS });
}

export function canonicalNameForInstalledComponent(name) {
  return LEGACY_TO_CANONICAL[name] ?? name;
}

export function installedNameForCanonicalComponent(name) {
  return CANONICAL_TO_LEGACY[name] ?? name;
}

export function isAgentIdentityCutover(baseComponents, targetComponents) {
  return Object.keys(LEGACY_INSTALLED_AGENT_COMPONENTS).every((name) => Object.hasOwn(baseComponents ?? {}, name))
    && Object.keys(CANONICAL_AGENT_COMPONENTS).every((name) => Object.hasOwn(targetComponents ?? {}, name));
}

export function hasLegacyInstalledAgentIdentity(components) {
  return Object.keys(LEGACY_INSTALLED_AGENT_COMPONENTS).every((name) => Object.hasOwn(components ?? {}, name))
    && Object.keys(CANONICAL_AGENT_COMPONENTS).every((name) => !Object.hasOwn(components ?? {}, name));
}

export const LEGACY_INSTALLED_AGENT_MANIFESTS = Object.freeze([
  Object.freeze({
    path: 'backend/opensphere-console-oaa-gateway/deploy.yaml',
    replacements: Object.freeze([Object.freeze([
      '(?:ghcr\\.io/opensphere-platform/)?opensphere-console-oaa-gateway(?:@sha256:[A-Za-z0-9_]+|:[A-Za-z0-9][A-Za-z0-9._-]*)',
      'oaaGateway'
    ])])
  }),
  Object.freeze({
    path: 'backend/oaa-governed-adapter/deploy.yaml',
    replacements: Object.freeze([Object.freeze([
      '(?:ghcr\\.io/opensphere-platform/)?opensphere-oaa-governed-adapter(?:@sha256:[A-Za-z0-9_]+|:[A-Za-z0-9][A-Za-z0-9._-]*)',
      'oaaGovernedAdapter'
    ])])
  })
]);
