// Candidate RKE2 admission fence for the CM -> PSSS Crossplane writer handoff.
// It is intentionally not installed by observation or by the Argo preparation.
// A reviewed cutover must verify this exact policy and binding before moving
// the three fixed executor bindings; no parameter object is required.
export const POLICY_NAME='opensphere-psss-crossplane-writer-fence';
export const CM_USERNAME='system:serviceaccount:opensphere-console:opensphere-cluster-manager-runtime';

const protectedName="request.operation == 'DELETE' ? oldObject.metadata.name : object.metadata.name";
const expression=`request.namespace != 'crossplane-system' &&
  request.resource.group != 'crossplane.io' &&
  !request.resource.group.endsWith('.crossplane.io') &&
  !(request.resource.group == 'apiextensions.k8s.io' &&
    request.resource.resource == 'customresourcedefinitions' &&
    (${protectedName}).endsWith('.crossplane.io')) &&
  !(request.resource.group == 'rbac.authorization.k8s.io' &&
    request.resource.resource in ['clusterroles','clusterrolebindings'] &&
    (${protectedName}).startsWith('crossplane')) &&
  !(request.resource.group == '' && request.resource.resource == 'namespaces' &&
    (${protectedName}) == 'crossplane-system')`;

export const POLICY=Object.freeze({
  apiVersion:'admissionregistration.k8s.io/v1',kind:'ValidatingAdmissionPolicy',
  metadata:{name:POLICY_NAME},
  spec:{failurePolicy:'Fail',matchConstraints:{matchPolicy:'Equivalent',namespaceSelector:{},objectSelector:{},resourceRules:[{
    apiGroups:['*'],apiVersions:['*'],operations:['CREATE','UPDATE','DELETE'],resources:['*'],scope:'*',
  }]},matchConditions:[{name:'cluster-manager-service-account',
    expression:`request.userInfo.username == '${CM_USERNAME}'`}],
  validations:[{expression,message:'Cluster Manager is not the Crossplane Core writer; use the reviewed PSSS owner operation.'}],
  },
});
export const BINDING=Object.freeze({
  apiVersion:'admissionregistration.k8s.io/v1',kind:'ValidatingAdmissionPolicyBinding',
  metadata:{name:POLICY_NAME},
  spec:{policyName:POLICY_NAME,validationActions:['Deny']},
});

// A structural check for the observed candidate. This does not establish
// effective enforcement: a real API-server rejection test is required.
export function matchesWriterFence(policy,binding){
  const canonical=value=>JSON.stringify(order(value));
  function order(value){return Array.isArray(value)?value.map(order):value&&typeof value==='object'
    ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,order(value[key])])):value;}
  const shape=value=>({apiVersion:value?.apiVersion,kind:value?.kind,
    metadata:{name:value?.metadata?.name},spec:value?.spec});
  return !policy?.metadata?.deletionTimestamp&&!binding?.metadata?.deletionTimestamp&&
    canonical(shape(policy))===canonical(POLICY)&&canonical(shape(binding))===canonical(BINDING);
}
