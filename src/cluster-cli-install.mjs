import { installConsoleCli } from './install-cli.mjs';
import { withServicePortForward } from './port-forward.mjs';

export async function installConsoleCliFromCluster({
  installDirectory,
  updatePath = false
} = {}, {
  tunnel = withServicePortForward,
  install = installConsoleCli
} = {}) {
  return tunnel({
    namespace: 'opensphere-console',
    service: 'opensphere-console-ext',
    remotePort: 8090,
    label: 'Console artifact download'
  }, (consoleUrl) => install({
    consoleUrl,
    installDirectory,
    // The temporary service tunnel terminates at the bootstrap certificate.
    // Manifest and artifact bytes remain size/digest verified.
    insecureSkipTlsVerify: true,
    updatePath
  }));
}
