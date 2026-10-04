'use strict';
// Custody/replay adapter for the existing GitHub CLI verifier, not a new
// signature scheme. Policy is compiled here; record fields cannot weaken it.
const {createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const PREDICATE='https://opensphere.io/attestations/release-bom/v1';
const TRUST=Object.freeze({type:'github-actions-attestation/v2',repository:'opensphere-platform/OpenSphere-console',
 signerWorkflow:'opensphere-platform/OpenSphere-console/.github/workflows/publish-candidate-images.yml',
 oidcIssuer:'https://token.actions.githubusercontent.com',sourceRef:'refs/heads/main',
 provenancePredicate:'https://slsa.dev/provenance/v1',sbomPredicate:'https://spdx.dev/Document/v2.3'});
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const json=v=>JSON.stringify(stable(v));
const digest=v=>'sha256:'+createHash('sha256').update(json(v)).digest('hex');
const fail=()=>{throw Error('ReleaseBomBundleUnavailable');};
function retainReleaseBomBundle(entry,subject,bomDigest){
 const bundle=entry?.attestation?.bundle,statement=entry?.verificationResult?.statement;
 if(!/^ghcr\.io\/opensphere-platform\/opensphere-[a-z0-9-]+@sha256:[a-f0-9]{64}$/.test(subject||'')
  ||!bundle||Buffer.byteLength(json(bundle))>98304||!bundle.verificationMaterial||!bundle.dsseEnvelope
  ||Object.keys(bundle).some(k=>!['mediaType','verificationMaterial','dsseEnvelope'].includes(k))
  ||statement?.predicateType!==PREDICATE||digest(statement.predicate)!==bomDigest
  ||!statement.subject?.some(s=>s.digest?.sha256===subject.split('@sha256:')[1]))fail();
 let payload;try{payload=JSON.parse(Buffer.from(bundle.dsseEnvelope.payload,'base64').toString('utf8'));}catch{fail();}
 if(json(payload)!==json(statement))fail();
 return {subject,predicateType:PREDICATE,trust:{...TRUST},bundle:structuredClone(bundle),bundleDigest:digest(bundle)};
}
function verifyRetainedReleaseBom(evidence,{execFile=execFileSync}={}){
 if(!evidence||json(evidence.trust)!==json(TRUST)||evidence.predicateType!==PREDICATE
  ||evidence.bundleDigest!==digest(evidence.bundle))fail();
 // Validate bounded input/subject before creating a temporary file. The
 // embedded predicate is only structurally checked; gh performs cryptography.
 let statement;try{statement=JSON.parse(Buffer.from(evidence.bundle.dsseEnvelope.payload,'base64').toString('utf8'));}catch{fail();}
 retainReleaseBomBundle({attestation:{bundle:evidence.bundle},verificationResult:{statement}},evidence.subject,digest(statement.predicate));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'opensphere-bom-')),file=path.join(dir,'bundle.json');
 try{
  fs.writeFileSync(file,JSON.stringify(evidence.bundle),{mode:0o600,flag:'wx'});
  const out=execFile('gh',['attestation','verify','oci://'+evidence.subject,'--bundle',file,
   '--repo',TRUST.repository,'--signer-workflow',TRUST.signerWorkflow,'--cert-oidc-issuer',TRUST.oidcIssuer,
   '--source-ref',TRUST.sourceRef,'--deny-self-hosted-runners','--predicate-type',PREDICATE,'--format','json'],
   {encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:1048576});
  const entries=JSON.parse(out);if(!Array.isArray(entries)||!entries.length)fail();
  const matched=entries.filter(e=>json(e.attestation?.bundle)===json(evidence.bundle));
  if(matched.length!==1)fail();
  const verified=matched[0].verificationResult?.statement;
  const retained=retainReleaseBomBundle(matched[0],evidence.subject,digest(verified?.predicate));
  if(retained.bundleDigest!==evidence.bundleDigest)fail();
  return {bom:structuredClone(verified.predicate),digest:digest(verified.predicate),subject:evidence.subject};
 }catch{fail();}finally{fs.rmSync(dir,{recursive:true,force:true});}
}
module.exports={retainReleaseBomBundle,verifyRetainedReleaseBom,RELEASE_BOM_BUNDLE_TRUST:TRUST};
